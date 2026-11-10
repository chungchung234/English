import { AppError, boundedJson, bytes, uuidPattern, type CompanionId, type TranscriptEvent } from './core.ts';

type SourceItem = { id: string; expression: string; source_session_id: string; source_analysis_id: string; evidence_ids: string[]; source_version: string };
type Recall = { id: string; item_id: string; rating: 'hard' | 'assisted' | 'independent'; occurred_at: string; kind: 'delayed' };
type Usage = { id: string; item_id: string; session_id: string; evidence_ids: string[]; mode_evidence_ids: string[]; kind: 'observed' | 'undetermined'; mode: 'undetermined' | 'repetition' | 'after_hint' | 'new_context'; review_status: 'confirmed'; source_version: string; created_at: string };
export type WeeklyScope = { companionId: CompanionId; period_start: string; period_end: string; generated_at: string };
const invalid = (): never => { throw new AppError(503, 'LEARNING_PLAN_UNAVAILABLE', 'Weekly learning evidence could not be verified.'); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const id = (value: unknown): string => typeof value === 'string' && uuidPattern.test(value) ? value : invalid();
const version = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value : invalid();
const date = (value: unknown): number => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : invalid();
function ids(value: unknown, min = 0): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > 12) return invalid();
  const result = value.map(id);
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function rows(value: unknown, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value.map(record);
}
function unique<T extends { id: string }>(values: T[]): T[] {
  if (new Set(values.map(value => value.id)).size !== values.length) return invalid();
  return values;
}

