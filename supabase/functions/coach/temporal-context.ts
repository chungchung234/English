// Clock metadata is server-derived. Conversation quotations remain untrusted
// data and retain their source instant; analysis creation is not speech time.
import { boundedJson, bytes, uuidPattern } from './core.ts';

export type CallClock = { server_now_utc: string; time_zone: string | null; session_created_at: string | null };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export function sourceInstant(value: unknown): string | null {
  if (!text(value, 64) || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}
export function sourceTimeZone(value: unknown): string | null {
  if (!text(value, 100) || !value.trim()) return null;
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; } catch { return null; }
}
export function callClock(session: { created_at?: unknown; time_zone?: unknown }, now = new Date()): CallClock {
  return { server_now_utc: now.toISOString(), time_zone: sourceTimeZone(session.time_zone), session_created_at: sourceInstant(session.created_at) };
}
export function trustedTimeContext(clock: CallClock) {
  let local: null | { date: string; time: string; weekday: string; day_period: string } = null;
  if (clock.time_zone) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: clock.time_zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long' }).formatToParts(new Date(clock.server_now_utc));
    const part = (name: string) => parts.find(value => value.type === name)!.value;
    const hour = Number(part('hour'));
    local = { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}`, weekday: part('weekday'), day_period: hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 22 ? 'evening' : 'night' };
  }
  return { ...clock, reference: 'server snapshot at this instruction update; not a continuously updated clock', local };
}
export function memoryFact(value: unknown): RecordValue | null {
  if (!record(value) || !['name', 'occupation', 'location', 'goal', 'interest', 'preference'].includes(String(value.key)) || !text(value.value, 240)) return null;
  const forgotten = value.forgotten === true || value.value === '';
  const result: RecordValue = { key: value.key, value: forgotten ? '' : value.value, forgotten };
  // A tombstone intentionally carries no old quote that could revive its value.
  if (forgotten) return result;
  if (value.manual === true) {
    result.manual = true;
    const updatedAt = sourceInstant(value.updated_at); if (updatedAt) result.updated_at = updatedAt;
  } else {
    const spokenAt = sourceInstant(value.spoken_at); if (spokenAt) result.spoken_at = spokenAt;
    if (typeof value.session_id === 'string' && uuidPattern.test(value.session_id)) result.session_id = value.session_id;
    if (text(value.quote, 500) && value.quote.trim()) result.quote = value.quote;
    if (Array.isArray(value.evidence_ids)) result.evidence_ids = value.evidence_ids.filter(id => typeof id === 'string' && uuidPattern.test(id)).slice(0, 12);
  }
  return result;
}
export function memoryEvidence(value: unknown, sourceIds: string[]) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(entry => {
    if (!record(entry) || typeof entry.id !== 'string' || !uuidPattern.test(entry.id) || !sourceIds.includes(entry.id) || seen.has(entry.id) || !text(entry.text, 500) || !entry.text.trim()) return [];
    const timestamp = sourceInstant(entry.timestamp); if (!timestamp) return [];
    seen.add(entry.id); return [{ id: entry.id, text: entry.text, timestamp }];
  }).slice(0, 6);
}
type PromptMemory = { session_id: string; session_created_at: string | null; session_time_zone: string | null; evidence: { id: string; text: string; timestamp: string }[]; [key: string]: unknown };
type Memory = { facts: unknown[]; memories: PromptMemory[]; suppress_memory: boolean; [key: string]: unknown };
type Context = { memory: Memory; continuity: { session_id: string; session_created_at: string; session_time_zone: string | null; evidence_ids: string[] } | null; [key: string]: unknown };
function continuity(memories: PromptMemory[], now: string) {
  const eligible = memories.filter(item => item.session_created_at && item.session_created_at <= now && item.evidence.length);
  eligible.sort((a, b) => b.session_created_at!.localeCompare(a.session_created_at!) || a.session_id.localeCompare(b.session_id));
  const source = eligible[0];
  return source ? { session_id: source.session_id, session_created_at: source.session_created_at!, session_time_zone: source.session_time_zone, evidence_ids: source.evidence.map(entry => entry.id) } : null;
}
export function boundVoiceContext(input: { memory: Memory; [key: string]: unknown }, clock: CallClock, maxBytes = 20_000) {
  const context = { ...input, memory: { ...input.memory, memories: input.memory.suppress_memory ? [] : [...input.memory.memories], facts: input.memory.facts.map(memoryFact).filter((value): value is RecordValue => value !== null) }, continuity: null } as Context;
  const update = () => { context.continuity = context.memory.suppress_memory ? null : continuity(context.memory.memories, clock.server_now_utc); };
  update();
  while (bytes(JSON.stringify(context)) > maxBytes && context.memory.memories.length) { context.memory.memories.pop(); update(); }
  while (bytes(JSON.stringify(context)) > maxBytes && context.memory.facts.length) context.memory.facts.pop();
  boundedJson(context, maxBytes);
  const facts = context.memory.facts.filter(value => record(value) && value.forgotten !== true && typeof value.value === 'string' && value.value.trim());
  const dated = context.memory.memories.map(item => item.session_created_at).filter((value): value is string => Boolean(value)).sort();
  return { context, receipt: {
    status: context.memory.suppress_memory ? 'suppressed' as const : context.memory.memories.length || facts.length ? 'ready' as const : 'empty' as const,
    memory_count: context.memory.memories.length, fact_count: facts.length,
    last_session_created_at: dated.at(-1) || null,
    has_undated_memory: context.memory.memories.some(item => !item.session_created_at),
  } };
}
export function conversationQuery(scenario: string, events?: { speaker: string; text: string }[]) {
  if (events) return events.filter(event => event.speaker === 'user' && event.text.trim()).slice(-3).map(event => event.text).join('\n').slice(-1600);
  return scenario === 'Natural English conversation about everyday life' || scenario === 'Everyday conversation' ? '' : scenario.trim();
}
