import { bytes, uuidPattern } from './core.ts';
import { recentConversation, sourceInstant, sourceTimeZone, type CallClock } from './temporal-context.ts';
import { projectSharedExchanges, type SharedExchange } from './shared-exchanges.ts';

// Engineering bounds, not validated conversational/learning optima. Seven days
// bounds unsolicited callbacks by source speech time; three openings in fourteen
// days give expression variation context without replaying a conversation log.
export const OPENING_POLICY_VERSION = 'opening-context-v2';
export const OPENING_BOUNDS = Object.freeze({ continuityDays: 7, styleDays: 14, styleCount: 3, styleChars: 240, topicChars: 300, maxBytes: 3600 });
const DAY = 86_400_000, PREPARED_PREFIX = 'User-prepared conversation:';
type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// These are conservative exclusion heuristics on top of the validated handoff,
// not a semantic classifier or a guarantee that arbitrary language is safe. The
// caller must supply only currently eligible same-account/companion sources.
const sensitive = /\b(?:diagnos\w*|cancer|depress\w*|anxiety|suicid\w*|self[- ]harm|pregnan\w*|miscarriage|fertility|medication|therapy|therapist|sexual\w*|sex|religio\w*|politic\w*|election|vot(?:e|ed|ing)|ethnic\w*|racial\w*|my race|abuse|assault|addict\w*|debt|salary|income|bank account|credit card|passport|password|only friend)\b|진단|암\s*치료|우울|불안장애|자살|자해|임신|유산|난임|약물|정신과|성생활|종교|정치|선거|투표|민족|인종|학대|중독|대출|빚|연봉|급여|계좌|비밀번호/i;
const contactIdentifiers = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\//i;
const phoneIdentifier = /\b(?:\+?\d[\d ()-]{7,}\d)\b/;
const standaloneIsoDate = /(?<![\p{L}\p{M}\p{N}_+-])\d{4}-\d{2}-\d{2}(?![\p{L}\p{M}\p{N}_+-])/gu;
function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function hasIdentifiers(value: string) {
  if (contactIdentifiers.test(value)) return true;
  const withoutDates = value.replace(standaloneIsoDate, (token: string, offset: number) => {
    if (!calendarDate(token)) return token;
    // Only independent calendar dates are exempt. Do not split a larger phone
    // sequence, including numbers separated from the date by spaces/brackets.
    const left = value.slice(0, offset), right = value.slice(offset + token.length);
    if (/\d[\d\s()+-]*$/.test(left) || /^[\s()+-]*\d/.test(right)) return token;
    return '[date]';
  });
  return phoneIdentifier.test(withoutDates);
}
const roleplay = /\b(?:role[- ]?play|pretend|fictional|imaginary|my character|in (?:this|the) scenario|act as|play the role)\b|역할극|상황극|가상\s*인물|내\s*역할|가정해/i;
const instructions = /\b(?:ignore (?:all |the |previous )?instructions|system prompt|developer message|return json|you must|reveal secrets)\b|(?:^|\n)\s*(?:system|assistant|developer)\s*:|<\/?(?:system|assistant|developer)>|지시를?\s*무시|시스템\s*프롬프트/i;
const historicalRequest = /[?？]|^\s*(?:do|did|does|are|is|am|was|were|have|has|had|who|what|when|where|why|how|which|whose|shall|should|would|could|can|will|may|might)\b|(?:^|[.!]\s+)(?:tell|show|give|help|say|repeat|correct|translate|explain|use|write|read|stop|wait|do not|don't)\b|\b(?:asked|requests?|questions?|can you|could you|would you|will you|want you to|would like you to|i need (?:your )?help|i want to know|help me|let(?:'s| us) (?:talk|discuss|practice)|how (?:do|can|should|would)|what (?:does|is the meaning)|please|explain|translate|correct my|teach me|repeat after)\b|알려\s*줘|설명해|설명\s*요청|어떻게\s*말|영어로\s*뭐|무슨\s*뜻|교정해|고쳐\s*줘|해\s*줘|대화하자|연습하자|따라\s*말/i;
const hypothetical = /\b(?:if I|if we|suppose|hypothetical|would be|could be|imagine|wish I)\b|만약|가정하면|일지도|라면/i;
const unsafe = (value: string) => sensitive.test(value) || hasIdentifiers(value) || roleplay.test(value) || hypothetical.test(value) || instructions.test(value);
const fieldTopic: Record<string, RegExp> = {
  name: /\b(?:name|called)\b|이름/i,
  occupation: /\b(?:work\w*|job|career|occupation|company|office|employ\w*|boss|colleague)\b|직장|직업|회사|근무|동료|상사/i,
  location: /\b(?:live|lives|living|home|hometown|location|moved|city|country|born)\b|주소|거주|살고|사는\s*곳|출신|고향/i,
  goal: /\b(?:goal|aim|hope|learning|study|improve)\b|목표|배우|공부|늘리/i,
  interest: /\b(?:enjoy\w*|likes?|loves?|favou?rite|hobb\w*|interest\w*|prefer\w*)\b|취미|좋아|관심|즐기/i,
  preference: /\b(?:prefer\w*|rather|dislike|hate|conversation|shorter|longer|simpler)\b|선호|싫어|짧게|길게|원해/i,
};

