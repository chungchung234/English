import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallPlayback } from '../web/call-playback.js';

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function events() {
  const listeners = new Map();
  return { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    fire: (name, extra = {}) => listeners.get(name)?.({ type: name, ...extra }), listeners };
}

test('a real user gesture retries blocked playback on the same stream without changing floor mute', async () => {
  const target = events(), stream = {}, element = { muted: true, srcObject: null }, notices = [];
  let calls = 0;
  element.play = async () => { if (++calls === 1) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
  const playback = createCallPlayback({ element, eventTarget: target, onBlocked: () => notices.push('blocked'), onRecovered: () => notices.push('recovered') });
  playback.attach(stream); await settle(); assert.equal(playback.blocked, true); assert.deepEqual(notices, ['blocked']);
  playback.attach(stream); assert.equal(calls, 1, 'ordinary repeated attachment does not spam play attempts');
  target.fire('pointerdown'); await settle();
  assert.equal(calls, 2); assert.equal(playback.blocked, false); assert.equal(element.srcObject, stream); assert.equal(element.muted, true);
  assert.deepEqual(notices, ['blocked', 'recovered']); playback.dispose(); assert.equal(target.listeners.size, 0);
});

test('keyboard recovery works while stale and disposed calls never resume playback', async () => {
  const target = events(), element = { play: async () => { calls++; throw Error('blocked'); } }; let calls = 0, current = true;
  const playback = createCallPlayback({ element, eventTarget: target, isCurrent: () => current });
  playback.attach({}); await settle(); target.fire('keydown', { key: 'a' }); await settle(); assert.equal(calls, 1);
  target.fire('keydown', { key: 'Enter' }); await settle(); assert.equal(calls, 2);
  current = false; target.fire('pointerdown'); await settle(); assert.equal(calls, 2);
  playback.dispose(); current = true; await playback.retry(); assert.equal(calls, 2);
});

test('late play settlement from a replaced stream cannot publish another call state', async () => {
  const target = events(), blocked = []; let rejectOld, calls = 0;
  const element = { play: () => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve() };
  const playback = createCallPlayback({ element, eventTarget: target, onBlocked: () => blocked.push(true) });
  playback.attach({ old: true }); playback.attach({ next: true }); await settle();
  rejectOld(Error('old stream failed')); await settle(); assert.deepEqual(blocked, []); assert.equal(playback.blocked, false); playback.dispose();
});
