import { AppError, allowKeys, bytes, fingerprint, requireSpeechSpeed, requireUuid, transcriptFingerprint, uuidPattern, type CompanionId, type TranscriptEvent } from './core.ts';
import { POLICY_VERSION, reviewPolicy, spendReservation, usageEstimate } from './policy.ts';
import { CONVERSATION_CHECKPOINT_VERSION } from './live-context.ts';
import { compactQualifiedHistory, safeCheckpoint, verifiedLegacyCheckpoint, type QualifiedCheckpoint } from './dialogue-continuity.ts';
import { createRealtimeReader, FIDELITY_POLICY_VERSION, pcmToBase64, realtimeReaderRequests, SYNTHESIS_MODEL, SYNTHESIS_OUTPUT_CAP, textDigest, verifySpeechCapture, type SynthesisAdapter } from './verified-speech.ts';

export const AUTHORED_DIALOGUE_PROTOCOL = 'authored_dialogue_v1';
export const AUTHORED_DIALOGUE_POLICY = '2026-11-14-authored-dialogue-v1';
const protocol = AUTHORED_DIALOGUE_PROTOCOL;
type Data = Record<string, any>;
export type DialogueSession = { id: string; user_id: string; companion_id: CompanionId; scenario: string; status: 'active' | 'ended'; ended_at: string | null; created_at?: string | null; time_zone?: string | null };
export type PlaybackOwner = { scope: string; sessionId: string; companionId: CompanionId; callEpoch: number; turnNonce: string; turnId: string; assistantEventId: string; authorityGeneration: number; expectedMemoryRevision: number | null; playbackEpoch: number };
export type PreparedDialogue = { instructions: string; context: unknown; opening: unknown; verify(): Promise<void> };
type Run = { job_id: string; lease_token: string; reserved: boolean; state?: string; result?: unknown; reason?: string };
export type TextProviderResult = { ok: boolean; status: number; payload: unknown };
export type DialogueDependencies = {
  get(name: string): string | undefined; supabase: string; key: string;
  rpc(name: string, body: Data): Promise<any>;
  session(userId: string, sessionId: string): Promise<DialogueSession>;
  events(userId: string, sessionId: string): Promise<TranscriptEvent[]>;
  prepare(userId: string, session: DialogueSession, omitted: boolean, purpose: string, checkpoint?: QualifiedCheckpoint | null): Promise<PreparedDialogue>;
  summarize(userId: string, session: DialogueSession, fresh: TranscriptEvent[], prior: string | null, run: Run, preDispatch: () => Promise<void>): Promise<string>;
  legacyCheckpoints?(userId: string, sessionId: string, prefix: string): Promise<{ request_key: string; result: Data }[]>;
  author?(body: Data, signal?: AbortSignal): Promise<TextProviderResult>;
  synthesize?: SynthesisAdapter;
  bootstrapVoice(userId: string, body: Data): Promise<Data>;
};
const data = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const invalid = () => new AppError(400, 'INVALID_DIALOGUE_REQUEST', 'This conversation request could not be verified.');
function integer(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || Number(value) < minimum) throw invalid(); return Number(value); }
function revision(value: unknown): number | null { return value === null ? null : integer(value); }
function ids(value: unknown): string[] { if (!Array.isArray(value) || value.length > 3000 || value.some(id => typeof id !== 'string' || !uuidPattern.test(id)) || new Set(value.map(id => id.toLowerCase())).size !== value.length) throw invalid(); return value.map(id => id.toLowerCase()); }
function omitted(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function reservationCeiling(get: DialogueDependencies['get']): number | null { const n = Number(get('AUTHORED_SYNTHESIS_MAX_RESERVATION_USD') ?? 1); return Number.isFinite(n) && n > 0 && n <= 1 ? n : null; }
export function authoredDialogueCapability(get: DialogueDependencies['get']): boolean { return get('AUTHORED_DIALOGUE_ENABLED') === 'true' && get('AUTHORED_DIALOGUE_FIDELITY_VERIFIED') === 'true' && reservationCeiling(get) !== null; }
const scopeOf = (deps: DialogueDependencies, userId: string) => deps.supabase.replace(/\/$/, '') + '|' + userId;
function ownerOf(value: unknown, deps: DialogueDependencies, userId: string): PlaybackOwner {
  const item = data(value); allowKeys(item, ['scope', 'sessionId', 'companionId', 'callEpoch', 'turnNonce', 'turnId', 'assistantEventId', 'authorityGeneration', 'expectedMemoryRevision', 'playbackEpoch']);
  if (item.scope !== scopeOf(deps, userId) || !['mia', 'alex', 'juno'].includes(item.companionId)) throw invalid();
  return { scope: item.scope, sessionId: requireUuid(item.sessionId), companionId: item.companionId, callEpoch: integer(item.callEpoch, 1), turnNonce: requireUuid(item.turnNonce), turnId: requireUuid(item.turnId), assistantEventId: requireUuid(item.assistantEventId), authorityGeneration: integer(item.authorityGeneration, 1), expectedMemoryRevision: revision(item.expectedMemoryRevision), playbackEpoch: integer(item.playbackEpoch) };
}
const rpcInvalid = () => new AppError(503, 'DIALOGUE_RPC_INVALID', 'The conversation acknowledgement could not be verified.');
function stateOf(raw: any): Data {
  const state = data(raw);
  if (!Number.isSafeInteger(state.call_epoch) || state.call_epoch < 1 || !Number.isSafeInteger(state.authority_generation) || state.authority_generation < 1 || !Number.isSafeInteger(state.turn_generation) || state.turn_generation < 0 || !['included', 'omitted'].includes(state.memory_mode) || (state.memory_mode === 'omitted' ? state.memory_revision !== null : !Number.isSafeInteger(state.memory_revision) || state.memory_revision < 0)) throw rpcInvalid();
  return state;
}
function turnOf(raw: any): Data { const turn = data(raw?.turn); if (!uuidPattern.test(turn.id) || !uuidPattern.test(turn.assistant_event_id) || !Number.isSafeInteger(turn.turn_generation) || turn.turn_generation < 1) throw rpcInvalid(); return turn; }
function tuple(userId: string, owner: PlaybackOwner, generation: number): Data { return { p_user_id: userId, p_turn_id: owner.turnId, p_call_epoch: owner.callEpoch, p_authority_generation: owner.authorityGeneration, p_turn_generation: generation }; }
async function approved(deps: DialogueDependencies, userId: string, sessionId: string) {
  const session = await deps.session(userId, sessionId);
  if (session.status !== 'active') throw new AppError(409, 'SESSION_ENDED', 'This call has ended.');
  if (await deps.rpc('conversation_context_authorized', { p_user_id: userId, p_session_id: sessionId }) !== true) throw new AppError(403, 'ACCOUNT_NOT_ALLOWED', 'This conversation is no longer available.');
  return session;
}
async function reserve(deps: DialogueDependencies, userId: string, sessionId: string, kind: string, key: string, allowCompleted = false): Promise<Run> {
  const run = await deps.rpc('reserve_run', { p_user_id: userId, p_kind: kind, p_request_key: key, p_session_id: sessionId, p_lease_seconds: 120 });
  if (allowCompleted && run?.reserved === false && run.state === 'completed') return run;
  if (!run?.reserved) throw new AppError(run?.reason === 'budget_exceeded' ? 429 : 409, run?.reason === 'budget_exceeded' ? 'BUDGET_EXCEEDED' : 'DIALOGUE_IN_PROGRESS', 'The conversation request is already active or unavailable.');
  return run;
}
async function fail(deps: DialogueDependencies, run: Run | null, error: unknown) { if (run) try { await deps.rpc('fail_run', { p_job_id: run.job_id, p_lease_token: run.lease_token, p_error: error instanceof AppError ? error.code : 'DIALOGUE_FAILED' }); } catch { /* lease expiry never authorizes playback */ } }
async function cost(deps: DialogueDependencies, run: Run, model: string, policy: unknown, amount: number) {
  if (await deps.rpc('reserve_model_spend', { p_job_id: run.job_id, p_lease_token: run.lease_token, p_model: model, p_policy: policy, p_reserved_usd: amount }) !== true) throw new AppError(429, 'COST_BUDGET_EXCEEDED', 'The model budget has been reached.');
}
async function account(deps: DialogueDependencies, run: Run, usage: unknown, amount: number | null, outcome: string) { await deps.rpc('record_model_spend', { p_job_id: run.job_id, p_lease_token: run.lease_token, p_usage: usage, p_estimated_usd: amount, p_outcome: outcome }); }

// Official mini pricing: no input audio is sent by this OOB reader. Count
// all output as audio (including text/reasoning) for a conservative estimate.
export function synthesisReservation(text: string, voice: string, speed: number, nonce: string): number {
  const inputBound = bytes(JSON.stringify(realtimeReaderRequests({ text, voice, speed, nonce }))) + 8192;
  return (inputBound * .60 + SYNTHESIS_OUTPUT_CAP * 20) / 1e6;
}
export function synthesisUsage(raw: unknown): { usage: unknown; estimatedUsd: number | null } {
  const value = data(raw), valid = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  // A verified nonempty audio result cannot have zero output tokens. An
  // impossible or absent usage report keeps the conservative reservation.
  if (!valid(value.input_tokens) || !valid(value.output_tokens) || value.output_tokens === 0 || (value.total_tokens !== undefined && (!valid(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens))) return { usage: null, estimatedUsd: null };
  for (const key of ['input_token_details', 'input_tokens_details']) if (value[key]?.audio_tokens !== undefined && value[key].audio_tokens !== 0) return { usage: null, estimatedUsd: null };
  return { usage: { input_tokens: value.input_tokens, output_tokens: value.output_tokens, total_tokens: value.input_tokens + value.output_tokens }, estimatedUsd: (value.input_tokens * .60 + value.output_tokens * 20) / 1e6 };
}

export function authoringRequest(instructions: string, events: TranscriptEvent[], opaque: Record<string, unknown>, policy: ReturnType<typeof reviewPolicy>, nonce: string, purpose: string): Data {
  const history: unknown[] = [];
  for (const event of events) {
    // Production carries only accepted plaintext. The ignored compatibility
    // argument cannot reintroduce encrypted or hidden provider state.
    history.push(event.speaker === 'user' ? { role: 'user', content: [{ type: 'input_text', text: event.text }] } : { role: 'assistant', content: [{ type: 'output_text', text: event.text }], phase: 'final_answer' });
  }
  return { model: policy.model, store: false, max_output_tokens: policy.maxOutput, reasoning: { effort: policy.effort }, service_tier: 'default', prompt_cache_options: { mode: 'explicit' },
    input: [{ role: 'developer', content: [{ type: 'input_text', text: instructions, prompt_cache_breakpoint: { mode: 'explicit' } }] }, ...history], text: { verbosity: policy.verbosity, format: { type: 'text' } }, tools: [], tool_choice: 'none', metadata: { turn_nonce: nonce, purpose } };
}
export function authoredOutput(value: unknown, model: string, nonce: string, purpose: string): { text: string; usage: unknown } {
  const payload = data(value);
  if (payload.status !== 'completed' || payload.store !== false || typeof payload.id !== 'string' || payload.metadata?.turn_nonce !== nonce || payload.metadata?.purpose !== purpose || typeof payload.model !== 'string' || !new RegExp('^' + model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:-\\d{4}-\\d{2}-\\d{2})?$').test(payload.model) || payload.text?.format?.type !== 'text' || !Array.isArray(payload.output)) throw new AppError(502, 'DIALOGUE_OUTPUT_INVALID', 'The conversation reply could not be verified.');
  const parts: string[] = [];
  for (const raw of payload.output) {
    const item = data(raw);
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content) || (item.phase !== undefined && item.phase !== 'final_answer')) throw new AppError(502, 'DIALOGUE_OUTPUT_INVALID', 'The conversation reply could not be verified.');
    item.content.forEach((part: Data) => { if (part?.type !== 'output_text' || typeof part.text !== 'string') throw new AppError(502, 'DIALOGUE_OUTPUT_INVALID', 'The conversation reply could not be verified.'); parts.push(part.text); });
  }
  const text = parts.join('\n');
  if (!text.trim() || text.length > 20_000) throw new AppError(502, 'DIALOGUE_OUTPUT_INVALID', 'The conversation reply could not be verified.');
  return { text, usage: payload.usage };
}
async function defaultAuthor(deps: DialogueDependencies, body: Data, signal?: AbortSignal): Promise<TextProviderResult> {
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + deps.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]) });
  return { ok: response.ok, status: response.status, payload: await response.json().catch(() => null) };
}
function publicContext(raw: any, session: DialogueSession): Data {
  const state = stateOf(raw);
  return { protocol, callEpoch: integer(state.call_epoch, 1), authorityGeneration: integer(state.authority_generation, 1), generation: integer(state.turn_generation), memoryRevision: revision(state.memory_revision), memoryMode: state.memory_mode, companionId: session.companion_id };
}
function makeOwner(turn: Data, deps: DialogueDependencies, userId: string): PlaybackOwner {
  return ownerOf({ scope: scopeOf(deps, userId), sessionId: turn.session_id, companionId: turn.companion_id, callEpoch: turn.call_epoch, turnNonce: turn.turn_nonce, turnId: turn.id ?? turn.turn_id, assistantEventId: turn.assistant_event_id, authorityGeneration: turn.authority_generation, expectedMemoryRevision: turn.memory_revision, playbackEpoch: turn.playback_epoch }, deps, userId);
}
async function publicTurn(raw: any, deps: DialogueDependencies, userId: string): Promise<Data> {
  const turn = turnOf(raw), event = data(raw?.assistant_event), text = event.text;
  if (!['text_complete', 'synthesizing', 'published', 'played'].includes(turn.status) || typeof text !== 'string' || !text.trim() || event.id !== turn.assistant_event_id || event.session_id !== turn.session_id || event.speaker !== 'assistant' || typeof event.event_key !== 'string' || !event.event_key.trim() || !Number.isFinite(Date.parse(event.timestamp)) || turn.written_text_sha256 !== await textDigest(text)) throw rpcInvalid();
  return { protocol, owner: makeOwner(turn, deps, userId), generation: turn.turn_generation, text, textSha256: turn.written_text_sha256,
    assistantEvent: { id: event.id, event_key: event.event_key, session_id: event.session_id, speaker: 'assistant', text, occurred_at: event.timestamp, storage: 'server' } };
}
const discardedReasons = ['stale_authority', 'stale_revision', 'cancelled', 'source_changed', 'session_ended', 'session_missing', 'source_missing'];
function playbackAck(raw: unknown, owner: PlaybackOwner, generation: number, receiptId: string, deps: DialogueDependencies, userId: string): Data {
  const result = data(raw), turn = turnOf(result);
  if (JSON.stringify(makeOwner(turn, deps, userId)) !== JSON.stringify(owner) || turn.turn_generation !== generation || result.receipt_id !== receiptId || !['recorded', 'discarded'].includes(result.status) || (result.status === 'recorded' ? result.reason !== null : !discardedReasons.includes(result.reason))) throw rpcInvalid();
  return { protocol, owner, generation, receiptId, status: result.status, reason: result.reason };
}
function pendingReports(value: unknown, deps: DialogueDependencies, userId: string): Data[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw invalid();
  return value.map(raw => { const item = data(raw); allowKeys(item, ['protocol', 'owner', 'generation', 'receiptId', 'qualifiedUserEventIds']); if (item.protocol !== protocol) throw invalid(); const owner = ownerOf(item.owner, deps, userId);
    return { turn_id: owner.turnId, turn_generation: integer(item.generation), playback_epoch: owner.playbackEpoch, receipt_id: requireUuid(item.receiptId), qualified_user_ids: ids(item.qualifiedUserEventIds), call_epoch: owner.callEpoch, authority_generation: owner.authorityGeneration, assistant_event_id: owner.assistantEventId, expected_memory_revision: owner.expectedMemoryRevision, companion_id: owner.companionId }; });
}