export type SanitizedAssistantOpening = { session_id: string; occurred_at: string; text: string; role: 'past_assistant_opening'; source_kind: 'observed_transcript'; companion_id?: string; speaker?: 'assistant'; is_opening?: true };
export type OpeningPlanTiming = { local_date: string; time_zone: string; relation: 'upcoming' | 'today' | 'past' };
export type OpeningContinuity = { session_id: string; source_started_at: string; source_ended_at: string; source_time_zone: string | null; evidence_id: string; source_spoken_at: string;
  note: string; state: 'stated' | 'planned' | 'resolved'; when: string | null; quote: string; role: 'historical_background'; must_not_infer_outcome: true; plan_timing: OpeningPlanTiming | null };
export type OpeningContext = {
  version: typeof OPENING_POLICY_VERSION;
  purpose: 'call_opening'; current_utterance: null;
  role: 'optional_conversation_context';
  context_kind: 'user_chosen_topic' | 'recent_conversation' | 'none';
  prepared_topic: null | { text: string; source: 'current_session_user_prepared'; role: 'optional_topic_not_spoken_utterance' };
  continuity: OpeningContinuity | null;
  shared_exchange?: SharedExchange;
  recent_openings: { session_id: string; occurred_at: string; text: string; role: 'style_only' }[];
  reason: 'prepared_topic' | 'eligible_continuity' | 'suppressed' | 'forgotten_fact' | 'invalid_clock' | 'no_recent_handoff' | 'stale_source' | 'no_suitable_thread';
};

function preparedTopic(context: Data): OpeningContext['prepared_topic'] {
  if (typeof context.scenario !== 'string' || !context.scenario.startsWith(PREPARED_PREFIX)) return null;
  const text = clean(context.scenario.slice(PREPARED_PREFIX.length));
  if (!text || text.length > OPENING_BOUNDS.topicChars || instructions.test(text)) return null;
  // This is the learner's explicitly prepared current topic, not an inferred
  // personal fact and not evidence that the learner has spoken in this call.
  return { text, source: 'current_session_user_prepared', role: 'optional_topic_not_spoken_utterance' };
}
function openingHistory(value: unknown, now: number, companionId: unknown): OpeningContext['recent_openings'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(), sessions = new Set<string>();
  return value.flatMap(entry => {
    if (!record(entry) || !uuid(entry.session_id) || !short(entry.text, 2000) || entry.role !== 'past_assistant_opening' || entry.source_kind !== 'observed_transcript' ||
      (entry.speaker !== undefined && entry.speaker !== 'assistant') || (entry.is_opening !== undefined && entry.is_opening !== true) ||
      (entry.companion_id !== undefined && entry.companion_id !== companionId)) return [];
    const instant = sourceInstant(entry.occurred_at), at = instant ? Date.parse(instant) : NaN;
    if (!instant || at > now || now - at > OPENING_BOUNDS.styleDays * DAY) return [];
    const text = clean(entry.text).slice(0, OPENING_BOUNDS.styleChars);
    if (!text || unsafe(entry.text)) return [];
    return [{ session_id: entry.session_id, occurred_at: instant, text, role: 'style_only' as const }];
  }).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.session_id.localeCompare(b.session_id)).filter(entry => {
    const signature = entry.text.toLocaleLowerCase('en');
    if (sessions.has(entry.session_id) || seen.has(signature)) return false;
    sessions.add(entry.session_id); seen.add(signature); return true;
  }).slice(0, OPENING_BOUNDS.styleCount);
}

