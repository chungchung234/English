import { createLearningOutbox } from '../src/learning-outbox.js';
import { validSpeed } from './speech-speed.js';

export const AUTHORED_DIALOGUE_PROTOCOL = 'authored_dialogue_v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const fields = ['scope', 'sessionId', 'companionId', 'callEpoch', 'turnNonce', 'turnId', 'assistantEventId', 'authorityGeneration', 'expectedMemoryRevision', 'playbackEpoch'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const revision = value => value === null || integer(value);
const ids = value => Array.isArray(value) && value.length <= 3000 && value.every(id => typeof id === 'string' && UUID.test(id)) && new Set(value).size === value.length;
const key = value => JSON.stringify(fields.map(field => value?.[field]));
const ownerValid = value => value && typeof value.scope === 'string' && UUID.test(value.sessionId) && UUID.test(value.turnNonce) && UUID.test(value.turnId) && UUID.test(value.assistantEventId) &&
  ['alex', 'mia', 'juno'].includes(value.companionId) && ['callEpoch', 'authorityGeneration', 'playbackEpoch'].every(field => integer(value[field])) && revision(value.expectedMemoryRevision);
const same = (a, b) => ownerValid(a) && ownerValid(b) && key(a) === key(b);
const protocol = AUTHORED_DIALOGUE_PROTOCOL;
const safeFailureCode=(value,fallback)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:fallback;

