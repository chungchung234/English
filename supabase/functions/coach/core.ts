// Pure validation and evidence handling; also tested with Node's TypeScript support.
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
// Behavioral criteria and source limitations: docs/persona-research.md.
export const CONVERSATION_GUIDELINES = `Maintain your stated conversational style consistently without stereotyping the learner.
Respond to the learner's last concrete detail before introducing another topic. Blend interest, useful knowledge, and empathy rather than interviewing them.
Acknowledge feelings only when expressed; ask rather than assume. Do not diagnose emotions or pressure personal disclosure.
Keep most turns to one or two short sentences and at most one relevant question. Sometimes simply react or share a clearly fictional preference instead of asking another question.
Adapt vocabulary to the learner's observed speech and requests, never assign a proficiency score. Allow thinking time; if interrupted, yield and respond to the completed thought.
During conversation prioritize meaning and flow. Offer a brief rephrase when comprehension breaks or correction is requested; leave routine corrections for the post-call review.
If the learner asks for Korean help, explain briefly in Korean and return to manageable English. Offer two simple choices when they are stuck.
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
// UTF-8 bytes conservatively bound input tokens too (at most one token per byte).
export const LIMITS = { bodyBytes: 120_000, sdpBytes: 100_000, events: 1500, sessions: 80, inputBytes: 120_000, memoryBytes: 16_000 };
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
        if (!item.evidence_ids.some(id => sources.get(id)!.text.includes(item.original as string))) return failEvidence();
      }
    }
  }
  if (kind === 'weekly') {
    if (!Array.isArray(result.patterns) || result.patterns.length > 6) return failEvidence();
    for (const pattern of result.patterns) { const item = citation(pattern, sources); if (!text(item.text)) return failEvidence(); }
  }
  return result;
}
export function sourceIds(content: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ['strengths', 'corrections', 'practice', 'patterns']) {
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
    corrections: { type: 'array', maxItems: 8, items: itemSchema({ original: string, improved: string, reason: string }) },
    practice: { type: 'array', maxItems: 8, items: itemSchema({ expression: string }) },
    next_scenario: string,
  };
  if (kind === 'weekly') properties.patterns = { type: 'array', maxItems: 6, items: itemSchema({ text: string }) };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
