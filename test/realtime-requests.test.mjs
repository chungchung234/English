import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeRequests } from '../web/realtime-requests.js';

function fixture(options = {}) {
  let serial = 0, timerSerial = 0;
  const sent = [], issues = [], timers = new Map();
  const tracker = createRealtimeRequests({ send: event => sent.push(event), onIssue: issue => issues.push(issue),
    randomUUID: () => String(++serial), setTimer: callback => { const id = ++timerSerial; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id), ...options });
  return { tracker, sent, issues, timers, expire() { for (const callback of [...timers.values()]) callback(); } };
}
const deleted = itemId => ({ type: 'conversation.item.deleted', item_id: itemId });
const matchDelete = itemId => event => event?.type === 'conversation.item.deleted' && event.item_id === itemId;
const update = instructions => ({ type: 'session.update', session: { instructions } });
const matchUpdate = instructions => event => event?.type === 'session.updated' && event.session?.instructions === instructions;
const providerError = (eventId, code = 'invalid_request_error') => ({ type: 'error', error: { event_id: eventId, code, message: 'private conversation and bearer credential' } });
const handled = requestType => ({ handled: true, requestType });

test('updates require the exact receipt and attach a fresh client event ID', async () => {
  const f = fixture(), promise = f.tracker.request({ ...update('checkpoint'), event_id: 'caller-id' }, { match: matchUpdate('checkpoint') });
  assert.equal(f.sent[0].event_id, 'rtc-1');
  assert.deepEqual(f.tracker.event({ type: 'session.updated', session: { audio: { output: { speed: 1 } } } }), { handled: false, requestType: 'unknown' });
  assert.equal(f.timers.size, 1);
  const ack = { type: 'session.updated', session: { instructions: 'checkpoint' } };
  assert.deepEqual(f.tracker.event(ack), handled('session.update'));
  assert.equal(await promise, ack); assert.equal(f.timers.size, 0); assert.deepEqual(f.issues, []);
});

