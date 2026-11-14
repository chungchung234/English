import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestSignal } from '../web/request-signal.js';

function clock() {
  const tasks = new Map(); let id = 0;
  return { tasks, later: fn => { tasks.set(++id, fn); return id; }, cancel: id => tasks.delete(id),
    fire() { const pending = [...tasks.values()]; tasks.clear(); pending.forEach(fn => fn()); } };
}

test('portable request signal works without AbortSignal static any/timeout and preserves caller cancellation', () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any'), timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  try {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const parent = new AbortController(), timer = clock(), reason = new Error('caller cancelled');
    const request = createRequestSignal({ signal: parent.signal, setTimeout: timer.later, clearTimeout: timer.cancel });
    assert.equal(request.signal.aborted, false);
    parent.abort(reason);
    assert.equal(request.signal.reason, reason); assert.equal(timer.tasks.size, 0);
    request.dispose();
  } finally {
    if (any) Object.defineProperty(AbortSignal, 'any', any); else delete AbortSignal.any;
    if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout); else delete AbortSignal.timeout;
  }
});

test('a request deadline aborts only its own request and is released on settlement', () => {
  const parent = new AbortController(), firstClock = clock(), secondClock = clock();
  const first = createRequestSignal({ signal: parent.signal, setTimeout: firstClock.later, clearTimeout: firstClock.cancel });
  const second = createRequestSignal({ signal: parent.signal, setTimeout: secondClock.later, clearTimeout: secondClock.cancel });
  firstClock.fire();
  assert.equal(first.signal.reason.name, 'TimeoutError'); assert.equal(second.signal.aborted, false); assert.equal(parent.signal.aborted, false);
  second.dispose(); assert.equal(secondClock.tasks.size, 0);
  parent.abort(); assert.equal(second.signal.aborted, false, 'completed request no longer follows its parent');
});

test('an already cancelled caller creates no live request timer', () => {
  const parent = new AbortController(), timer = clock(); parent.abort();
  const request = createRequestSignal({ signal: parent.signal, setTimeout: timer.later, clearTimeout: timer.cancel });
  assert.equal(request.signal.aborted, true); assert.equal(timer.tasks.size, 0);
});