// The database returns raw rows and their existing server digests together.
// Never re-attest a separately fetched old plaintext snapshot with fresh hashes.
function acceptedSnapshot(raw: unknown, sessionId: string, currentIds: string[], historyIds: string[]) {
  const accepted = data(raw), selected = new Set([...currentIds, ...historyIds]), digests = data(accepted.source_event_digests);
  if (!Array.isArray(accepted.current_user_ids) || !Array.isArray(accepted.history_ids) || accepted.current_user_ids.length !== currentIds.length || accepted.history_ids.length !== historyIds.length ||
    new Set(accepted.current_user_ids).size !== currentIds.length || new Set(accepted.history_ids).size !== historyIds.length || accepted.current_user_ids.some((id: string) => !currentIds.includes(id)) || accepted.history_ids.some((id: string) => !historyIds.includes(id)) ||
    !Array.isArray(accepted.events) || accepted.events.length !== selected.size || Object.keys(digests).length !== selected.size || Object.entries(digests).some(([id, digest]) => !selected.has(id) || typeof digest !== 'string' || !/^[a-f0-9]{32}$/.test(digest))) throw rpcInvalid();
  const byId = new Map<string, TranscriptEvent>();
  for (const rawEvent of accepted.events) {
    const event = data(rawEvent);
    if (!selected.has(event.id) || byId.has(event.id) || event.session_id !== sessionId || !['user', 'assistant'].includes(event.speaker) || typeof event.text !== 'string' || !event.text.trim() || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)) || (currentIds.includes(event.id) && event.speaker !== 'user')) throw rpcInvalid();
    byId.set(event.id, { id: event.id, session_id: event.session_id, speaker: event.speaker, text: event.text, timestamp: event.timestamp });
  }
  return { current: accepted.current_user_ids.map((id: string) => byId.get(id)!), history: accepted.history_ids.map((id: string) => byId.get(id)!), digests };
}