export async function authoredTextSha256(text, subtle = globalThis.crypto?.subtle) {
  if (typeof text !== 'string' || !subtle?.digest) throw new TypeError('Text digest unavailable.');
  return [...new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function report(value) {
  if (!value || value.protocol !== protocol || !ownerValid(value.owner) || !integer(value.generation) || !UUID.test(value.receiptId) || !ids(value.qualifiedUserEventIds)) throw new TypeError('Invalid authored playback report.');
  return Object.freeze({ protocol, owner: Object.freeze(Object.fromEntries(fields.map(field => [field, value.owner[field]]))), generation: value.generation,
    receiptId: value.receiptId, qualifiedUserEventIds: Object.freeze([...value.qualifiedUserEventIds]) });
}

// The pending immutable report joins the next turn transaction too. A slow
// optional receipt ACK cannot make the next turn forget already played speech.
export function createAuthoredPlaybackDelivery({ getScope, send, storage, maxRequests = 50 } = {}) {
  if (typeof getScope !== 'function' || typeof send !== 'function') throw new TypeError('Playback delivery callbacks required.');
  const memory = new Map(), writes = new Set(), flights = new Map();
  const store = () => storage ??= createLearningOutbox('loop-authored-playback-v1');
  const identity = value => value.owner.scope + '|' + value.receiptId;
  async function pending(scope) {
    await Promise.allSettled([...writes]);
    let durable = [];
    try { durable = (await store().list(scope)).map(row => report(row.body)); } catch { /* Memory remains usable during this call. */ }
    const found = new Map(durable.map(value => [identity(value), value]));
    for (const [id, value] of memory) if (value.owner.scope === scope) {
      const stored=found.get(id);
      if(stored&&JSON.stringify(stored)!==JSON.stringify(value)){memory.delete(id);continue;}
      if(!stored)found.set(id,value);
    }
    return [...found.values()];
  }
  return {
    queue(value) {
      const normalized = report(value), id = identity(normalized), old = memory.get(id);
      if (old && JSON.stringify(old) !== JSON.stringify(normalized)) throw new TypeError('Playback report identity changed.');
      const prior = [...writes];
      const work = Promise.allSettled(prior).then(async () => {
        const settled=memory.get(id);
        if(settled&&JSON.stringify(settled)!==JSON.stringify(normalized))throw new TypeError('Playback report identity changed.');
        let durable;
        try { durable = await store().list(normalized.owner.scope); }
        catch { memory.set(id, normalized); return; } // Optional persistence unavailable; preserve this call's immutable evidence.
        const existing = durable.find(row => row.id === normalized.receiptId);
        if (existing && JSON.stringify(report(existing.body)) !== JSON.stringify(normalized)) throw new TypeError('Playback report identity changed.');
        try {
          await store().put(normalized.owner.scope, { id: normalized.receiptId, kind: 'event',
            created_at: existing?.created_at || new Date().toISOString(), body: normalized });
        } catch(error) {
          // A quota failure need not erase this call's truthful completion. An
          // ambiguous write must first rule out a conflicting durable identity.
          const confirmed=(await store().list(normalized.owner.scope)).find(row=>row.id===normalized.receiptId);
          if(confirmed&&JSON.stringify(report(confirmed.body))!==JSON.stringify(normalized))throw error;
        }
        memory.set(id, normalized);
      }).finally(() => writes.delete(work));
      writes.add(work); return work;
    },
    async pending(scope, authority) {
      return (await pending(scope)).filter(value => value.owner.sessionId === authority.sessionId && value.owner.callEpoch === authority.callEpoch &&
        value.owner.authorityGeneration === authority.authorityGeneration && value.owner.expectedMemoryRevision === authority.memoryRevision);
    },
    flush() {
      const scope = getScope(); if (!scope) return Promise.resolve({ delivered: 0 });
      if (flights.has(scope)) return flights.get(scope);
      const work = (async () => {
        let delivered = 0;
        for (const value of (await pending(scope)).slice(0, maxRequests)) {
          if (getScope() !== scope) break;
          try {
            const ack = await send(value, scope);
            if (getScope() !== scope || ack?.protocol !== protocol || !same(ack.owner, value.owner) || ack.generation !== value.generation || ack.receiptId !== value.receiptId || !(ack.status === 'recorded' && ack.reason === null || ack.status === 'discarded' && ['stale_authority', 'stale_revision', 'cancelled', 'source_changed', 'session_ended', 'source_missing', 'session_missing'].includes(ack.reason))) break;
            memory.delete(identity(value)); try { await store().remove(scope, value.receiptId); } catch { /* An exact duplicate is safe to retry. */ }
            delivered++;
          } catch { break; }
        }
        return { delivered };
      })().finally(() => flights.delete(scope));
      flights.set(scope, work); return work;
    },
  };
}

export function createAuthoredDialogue({ scope, sessionId, companionId, callEpoch, edge, player, playbackDelivery,
  isCurrent = () => true, savedInputs, onTranscript = () => {}, onLifecycle = () => {}, onState = () => {}, onFailure = () => {},
  initialSpeed = .85, onSpeed = () => {}, subtle = globalThis.crypto?.subtle } = {}) {
  if (typeof scope !== 'string' || !UUID.test(sessionId) || !['alex', 'mia', 'juno'].includes(companionId) || !integer(callEpoch) ||
    typeof edge !== 'function' || typeof savedInputs !== 'function' || !player?.prepare || !validSpeed(initialSpeed)) throw new TypeError('Invalid authored dialogue options.');
  let authority = null, current = null, disposed = false, epoch = 0, playbackEpoch = 0, desiredSpeed = initialSpeed, appliedSpeed = initialSpeed;
  const records = new Map();
  const live = () => { try { return !disposed && isCurrent(); } catch { return false; } };
  const active = record => live() && current === record && record.epoch === epoch && !record.terminal && !record.cancelling;
  const emit = (record, kind, extra = {}) => { if (live()) onLifecycle({ kind, turnNonce: record.turnNonce, ...extra }); };
  const speedState = () => ({ applied: appliedSpeed, desired: desiredSpeed, pending: desiredSpeed !== appliedSpeed });
  const publish = () => { if (live()) onState({ pending: Boolean(current && !current.lifecycleDone && !current.terminal), player: player.state, speed: speedState() }); };
  function owns(owner) { return ownerValid(owner) && active(current) && same(current.owner, owner) && authority?.authorityGeneration === owner.authorityGeneration && authority?.memoryRevision === owner.expectedMemoryRevision; }
  function stopLocal(record, reason) {
    if (!record || record.terminal) return;
    record.cancelling = true; record.controller.abort();
    if (record.owner) player.cancel(record.owner, reason); else player.invalidate(reason);
  }
  function failure(record, error) {
    if (!active(record) || record.cancelling) return;
    stopLocal(record, 'authority_revoked'); record.terminal = true;
    const code=safeFailureCode(error?.code,'AUTHORED_DIALOGUE_FAILED');
    emit(record, 'failed', {code}); publish(); onFailure({ code, recoveryNeeded: true });
  }
  async function initialize(omitLearningContext = false, options = {}, reset = false) {
    const requestEpoch = ++epoch;
    const result = await edge('dialogue-context', { protocol, sessionId, callEpoch, omitLearningContext, ...(reset ? {reset:true} : {}) }, options);
    if (!live() || requestEpoch !== epoch) return false;
    if (result?.protocol !== protocol || result.callEpoch !== callEpoch || result.companionId !== companionId || !integer(result.authorityGeneration) || !integer(result.generation) || !revision(result.memoryRevision) || !['included', 'omitted'].includes(result.memoryMode) ||
      omitLearningContext && (result.memoryMode !== 'omitted' || result.memoryRevision !== null)) throw Object.assign(Error('Dialogue authority was not confirmed.'), { code: 'DIALOGUE_AUTHORITY_UNCONFIRMED' });
    authority = { ...result, sessionId, callEpoch }; publish(); return true;
  }
  function create(request) {
    if (!live() || !authority || !UUID.test(request?.turnNonce) || !['startup', 'reply', 'hint'].includes(request.purpose) || records.has(request.turnNonce) || current && !current.lifecycleDone && !current.terminal) throw Error('Dialogue output is unavailable.');
    const record = { turnNonce: request.turnNonce, request, epoch: ++epoch, authority: { ...authority }, controller: new AbortController(),
      playbackEpoch: ++playbackEpoch, owner: null, generation: null, candidates: new Map(), candidateEpochs: new Map(), cancelling: false, terminal: false, lifecycleDone: false, playedThrough: false, resumptions: [], speed: desiredSpeed };
    current = record; records.set(record.turnNonce, record); publish();
    record.flight = (async () => {
      try {
        const source = await savedInputs(request);
        if (!active(record)) return;
        if (!ids(source?.currentUserEventIds) || !ids(source.acceptedHistoryEventIds) || !ids(source.qualifiedUserEventIds) || request.purpose === 'reply' && !source.currentUserEventIds.length) throw Error('Saved caller input was not confirmed.');
        record.qualifiedUserEventIds = [...source.qualifiedUserEventIds];
        const pendingPlaybackReports = await playbackDelivery?.pending(scope, record.authority) || [];
        if (!active(record)) return;
        const body = { protocol, sessionId, callEpoch, authorityGeneration: record.authority.authorityGeneration, turnNonce: record.turnNonce,
          expectedGeneration: record.authority.generation, playbackEpoch: record.playbackEpoch, purpose: request.purpose,
          currentUserEventIds: source.currentUserEventIds, acceptedHistoryEventIds: source.acceptedHistoryEventIds,
          expectedMemoryRevision: record.authority.memoryRevision, omitLearningContext: record.authority.memoryMode === 'omitted', speechSpeed: record.speed,
          ...(request.purpose === 'hint' ? { hint: 'next_sentence' } : {}), ...(pendingPlaybackReports.length ? { pendingPlaybackReports } : {}) };
        const result = await edge('dialogue-turn', body, { signal: record.controller.signal });
        if (!active(record)) return;
        const owner = result?.owner, raw = result?.assistantEvent;
        if (result?.protocol !== protocol || !ownerValid(owner) || owner.scope !== scope || owner.sessionId !== sessionId || owner.companionId !== companionId || owner.callEpoch !== callEpoch ||
          owner.turnNonce !== record.turnNonce || owner.authorityGeneration !== record.authority.authorityGeneration || owner.expectedMemoryRevision !== record.authority.memoryRevision || owner.playbackEpoch !== record.playbackEpoch ||
          !integer(result.generation) || result.generation <= record.authority.generation || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 20000 || !SHA.test(result.textSha256) ||
          !raw || raw.id !== owner.assistantEventId || raw.session_id !== sessionId || raw.speaker !== 'assistant' || raw.text !== result.text || raw.storage !== 'server' || typeof raw.event_key !== 'string' || !Number.isFinite(Date.parse(raw.occurred_at))) throw Error('Dialogue text owner was not confirmed.');
        if (await authoredTextSha256(result.text, subtle) !== result.textSha256 || !active(record)) return failure(record, Error('Dialogue text digest mismatch.'));
        record.owner = Object.freeze({ ...owner }); record.generation = result.generation; record.textSha256 = result.textSha256;
        authority.generation = result.generation;
        onTranscript({ ...raw }, record.owner); emit(record, 'text_ready', { turnId: owner.turnId, itemId: raw.id });
        const audio = await edge('dialogue-synthesis', { protocol, owner: record.owner, generation: record.generation }, { signal: record.controller.signal });
        if (!active(record)) return;
        if (typeof audio?.pcmBase64 !== 'string' || audio.pcmBase64.length > 22369628 || !same(audio.manifest?.owner, record.owner) || audio.manifest.synthesisSpeed !== record.speed) throw Error('Dialogue audio owner was not confirmed.');
        const binary = atob(audio.pcmBase64), bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (!await player.prepare(record.owner, record.textSha256, audio.manifest, bytes.buffer, record.controller.signal) || !active(record)) { if (active(record)) failure(record, Error('Verified dialogue audio was rejected.')); return; }
        for (const decision of record.candidates.values()) player.pauseCandidate(record.owner, decision.candidateId, decision.decisionEpoch);
        if (!active(record)) return;
        appliedSpeed = record.speed; onSpeed(speedState()); player.play(record.owner); publish();
      } catch (error) { failure(record, error); }
    })();
  }
  async function cancel(request) {
    const record = current;
    if (!record || record.turnNonce !== request?.turnNonce || record.terminal || record.lifecycleDone) return false;
    stopLocal(record, request.reason === 'accepted_turn' ? 'accepted_new_turn' : 'explicit_stop');
    try {
      const result = await edge('dialogue-cancel', { protocol, sessionId, callEpoch, authorityGeneration: record.authority.authorityGeneration,
        turnNonce: record.turnNonce, ...(record.generation === null ? {} : { generation: record.generation }), reason: request.reason || 'explicit_stop' });
      if (!live() || current !== record || record.epoch !== epoch) return false;
      if (result?.protocol !== protocol || result.cancelled !== true || result.sessionId !== sessionId || result.callEpoch !== callEpoch || result.authorityGeneration !== record.authority.authorityGeneration || result.turnNonce !== record.turnNonce || !['cancelled', 'already_cancelled', 'stale'].includes(result.status)) throw Error('Dialogue cancellation was not confirmed.');
      if (integer(result.generation) && authority?.authorityGeneration === record.authority.authorityGeneration) authority.generation = Math.max(authority.generation, result.generation);
      record.terminal = true; emit(record, 'terminal'); publish(); return true;
    } catch (error) { if (live() && current === record) { const code=safeFailureCode(error?.code,'DIALOGUE_CANCEL_UNCONFIRMED');emit(record, 'failed', {code});onFailure({code,recoveryNeeded:true}); } return false; }
  }
  return {
    kind: protocol, create, cancel, owns,
    get authority() { return authority && { ...authority }; },
    get state() { return { pending: Boolean(current && !current.lifecycleDone && !current.terminal), player: player.state }; },
    get speed() { return speedState(); },
    initialize,
    async recover(options = {}) {
      this.invalidate('authority_revoked'); current = null;
      return initialize(true, options, true);
    },
    pauseCandidate(decision) {
      const record = current; if (!active(record) || record.turnNonce !== decision.turnNonce || record.lifecycleDone || typeof decision.candidateId !== 'string' || !decision.candidateId || !integer(decision.decisionEpoch) || (record.candidateEpochs.get(decision.candidateId) ?? -1) >= decision.decisionEpoch) return false;
      record.candidateEpochs.set(decision.candidateId, decision.decisionEpoch);
      record.candidates.set(decision.candidateId, { candidateId: decision.candidateId, decisionEpoch: decision.decisionEpoch, kind: 'pending' });
      if (record.owner) player.pauseCandidate(record.owner, decision.candidateId, decision.decisionEpoch); publish(); return true;
    },
    resolveCandidate(decision) {
      const record = current, candidate = record?.candidates.get(decision.candidateId);
      if (!active(record) || record.turnNonce !== decision.turnNonce || candidate?.decisionEpoch !== decision.decisionEpoch) return false;
      candidate.kind = decision.kind;
      if (record.owner) player.resolveCandidate(record.owner, decision);
      if (['rejected_noise', 'rejected_echo'].includes(decision.kind)) record.candidates.delete(decision.candidateId);
      publish(); return true;
    },
    async resume(request) {
      const record = current; if (!active(record) || record.turnNonce !== request.turnNonce || !record.owner) return false;
      record.resumptions = request.decisions || [];
      // The first call enters resumeFromGesture synchronously inside the click.
      const decisions = record.resumptions;
      if (!decisions.length) return player.resumeFromGesture(record.owner);
      for (const decision of decisions) {
        if (!active(record) || record.candidates.get(decision.candidateId)?.decisionEpoch !== decision.decisionEpoch) return false;
        await player.resumeFromGesture(record.owner, decision);
        if (!active(record)) return false;
      }
      publish(); return decisions.every(decision=>!record.candidates.has(decision.candidateId));
    },
    requestSpeed(value) { if (!live() || !validSpeed(value)) return false; desiredSpeed = value; onSpeed(speedState()); publish(); return true; },
    playerEvent(event) {
      const record = records.get(event?.owner?.turnNonce);
      if (!record || !same(event?.owner, record.owner) || !live() || record.terminal || record.cancelling ||
        authority?.authorityGeneration !== record.owner.authorityGeneration || authority?.memoryRevision !== record.owner.expectedMemoryRevision ||
        current !== record && event.kind !== 'played_through') return;
      if (event.kind === 'candidate_dismissed_by_user' && record.candidates.get(event.candidateId)?.decisionEpoch === event.decisionEpoch) {
        record.candidates.delete(event.candidateId);
        emit(record, 'candidate_dismissed', {candidateId:event.candidateId,decisionEpoch:event.decisionEpoch});
      }
      else if (event.kind === 'started') emit(record, 'started');
      else if (event.kind === 'resume_applied') { emit(record, 'resumed', { decisions: record.resumptions }); record.resumptions = []; }
      else if (['blocked', 'context_interrupted', 'continuity_uncertain'].includes(event.kind)) emit(record, event.kind === 'blocked' ? 'blocked' : 'uncertain');
      else if (event.kind === 'played_through' && event.evidence === 'client_reported_playback_completed' && !record.playedThrough) {
        const value = { protocol, owner: record.owner, generation: record.generation, receiptId: record.owner.assistantEventId, qualifiedUserEventIds: record.qualifiedUserEventIds };
        void playbackDelivery?.queue(value)?.catch?.(() => {}); record.lifecycleDone = true; record.playedThrough = true;
        emit(record, 'played_through'); void playbackDelivery?.flush();
      } else if (event.kind === 'estimated_drain' && !record.lifecycleDone) { record.lifecycleDone = true; emit(record, 'estimated_drain'); }
      else if (event.kind === 'terminal') { failure(record, Object.assign(Error('Dialogue playback stopped.'), { code: 'DIALOGUE_PLAYBACK_STOPPED' })); }
      publish();
    },
    invalidate(reason = 'scope_changed') {
      const record = current; stopLocal(record, reason); player.invalidate(reason);
      for (const value of records.values()) value.terminal = true;
      records.clear(); authority = null; ++epoch; publish();
    },
    dispose() { this.invalidate('call_end'); disposed = true; player.dispose(); },
  };
}
