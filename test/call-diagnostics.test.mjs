import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallDiagnostics } from '../src/call-diagnostics.mjs';

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = { session_id: session, client_build: 'git:1234567', kind: 'provider_error', code: 'conversation_item_not_found',
  request_type: 'conversation.item.delete', elapsed_ms: 600_000, connection_state: 'connected', data_state: 'open', phase: 'connected' };
const storage = () => { const rows = new Map(); return { rows, getItem: key => rows.get(key), setItem: (key, value) => rows.set(key, value) }; };
function fixture(options = {}) {
  let scope = 'account-a', time = Date.parse('2026-11-11T12:00:00Z'), id = 0;
  const store = options.storage || storage();
  const client = createCallDiagnostics({ getScope: () => scope, storage: store, now: () => time,
    randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`, send: options.send || (async rows => ({ event_ids: rows.map(row => row.event_id) })) });
  return { client, store, setScope: value => { scope = value; }, advance: value => { time += value; } };
}

test('only bounded diagnostic metadata is retained; provider content and injected fields cannot cross the boundary', async () => {
  const requests = [], f = fixture({ send: async rows => { requests.push(rows); return { event_ids: rows.map(row => row.event_id) }; } });
  assert.equal(f.client.record({ ...base, error: { message: 'private speech', token: 'secret' }, message: 'private speech', transcript: 'private speech', token: 'secret' }), true);
  const queued = f.client.list();
  assert.equal(queued[0].occurred_at, '2026-11-11T12:00:00.000Z');
  assert.equal(queued[0].event_id, '00000000-0000-4000-8000-000000000001');
  assert(!JSON.stringify([...f.store.rows.values()]).includes('private speech'));
  assert(!JSON.stringify([...f.store.rows.values()]).includes('secret'));
  queued[0].token = 'caller mutation';
  await f.client.flush();
  assert(!JSON.stringify(requests).includes('caller mutation'));
  assert.equal(requests[0][0].request_type, 'conversation.item.delete');
  assert.deepEqual(f.client.list(), []);
});

test('invalid states and session identifiers are rejected; free-form code and build values are replaced', () => {
  const { client } = fixture();
  for (const patch of [{ session_id: 'other account' }, { kind: 'speech text' }, { connection_state: 'speech text' },
    { data_state: 'speech text' }, { phase: 'speech text' }, { elapsed_ms: -1 }, { elapsed_ms: 7_200_001 }, { elapsed_ms: 1.2 }]) {
    assert.equal(client.record({ ...base, ...patch }), false);
  }
  assert.equal(client.record({ ...base, code: 'message with speech', client_build: 'owner@example.com', request_type: 'private command' }), true);
  assert.equal(client.list()[0].code, 'unknown');
  assert.equal(client.list()[0].client_build, 'dev:unversioned');
  assert.equal(client.list()[0].request_type, 'unknown');
});

test('failed delivery retries the exact receipt, including after client reload, and empty acknowledgements do not remove it', async () => {
  let calls = 0; const sent = [], store = storage();
  const f = fixture({ storage: store, send: async rows => { sent.push(rows); if (++calls === 1) throw Error('offline'); return {}; } });
  f.client.record(base); await f.client.flush(); await f.client.flush();
  assert.equal(sent.length, 1, 'five-second sync cannot bypass cooldown');
  f.advance(30_000); await f.client.flush();
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); assert.equal(f.client.list().length, 1);
  const afterReload = fixture({ storage: store });
  assert.deepEqual(afterReload.client.list(), f.client.list());
  await afterReload.client.flush(); assert.equal(afterReload.client.list().length, 1, 'reload retains cooldown');
  afterReload.advance(90_000); await afterReload.client.flush(); assert.deepEqual(afterReload.client.list(), []);
});

test('server receipts remove only sent IDs; explicit capacity drops settle while unrelated and absent receipts remain queued', async () => {
  let calls = 0; const sent = [];
  const f = fixture({ send: async rows => {
    sent.push(rows);
    if (++calls === 1) return { event_ids: [rows[0].event_id, 'ffffffff-ffff-4fff-8fff-ffffffffffff'], dropped_event_ids: [rows[1].event_id] };
    return { event_ids: [] };
  } });
  for (let i = 0; i < 3; i++) f.client.record({ ...base, code: 'error_' + i });
  await f.client.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].length, 1);
  assert.equal(f.client.list().length, 1);
  assert.equal(f.client.list()[0].code, 'error_2');
});

test('account changes cannot send the previous queue or apply its acknowledgement to the new account', async () => {
  let resolve; const sent = [], f = fixture({ send: (rows, owner) => { sent.push({ rows, owner }); return new Promise(done => { resolve = done; }); } });
  f.client.record(base); const running = f.client.flush();
  f.setScope('account-b'); f.client.record({ ...base, session_id: otherSession });
  const b = f.client.list();
  const overlapping = f.client.flush();
  resolve({ event_ids: sent[0].rows.map(row => row.event_id) });
  await Promise.all([running, overlapping]);
  assert.equal(sent.length, 1); assert.equal(sent[0].owner, 'account-a');
  assert.deepEqual(f.client.list(), b);
  f.setScope('account-a'); assert.deepEqual(f.client.list(), []);
});

test('equivalent bursts are deduplicated for ten seconds after acknowledgement while different requests stay visible', async () => {
  const f = fixture();
  assert.equal(f.client.record(base), true);
  assert.equal(f.client.record({ ...base, message: 'another provider message' }), false);
  await f.client.flush();
  f.advance(9999); assert.equal(f.client.record(base), false);
  assert.equal(f.client.record({ ...base, request_type: 'session.update' }), true);
  f.advance(1); assert.equal(f.client.record(base), true);
  assert.equal(f.client.list().length, 2);
  f.setScope('account-b'); assert.equal(f.client.record(base), true);
});

test('queue and batch work are bounded, including absent server acknowledgements', async () => {
  const sent = [], f = fixture({ send: async rows => { sent.push(rows); return {}; } });
  for (let i = 0; i < 125; i++) f.client.record({ ...base, code: 'error_' + i });
  assert.equal(f.client.list().length, 100);
  assert.equal(f.client.list()[0].code, 'error_25');
  await f.client.flush(); assert.equal(sent.length, 1); assert.equal(sent[0].length, 20);
  const drained = fixture({ storage: f.store });
  drained.advance(30_000); await drained.client.flush(); assert.deepEqual(drained.client.list(), []);
});

test('storage denial, corrupt caches, invalid clocks and signed-out records cannot disrupt calls', async () => {
  const broken = { getItem() { throw Error('disabled'); }, setItem() { throw Error('full'); } };
  const f = fixture({ storage: broken });
  assert.doesNotThrow(() => assert.equal(f.client.record(base), true));
  assert.equal(f.client.list().length, 1); await f.client.flush(); assert.deepEqual(f.client.list(), []);
  f.setScope(null); assert.equal(f.client.record(base), false); assert.deepEqual(f.client.list(), []); await f.client.flush();
  const bad = createCallDiagnostics({ getScope: () => 'account-a', storage: storage(), now: () => 'not a date', send: () => {} });
  assert.doesNotThrow(() => assert.equal(bad.record(base), false));
  const store = storage(); store.setItem('loop.call-diagnostics:account-a', '{corrupt');
  const corrupt = fixture({ storage: store }); assert.deepEqual(corrupt.client.list(), []);
  assert.doesNotThrow(() => corrupt.client.record(base)); assert.equal(corrupt.client.list().length, 1);
});

test('audio diagnostics retain only enum settings and local response UUIDs, without raw provider or device data', async () => {
  const sent = [], f = fixture({ send: async rows => { sent.push(structuredClone(rows)); return { event_ids: rows.map(row => row.event_id) }; } });
  const audio = { requested_mode: 'speakerphone', expected_noise: 'far_field', effective_noise: 'near_field',
    capture_echo: 'on', capture_noise: 'off', capture_gain: 'unreported', vad_type: 'semantic_vad', interrupt_response: 'on',
    output_state: 'playing', cancel_origin: 'provider_turn_detected', response_key: '11111111-1111-4111-8111-111111111111' };
  assert.equal(f.client.record({ ...base, kind: 'audio_interruption', audio_context: { ...audio,
    message: 'private provider message', transcript: 'private speech', sdp: 'private negotiation', deviceId: 'private device',
    response_id: 'resp_private_provider_id', raw_event: { token: 'private credential' } } }), true);
  assert.deepEqual(f.client.list()[0].audio_context, audio);
  assert(!JSON.stringify([...f.store.rows.values()]).includes('private'));
  const exposed = f.client.list(); exposed[0].audio_context.effective_noise = 'caller mutation';
  audio.requested_mode = 'headset';
  await f.client.flush();
  assert.equal(sent[0][0].audio_context.requested_mode, 'speakerphone', 'record owns a copy of settings');
  assert.equal(sent[0][0].audio_context.effective_noise, 'near_field', 'queue views cannot mutate nested receipts');
  assert.deepEqual(f.client.list(), []);
});

test('empty or invalid audio context cannot create the new kinds; old diagnostic payloads remain compatible', () => {
  const invalid = [undefined, null, {}, [], 'private speech', { deviceId: 'private device' },
    { requested_mode: true }, { expected_noise: 'off' }, { effective_noise: 'provider_default' }, { capture_echo: true },
    { capture_noise: 'enabled' }, { capture_gain: 1 }, { vad_type: null }, { interrupt_response: false },
    { output_state: 'buffer contents' }, { cancel_origin: 'raw reason' }, { response_key: 'resp_provider_id' }];
  for (const kind of ['audio_configuration', 'audio_interruption']) {
    const { client } = fixture();
    for (const audio_context of invalid) assert.equal(client.record({ ...base, kind, audio_context }), false);
  }
  const { client } = fixture();
  assert.equal(client.record({ ...base, audio_context: { deviceId: 'private device', expected_noise: 'invalid' } }), true);
  assert(!Object.hasOwn(client.list()[0], 'audio_context'));
  assert.equal(client.record({ ...base, kind: 'audio_configuration', audio_context: {
    requested_mode: 'headset', effective_noise: 'invalid', capture_echo: true, response_key: 'resp_provider_id' } }), true);
  assert.deepEqual(client.list()[1].audio_context, { requested_mode: 'headset' });
});

test('deduplication preserves distinct responses and effective settings, while canonical context survives reload and exact retries', async () => {
  let calls = 0; const sent = [], store = storage(), f = fixture({ storage: store, send: async rows => {
    sent.push(structuredClone(rows));
    if (++calls === 1) { rows[0].audio_context.cancel_origin = 'transport mutation'; throw Error('offline'); }
    return { event_ids: rows.map(row => row.event_id) };
  } });
  const one = { ...base, kind: 'audio_interruption', audio_context: { response_key: '11111111-1111-4111-8111-111111111111', effective_noise: 'far_field', output_state: 'playing' } };
  assert.equal(f.client.record(one), true);
  assert.equal(f.client.record({ ...one, audio_context: { output_state: 'playing', effective_noise: 'far_field', response_key: one.audio_context.response_key } }), false, 'key ordering does not invent a new interruption');
  assert.equal(f.client.record({ ...one, audio_context: { ...one.audio_context, response_key: '22222222-2222-4222-8222-222222222222' } }), true, 'two responses cancelled within ten seconds remain distinct');
  assert.equal(f.client.record({ ...one, audio_context: { ...one.audio_context, effective_noise: 'near_field' } }), true, 'effective setting changes remain observable');
  assert.equal(f.client.list().length, 3);
  const reloaded = fixture({ storage: store });
  assert.equal(reloaded.client.record(one), false, 'a reload still deduplicates the same queued receipt');
  await f.client.flush(); f.advance(30_000); await f.client.flush();
  assert.deepEqual(sent[0], sent[1], 'an offline retry retains the original nested settings');
  assert.deepEqual(f.client.list(), []);
  assert.equal(f.client.record(one), true, 'after the backoff exceeds ten seconds a later observation is eligible');
  assert.equal(f.client.record(one), false, 'the later observation still has a ten-second burst guard');
  assert.equal(f.client.record({ ...one, audio_context: { ...one.audio_context, response_key: '33333333-3333-4333-8333-333333333333' } }), true);
});

test('malformed immutable diagnostic batches are quarantined without fabricated ACKs or starving a later session', async () => {
  const sent = [], f = fixture({ send: async rows => {
    sent.push(structuredClone(rows));
    if (rows.some(row => row.session_id === session)) throw Object.assign(Error('private database detail'), { code: '22023' });
    return { event_ids: rows.map(row => row.event_id) };
  } });
  f.client.record(base); const original = f.client.list(); await f.client.flush();
  for (let i = 0; i < 10; i++) { f.advance(5000); await f.client.flush(); }
  assert.equal(sent.length, 1); assert.deepEqual(f.client.list(), original, 'quarantine is not an acknowledgement or raw receipt edit');
  assert(!JSON.stringify([...f.store.rows.values()]).includes('private database detail'));
  f.client.record({ ...base, session_id: otherSession }); await f.client.flush();
  assert.equal(sent.length, 2); assert.equal(sent[1][0].session_id, otherSession);
  assert.deepEqual(f.client.list(), original, 'an unrelated valid session can settle without resending poison');
});

test('transport, permission and absent-receipt retries stop after a bounded count and remain bounded across reload', async () => {
  for (const error of [undefined, Object.assign(Error('denied'), { code: '42501', status: 403 }), Error('offline')]) {
    let calls = 0;
    const f = fixture({ send: async () => { calls++; if (error) throw error; return {}; } });
    f.client.record(base);
    for (let i = 0; i < 12; i++) { await f.client.flush(); f.advance(300_000); }
    assert.equal(calls, 8); assert.equal(f.client.list().length, 1);
    const reloaded = fixture({ storage: f.store, send: async () => { calls++; return {}; } });
    reloaded.advance(20_000_000); await reloaded.client.flush(); assert.equal(calls, 8, 'reload cannot restart a poison batch');
  }
});

test('retry cooldown is account-scoped and does not expose retry bookkeeping in transport receipts', async () => {
  const sent = [], f = fixture({ send: async (rows, owner) => {
    sent.push({ rows: structuredClone(rows), owner });
    if (owner === 'account-a') throw Error('offline');
    return { event_ids: rows.map(row => row.event_id) };
  } });
  f.client.record(base); await f.client.flush(); f.setScope('account-b');
  f.client.record({ ...base, session_id: otherSession }); await f.client.flush();
  assert.equal(sent.length, 2); assert.equal(sent[1].owner, 'account-b');
  assert.deepEqual(f.client.list(), []);
  assert(!JSON.stringify(sent).includes('nextAt')); assert(!JSON.stringify(sent).includes('quarantined'));
  f.setScope('account-a'); await f.client.flush(); assert.equal(sent.length, 2);
  f.advance(30_000); await f.client.flush(); assert.equal(sent.length, 3);
});

test('latency receipts keep bounded timing enums and local keys, reject invalid metrics, and own their nested context', async () => {
  const sent = [], f = fixture({ send: async rows => { sent.push(structuredClone(rows)); return { event_ids: rows.map(row => row.event_id) }; } });
  const context = { turn_key: '11111111-1111-4111-8111-111111111111', purpose: 'reply', start_basis: 'speech_stop_received',
    measurement: 'provider_output_started', request_ms: 220, transcription_ms: 200, provider_output_ms: 650 };
  assert.equal(f.client.record({ ...base, kind: 'turn_latency', code: 'REALTIME_PROVIDER_OUTPUT', latency_context: { ...context,
    response_id: 'resp_private', item_id: 'item_private', transcript: 'private utterance' } }), true);
  const listed = f.client.list(); assert.deepEqual(listed[0].latency_context, context); listed[0].latency_context.request_ms = 1;
  assert(!JSON.stringify([...f.store.rows.values()]).includes('private'));
  for (const latency_context of [undefined, {}, { ...context, turn_key: 'resp_private' }, { ...context, purpose: 'private utterance' },
    { ...context, start_basis: 'physically_heard' }, { ...context, measurement: 'heard' }, { ...context, request_ms: -1 },
    { ...context, transcription_ms: 120001 }, { ...context, request_ms: 1.5 }, { ...context, request_ms: '10' },
    { ...context, provider_output_ms: undefined }, { ...context, measurement: 'native_render' }, { ...context, measurement: 'source_saved' }]) {
    assert.equal(f.client.record({ ...base, kind: 'turn_latency', latency_context }), false);
  }
  await f.client.flush(); assert.equal(sent[0][0].latency_context.request_ms, 220);
});

test('an already-open tab observes a peer quarantine instead of restarting the same failed batch', async () => {
  let attempts = 0; const store = storage();
  const stale = fixture({ storage: store, send: async rows => { attempts++; return { event_ids: rows.map(row => row.event_id) }; } });
  const writer = fixture({ storage: store, send: async () => { attempts++; throw Object.assign(Error('invalid'), { code: '22023' }); } });
  writer.client.record(base); assert.equal(stale.client.list().length, 1, 'the second tab is warm before failure');
  await writer.client.flush(); stale.advance(300_000); await stale.client.flush();
  assert.equal(attempts, 1); assert.equal(stale.client.list().length, 1);
});
