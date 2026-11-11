import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallCues } from '../web/call-cues.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture({ suspended = false, constructFails = false, toneFails = false } = {}) {
  const contexts = [], timers = new Map(); let clock = 0, nextTimer = 0;
  const parameter = () => ({ events: [], setValueAtTime(value, time) { this.events.push({ value, time }); }, linearRampToValueAtTime(value, time) { this.events.push({ value, time }); } });
  class AudioContext {
    constructor() {
      if (constructFails) throw Error('Audio unsupported');
      this.state = suspended ? 'suspended' : 'running'; this.destination = {}; this.oscillators = []; this.gains = []; this.resumes = [];
      this.closed = 0; contexts.push(this);
    }
    get currentTime() { return clock / 1000; }
    resume() { const pending = deferred(); this.resumes.push(pending); return pending.promise; }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    createOscillator() {
      if (toneFails) throw Error('Audio node unavailable');
      const node = { frequency: parameter(), starts: [], stops: [], disconnected: false,
        connect() {}, disconnect() { this.disconnected = true; }, start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); } };
      this.oscillators.push(node); return node;
    }
    createGain() { const node = { gain: parameter(), disconnected: false, connect() {}, disconnect() { this.disconnected = true; } }; this.gains.push(node); return node; }
  }
  const cues = createCallCues({ AudioContext, setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id) });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    clock = until;
  }
  const resume = async ctx => { ctx.state = 'running'; ctx.resumes.at(-1).resolve(); await settle(); };
  return { cues, contexts, timers, advance, resume };
}

test('connecting creates and resumes audio synchronously, and actual connection immediately silences and closes it', async () => {
  const f = fixture({ suspended: true }); f.cues.startConnecting();
  assert.equal(f.contexts.length, 1); const ctx = f.contexts[0];
  assert.equal(ctx.resumes.length, 1, 'resume retains the click activation instead of waiting for call setup');
  assert.equal(ctx.oscillators.length, 0);
  await f.resume(ctx); assert.equal(ctx.oscillators.length, 2); assert.equal(f.timers.size, 1);
  f.cues.connected(); assert.equal(ctx.closed, 1); assert.equal(f.timers.size, 0);
  assert(ctx.oscillators.every(node => node.disconnected && node.stops.includes(undefined)));
  assert(ctx.gains.every(node => node.disconnected));
  f.advance(10000); assert.equal(ctx.oscillators.length, 2); f.cues.dispose();
});

test('connecting repeats with one timer and a bounded audio graph even when onended is omitted', () => {
  const f = fixture(); f.cues.startConnecting(); f.cues.startConnecting();
  assert.equal(f.contexts.length, 1); const ctx = f.contexts[0];
  for (let i = 0; i < 20; i++) {
    assert.equal(ctx.oscillators.filter(node => !node.disconnected).length, 2);
    assert.equal(f.timers.size, 1); f.advance(1600);
  }
  f.cues.stopConnecting(); assert.equal(ctx.closed, 1); assert.equal(f.timers.size, 0);
  f.cues.startConnecting(); assert.equal(f.contexts.length, 2, 'reconnection gets its own live context');
  f.cues.dispose(); assert.equal(f.contexts[1].closed, 1);
});

test('late resume cannot resurrect a connected or disposed attempt or interfere with a new end cue', async () => {
  const f = fixture({ suspended: true }); f.cues.startConnecting(); const old = f.contexts[0];
  f.cues.connected(); f.cues.end(); const end = f.contexts[1];
  await f.resume(old); assert.equal(old.oscillators.length, 0);
  await f.resume(end); assert.equal(end.oscillators.length, 2);
  f.cues.dispose(); f.advance(10000); assert.equal(end.closed, 1); assert.equal(f.timers.size, 0);
  const g = fixture({ suspended: true }); g.cues.startConnecting(); const pending = g.contexts[0]; g.cues.dispose();
  await g.resume(pending); g.cues.startConnecting(); g.cues.end();
  assert.equal(pending.oscillators.length, 0); assert.equal(g.contexts.length, 1); assert.equal(g.timers.size, 0);
});

test('ending cancels connection pulses, plays one short descending cue and releases every resource', () => {
  const f = fixture(); f.cues.startConnecting(); const connecting = f.contexts[0];
  f.cues.end(); f.cues.end(); f.cues.connected(); const ending = f.contexts[1];
  assert.equal(connecting.closed, 1); assert.equal(f.contexts.length, 2);
  assert.equal(ending.oscillators.length, 2);
  assert(ending.oscillators[0].frequency.events[0].value > ending.oscillators[1].frequency.events[0].value);
  assert(ending.oscillators.at(-1).stops[0] < .4, 'end sound fits the short transition');
  assert(ending.gains.every(node => Math.max(...node.gain.events.map(event => event.value)) <= .04));
  f.advance(420); assert.equal(ending.closed, 1); assert.equal(f.timers.size, 0);
  assert(ending.oscillators.every(node => node.disconnected)); assert(ending.gains.every(node => node.disconnected));
  f.cues.end(); f.cues.startConnecting(); assert.equal(f.contexts.length, 2); f.cues.dispose();
});

test('a suspended end sound expires without waiting for browser audio permission', async () => {
  const f = fixture({ suspended: true }); f.cues.end(); const ctx = f.contexts[0];
  f.advance(420); assert.equal(ctx.closed, 1); assert.equal(f.timers.size, 0);
  await f.resume(ctx); assert.equal(ctx.oscillators.length, 0); f.cues.dispose();
});

test('missing audio, constructor, playback and node failures remain silent and never escape into call flow', async () => {
  const missing = createCallCues({ AudioContext: null });
  assert.doesNotThrow(() => { missing.startConnecting(); missing.connected(); missing.end(); missing.dispose(); });
  for (const options of [{ constructFails: true }, { toneFails: true }]) {
    const f = fixture(options); assert.doesNotThrow(() => { f.cues.startConnecting(); f.cues.end(); f.cues.dispose(); });
    assert.equal(f.timers.size, 0); assert(f.contexts.every(ctx => ctx.closed === 1));
  }
  const f = fixture({ suspended: true }); f.cues.startConnecting();
  f.contexts[0].resumes[0].reject(Error('Autoplay blocked')); await settle();
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.timers.size, 0);
  f.cues.end(); f.contexts[1].resumes[0].reject(Error('Autoplay blocked')); await settle();
  assert.equal(f.contexts[1].closed, 1); assert.equal(f.timers.size, 0); f.cues.dispose();
});