// This is an action proposal, not a learner assessment. The database supplies
// only currently valid, privacy-eligible sources; the exact requested transcript
// and period provide a second boundary before any source can inform a proposal.
export function weeklyLearningPlan(raw: unknown, events: TranscriptEvent[], scope: WeeklyScope) {
  const start = date(scope.period_start), end = date(scope.period_end), generated = date(scope.generated_at);
  if (end - start !== 168 * 60 * 60 * 1000 || generated < end || !['alex', 'mia', 'juno'].includes(scope.companionId)) return invalid();
  const value = record(raw);
  boundedJson(value, 120_000);
  const sources = new Map<string, TranscriptEvent>();
  for (const event of events) {
    if (sources.has(event.id) || !uuidPattern.test(event.id) || !uuidPattern.test(event.session_id) || !['user', 'assistant'].includes(event.speaker)) return invalid();
    date(event.timestamp);
    sources.set(event.id, event);
  }
  const inPeriod = (time: string) => date(time) >= start && date(time) <= end;
  const items = unique(rows(value.items, 500).map((row): SourceItem => {
    if (typeof row.expression !== 'string' || !row.expression.trim() || row.expression.length > 3000 || bytes(row.expression) > 12_000) return invalid();
    const item = { id: id(row.id), expression: row.expression, source_session_id: id(row.source_session_id), source_analysis_id: id(row.source_analysis_id), evidence_ids: ids(row.evidence_ids, 1), source_version: version(row.source_version) };
    // Missing or mismatched source IDs are a malformed service contract. A
    // legitimate source turn outside this requested 168-hour period is simply
    // ineligible, even when its call ended during the period.
    if (item.evidence_ids.some(eventId => sources.get(eventId)?.speaker !== 'user' || sources.get(eventId)?.session_id !== item.source_session_id)) return invalid();
    return item;
  })).filter(item => item.expression.length <= 500 && bytes(item.expression) <= 2000 && item.evidence_ids.every(eventId => inPeriod(sources.get(eventId)!.timestamp)));
  const itemIds = new Set(items.map(item => item.id));
  const itemSources = new Map(items.map(item => [item.id, item]));
  const recalls = unique(rows(value.recalls, 2000).map((row): Recall => {
    if (row.kind !== 'delayed' || !['hard', 'assisted', 'independent'].includes(String(row.rating)) || !inPeriod(String(row.occurred_at))) return invalid();
    return { id: id(row.id), item_id: id(row.item_id), rating: row.rating as Recall['rating'], occurred_at: String(row.occurred_at), kind: 'delayed' };
  })).filter(recall => itemIds.has(recall.item_id));
  const usage = unique(rows(value.usage, 2000).map((row): Usage => {
    if (row.review_status !== 'confirmed' || !['observed', 'undetermined'].includes(String(row.kind)) || !['undetermined', 'repetition', 'after_hint', 'new_context'].includes(String(row.mode)) || !inPeriod(String(row.created_at))) return invalid();
    const observation: Usage = { id: id(row.id), item_id: id(row.item_id), session_id: id(row.session_id), evidence_ids: ids(row.evidence_ids, row.kind === 'observed' ? 1 : 0), mode_evidence_ids: ids(row.mode_evidence_ids), kind: row.kind as Usage['kind'], mode: row.mode as Usage['mode'], review_status: 'confirmed', source_version: version(row.source_version), created_at: String(row.created_at) };
    if ((observation.kind === 'undetermined' && observation.mode !== 'undetermined') || (observation.mode !== 'undetermined' && observation.mode_evidence_ids.length === 0)) return invalid();
    if (observation.evidence_ids.some(eventId => sources.get(eventId)?.speaker !== 'user' || sources.get(eventId)?.session_id !== observation.session_id || !inPeriod(sources.get(eventId)!.timestamp))) return invalid();
    if (observation.mode_evidence_ids.some(eventId => {
      const hint = sources.get(eventId);
      return hint?.speaker !== 'assistant' || hint.session_id !== observation.session_id || !inPeriod(hint.timestamp)
        || !observation.evidence_ids.some(userEventId => date(hint.timestamp) < date(sources.get(userEventId)!.timestamp));
    })) return invalid();
    // Preserve a reviewed mode only with the supporting event relationship.
    // An earlier assistant turn alone never proves a hint or a new context.
    // Repetition additionally needs the actual target phrase in that turn.
    const target = itemSources.get(observation.item_id);
    if (observation.mode === 'repetition' && target) {
      const normalize = (text: string) => text.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
      const escaped = normalize(target.expression).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const phrase = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
      if (!observation.mode_evidence_ids.some(eventId => phrase.test(normalize(sources.get(eventId)!.text)))) return invalid();
    }
    return observation;
  })).filter(observation => itemIds.has(observation.item_id));
  const latestRecall = (item: SourceItem) => recalls.filter(recall => recall.item_id === item.id).sort((a, b) => date(b.occurred_at) - date(a.occurred_at) || a.id.localeCompare(b.id))[0];
  const priority = (item: SourceItem) => { const recall = latestRecall(item); return recall ? { hard: 0, assisted: 1, independent: 2 }[recall.rating] : 3; };
  const ordered = [...items].sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id));
  const keep = ordered[0];
  const next = ordered.find(item => item.id !== keep?.id && usage.some(observation => observation.item_id === item.id && observation.kind === 'observed')) || ordered.find(item => item.id !== keep?.id) || keep;
  const keepGoal = keep ? `예문을 가린 뒤 “${keep.expression}”를 한 번 떠올려 말해 보기.` : '';
  const tryGoal = next ? `다음 대화에서 상황이 맞으면 “${next.expression}”를 한 번 사용해 보기.` : '';
  return {
    learning_plan: keep && next ? {
      keep: { goal: keepGoal.length <= 500 ? keepGoal : '선택한 표현의 예문을 가린 뒤 한 번 떠올려 말해 보기.', item_id: keep.id },
      try: { goal: tryGoal.length <= 500 ? tryGoal : '다음 대화에서 상황이 맞으면 선택한 표현을 한 번 사용해 보기.', item_id: next.id },
    } : null,
    learning_plan_context: {
      scope: { ...scope, hours: 168, source_events: events.map(event => ({ event_id: event.id, session_id: event.session_id, timestamp: event.timestamp })) },
      source_items: items,
      recalls,
      reviewed_usage: usage,
      selection: 'user_required',
      future_calls_included: false,
      interpretation: 'Practice suggestions from this requested sample and delayed self-reports; reviewed usage remains observational evidence, not a mastery judgment.',
    },
  };
}
