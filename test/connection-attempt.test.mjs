import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionAttempt, CALL_CONNECT_TIMEOUT_MS } from '../web/connection-attempt.js';

const pending = () => new Promise(() => {});
function clock() {
  const tasks = new Map(); let id = 0, delay;
  return { tasks, get delay() { return delay; }, later: (fn, ms) => { delay = ms; tasks.set(++id, fn); return id; },
    cancel: id => tasks.delete(id), fire() { const work = [...tasks.values()]; tasks.clear(); work.forEach(fn => fn()); } };
}

test('initial connection deadline releases non-abortable work and waiting RTC readiness', async () => {
  const controller = new AbortController(), timer = clock();
  const attempt = createConnectionAttempt({ controller, setTimeout: timer.later, clearTimeout: timer.cancel });
  const offer = attempt.wait(pending()), ready = attempt.waitUntilConnected();
  assert.equal(timer.delay, CALL_CONNECT_TIMEOUT_MS); timer.fire();
  await assert.rejects(offer, { code: 'CALL_CONNECT_TIMEOUT' }); await assert.rejects(ready, { code: 'CALL_CONNECT_TIMEOUT' });
  assert.equal(attempt.connected(), false, 'late readiness cannot revive an expired attempt'); assert.equal(timer.tasks.size, 0);
});

test('actual readiness permanently disarms the initial deadline', async () => {
  const controller = new AbortController(), timer = clock();
  const attempt = createConnectionAttempt({ controller, setTimeout: timer.later, clearTimeout: timer.cancel });
  const ready = attempt.waitUntilConnected(); assert.equal(attempt.connected(), true); await ready;
  timer.fire(); assert.equal(controller.signal.aborted, false); assert.equal(timer.tasks.size, 0);
  assert.equal(await attempt.wait(Promise.resolve('established')), 'established'); attempt.dispose();
});

test('explicit cancellation and disposal cannot resolve readiness later', async () => {
  for (const cancel of [controller => controller.abort(), (_, attempt) => attempt.dispose()]) {
    const controller = new AbortController(), timer = clock();
    const attempt = createConnectionAttempt({ controller, setTimeout: timer.later, clearTimeout: timer.cancel });
    const ready = attempt.waitUntilConnected(); cancel(controller, attempt);
    await assert.rejects(ready, { name: 'AbortError' }); assert.equal(attempt.connected(), false); assert.equal(timer.tasks.size, 0);
  }
});