function localCalendarDay(instant: string, zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone: zone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
    const part = (name: string) => parts.find(value => value.type === name)?.value;
    const year = part('year'), month = part('month'), day = part('day');
    const value = year && month && day ? `${year.padStart(4, '0')}-${month}-${day}` : null;
    return value && calendarDate(value) ? value : null;
  } catch { return null; }
}
function planTiming(state: string, when: string | null, spokenAt: string, sourceZone: string | null, now: string): OpeningPlanTiming | null {
  if (state !== 'planned' || when === null) return null;
  const zone = sourceTimeZone(sourceZone); if (!zone) return null;
  const currentDay = localCalendarDay(now, zone); if (!currentDay) return null;
  const phrase = when.trim(), relative: Record<string, number> = { today: 0, tomorrow: 1, yesterday: -1, '오늘': 0, '내일': 1, '어제': -1 };
  let plannedDay: string;
  if (calendarDate(phrase)) plannedDay = phrase;
  else {
    const offset = relative[phrase.toLocaleLowerCase('en')];
    if (typeof offset !== 'number') return null;
    const sourceDay = localCalendarDay(spokenAt, zone); if (!sourceDay) return null;
    // Add a civil calendar day, not 24 hours to the source instant. DST changes
    // can make those operations land on different local dates.
    const civil = new Date(sourceDay + 'T00:00:00.000Z'); civil.setUTCDate(civil.getUTCDate() + offset);
    plannedDay = civil.toISOString().slice(0, 10); if (!calendarDate(plannedDay)) return null;
  }
  return { local_date: plannedDay, time_zone: zone, relation: plannedDay > currentDay ? 'upcoming' : plannedDay < currentDay ? 'past' : 'today' };
}

/**
 * Pure selection from boundVoiceContext.context plus a caller-scoped history.
 * This neither retrieves sources nor verifies ownership, suppression revisions,
 * source holds or exclusions. The voice preparation path must do those checks
 * before and after selection, just as for the ordinary voice instructions.
 * The result describes optional context, never a task for the character to
 * perform. It prescribes no direction, turn shape, greeting or length quota.
 */
