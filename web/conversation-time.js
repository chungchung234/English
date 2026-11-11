// A saved UTC instant and the time zone chosen when the call started are
// separate facts. Missing legacy zones never become inferred travel/location.
export function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return null;
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return null; }
}
export function deviceTimeZone() {
  try { return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC'; }
  catch { return 'UTC'; }
}
const instant = value => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function formatInstant(value, zone, { seconds = false, offset = false } = {}) {
  const stamp = instant(value);
  if (stamp === null) return '시각 정보 없음';
  const timeZone = validTimeZone(zone) || 'UTC', date = new Date(stamp);
  const formatted = new Intl.DateTimeFormat('ko-KR', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' }).format(date);
  const suffix = offset ? new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value : '';
  return suffix ? `${formatted} ${suffix}` : formatted;
}
export function sessionTimeZone(session, fallback = deviceTimeZone()) {
  const saved = validTimeZone(session?.time_zone), display = saved || validTimeZone(fallback) || 'UTC';
  return { zone: display, saved: Boolean(saved), label: saved ? display : `${display} 표시 · 당시 시간대 미저장` };
}
export function sessionTimeLabel(session, fallback) {
  const time = sessionTimeZone(session, fallback);
  const started = formatInstant(session?.created_at, time.zone, { offset: true });
  const ended = instant(session?.ended_at) === null ? '' : ` · 종료 ${formatInstant(session.ended_at, time.zone, { offset: true })}`;
  return `통화 기록 ${started}${ended} · ${time.label}`;
}
export function recordTimeLabel(value, zone) { return `기록 시각 ${formatInstant(value, zone, { seconds: true, offset: true })}`; }

export function createConversationClock({ clock, timeZone, wallNow = () => Date.now(), monotonicNow = () => performance.now() } = {}) {
  const server = instant(clock?.server_now_utc), anchor = server ?? wallNow(), reference = monotonicNow();
  const zone = validTimeZone(clock?.time_zone) || validTimeZone(timeZone) || deviceTimeZone();
  const source = server === null ? 'device' : 'server';
  const now = () => anchor + Math.max(0, monotonicNow() - reference);
  return {
    now,
    get timeZone() { return zone; },
    get source() { return source; },
    snapshot() {
      const utc = new Date(now()).toISOString();
      return { utc, zone, source, label: `현재 ${formatInstant(utc, zone)} · ${zone}${source === 'device' ? ' · 기기 시각' : ''}` };
    }
  };
}

export function memoryReceiptLabel(value) {
  if (!value || !['ready', 'suppressed', 'empty'].includes(value.status)) return '';
  const count = (number, max) => Number.isSafeInteger(number) && number >= 0 && number <= max ? number : 0;
  const memories = count(value.memory_count, 12), facts = count(value.fact_count, 6);
  if (value.status === 'suppressed') return `이전 대화 참고 보류 · ${facts ? `저장 정보 ${facts}개 전달됨` : '통화 뒤 기억 설정에서 확인'}`;
  if (value.status === 'empty') return '이전 대화에서 전달할 기억이 아직 없어요';
  if (!memories && !facts) return '';
  return [memories ? `이전 대화 ${memories}개` : '', facts ? `저장 정보 ${facts}개` : ''].filter(Boolean).join(' · ') + ' 전달됨';
}
