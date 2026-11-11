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