export function buildOpeningContext({ context, clock, recentOpenings = [], exchangeRevision }: { context: unknown; clock: CallClock; recentOpenings?: unknown; exchangeRevision?: number }): OpeningContext {
  const data = record(context) ? context : {}, memory = record(data.memory) ? data.memory : {};
  const prepared = preparedTopic(data), instant = sourceInstant(clock?.server_now_utc), now = instant ? Date.parse(instant) : NaN;
  const suppressed = memory.suppress_memory === true;
  // Source eligibility/history_cutoff is authoritative, including forget/edit
  // operations. This extra field-topic exclusion is deliberately conservative;
  // it is not a semantic mapping and does not disable unrelated style history.
  const guardedFields = Array.isArray(memory.facts) ? memory.facts.filter(fact => record(fact) && (fact.forgotten === true || fact.value === '' || fact.manual === true))
    .map(fact => fieldTopic[String((fact as Data).key)]).filter((value): value is RegExp => Boolean(value)) : [];
  const result: OpeningContext = { version: OPENING_POLICY_VERSION, purpose: 'call_opening', current_utterance: null,
    role: 'optional_conversation_context', context_kind: prepared ? 'user_chosen_topic' : 'none',
    prepared_topic: prepared, continuity: null, recent_openings: [],
    reason: prepared ? 'prepared_topic' : suppressed ? 'suppressed' : !instant ? 'invalid_clock' : 'no_recent_handoff' };
  if (suppressed || !instant) return result;
  result.recent_openings = openingHistory(recentOpenings, now, data.companionId);

  // Only the latest eligible handoff may supply optional recent context.
  // Empty, missing, legacy-summary and excerpt fallbacks do not promote an
  // older conversation_memories/feedback/fact profile into a new opening.
  const recent = recentConversation(memory.recent_conversation, instant);
  if (recent?.mode === 'handoff') {
    const recentAt = Date.parse(recent.session_ended_at);
    if (now - recentAt > OPENING_BOUNDS.continuityDays * DAY) {
      if (!prepared) result.reason = 'stale_source';
    } else {
      if (!prepared) result.reason = 'no_suitable_thread';
      for (const thread of recent.threads) {
        if (!['stated', 'planned', 'resolved'].includes(thread.state) || unsafe(thread.note) || historicalRequest.test(thread.note)) continue;
        const evidenceId = thread.evidence_ids[0], turn = recent.turns.find(turn => turn.id === evidenceId);
        if (!turn || unsafe(turn.text) || historicalRequest.test(turn.text)) continue;
        if (guardedFields.some(pattern => pattern.test(thread.note) || pattern.test(turn.text))) {
          if (!prepared) result.reason = 'forgotten_fact';
          continue;
        }
        const at = Date.parse(turn.timestamp);
        if (at < Date.parse(recent.session_created_at) || at > recentAt || at > now || now - at > OPENING_BOUNDS.continuityDays * DAY) continue;
        if (thread.when !== null && !turn.text.includes(thread.when)) continue;
        result.continuity = { session_id: recent.session_id, source_started_at: recent.session_created_at, source_ended_at: recent.session_ended_at, source_time_zone: recent.session_time_zone,
          evidence_id: evidenceId, source_spoken_at: turn.timestamp, note: clean(thread.note), state: thread.state as OpeningContinuity['state'],
          when: thread.when, quote: turn.text, role: 'historical_background', must_not_infer_outcome: true,
          plan_timing: planTiming(thread.state, thread.when, turn.timestamp, recent.session_time_zone, instant) };
        if (!prepared) {
          result.context_kind = 'recent_conversation'; result.reason = 'eligible_continuity';
        }
        break;
      }
    }
  }
  // An explicitly user-chosen topic takes precedence in the supplied data.
  // It is still optional context, not a command to speak a particular line or
  // perform a teaching/conversation task.
  if (prepared) result.continuity = null;
  if (result.continuity) {
    const companionId = ['alex', 'mia', 'juno'].includes(String(data.companionId)) ? data.companionId as 'alex' | 'mia' | 'juno' : null;
    const pairs = projectSharedExchanges(memory.shared_exchanges, { companionId, revision: exchangeRevision, now: instant,
      facts: Array.isArray(memory.facts) ? memory.facts : [] });
    const pair = pairs.find(item => item.source_session_id === result.continuity!.session_id && item.caller.id === result.continuity!.evidence_id &&
      item.caller.quote.includes(result.continuity!.quote) && !unsafe(item.companion.quote));
    if (pair) result.shared_exchange = pair;
  }
  while (bytes(JSON.stringify(result)) > OPENING_BOUNDS.maxBytes && result.recent_openings.length) result.recent_openings.pop();
  if (bytes(JSON.stringify(result)) > OPENING_BOUNDS.maxBytes) delete result.shared_exchange;
  return result;
}
