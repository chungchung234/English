import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationClock, formatInstant, memoryReceiptLabel, recordTimeLabel, sessionTimeLabel, sessionTimeZone, validTimeZone } from '../web/conversation-time.js';

test('server clock advances monotonically across Korean midnight despite a wrong or changed device clock', () => {
  let mono = 5000, wall = Date.parse('2034-01-01T00:00:00Z');
  const clock = createConversationClock({ clock: { server_now_utc: '2026-11-10T14:59:30Z', time_zone: 'Asia/Seoul' }, monotonicNow: () => mono, wallNow: () => wall });
  assert.equal(clock.source, 'server'); assert.match(clock.snapshot().label, /2026\. 11\. 10\. 23:59/);
  mono += 40000; wall -= 5 * 86400000;
  assert.equal(clock.snapshot().utc, '2026-11-10T15:00:10.000Z'); assert.match(clock.snapshot().label, /2026\. 11\. 11\. 00:00/);
  assert.doesNotMatch(clock.snapshot().label, /기기 시각/);
});

test('UTC instants display with IANA DST rules, including repeated local times', () => {
  assert.match(formatInstant('2026-03-08T06:59:00Z', 'America/New_York'), /01:59/);
  assert.match(formatInstant('2026-03-08T07:01:00Z', 'America/New_York'), /03:01/);
  assert.match(formatInstant('2026-11-01T05:30:00Z', 'America/New_York'), /01:30/);
  assert.match(formatInstant('2026-11-01T06:30:00Z', 'America/New_York'), /01:30/);
  assert.match(recordTimeLabel('2026-11-01T05:30:00Z', 'America/New_York'), /GMT-4/);
  assert.match(recordTimeLabel('2026-11-01T06:30:00Z', 'America/New_York'), /GMT-5/);
  assert.match(recordTimeLabel('2026-11-10T15:00:01Z', 'UTC'), /기록 시각.*15:00:01/);
  assert.match(sessionTimeLabel({ created_at: '2026-11-01T05:50:00Z', ended_at: '2026-11-01T06:10:00Z', time_zone: 'America/New_York' }), /01:50 GMT-4.*종료.*01:10 GMT-5/);
});

test('legacy time zone is unknown while the chosen display zone stays explicit', () => {
  const legacy = { created_at: '2026-11-10T15:00:00Z', ended_at: '2026-11-10T15:05:00Z', time_zone: null };
  assert.deepEqual(sessionTimeZone(legacy, 'Asia/Seoul'), { zone: 'Asia/Seoul', saved: false, label: 'Asia/Seoul 표시 · 당시 시간대 미저장' });
  assert.match(sessionTimeLabel(legacy, 'Asia/Seoul'), /2026\. 11\. 11\. 00:00.*종료.*00:05.*당시 시간대 미저장/);
  assert.equal(legacy.time_zone, null); assert.equal(legacy.created_at, '2026-11-10T15:00:00Z');
  assert.doesNotMatch(sessionTimeLabel({ ...legacy, time_zone: 'UTC' }), /미저장/);
  assert.match(sessionTimeLabel({ time_zone: 'UTC' }), /시각 정보 없음/);
});

test('old voice replies and invalid clock values explicitly fall back to device time', () => {
  let mono = 10;
  const clock = createConversationClock({ clock: { server_now_utc: 'not a time', time_zone: 'not/a-zone' }, timeZone: 'UTC', wallNow: () => Date.parse('2026-11-10T12:00:00Z'), monotonicNow: () => mono });
  assert.equal(clock.source, 'device'); assert.equal(clock.timeZone, 'UTC'); assert.match(clock.snapshot().label, /기기 시각/);
  mono += 60000; assert.match(clock.snapshot().label, /12:01/);
  assert.equal(validTimeZone('no/such/place'), null); assert.equal(validTimeZone(''), null); assert.equal(validTimeZone('Asia/Seoul'), 'Asia/Seoul');
});

test('memory receipt is about supplied context, never an assertion that the AI recalled it', () => {
  assert.equal(memoryReceiptLabel({ status: 'ready', memory_count: 2, fact_count: 1 }), '이전 대화 2개 · 저장 정보 1개 전달됨');
  assert.match(memoryReceiptLabel({ status: 'suppressed', memory_count: 4 }), /참고 보류/);
  assert.equal(memoryReceiptLabel({ status: 'suppressed', memory_count: 0, fact_count: 1 }), '이전 대화 참고 보류 · 저장 정보 1개 전달됨');
  assert.match(memoryReceiptLabel({ status: 'empty' }), /아직 없어요/);
  assert.equal(memoryReceiptLabel({ status: 'ready', memory_count: '2', fact_count: -1 }), '');
  assert.equal(memoryReceiptLabel(null), '');
});