export async function handleAuthoredDialogue(endpoint: string, userId: string, body: Data, deps: DialogueDependencies, signal?: AbortSignal): Promise<Data> {
  if (body.protocol !== protocol) throw invalid();
  const notAborted = () => { if (signal?.aborted) throw new AppError(409, 'DIALOGUE_CANCELLED', 'This conversation response was stopped.'); };
  if (!authoredDialogueCapability(deps.get)) throw new AppError(409, 'AUTHORED_DIALOGUE_DISABLED', 'This conversation option is not available.');
  if (endpoint === 'dialogue-voice') {
    allowKeys(body, ['protocol', 'sessionId', 'sdp', 'speechSpeed']); await approved(deps, userId, requireUuid(body.sessionId));
    const result = await deps.bootstrapVoice(userId, { sessionId: body.sessionId, sdp: body.sdp, speechSpeed: requireSpeechSpeed(body.speechSpeed), omitLearningContext: true, turnControl: 'manual_turns_v1' });
    return { ...result, protocol, authored_dialogue: { asr_only: true } };
  }
  if (endpoint === 'dialogue-context') {
    allowKeys(body, ['protocol', 'sessionId', 'callEpoch', 'omitLearningContext', 'reset']); const sessionId = requireUuid(body.sessionId), session = await approved(deps, userId, sessionId);
    const raw = await deps.rpc('authored_dialogue_context', { p_user_id: userId, p_session_id: sessionId, p_omit_memory: omitted(body.omitLearningContext), p_call_epoch: integer(body.callEpoch, 1), p_reset: body.reset === undefined ? false : omitted(body.reset) });
    return publicContext(raw, session);
  }
  if (endpoint === 'dialogue-cancel') {
    allowKeys(body, ['protocol', 'sessionId', 'callEpoch', 'authorityGeneration', 'turnNonce', 'generation', 'reason']);
    const sessionId = requireUuid(body.sessionId); await deps.session(userId, sessionId);
    const callEpoch = integer(body.callEpoch, 1), authorityGeneration = integer(body.authorityGeneration, 1), turnNonce = requireUuid(body.turnNonce), generation = body.generation === undefined ? null : integer(body.generation);
    const result = data(await deps.rpc('authored_dialogue_cancel', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_turn_nonce: turnNonce, p_turn_generation: generation }));
    if (result.cancelled !== true || !['cancelled', 'already_cancelled', 'stale'].includes(result.status) || result.turn_nonce !== turnNonce || result.call_epoch !== callEpoch || result.authority_generation !== authorityGeneration || !Number.isSafeInteger(result.turn_generation) || result.turn_generation < 0) throw rpcInvalid();
    return { protocol, sessionId, callEpoch, authorityGeneration, turnNonce, generation: result.turn_generation, cancelled: true, status: result.status };
  }
  if (endpoint === 'dialogue-playback') {
    allowKeys(body, ['protocol', 'owner', 'generation', 'receiptId', 'qualifiedUserEventIds']); const owner = ownerOf(body.owner, deps, userId), generation = integer(body.generation), receiptId = requireUuid(body.receiptId);
    const receiptSource = data(await deps.rpc('authored_dialogue_receipt_source', { p_user_id: userId, p_session_id: owner.sessionId, p_turn_id: owner.turnId, p_companion_id: owner.companionId }));
    if (receiptSource.missing === true && ['session_missing', 'source_missing'].includes(receiptSource.reason)) return { protocol, owner, generation, receiptId, status: 'discarded', reason: receiptSource.reason };
    if (receiptSource.missing !== false) throw rpcInvalid();
    await deps.session(userId, owner.sessionId);
    const result = data(await deps.rpc('authored_dialogue_playback', { ...tuple(userId, owner, generation), p_playback_epoch: owner.playbackEpoch, p_receipt_id: receiptId, p_qualified_user_ids: ids(body.qualifiedUserEventIds), p_assistant_event_id: owner.assistantEventId, p_expected_memory_revision: owner.expectedMemoryRevision, p_companion_id: owner.companionId }));
    return playbackAck(result, owner, generation, receiptId, deps, userId);
  }
  if (endpoint === 'dialogue-synthesis') {
    allowKeys(body, ['protocol', 'owner', 'generation']); const owner = ownerOf(body.owner, deps, userId), generation = integer(body.generation); const session = await approved(deps, userId, owner.sessionId);
    if (session.companion_id !== owner.companionId) throw invalid(); notAborted(); let run: Run | null = null, accounted = false;
    try {
      run = await reserve(deps, userId, session.id, 'dialogue_synthesis', 'dialogue-synthesis:' + owner.turnId + ':' + generation);
      const settingsBase = { model: SYNTHESIS_MODEL, verification_policy: FIDELITY_POLICY_VERSION };
      const raw = await deps.rpc('authored_dialogue_synthesis_begin', { ...tuple(userId, owner, generation), p_playback_epoch: owner.playbackEpoch, p_job_id: run.job_id, p_lease_token: run.lease_token, p_settings: settingsBase });
      const turn = turnOf(raw), text = raw?.text, voice = raw?.voice, speed = raw?.speed;
      if (typeof text !== 'string' || !text.trim() || typeof voice !== 'string' || !Number.isFinite(speed) || makeOwner(turn, deps, userId).assistantEventId !== owner.assistantEventId) throw invalid();
      const settings = data(raw?.settings);
      if (settings.model !== SYNTHESIS_MODEL || settings.verification_policy !== FIDELITY_POLICY_VERSION || settings.voice !== voice || settings.speed !== speed || settings.approved_text_sha256 !== await textDigest(text) || JSON.stringify(makeOwner(turn, deps, userId)) !== JSON.stringify(owner)) throw rpcInvalid();
      const reservation = synthesisReservation(text, voice, speed, owner.turnNonce);
      if (reservation > reservationCeiling(deps.get)!) throw new AppError(503, 'SYNTHESIS_COST_CONFIGURATION', 'The spoken response budget is not configured.');
      await cost(deps, run, SYNTHESIS_MODEL, { ...settings, pricing_policy: 'realtime-mini-text-input-audio-output-v1' }, reservation);
      notAborted();
      if (await deps.rpc('authored_dialogue_dispatch', { p_user_id: userId, p_session_id: session.id, p_call_epoch: owner.callEpoch, p_authority_generation: owner.authorityGeneration, p_expected_generation: generation,
        p_expected_memory_revision: owner.expectedMemoryRevision, p_turn_nonce: owner.turnNonce, p_turn_id: owner.turnId, p_stage: 'dialogue_synthesis', p_job_id: run.job_id, p_lease_token: run.lease_token, p_source_event_digests: data(turn.source_manifest).event_digests }) !== true) throw rpcInvalid();
      notAborted();
      const capture = await (deps.synthesize ?? createRealtimeReader())({ text, nonce: owner.turnNonce, voice, speed, key: deps.key, signal });
      const settlement = synthesisUsage(capture.usage);
      await account(deps, run, settlement.usage, settlement.estimatedUsd, settlement.estimatedUsd !== null && settlement.estimatedUsd > reservation ? 'reservation_exceeded' : 'generated_audio'); accounted = true;
      if (settlement.estimatedUsd !== null && settlement.estimatedUsd > reservation) throw new AppError(503, 'SYNTHESIS_COST_CONFIGURATION', 'The spoken response budget could not be verified.');
      notAborted();
      const clip = await verifySpeechCapture(capture, text);
      notAborted();
      const published = await deps.rpc('authored_dialogue_publish', { ...tuple(userId, owner, generation), p_playback_epoch: owner.playbackEpoch, p_job_id: run.job_id, p_lease_token: run.lease_token,
        p_transcript: capture.transcript, p_audio_sha256: clip.pcmSha256, p_audio_bytes: clip.byteLength, p_audio_frames: clip.sourceFrames, p_pcm_rate: 24000, p_settings: settings });
      if (published?.published !== true || published.turn_id !== owner.turnId || published.turn_generation !== generation || published.synthesis_id !== run.job_id) throw rpcInvalid();
      return { protocol, manifest: { version: 'verified-pcm-candidate-v1', owner, textSha256: clip.textSha256, pcmSha256: clip.pcmSha256, format: 'pcm_s16le', sampleRate: 24000, channels: 1, sourceFrames: clip.sourceFrames, byteLength: clip.byteLength, synthesisId: run.job_id,
        transcriptVerification: { status: 'matched', policyVersion: FIDELITY_POLICY_VERSION, approvedTextSha256: clip.textSha256 }, synthesisSpeed: speed }, pcmBase64: pcmToBase64(clip.pcm) };
    } catch (error) { if (run && !accounted) try { await account(deps, run, null, null, 'transport_unknown'); } catch { /* pre-spend validation may have failed */ } await fail(deps, run, error); throw error; }
  }
  if (endpoint !== 'dialogue-turn') throw new AppError(404, 'NOT_FOUND', 'This endpoint was not found.');
  allowKeys(body, ['protocol', 'sessionId', 'callEpoch', 'authorityGeneration', 'turnNonce', 'expectedGeneration', 'playbackEpoch', 'purpose', 'hint', 'currentUserEventIds', 'acceptedHistoryEventIds', 'expectedMemoryRevision', 'omitLearningContext', 'speechSpeed', 'pendingPlaybackReports']);
  const sessionId = requireUuid(body.sessionId), session = await approved(deps, userId, sessionId), callEpoch = integer(body.callEpoch, 1), authorityGeneration = integer(body.authorityGeneration, 1), expectedGeneration = integer(body.expectedGeneration), turnNonce = requireUuid(body.turnNonce), playbackEpoch = integer(body.playbackEpoch), isOmitted = omitted(body.omitLearningContext), expectedRevision = revision(body.expectedMemoryRevision), speed = requireSpeechSpeed(body.speechSpeed);
  const currentIds = ids(body.currentUserEventIds), historyIds = ids(body.acceptedHistoryEventIds);
  if (!['startup', 'reply', 'hint'].includes(body.purpose) || body.purpose === 'reply' && !currentIds.length || body.purpose !== 'reply' && currentIds.length || body.purpose === 'hint' && body.hint !== 'next_sentence' || body.purpose !== 'hint' && body.hint !== undefined || currentIds.some(id => historyIds.includes(id)) || isOmitted !== (expectedRevision === null)) throw invalid();
  const pending = pendingReports(body.pendingPlaybackReports, deps, userId);
  if (pending.some(report => report.call_epoch !== callEpoch || report.authority_generation !== authorityGeneration)) throw invalid();
  if (pending.length) {
    const acknowledged = await deps.rpc('authored_dialogue_batchplaybacks', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_reports: pending });
    if (acknowledged?.processed !== pending.length || !Array.isArray(acknowledged.results) || acknowledged.results.length !== pending.length) throw rpcInvalid();
    for (let i = 0; i < pending.length; i++) {
      const report = data(body.pendingPlaybackReports[i]); playbackAck(acknowledged.results[i], ownerOf(report.owner, deps, userId), report.generation, report.receiptId, deps, userId);
    }
  }
  const rawState = await deps.rpc('authored_dialogue_state', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_expected_generation: expectedGeneration, p_expected_memory_revision: expectedRevision, p_turn_nonce: turnNonce }), state = stateOf(rawState);
  if (state.authority_generation !== authorityGeneration || state.turn_generation !== expectedGeneration || state.memory_revision !== expectedRevision) throw new AppError(409, 'MEMORY_CHANGED', 'The conversation context changed. Please retry.');
  const snapshot = acceptedSnapshot(await deps.rpc('authored_dialogue_history', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_expected_generation: expectedGeneration, p_current_user_ids: currentIds, p_history_ids: historyIds, p_expected_memory_revision: expectedRevision }), sessionId, currentIds, historyIds);
  const { history, current } = snapshot;
  const sourceDigests = (events: TranscriptEvent[]) => Object.fromEntries(events.map(event => [event.id, snapshot.digests[event.id]]));
  const dispatch = async (run: Run, stage: string, turn: Data | null, digests: Data) => {
    notAborted();
    if (await deps.rpc('authored_dialogue_dispatch', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_expected_generation: turn?.turn_generation ?? expectedGeneration,
      p_expected_memory_revision: expectedRevision, p_turn_nonce: turnNonce, p_turn_id: turn?.id ?? null, p_stage: stage, p_job_id: run.job_id, p_lease_token: run.lease_token, p_source_event_digests: digests }) !== true) throw rpcInvalid();
    notAborted();
  };
  const checkpointPolicy = reviewPolicy('checkpoint', deps.get), checkpointFingerprint = await fingerprint({ version: CONVERSATION_CHECKPOINT_VERSION, policy: checkpointPolicy, prompt_version: POLICY_VERSION });
  let previous = safeCheckpoint(state.checkpoint ?? rawState?.checkpoint, history, checkpointFingerprint);
  const storeCheckpoint = async (checkpoint: QualifiedCheckpoint, covered: TranscriptEvent[]) => {
    const saved = data(await deps.rpc('authored_dialogue_checkpoint', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_expected_generation: expectedGeneration, p_covered_event_ids: checkpoint.covered_ids, p_summary: checkpoint.summary, p_expected_memory_revision: expectedRevision, p_policy_fingerprint: checkpointFingerprint, p_source_event_digests: sourceDigests(covered), p_turn_nonce: turnNonce }));
    const confirmed = safeCheckpoint(saved.checkpoint, covered, checkpointFingerprint);
    if (!confirmed || confirmed.summary !== checkpoint.summary || confirmed.covered_ids.length !== covered.length) throw rpcInvalid();
  };
  if (!previous && authorityGeneration === 1 && deps.legacyCheckpoints) {
    const prefix = `checkpoint:${CONVERSATION_CHECKPOINT_VERSION}:${session.companion_id}:${sessionId}:${(await fingerprint({ prompt_version: POLICY_VERSION, policy: checkpointPolicy })).slice(0, 16)}:${expectedRevision ?? 0}:${isOmitted ? 'omitted:v2:' : ''}qualified:v1:`;
    previous = await verifiedLegacyCheckpoint(await deps.legacyCheckpoints(userId, sessionId, prefix), history, { prefix, revision: expectedRevision ?? 0, model: checkpointPolicy.model, promptVersion: POLICY_VERSION, omitted: isOmitted, policyFingerprint: checkpointFingerprint });
    if (previous) await storeCheckpoint(previous, history.slice(0, previous.covered_ids.length));
  }
  const compact = await compactQualifiedHistory(history, previous, checkpointFingerprint, async (fresh, prior, covered) => {
    const key = 'dialogue-checkpoint:' + sessionId + ':' + (await fingerprint([authorityGeneration, checkpointFingerprint, await transcriptFingerprint(covered)])).slice(0, 64);
    const run = await reserve(deps, userId, sessionId, 'checkpoint', key, true), coverageDigest = await transcriptFingerprint(covered);
    if (!run.reserved) {
      const cached = data(run.result);
      if (cached.checkpoint_version !== CONVERSATION_CHECKPOINT_VERSION || cached.policy_fingerprint !== checkpointFingerprint || cached.coverage_digest !== coverageDigest || typeof cached.summary !== 'string' || !cached.summary.trim() || cached.summary.length > 900) throw rpcInvalid();
      return cached.summary;
    }
    try { const summary = await deps.summarize(userId, session, fresh, prior, run, () => dispatch(run, 'checkpoint', null, sourceDigests(covered))); await deps.rpc('complete_run', { p_job_id: run.job_id, p_lease_token: run.lease_token, p_result: { checkpoint_version: CONVERSATION_CHECKPOINT_VERSION, coverage_digest: coverageDigest, policy_fingerprint: checkpointFingerprint, summary } }); return summary; }
    catch (error) { await fail(deps, run, error); throw error; }
  }, storeCheckpoint);
  notAborted();
  const prepared = await deps.prepare(userId, session, isOmitted, body.purpose, compact.checkpoint);
  const policy = reviewPolicy('session', deps.get), policyFingerprint = await fingerprint({ version: AUTHORED_DIALOGUE_POLICY, policy, hint: body.hint ?? null, speed });
  const begun = await deps.rpc('authored_dialogue_begin', { p_user_id: userId, p_session_id: sessionId, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_expected_generation: expectedGeneration, p_turn_nonce: turnNonce, p_purpose: body.purpose, p_hint: body.hint ?? null,
    p_current_user_ids: currentIds, p_history_ids: historyIds, p_expected_memory_revision: expectedRevision, p_playback_epoch: playbackEpoch, p_context: prepared.context, p_opening: prepared.opening, p_policy_fingerprint: policyFingerprint,
    p_pending_playbacks: pending, p_speech_speed: speed, p_checkpoint_covered_ids: compact.checkpoint?.covered_ids ?? [], p_source_event_digests: snapshot.digests });
  const turn = turnOf(begun);
  if (turn.status !== 'reserved') return publicTurn(begun, deps, userId);
  let run: Run | null = null, accounted = false;
  try {
    run = await reserve(deps, userId, sessionId, 'dialogue', 'dialogue:' + (turn.id ?? turn.turn_id));
    const instructions = prepared.instructions + (body.purpose === 'hint' ? '\nFor this response only: The caller requested an English next sentence for the current conversation. Give the useful expression directly.' : '');
    const modelInput = authoringRequest(instructions, [...compact.events, ...current], {}, policy, turnNonce, body.purpose);
    const reservation = spendReservation(bytes(JSON.stringify(modelInput)), policy.model, policy.maxOutput);
    await cost(deps, run, policy.model, { version: AUTHORED_DIALOGUE_POLICY, ...policy }, reservation);
    await prepared.verify();
    await dispatch(run, 'dialogue', turn, snapshot.digests);
    notAborted();
    let result: TextProviderResult;
    try { result = await (deps.author ?? ((request, requestSignal) => defaultAuthor(deps, request, requestSignal)))(modelInput, signal); }
    catch (error) { await account(deps, run, null, null, 'transport_unknown'); accounted = true; throw error; }
    const accounting = usageEstimate(data(result.payload).usage, policy.model); await account(deps, run, accounting.usage, accounting.estimated_usd, !result.ok ? 'http_error' : data(result.payload).status === 'completed' ? 'generated' : 'incomplete'); accounted = true;
    if (accounting.estimated_usd !== null && accounting.estimated_usd > reservation) throw new AppError(503, 'DIALOGUE_COST_CONFIGURATION', 'The conversation reply budget could not be verified.');
    if (!result.ok) throw new AppError(502, 'DIALOGUE_UNAVAILABLE', 'The conversation reply could not be completed.');
    notAborted();
    const output = authoredOutput(result.payload, policy.model, turnNonce, body.purpose); await prepared.verify(); notAborted();
    const completed = await deps.rpc('authored_dialogue_complete_text', { p_user_id: userId, p_turn_id: turn.id ?? turn.turn_id, p_call_epoch: callEpoch, p_authority_generation: authorityGeneration, p_turn_generation: turn.turn_generation, p_job_id: run.job_id, p_lease_token: run.lease_token, p_text: output.text, p_opaque_output: null });
    return publicTurn(completed, deps, userId);
  } catch (error) { if (run && !accounted) try { await account(deps, run, null, null, 'transport_unknown'); } catch { /* no reservation may exist */ } await fail(deps, run, error); throw error; }
}
