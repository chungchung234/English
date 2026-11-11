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
type Context = { memory: Memory & { conversation_memories: NonNullable<ReturnType<typeof recentConversation>>[] }; continuity: { session_id: string; session_created_at: string; session_time_zone: string | null; evidence_ids: string[] } | null; [key: string]: unknown };
export function recentConversation(value: unknown, now: string) {
  if (!record(value) || typeof value.session_id !== 'string' || !uuidPattern.test(value.session_id) || !Array.isArray(value.turns)) return null;
  const created = sourceInstant(value.session_created_at), ended = sourceInstant(value.session_ended_at);
  if (!created || !ended || created > ended || ended > now) return null;
  const seen = new Set<string>();
  const turns = value.turns.flatMap(entry => {
    if (!record(entry) || typeof entry.id !== 'string' || !uuidPattern.test(entry.id) || seen.has(entry.id) || entry.speaker!=='user' || !text(entry.text,500) || !entry.text.trim()) return [];
    const timestamp = sourceInstant(entry.timestamp); if (!timestamp) return [];
    seen.add(entry.id); return [{id:entry.id,speaker:'user',text:entry.text.slice(0,180),timestamp}];
  }).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id)).slice(0,value.mode==='handoff'?3:2);
  const mode = value.mode==='handoff'?'handoff':value.mode==='analysis_fallback'?'analysis_fallback':'excerpt_fallback';
  const threads = mode==='handoff' && Array.isArray(value.threads) ? value.threads.flatMap(item=>{
    if(!record(item)||!text(item.note,180)||!item.note.trim()||!['stated','planned','resolved','unknown'].includes(String(item.state))
      || !(item.when===null||text(item.when,80)) || !(item.follow_up===null||text(item.follow_up,100))
      || !Array.isArray(item.evidence_ids)||item.evidence_ids.length!==1||!turns.some(turn=>turn.id===(item.evidence_ids as unknown[])[0])) return [];
    return [{note:item.note,state:String(item.state),when:item.when,follow_up:item.follow_up,evidence_ids:item.evidence_ids as string[]}];
  }).slice(0,3):[];
  if(mode==='handoff'&&!threads.length)return null;
  if(mode==='handoff')for(let i=turns.length-1;i>=0;i--)if(!threads.some(thread=>thread.evidence_ids.includes(turns[i].id)))turns.splice(i,1);
  const result = {session_id:value.session_id,session_created_at:created,session_ended_at:ended,session_time_zone:sourceTimeZone(value.session_time_zone),
    analysis_status:['ready','failed','pending','unavailable'].includes(String(value.analysis_status))?String(value.analysis_status):'unavailable',
    mode,summary:mode!=='handoff'&&text(value.summary,1000)?value.summary.slice(0,600):null,threads,turns};
  if(bytes(JSON.stringify(result))>4000)return null;
  return turns.some(turn=>turn.speaker==='user')?result:null;
}
function continuity(memories: PromptMemory[], now: string) {
  const eligible = memories.filter(item => item.session_created_at && item.session_created_at <= now && item.evidence.length);
  eligible.sort((a, b) => b.session_created_at!.localeCompare(a.session_created_at!) || a.session_id.localeCompare(b.session_id));
  const source = eligible[0];
  return source ? { session_id: source.session_id, session_created_at: source.session_created_at!, session_time_zone: source.session_time_zone, evidence_ids: source.evidence.map(entry => entry.id) } : null;
}
export function boundVoiceContext(input: { memory: Memory; [key: string]: unknown }, clock: CallClock, maxBytes = 20_000) {
  const recent = input.memory.suppress_memory ? null : recentConversation(input.memory.recent_conversation,clock.server_now_utc);
  const used=new Set(recent?[recent.session_id]:[]);
  const conversation_memories=input.memory.suppress_memory||!Array.isArray(input.memory.conversation_memories)?[]:input.memory.conversation_memories.flatMap(value=>{
    const bundle=recentConversation(value,clock.server_now_utc);if(!bundle||bundle.mode!=='handoff'||used.has(bundle.session_id))return [];used.add(bundle.session_id);return [bundle];
  }).slice(0,4);
  while(bytes(JSON.stringify({recent,conversation_memories}))>6500&&conversation_memories.length)conversation_memories.pop();
  const replaced=new Set([...(recent?.mode==='handoff'||recent?.mode==='analysis_fallback'?[recent.session_id]:[]),...conversation_memories.map(item=>item.session_id)]);
  const context = { ...input, memory: { ...input.memory, recent_conversation:recent, conversation_memories, memories: input.memory.suppress_memory ? [] : input.memory.memories.filter(item=>!replaced.has(item.session_id)), facts: input.memory.facts.map(memoryFact).filter((value): value is RecordValue => value !== null) }, continuity: null } as Context;
  const update = () => {
    const source=recent??[...context.memory.conversation_memories].sort((a,b)=>b.session_created_at.localeCompare(a.session_created_at))[0];
    context.continuity = context.memory.suppress_memory ? null : source ? {session_id:source.session_id,session_created_at:source.session_created_at,session_time_zone:source.session_time_zone,evidence_ids:source.turns.map(turn=>turn.id)} : continuity(context.memory.memories, clock.server_now_utc);
  };
  update();
  while (bytes(JSON.stringify(context)) > maxBytes && context.memory.memories.length) { context.memory.memories.pop(); update(); }
  while (bytes(JSON.stringify(context)) > maxBytes && context.memory.conversation_memories.length) {context.memory.conversation_memories.pop();update();}
  while (bytes(JSON.stringify(context)) > maxBytes && context.memory.facts.length) context.memory.facts.pop();
  boundedJson(context, maxBytes);
  const facts = context.memory.facts.filter(value => record(value) && value.forgotten !== true && typeof value.value === 'string' && value.value.trim());
  const dated = [...context.memory.memories.map(item => item.session_created_at),...context.memory.conversation_memories.map(item=>item.session_created_at)].filter((value): value is string => Boolean(value)).sort();
  return { context, receipt: {
    status: context.memory.suppress_memory ? 'suppressed' as const : context.memory.memories.length || facts.length || recent || context.memory.conversation_memories.length ? 'ready' as const : 'empty' as const,
    memory_count: context.memory.memories.length, fact_count: facts.length,
    last_session_created_at: [...dated,...(recent?[recent.session_created_at]:[])].sort().at(-1) || null,
    has_undated_memory: context.memory.memories.some(item => !item.session_created_at),
    ...(recent?{recent_session_id:recent.session_id,recent_turn_count:recent.turns.length,recent_analysis_status:recent.analysis_status,recent_mode:recent.mode}:{}),
    ...(context.memory.conversation_memories.length?{conversation_count:context.memory.conversation_memories.length}:{}),
  } };
}
export function conversationQuery(scenario: string, events?: { speaker: string; text: string }[]) {
  if (events) return events.filter(event => event.speaker === 'user' && event.text.trim()).slice(-3).map(event => event.text).join('\n').slice(-1600);
  return scenario === 'Natural English conversation about everyday life' || scenario === 'Everyday conversation' ? '' : scenario.trim();
}
