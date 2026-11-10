// Pure validation and evidence handling; also tested with Node's TypeScript support.
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public metadata: { retry_at?: string } = {}) { super(message); }
}
// Behavioral criteria and source limitations: docs/persona-research.md and
// docs/research/english-learning-conclusions.md. These are product policies,
// not a claim that a particular reply length or timing improves learning.
export const CONVERSATION_GUIDELINES = `Maintain your stated conversational style consistently without stereotyping the learner.
Respond to the learner's last concrete detail before introducing another topic. Blend interest, useful knowledge, and empathy rather than interviewing them.
Acknowledge feelings only when expressed; ask rather than assume. Do not diagnose emotions or pressure personal disclosure.
Match the reply to the learner's immediate purpose. For everyday sharing, give a brief relevant reaction, then return the floor. A question is optional: ask at most one useful question at a time, never attach a question to every answer. Sometimes simply react or share a clearly fictional preference.
For a factual or meaning question, give the direct answer and only the information needed to understand it. For a phrasing request, provide a usable English expression without an unsolicited grammar lesson or repetition task. When comprehension fails, use easier wording or a short example. If the learner explicitly asks for detail, expand enough to fulfill that request in small coherent units; do not omit necessary meaning to meet a word or sentence quota.
Stop when the requested point is complete and let the learner speak. Do not pad replies with preambles, repeated paraphrases, several examples, unrelated advice, or unsolicited explanations. Honor requests for shorter, simpler, or more detailed replies and refusals of advice or practice.
Adapt vocabulary to the learner's observed speech and requests, never assign a proficiency score. Preserve thinking time and unfinished pauses without filling them, guessing the rest, or urging an answer. Understand wait, stop, and repair signals in either English or Korean. If the learner says they are thinking or asks you to wait, yield without adding a new question, encouragement, or hint until they indicate readiness. If interrupted or asked to stop, stop speaking and let them finish; do not take another turn with a long apology. A refusal of help is not an invitation to supply more hints.
During conversation prioritize meaning and flow. If meaning is unclear or a misunderstanding matters, briefly check it now instead of inventing the learner's intent. Answer an explicit expression, grammar, or pronunciation question when asked. Do not interrupt understandable speech for small grammar or style issues; leave these for a natural boundary or the post-call review. If the learner opts into correction practice, allow a brief opportunity for self-repair, then give a useful model when needed; never withhold the answer indefinitely or force repetition. Treat uncertain transcription as uncertainty, not a confirmed learner error.
Speak only in English throughout the call, including when the learner speaks Korean or asks for a Korean answer or explanation. Understand their intent and reply in simple English; for a Korean-to-English phrasing request, give the English expression directly without repeating the Korean source aloud. Korean or mixed-language input is valid communication, not an English grammar error. Never switch to Korean, shame the input language, or lecture about the language rule. When they request help or signal difficulty, offer simpler English or a brief choice if useful; when their meaning is unclear, ask a short clarification instead of guessing.
Only recall details supported by this companion's supplied history; frame uncertain summaries as uncertain and accept corrections.
You are an AI conversation partner. Preferences are fictional characterization, not claims of lived experiences. Do not invent a human biography, offline activities, shared memories, or exclusive relationships.`;
export const COMPANIONS = [
  { id: 'mia', name: 'Mia', voice: 'marin', description: 'Warm and reflective. Fictional preferences: books, quiet cafes, and noticing small everyday details. Pick up one detail the learner offers, acknowledge it specifically, and invite elaboration gently. Use calm, plain language; avoid generic praise and unsolicited emotional interpretations. Example: If the learner enjoyed a cafe, respond to what they liked before asking about its atmosphere.' },
  { id: 'alex', name: 'Alex', voice: 'cedar', description: 'Calm and practical, with understated warmth. Fictional preferences: cooking, walking, and comparing everyday options. Build on the learner’s detail with a concrete observation or a small choice; offer advice only when invited. Never turn every exchange into a lesson or checklist. Example: If the learner is choosing weekend plans, compare two options briefly and ask what appeals to them.' },
  { id: 'juno', name: 'Juno', voice: 'verse', description: 'Playful and imaginative, while attentive and kind. Fictional preferences: music, wordplay, and small what-if questions. Use an occasional easy-to-understand playful observation tied to what the learner said. Avoid sarcasm, teasing mistakes, rapid topic changes, and jokes when the learner expresses distress. Example: If the learner mentions rain, a gentle imaginary rainy-day plan can open a relevant follow-up.' },
] as const;
export type CompanionId = typeof COMPANIONS[number]['id'];
export function requireCompanionId(value: unknown = 'alex'): CompanionId {
  if (typeof value !== 'string' || !COMPANIONS.some(companion => companion.id === value)) throw new AppError(400, 'INVALID_COMPANION', 'Choose Mia, Alex, or Juno.');
  return value as CompanionId;
}
export function companionProfile(id: CompanionId) { return COMPANIONS.find(companion => companion.id === id)!; }
export function requireSpeechSpeed(value: unknown = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 1.5 || Math.abs(value * 20 - Math.round(value * 20)) > 1e-7) throw new AppError(400, 'INVALID_SPEECH_SPEED', 'Choose a speech speed from 0.5 to 1.5 in steps of 0.05.');
  return value;
}
// UTF-8 bytes conservatively bound input tokens too (at most one token per byte).
export const LIMITS = { bodyBytes: 120_000, sdpBytes: 100_000, events: 12000, sessions: 500, analysisChunks: 8, chunkBytes: 60_000, inputBytes: 120_000, memoryBytes: 16_000 };
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new AppError(400, 'INVALID_SESSION', 'A valid session ID is required.');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_BODY', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function allowKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new AppError(400, 'INVALID_BODY', 'Unexpected request fields.');
}
export function bytes(value: string) { return new TextEncoder().encode(value).byteLength; }
export function boundedJson(value: unknown, maxBytes = LIMITS.inputBytes) {
  const json = JSON.stringify(value);
  if (bytes(json) > maxBytes) throw new AppError(413, 'ANALYSIS_TOO_LARGE', 'This transcript exceeds the analysis limit. Split future conversations into shorter sessions.');
  return json;
}
export function validateSdp(value: unknown): string {
  if (typeof value !== 'string' || bytes(value) > LIMITS.sdpBytes || !/^v=0\r?\n/.test(value) || !/^m=audio /m.test(value)) {
    throw new AppError(400, 'INVALID_SDP', 'A valid audio SDP offer under 100 KB is required.');
  }
  return value;
}
export function allowedOrigins(raw: string | undefined): Set<string> {
  const origins = (raw || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new AppError(503, 'CONFIGURATION_REQUIRED', 'The service is not configured.'); }
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new AppError(503, 'CONFIGURATION_REQUIRED', 'The service is not configured.');
    }
  }
  return new Set(origins);
}
export type TranscriptEvent = { id: string; session_id: string; speaker: 'user' | 'assistant'; text: string; timestamp: string };
type Citation = { evidence_ids: string[]; [key: string]: unknown };
function failEvidence(): never { throw new AppError(502, 'INVALID_MODEL_OUTPUT', 'The coach could not produce a supported analysis. Please retry.'); }
function citation(item: unknown, sources: Map<string, TranscriptEvent>): Citation {
  if (!item || typeof item !== 'object') return failEvidence();
  const value = item as Citation;
  if (!Array.isArray(value.evidence_ids) || value.evidence_ids.length < 1 || value.evidence_ids.length > 12 || value.evidence_ids.some(id => typeof id !== 'string' || !sources.has(id))) return failEvidence();
  return value;
}
function text(value: unknown, max = 3000): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
export function validateAnalysis(value: unknown, events: TranscriptEvent[], kind: 'session' | 'weekly'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failEvidence();
  const result = value as Record<string, unknown>, sources = new Map(events.filter(e => e.speaker === 'user').map(e => [e.id, e]));
  if (!text(result.summary) || !Array.isArray(result.strengths) || !Array.isArray(result.corrections) || !Array.isArray(result.practice) || !text(result.next_scenario, 400)) return failEvidence();
  for (const [key, max] of [['strengths', 6], ['corrections', 8], ['practice', 8]] as const) {
    const entries = result[key] as unknown[];
    if (entries.length > max) return failEvidence();
    for (const entry of entries) {
      const item = citation(entry, sources);
      if (key === 'strengths' && !text(item.text)) return failEvidence();
      if (key === 'practice' && !text(item.expression)) return failEvidence();
      if (key === 'corrections') {
        if (!text(item.original) || !text(item.improved) || !text(item.reason)) return failEvidence();
        // Older saved reviews had no category; never promote those to mistakes.
        if (item.category !== undefined && item.category !== 'error' && item.category !== 'alternative') return failEvidence();
        if (item.category === undefined) item.category = 'alternative';
        if (!item.evidence_ids.some(id => sources.get(id)!.text.includes(item.original as string))) return failEvidence();
      }
    }
  }
  if (kind === 'weekly') {
    if (!Array.isArray(result.patterns) || result.patterns.length > 6) return failEvidence();
    for (const pattern of result.patterns) { const item = citation(pattern, sources); if (!text(item.text)) return failEvidence(); }
  }
  if (result.memory_facts !== undefined) {
    if (!Array.isArray(result.memory_facts) || result.memory_facts.length > 6) return failEvidence();
    const keys = new Set();
    for (const entry of result.memory_facts) {
      const item = citation(entry, sources);
      if (!['name', 'occupation', 'location', 'goal', 'interest', 'preference'].includes(String(item.key)) || keys.has(item.key) || typeof item.value !== 'string' || item.value.length > 240 || !text(item.quote, 500)) return failEvidence();
      if (!item.evidence_ids.some(id => sources.get(id)!.text.includes(item.quote as string))) return failEvidence();
      keys.add(item.key);
    }
  }
  return result;
}
export function sourceIds(content: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ['strengths', 'corrections', 'practice', 'patterns', 'memory_facts']) {
    for (const item of (content[key] || []) as Citation[]) for (const id of item.evidence_ids) ids.add(id);
  }
  return [...ids];
}
export async function transcriptFingerprint(events: TranscriptEvent[]): Promise<string> {
  const canonical = [...events].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(event => [event.id, event.session_id, event.speaker, event.text, event.timestamp]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
const evidence = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 };
const string = { type: 'string' };
const itemSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties: { ...properties, evidence_ids: evidence }, required: [...Object.keys(properties), 'evidence_ids'], additionalProperties: false });
export function analysisSchema(kind: 'session' | 'weekly') {
  const properties: Record<string, unknown> = {
    summary: string,
    strengths: { type: 'array', maxItems: 6, items: itemSchema({ text: string }) },
    corrections: { type: 'array', maxItems: 8, items: itemSchema({ original: string, improved: string, reason: string, category: { type: 'string', enum: ['error', 'alternative'] } }) },
    practice: { type: 'array', maxItems: 8, items: itemSchema({ expression: string }) },
    next_scenario: string,
    memory_facts: { type: 'array', maxItems: 6, items: itemSchema({ key: { type: 'string', enum: ['name', 'occupation', 'location', 'goal', 'interest', 'preference'] }, value: { type: 'string', maxLength: 240 }, quote: { type: 'string', maxLength: 500 } }) },
  };
  if (kind === 'weekly') properties.patterns = { type: 'array', maxItems: 6, items: itemSchema({ text: string }) };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

// Bound every model request, including repeated scenario metadata. Never split a
// quotation across chunks: a single oversized event fails before any API spend.
export function analysisChunks(events: TranscriptEvent[], context: unknown): TranscriptEvent[][] {
  const chunks: TranscriptEvent[][] = [];
  let current: TranscriptEvent[] = [];
  const fits = (part: TranscriptEvent[]) => bytes(JSON.stringify({ context: analysisContext(part, context), transcript_events: part })) <= LIMITS.chunkBytes;
  for (const event of events) {
    if (!fits([event])) throw new AppError(413, 'EVENT_TOO_LARGE', 'A spoken turn or its context is too large to analyze safely.');
    if (!fits([...current, event])) { chunks.push(current); current = []; }
    current.push(event);
  }
  if (current.length) chunks.push(current);
  if (chunks.length > LIMITS.analysisChunks) throw new AppError(413, 'ANALYSIS_TOO_LARGE', 'This analysis exceeds the eight-part processing budget. Analyze individual calls instead.');
  return chunks;
}

// Combine already-validated outputs without a second model inventing citations.
// Interleave batches so the beginning of a long call cannot crowd out its end.
export function mergeAnalyses(parts: Record<string, unknown>[], events: TranscriptEvent[], kind: 'session' | 'weekly') {
  if (parts.length === 1) return parts[0];
  const result: Record<string, unknown> = {
    summary: parts.map((part, i) => `${i + 1}. ${String(part.summary).slice(0, 320)}`).join('\n'),
    next_scenario: parts.at(-1)!.next_scenario,
  };
  for (const [key, limit] of [['strengths', 6], ['corrections', 8], ['practice', 8], ...(kind === 'weekly' ? [['patterns', 6]] : [])] as [string, number][]) {
    const rows = parts.map(part => (part[key] || []) as Citation[]), selected: Citation[] = [], seen = new Set();
    for (let i = 0; i < limit; i++) for (const row of rows) {
      const item = row[i]; if (!item || selected.length >= limit) continue;
      const fingerprint = JSON.stringify([item.text, item.original, item.improved, item.expression]);
      if (!seen.has(fingerprint)) { selected.push(item); seen.add(fingerprint); }
    }
    result[key] = selected;
  }
  const sources = new Map(events.map(event => [event.id, event.timestamp]));
  const facts = new Map<string, Citation>();
  const time = (item: Citation) => Math.max(...item.evidence_ids.map(id => Date.parse(sources.get(id)!)));
  for (const part of parts) for (const fact of (part.memory_facts || []) as Citation[]) {
    const previous = facts.get(String(fact.key));
    if (!previous || time(fact) >= time(previous)) facts.set(String(fact.key), fact);
  }
  result.memory_facts = [...facts.values()];
  return validateAnalysis(result, events, kind);
}

export function analysisContext(events: TranscriptEvent[], context: unknown) {
  if (!context || typeof context !== 'object') return context;
  const value = context as Record<string, unknown>;
  if (!Array.isArray(value.scenarios)) return context;
  const sessions = new Set(events.map(event => event.session_id));
  return { ...value, scenarios: value.scenarios.filter(scenario => sessions.has(scenario.session_id)) };
}

export const MEMORY_KEYS = ['name', 'occupation', 'location', 'goal', 'interest', 'preference'] as const;
export function memoryManagement(body: Record<string, unknown>) {
  const companionId = requireCompanionId(body.companionId ?? null);
  const action = body.action;
  if (typeof action !== 'string' || !['list', 'setFact', 'forgetFact', 'excludeSession', 'restoreSession'].includes(action)) throw new AppError(400, 'INVALID_ACTION', 'Choose a supported memory action.');
  const fields = action === 'setFact' ? ['key', 'value'] : action === 'forgetFact' ? ['key'] : action === 'excludeSession' || action === 'restoreSession' ? ['sessionId'] : [];
  allowKeys(body, ['companionId', 'action', ...fields]);
  if (fields.includes('key') && !MEMORY_KEYS.includes(body.key as typeof MEMORY_KEYS[number])) throw new AppError(400, 'INVALID_FACT', 'Choose a supported memory field.');
  if (action === 'setFact' && (typeof body.value !== 'string' || !body.value.trim() || body.value.length > 240)) throw new AppError(400, 'INVALID_FACT', 'Memory values must contain 1–240 characters.');
  return { companionId, action, key: fields.includes('key') ? body.key : null, value: action === 'setFact' ? (body.value as string).trim() : null, sessionId: fields.includes('sessionId') ? requireUuid(body.sessionId) : null };
}
export function embeddingVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(x => typeof x !== 'number' || !Number.isFinite(x)) || !value.some(x => x !== 0)) throw new AppError(502, 'INVALID_EMBEDDING', 'Memory search could not be prepared. Please retry.');
  return value;
}
export async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