test('four parallel deletes settle independently and reject only the linked request', async () => {
  const f = fixture(), promises = ['a', 'b', 'c', 'd'].map(itemId => f.tracker.request({ type: 'conversation.item.delete', item_id: itemId }, { match: matchDelete(itemId) }));
  const settled = Promise.allSettled(promises);
  f.tracker.event(deleted('d')); f.tracker.event(deleted('a'));
  assert.deepEqual(f.tracker.event(providerError(f.sent[1].event_id, 'item_not_found')), handled('conversation.item.delete'));
  assert.equal(f.timers.size, 1); f.tracker.event(deleted('c'));
  const rows = await settled;
  assert.deepEqual(rows.map(row => row.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(rows[1].reason.code, 'item_not_found'); assert.equal(rows[1].reason.requestType, 'conversation.item.delete');
  assert.equal(rows[1].reason.message, 'item_not_found'); assert.doesNotMatch(JSON.stringify(rows[1].reason), /private|bearer|credential/);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.issues, [], 'the central handler owns provider error diagnostics');
});

test('unlinked provider errors never reject a pending operation or retain provider text', async () => {
  const f = fixture(), promise = f.tracker.request(update('next'), { match: matchUpdate('next') });
  assert.deepEqual(f.tracker.event(providerError('unrelated')), { handled: false, requestType: 'unknown' });
  assert.deepEqual(f.tracker.event(providerError(undefined)), { handled: false, requestType: 'unknown' });
  assert.equal(f.timers.size, 1);
  const rejection = assert.rejects(promise, error => error.code === 'PROVIDER_ERROR' && error.message === 'PROVIDER_ERROR');
  f.tracker.event(providerError(f.sent[0].event_id, 'bad code containing private content'));
  await rejection; assert.deepEqual(f.issues, []);
});

test('an explicitly rejected delete does not consume an identical retry acknowledgement', async () => {
  const f = fixture(), message = { type: 'conversation.item.delete', item_id: 'retry-item' };
  const first = f.tracker.request(message, { match: matchDelete('retry-item') });
  const rejected = assert.rejects(first, { code: 'item_not_found' });
  f.tracker.event(providerError(f.sent[0].event_id, 'item_not_found')); await rejected;
  const second = f.tracker.request(message, { match: matchDelete('retry-item') });
  assert.deepEqual(f.tracker.event(providerError(f.sent[0].event_id, 'item_not_found')), handled('conversation.item.delete'), 'a repeated old rejection cannot affect the retry');
  const ack = deleted('retry-item');
  assert.deepEqual(f.tracker.event(ack), handled('conversation.item.delete'));
  assert.equal(await second, ack); assert.equal(f.timers.size, 0); assert.deepEqual(f.issues, []);
});

test('a timed-out request reports once and its late error cannot reject a new request', async () => {
  const f = fixture(), first = f.tracker.request(update('old'), { match: matchUpdate('old') });
  const rejected = assert.rejects(first, error => error.code === 'REQUEST_TIMEOUT' && error.requestType === 'session.update');
  f.expire(); await rejected;
  assert.deepEqual(f.issues, [{ kind: 'request_timeout', code: 'REQUEST_TIMEOUT', request_type: 'session.update' }]);
  const second = f.tracker.request(update('new'), { match: matchUpdate('new') });
  assert.deepEqual(f.tracker.event(providerError(f.sent[0].event_id)), handled('session.update'));
  f.tracker.event({ type: 'session.updated', session: { instructions: 'old' } });
  assert.equal(f.timers.size, 1);
  const ack = { type: 'session.updated', session: { instructions: 'new' } };
  f.tracker.event(ack); assert.equal(await second, ack); assert.equal(f.issues.length, 1);
});

test('an identical retry cannot be confirmed by the late timeout acknowledgement', async () => {
  const f = fixture(), first = f.tracker.request(update('same'), { match: matchUpdate('same') });
  const rejected = assert.rejects(first, { code: 'REQUEST_TIMEOUT' }); f.expire(); await rejected;
  const second = f.tracker.request(update('same'), { match: matchUpdate('same') });
  const ack = { type: 'session.updated', session: { instructions: 'same' } };
  f.tracker.event(ack); assert.equal(f.timers.size, 1, 'the oldest unacknowledged request consumes its late receipt');
  f.tracker.event(ack); assert.equal(await second, ack); assert.equal(f.timers.size, 0);
});

test('an exact deletion-state receipt confirms a retry when the original acknowledgement was lost', async () => {
  const f = fixture(), message = { type: 'conversation.item.delete', item_id: 'lost-ack' };
  const first = f.tracker.request(message, { match: matchDelete('lost-ack'), stateAck: true });
  const rejected = assert.rejects(first, { code: 'REQUEST_TIMEOUT' }); f.expire(); await rejected;
  const second = f.tracker.request(message, { match: matchDelete('lost-ack'), stateAck: true });
  const other = f.tracker.request({ type: 'conversation.item.delete', item_id: 'other' }, { match: matchDelete('other'), stateAck: true });
  const ack = deleted('lost-ack');
  assert.deepEqual(f.tracker.event(ack), handled('conversation.item.delete'));
  assert.equal(await second, ack, 'one receipt proves the requested item is deleted without an infinite timeout/retry loop');
  assert.equal(f.timers.size, 1, 'another item still requires its own receipt');
  f.tracker.event(deleted('other')); await other;
  assert.deepEqual(f.issues, [{ kind: 'request_timeout', code: 'REQUEST_TIMEOUT', request_type: 'conversation.item.delete' }]);
});

test('one exact settings-state receipt confirms all matching state requests while preserving default FIFO', async () => {
  const f = fixture(), original = f.tracker.request(update('same'), { match: matchUpdate('same'), stateAck: true });
  const rejected = assert.rejects(original, { code: 'REQUEST_TIMEOUT' }); f.expire(); await rejected;
  const requests = [
    f.tracker.request(update('same'), { match: matchUpdate('same'), stateAck: true }),
    f.tracker.request(update('same'), { match: matchUpdate('same'), stateAck: true }),
  ];
  const conservative = f.tracker.request(update('same'), { match: matchUpdate('same') });
  const ack = { type: 'session.updated', session: { instructions: 'same' } };
  f.tracker.event(ack);
  assert.deepEqual(await Promise.all(requests), [ack, ack]); assert.equal(f.timers.size, 1, 'state receipts must not broadcast to conservative requests');
  f.tracker.event(ack); assert.equal(await conservative, ack); assert.equal(f.timers.size, 0);
  assert.equal(f.issues.length, 1, 'successful retries do not erase or duplicate the original timeout diagnostic');
});

test('synchronous acknowledgement during send settles before a later send throw', async () => {
  let tracker;
  const issues = [], ack = deleted('a');
  tracker = createRealtimeRequests({ send() { tracker.event(ack); throw Error('sensitive transport information'); }, onIssue: issue => issues.push(issue) });
  assert.equal(await tracker.request({ type: 'conversation.item.delete', item_id: 'a' }, { match: matchDelete('a') }), ack);
  assert.deepEqual(issues, []); tracker.dispose();
});

test('synchronous send failure is sanitized and clears the timer exactly once', async () => {
  const f = fixture({ send() { throw Error('private transport URL'); } });
  await assert.rejects(f.tracker.request(update('secret'), { match: matchUpdate('secret') }), error => error.code === 'SEND_FAILED' && error.message === 'SEND_FAILED');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.issues, [{ kind: 'context_error', code: 'SEND_FAILED', request_type: 'session.update' }]);
  f.expire(); assert.equal(f.issues.length, 1);
});

