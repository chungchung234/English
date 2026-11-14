import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionAttempt, finishConnectionSession, CALL_CONNECT_TIMEOUT_MS } from '../web/connection-attempt.js';

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

test('late creation waits for an unacknowledged close and retries after its pre-insert rejection',async()=>{
 const attempt={sessionId:'owned-session'},calls=[];let rejectFirst;
 const finish=async id=>{calls.push(id);if(calls.length===1)return new Promise((_,reject)=>{rejectFirst=reject;});};
 const first=finishConnectionSession(attempt,{finish});await Promise.resolve();
 assert.notEqual(attempt.sessionClosed,true,'sending is not a close receipt');
 const late=finishConnectionSession(attempt,{finish});assert.equal(calls.length,1);
 rejectFirst(Error('Session not found before insert committed'));
 assert.equal(await first,false);assert.equal(await late,true);assert.equal(attempt.sessionClosed,true);
 assert.deepEqual(calls,['owned-session','owned-session']);await finishConnectionSession(attempt,{finish});assert.equal(calls.length,2);
});

test('a close queued behind a failed request cannot send under a different account scope',async()=>{
 const attempt={sessionId:'old-session'};let current=true,rejectFirst,calls=0;
 const options={isCurrent:()=>current,finish:()=>{calls++;return new Promise((_,reject)=>{rejectFirst=reject;});}};
 const first=finishConnectionSession(attempt,options);await Promise.resolve();const late=finishConnectionSession(attempt,options);
 current=false;rejectFirst(Error('offline'));await first;assert.equal(await late,false);assert.equal(calls,1);assert.notEqual(attempt.sessionClosed,true);
});
