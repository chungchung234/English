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
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); assert.equal(f.client.list().length, 1);
  const afterReload = fixture({ storage: store });
  assert.deepEqual(afterReload.client.list(), f.client.list());
  await afterReload.client.flush(); assert.deepEqual(afterReload.client.list(), []);
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
  await drained.client.flush(); assert.deepEqual(drained.client.list(), []);
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
  await f.client.flush(); await f.client.flush();
  assert.deepEqual(sent[0], sent[1], 'an offline retry retains the original nested settings');
  assert.deepEqual(f.client.list(), []);
  assert.equal(f.client.record(one), false, 'acknowledged response still has a ten-second burst guard');
  assert.equal(f.client.record({ ...one, audio_context: { ...one.audio_context, response_key: '33333333-3333-4333-8333-333333333333' } }), true);
});
