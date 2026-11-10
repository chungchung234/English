import { AppError, boundedJson, bytes, requireCompanionId, uuidPattern, type CompanionId, type TranscriptEvent } from './core.ts';

const contextError = () => new AppError(503, 'LEARNING_CONTEXT_UNAVAILABLE', 'Learning evidence could not be verified. Please retry.');
const outputError = () => new AppError(502, 'INVALID_MODEL_OUTPUT', 'The proposal could not be verified. Please retry.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= max;
const version = (value: unknown): value is string => text(value, 200);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
function events(value: unknown, sessionId?: string, userOnly = false): TranscriptEvent[] {
  if (!Array.isArray(value) || value.length > 12000) throw contextError();
  const seen = new Set<string>();
  const result = value.map(entry => {
    if (!record(entry) || !uuid(entry.id) || seen.has(entry.id) || !uuid(entry.session_id) || (sessionId && entry.session_id !== sessionId) || !['user', 'assistant'].includes(String(entry.speaker)) || (userOnly && entry.speaker !== 'user') || !text(entry.text, 60000) || !text(entry.timestamp, 60) || !Number.isFinite(Date.parse(entry.timestamp))) throw contextError();
    seen.add(entry.id);
    return { id: entry.id, session_id: entry.session_id, speaker: entry.speaker, text: entry.text, timestamp: entry.timestamp } as TranscriptEvent;
  });
  boundedJson(result, 60000);
  return result;
}
export type ReviewContext = {
  review: { id: string; item_id: string; source_analysis_id: string; source_session_id: string; source_version: string; explanation: string; revision: number; status: string; proposal?: unknown };
  expression: string; original: string; evidence: TranscriptEvent[]; companion_id: CompanionId;
};
export function reconsiderContext(value: unknown, requestId: string): ReviewContext {
  if (!record(value) || !record(value.review)) throw contextError();
  const request = value.review;
  if (request.id !== requestId || !uuid(request.id) || !uuid(request.item_id) || !uuid(request.source_analysis_id) || !uuid(request.source_session_id) || !version(request.source_version) || !text(request.explanation, 4000) || !revision(request.revision) || !text(value.expression, 3000) || !text(value.original, 3000, true)) throw contextError();
  const status = request.status ?? request.state;
  if (typeof status !== 'string') throw contextError();
  if (!['pending', 'proposed'].includes(String(status))) throw new AppError(409, 'REVIEW_NOT_PENDING', 'This reconsideration is no longer pending.');
  const evidence = events(value.evidence, request.source_session_id, true);
  if (!evidence.length || evidence.length > 12) throw contextError();
  if (value.original && !evidence.some(event => event.text.includes(value.original as string))) throw contextError();
  const result: ReviewContext = { review: { id: request.id, item_id: request.item_id, source_analysis_id: request.source_analysis_id, source_session_id: request.source_session_id, source_version: request.source_version, explanation: request.explanation, revision: request.revision as number, status: String(status), ...(request.proposal === undefined ? {} : { proposal: request.proposal }) }, expression: value.expression, original: value.original, evidence, companion_id: requireCompanionId(value.companion_id) };
  boundedJson(result, 65000);
  return result;
}
export type ReconsiderProposal = { expression: string; reason: string; category: 'error' | 'alternative'; evidence_ids: string[] };
export const reconsiderSchema = {
  type: 'object', additionalProperties: false,
  properties: { expression: { type: 'string', minLength: 1, maxLength: 500 }, reason: { type: 'string', minLength: 1, maxLength: 1500 }, category: { type: 'string', enum: ['error', 'alternative'] }, evidence_ids: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } } },
  required: ['expression', 'reason', 'category', 'evidence_ids'],
};
export function validateReconsiderProposal(value: unknown, context: ReviewContext): ReconsiderProposal {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'category,evidence_ids,expression,reason' || !text(value.expression, 500) || !text(value.reason, 1500) || !['error', 'alternative'].includes(String(value.category)) || !Array.isArray(value.evidence_ids) || !value.evidence_ids.length || value.evidence_ids.length > 12) throw outputError();
  const allowed = new Set(context.evidence.filter(event => event.speaker === 'user').map(event => event.id));
  if (value.evidence_ids.some(id => !uuid(id) || !allowed.has(id)) || new Set(value.evidence_ids).size !== value.evidence_ids.length) throw outputError();
  return { expression: value.expression, reason: value.reason, category: value.category as ReconsiderProposal['category'], evidence_ids: value.evidence_ids as string[] };
}
export type UsageTarget = { id: string; item_id: string; expression: string; source_version: string; source_session_id: string; source_analysis_id: string };
export type UsageContext = { targets: UsageTarget[]; source_version: string; events?: TranscriptEvent[] };
export function usageContext(value: unknown, sessionId: string, withEvents: boolean): UsageContext {
  if (!record(value) || !version(value.source_version) || !Array.isArray(value.targets) || value.targets.length > 1) throw contextError();
  const targets = value.targets.map(entry => {
    if (!record(entry) || !uuid(entry.id) || !uuid(entry.item_id) || !text(entry.expression, 500) || bytes(entry.expression) > 2000 || !version(entry.source_version) || !uuid(entry.source_session_id) || !uuid(entry.source_analysis_id) || entry.source_session_id === sessionId) throw contextError();
    return { id: entry.id, item_id: entry.item_id, expression: entry.expression, source_version: entry.source_version, source_session_id: entry.source_session_id, source_analysis_id: entry.source_analysis_id } as UsageTarget;
  });
  return { targets, source_version: value.source_version, ...(withEvents ? { events: events(value.events, sessionId) } : {}) };
}
export type UsageObservation = { kind: 'observed' | 'undetermined'; evidence_ids: string[]; mode: 'undetermined'; mode_evidence_ids: string[] };
// Phrase presence is an observation only. Text alone cannot prove an opportunity,
// unprompted use, an effective hint, a new context, or learning/mastery.
export function observationalUsage(transcript: TranscriptEvent[], target: Pick<UsageTarget, 'expression'>): UsageObservation {
  if (!text(target.expression, 500) || bytes(target.expression) > 2000) throw contextError();
  const normalize = (value: string) => value.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
  const needle = normalize(target.expression);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode letter/number guards prevent a short expression matching word parts.
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
  const ids = transcript.filter(event => event.speaker === 'user' && match.test(normalize(event.text))).slice(0, 12).map(event => event.id);
  return { kind: ids.length ? 'observed' : 'undetermined', evidence_ids: ids, mode: 'undetermined', mode_evidence_ids: [] };
}