test('an asynchronous transport rejection cannot escape or corrupt a successful receipt', async () => {
  const f = fixture({ send: () => Promise.reject(Error('private transport error')) });
  await assert.rejects(f.tracker.request(update('a')), { code: 'SEND_FAILED' });
  assert.equal(f.timers.size, 0); assert.equal(f.issues.length, 1);
  let tracker;
  tracker = createRealtimeRequests({ send() { tracker.event(deleted('a')); return Promise.reject(Error('late transport rejection')); } });
  await tracker.request({ type: 'conversation.item.delete', item_id: 'a' }, { match: matchDelete('a') });
  await Promise.resolve(); tracker.dispose();
});

test('a timeout callback racing a receipt cannot settle or diagnose an acknowledged request', async () => {
  const f = fixture(), promise = f.tracker.request(update('a'), { match: matchUpdate('a') });
  const staleTimeout = [...f.timers.values()][0], ack = { type: 'session.updated', session: { instructions: 'a' } };
  f.tracker.event(ack); staleTimeout();
  assert.equal(await promise, ack); assert.deepEqual(f.issues, []);
});

test('disposal cancels every pending request without diagnostics and rejects later requests', async () => {
  const f = fixture(), promises = ['a', 'b'].map(itemId => f.tracker.request({ type: 'conversation.item.delete', item_id: itemId }, { match: matchDelete(itemId) }));
  const settled = Promise.allSettled(promises), staleTimeouts = [...f.timers.values()];
  f.tracker.dispose(); f.tracker.dispose(); for (const timer of staleTimeouts) timer();
  const rows = await settled; assert(rows.every(row => row.status === 'rejected' && row.reason.code === 'REQUEST_CANCELLED'));
  assert.equal(f.timers.size, 0); assert.deepEqual(f.issues, []);
  assert.deepEqual(f.tracker.event(providerError(f.sent[0].event_id)), handled('conversation.item.delete'));
  await assert.rejects(f.tracker.request(update('late')), { code: 'REQUEST_CANCELLED' }); assert.equal(f.sent.length, 2);
});

test('the recent request history is bounded at 256 while pending older requests remain tracked', async () => {
  const f = fixture(), oldest = f.tracker.request({ type: 'conversation.item.delete', item_id: 'pending' }, { match: matchDelete('pending') });
  for (let index = 0; index < 257; index++) {
    const itemId = String(index), promise = f.tracker.request({ type: 'conversation.item.delete', item_id: itemId }, { match: matchDelete(itemId) });
    f.tracker.event(deleted(itemId)); await promise;
  }
  assert.deepEqual(f.tracker.event(providerError('rtc-2')), { handled: false, requestType: 'unknown' });
  assert.deepEqual(f.tracker.event(providerError('rtc-3')), handled('conversation.item.delete'));
  const rejected = assert.rejects(oldest, { code: 'item_not_found' });
  assert.deepEqual(f.tracker.event(providerError('rtc-1', 'item_not_found')), handled('conversation.item.delete')); await rejected;
  assert.equal(f.timers.size, 0); assert.deepEqual(f.issues, []);
});

test('a malformed acknowledgement matcher cannot break unrelated request settlement', async () => {
  const f = fixture(), bad = f.tracker.request(update('bad'), { match() { throw Error('private matcher details'); } });
  const good = f.tracker.request({ type: 'conversation.item.delete', item_id: 'good' }, { match: matchDelete('good') });
  f.tracker.event(deleted('good')); await good;
  const settled = Promise.allSettled([bad]); f.tracker.dispose();
  assert.equal((await settled)[0].reason.code, 'REQUEST_CANCELLED'); assert.deepEqual(f.issues, []);
});
