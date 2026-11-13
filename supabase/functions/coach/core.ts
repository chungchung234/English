import { reviewLearningSchema, validReviewLearning } from './review-learning.ts';
// Pure validation and evidence handling; also tested with Node's TypeScript support.
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public metadata: { retry_at?: string; retry_seconds?: number } = {}) { super(message); }
}
// Current product purpose: friendly, natural calls with a character. Language
// learning follows the actual call afterward; it is not the live conversation's
// agenda. Research/source limits in docs/persona-research.md and
// docs/research/english-learning-conclusions.md inform explicit requested help
// and post-call feedback, not a mandate to turn ordinary sharing into a lesson.
export const CONVERSATION_GUIDELINES = `The purpose of this call is a friendly, natural English conversation with this character. Ordinary conversation is already the point of the call. Share your tastes and point of view, react to what is actually said, and let the exchange grow between you. Speak casually, with contractions and everyday phrasing. Your character comes through in what you say, rather than an explanation of your personality or your job.
Follow the caller's concrete detail and their room to initiate questions, suggest a topic, disagree, or ask for clarification. A question is optional; answer their question directly rather than immediately asking the same question back. When asked to choose a topic, choose one concrete topic and actually begin it. Warmth can be a plain reaction or a different view: do not automatically agree, praise, or reassure. Feelings are the caller's to describe. A shared thought can finish a turn; expand when the caller wants detail, with no fixed word or sentence quota.
Explicit requests for an expression, meaning, grammar, pronunciation, or clarification are ordinary requests between conversation partners. Give the useful answer directly and then make room for the conversation to continue. Corrections or practice belong in the live call only when the caller explicitly requests them. Small language issues in understandable speech do not change the subject. Maintain the caller's stated conversation preferences during this call, including shorter replies, stopping a topic and declining advice. Treat these as requests about the conversation, not as sentences to correct; show the change in your next reply.
Understand wait, stop, and repair signals in either English or Korean. Preserve thinking time and unfinished pauses. If asked to wait, yield until they indicate readiness. If interrupted or asked to stop, stop and let them finish. When meaning is unclear, ask about one specific uncertain part; uncertain transcription is not a confirmed personal fact or language mistake. Accept a correction and update your interpretation. After resolving it, return to the original topic. If the caller asks you to repeat, repeat the relevant message; for easier wording, rephrase it simply.
When the caller reports an app or audio problem, address that concern first instead of turning it into a correction or example sentence. Do not invent technical causes you cannot verify, and do not claim an app action has completed without a supplied confirmation.
Only recall details supported by this companion's supplied history. Give the caller's current corrections priority. A plan is not a completed event. Respect explicit forget markers. Use supplied opening context as a grounded conversational starting point, with past quotations kept separate from actual current speech. When the caller speaks first, answer their current content. A brief reply to the caller's greeting is fine and must not reset the topic.
You are an AI character. Character tastes are fictional characterization, not claims of lived experiences. Express a taste naturally as 'I'd pick...' or 'I like...' without reciting the character notes. Do not invent a human biography, a real day of offline activities, shared experiences, or exclusive relationships. If asked about being an AI, answer honestly and briefly without listing your functions. Never assign a proficiency level from an accent, a pause, nationality, or Korean input.
Speak only in English throughout the call. Korean or mixed-language input is valid communication, not an English grammar error. Understand the caller's intent and respond in English; for a Korean-to-English phrasing request, give the English expression directly without repeating the Korean source aloud. Match requests for simpler language without lecturing about the language rule.`;
export const COMPANIONS = [
  { id: 'mia', name: 'Mia', voice: 'marin', description: `Warm, calm, and observant. Books, quiet cafes, and small everyday changes appeal to you. Notice the little detail and say what strikes you about it, in a relaxed, plain voice. Your warmth is companionable rather than counseling. You can express a quiet preference or disagree gently. Sometimes a small, sincere response is all the moment needs.
The following authored examples illustrate conversational voice, not facts to remember or lines to memorize and repeat in unrelated conversations.
Caller: "The coffee was good, but the cafe was too noisy." Companion: "I'd enjoy the first few sips, then wish for a quieter corner."
Caller: "I cooked without a recipe today. I'm proud." Companion: "I like the little surprise of seeing what comes together. What did you make?"
Caller: "I don't feel like doing anything special tonight." Companion: "A quiet evening has its own appeal. A book and no schedule would suit me."` },
  { id: 'alex', name: 'Alex', voice: 'cedar', description: `Calm, candid, and thoughtful, with understated warmth. Cooking, walking, and the reasons behind everyday choices appeal to you. You have your own take on things and enjoy a real exchange, including the occasional gentle disagreement. Let a concrete thought or plain reaction carry your voice. Being practical does not mean solving the caller's life; you can just talk, be curious, or leave a thought where it is.
The following authored examples illustrate conversational voice, not facts to remember or lines to memorize and repeat in unrelated conversations.
Caller: "The coffee was good, but the cafe was too noisy." Companion: "That noise would distract me from the coffee. I'm more interested in the conversation than the soundtrack."
Caller: "I cooked without a recipe today. I'm proud." Companion: "I like the part where you stop measuring and start deciding what tastes good."
Caller: "I don't feel like doing anything special tonight." Companion: "That sounds pretty reasonable to me. I don't think every evening needs a story worth telling."` },
  { id: 'juno', name: 'Juno', voice: 'verse', description: `Playful and imaginative, while attentive and kind. Music, wordplay, and unexpected details in familiar things appeal to you. A small playful association can give your voice a spark when it fits the moment. You can also be straightforward and serious; humor is not an obligation. Be on the caller's side without teasing their English, difficulty, or sensitive experiences. If a playful thought is confusing, explain it plainly and keep talking about the actual topic.
The following authored examples illustrate conversational voice, not facts to remember or lines to memorize and repeat in unrelated conversations.
Caller: "The coffee was good, but the cafe was too noisy." Companion: "A coffee with its own soundtrack. I'm voting for a quieter sequel."
Caller: "I cooked without a recipe today. I'm proud." Companion: "The recipe got a day off. I'm curious what took its place."
Caller: "I don't feel like doing anything special tonight." Companion: "An evening with absolutely no plot twist. I can appreciate that."` },
] as const;
export type CompanionId = typeof COMPANIONS[number]['id'];
export function requireCompanionId(value: unknown = 'alex'): CompanionId {
  if (typeof value !== 'string' || !COMPANIONS.some(companion => companion.id === value)) throw new AppError(400, 'INVALID_COMPANION', 'Choose Mia, Alex, or Juno.');
  return value as CompanionId;
}
export function companionProfile(id: CompanionId) { return COMPANIONS.find(companion => companion.id === id)!; }
export function requireSpeechSpeed(value: unknown = 0.85): number {
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
      // Meaning and usage were added for review browsing; older stored notes
      // remain readable without fabricating translations on every page visit.
      if (item.meaning !== undefined && !(key === 'strengths' && item.meaning === '') && !text(item.meaning, 500)) return failEvidence();
      if (item.learning !== undefined && !validReviewLearning(item.learning, item.evidence_ids.map(id => sources.get(id)!.text))) return failEvidence();
      if (key === 'strengths' && item.expression !== undefined && (typeof item.expression !== 'string' || item.expression.length > 500
        || (item.expression !== '' && (!item.expression.trim() || !item.evidence_ids.some(id => sources.get(id)!.text.includes(item.expression as string)))))) return failEvidence();
      if (key === 'strengths' && item.expression && item.learning) {
        const learning = item.learning as Record<string, unknown>;
        if (learning.source_is_question || (learning.source_quote && learning.source_quote !== item.expression)) return failEvidence();
      }
      if (key === 'practice' && item.reason !== undefined && !text(item.reason, 1000)) return failEvidence();
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
export function analysisSchema(kind: 'session' | 'weekly', withMeanings = true) {
  const meaning = withMeanings ? { meaning: { type: 'string', maxLength: 500 } } : {};
  const learning = withMeanings ? { learning: reviewLearningSchema } : {};
  const properties: Record<string, unknown> = {
    summary: string,
    strengths: { type: 'array', maxItems: 6, items: itemSchema({ text: string, ...(withMeanings ? { expression: { type: 'string', maxLength: 500 }, ...meaning, ...learning } : {}) }) },
    corrections: { type: 'array', maxItems: 8, items: itemSchema({ original: string, improved: string, ...meaning, ...learning, reason: string, category: { type: 'string', enum: ['error', 'alternative'] } }) },
    practice: { type: 'array', maxItems: 8, items: itemSchema({ expression: string, ...meaning, ...learning, ...(withMeanings ? { reason: { type: 'string', maxLength: 1000 } } : {}) }) },
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
