import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallCompletion } from '../web/call-completion.js';

function harness({ initialClock = 0, startedAt } = {}) {
  let clock = initialClock, nextId = 0;
  const timers = new Map(), callbacks = [], updates = [], reviews = [];
  const control = createCallCompletion({ now: () => clock, startedAt,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { at: clock + delay, fn }); callbacks.push(fn); return id; },
    clearTimeout(id) { timers.delete(id); }, onUpdate: state => updates.push(state), onReview: state => reviews.push(state) });
  function advance(ms) {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      clock = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    clock = target;
  }
  return { control, advance, timers, callbacks, updates, reviews };
}

test('a normal close waits for actual save acknowledgement instead of the former fixed visual delay', async () => {
  const h = harness();
  assert.deepEqual(h.control.state, { elapsedMs: 0, stage: 'transcribing', status: 'pending', reviewOpened: false, canReview: false });
  h.advance(600); assert.equal(h.reviews.length, 0);
  h.advance(1200); h.control.setStage('saving');
  h.advance(425);
  assert.equal(h.reviews.length, 0, 'a prepared transcript is not a server acknowledgement');
  assert.equal(h.control.state.elapsedMs, 2225);
  h.control.settle('saved'); await h.control.reviewed;
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].status, 'saved');
  assert.equal(h.reviews[0].elapsedMs, 2225);
  h.advance(8000); assert.equal(h.control.state.elapsedMs, 2225, 'saved duration does not continue during feedback');
  assert.equal(h.timers.size, 0);
});

test('an unusually fast acknowledgement preserves the end cue minimum without inflating measured storage time', async () => {
  const h = harness(); h.advance(80); h.control.settle('saved');
  assert.equal(h.control.state.elapsedMs, 80); assert.equal(h.reviews.length, 0);
  h.advance(519); assert.equal(h.reviews.length, 0);
  h.advance(1); await h.control.reviewed;
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].elapsedMs, 80);
  assert.equal(h.timers.size, 0);
});

test('an explicit hangup timestamp includes synchronous shutdown and anchors the minimum end cue', async () => {
  const h = harness({ initialClock: 1235, startedAt: 1000 });
  assert.equal(h.control.state.elapsedMs, 235, 'shutdown before construction is part of hangup-to-ack latency');
  h.advance(45); h.control.settle('saved');
  assert.equal(h.control.state.elapsedMs, 280);
  h.advance(319); assert.equal(h.reviews.length, 0);
  h.advance(1); await h.control.reviewed;
  assert.equal(h.reviews.length, 1, 'the minimum ends 600 ms after hangup, not after construction');
  assert.equal(h.reviews[0].elapsedMs, 280, 'the cue remainder does not inflate save latency');
  const pending = harness({ initialClock: 1235, startedAt: 1000 });
  pending.advance(2764); assert.equal(pending.control.openReview(), false);
  pending.advance(1); assert.equal(pending.control.openReview(), true, 'manual review is offered 3 seconds after hangup');
  pending.control.dispose();
  const invalid = harness({ initialClock: 1235, startedAt: Infinity });
  assert.equal(invalid.control.state.elapsedMs, 0, 'non-finite timestamps use the construction clock');
  invalid.control.dispose();
});

test('slow saving offers optional review but never navigates or claims success on a timer', async () => {
  const h = harness(); h.advance(2999);
  assert.equal(h.control.openReview(), false); assert.equal(h.reviews.length, 0);
  h.advance(1); assert.equal(h.control.state.canReview, true);
  h.advance(9000);
  assert.equal(h.control.state.status, 'pending'); assert.equal(h.reviews.length, 0);
  assert.equal(h.control.openReview(), true); await h.control.reviewed;
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].status, 'pending');
  assert.equal(h.control.openReview(), false);
  h.control.setStage('saving'); h.advance(2375);
  h.control.settle('saved');
  assert.equal(h.control.state.elapsedMs, 14375);
  assert.equal(h.control.state.status, 'saved'); assert.equal(h.reviews.length, 1, 'later save must not pull the learner back');
  assert.equal(h.timers.size, 0);
});

test('a failed or incomplete close is partial and cannot be changed by a duplicate late success', async () => {
  const h = harness(); h.advance(9750); h.control.settle('partial'); await h.control.reviewed;
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].status, 'partial');
  assert.equal(h.control.state.elapsedMs, 9750);
  assert.equal(h.control.settle('saved'), false); assert.equal(h.control.setStage('saving'), false);
  assert.equal(h.control.state.status, 'partial');
  const fast = harness(); fast.advance(100); fast.control.settle('partial'); fast.advance(500); await fast.control.reviewed;
  assert.equal(fast.reviews[0].status, 'partial'); assert.equal(fast.reviews[0].elapsedMs, 100);
});

test('disposal settles navigation waiters and invalidates pending or already queued callbacks', async () => {
  const h = harness(); h.advance(500);
  const before = h.updates.length, queued = [...h.callbacks];
  h.control.dispose(); await h.control.reviewed;
  for (const callback of queued) callback();
  h.advance(20000);
  assert.equal(h.timers.size, 0); assert.equal(h.updates.length, before); assert.equal(h.reviews.length, 0);
  assert.equal(h.control.state.elapsedMs, 500); assert.equal(h.control.settle('saved'), false);
  assert.equal(h.control.openReview(), false);
  const fast = harness(); fast.advance(100); fast.control.settle('saved');
  const reveal = [...fast.callbacks]; fast.control.dispose(); await fast.control.reviewed;
  for (const callback of reveal) callback(); fast.advance(1000);
  assert.equal(fast.reviews.length, 0, 'a disposed end-animation callback cannot navigate a later call');
});
