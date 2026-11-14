import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createVerifiedPcmPlayback, pcmSha256 } from '../web/verified-pcm-playback.js';
import { PcmRenderCursor } from '../web/verified-pcm-worklet.js';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = (n = 1) => ({ scope: `https://service.example|${uid(1)}`, sessionId: uid(2), companionId: 'alex', callEpoch: 1,
  turnNonce: uid(3 + n), turnId: uid(4 + n), assistantEventId: uid(5 + n), authorityGeneration: 1, expectedMemoryRevision: 3, playbackEpoch: n });
const textHash = 'a'.repeat(64), assetHash = 'b'.repeat(64), workletUrl = `https://app.example/assets/verified-pcm-worklet.${assetHash.slice(0, 12)}.js`;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const waitFor = async check => { const until = Date.now() + 1000; while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 3)); assert(check()); };
async function clip(owner = own(), frames = 2400) {
  const bytes = new ArrayBuffer(frames * 2), view = new DataView(bytes);
  for (let i = 0; i < frames; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 13) * 16000), true);
  const manifest = { version: 'verified-pcm-candidate-v1', owner: { ...owner }, textSha256: textHash,
    pcmSha256: await pcmSha256(bytes, webcrypto.subtle), format: 'pcm_s16le', sampleRate: 24000, channels: 1, sourceFrames: frames,
    byteLength: bytes.byteLength, synthesisId: uid(99), transcriptVerification: { status: 'matched', policyVersion: 'words-v1', approvedTextSha256: textHash }, synthesisSpeed: .85 };
  return { bytes, manifest, owner };
}
function harness(t, overrides = {}) {
  const contexts = [], nodes = [], events = []; let active = true;
  class Context {
    constructor() { contexts.push(this); this.sampleRate = 44100; this.state = 'suspended'; this.currentTime = 0; this.outputTime = 0; this.baseLatency = .005; this.outputLatency = .01;
      this.destination = { device: true }; this.loads = []; this.audioWorklet = { addModule: async url => { this.loads.push(url); } }; }
    createGain() { const connections = []; const gain = { value: 0, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; } };
      return this.gain = { gain, connections, connect: to => connections.push(to), disconnect() {} }; }
    createMediaStreamDestination() { return this.reference = { stream: { reference: true }, disconnect() {} }; }
    async resume() { this.resumeCalls = (this.resumeCalls || 0) + 1; if (this.blockResume) throw Error('gesture blocked'); this.state = 'running'; this.onstatechange?.(); }
    async close() { this.state = 'closed'; }
    getOutputTimestamp() { return { contextTime: this.outputTime, performanceTime: this.outputTime * 1000 }; }
  }
  class Node {
    constructor(context, name) { nodes.push(this); this.context = context; this.name = name; this.commands = []; this.port = { onmessage: null, close() {}, postMessage: message => {
      this.commands.push(message); this.token = message.token;
      const reply = (kind, extra = {}) => queueMicrotask(() => this.emit(kind, { commandId: message.commandId, ...extra }));
      if (message.kind === 'load') { this.cursor = new PcmRenderCursor(message.samples, context.sampleRate); reply('loaded'); }
      if (message.kind === 'play') this.cursor.resume();
      if (message.kind === 'pause') { this.cursor.pause(); reply('pause_applied', { candidateId: message.candidateId, decisionEpoch: message.decisionEpoch }); }
      if (message.kind === 'resume') { this.cursor.resume(); reply('resume_applied'); }
      if (message.kind === 'clear') this.cursor?.clear();
    } }; }
    connect(to) { this.connected = to; } disconnect() { this.connected = null; }
    emit(kind, extra = {}) { this.port.onmessage?.({ data: { kind, token: this.token, cursor: this.cursor?.snapshot(), ...extra } }); }
    advance(frames = 128) {
      const start = Math.round(this.context.currentTime * this.context.sampleRate), output = new Float32Array(frames), written = this.cursor.render(output, start);
      this.context.currentTime = (start + frames) / this.context.sampleRate;
      if (written && !this.started) { this.started = true; this.emit('started'); }
      if (this.cursor.drained && !this.drained) { this.drained = true; this.emit('render_drained', { sourceFrames: this.cursor.sourceFrame, finalContextFrameExclusive: this.cursor.finalContextFrameExclusive }); }
      else this.emit('progress');
      return output;
    }
  }
  const player = createVerifiedPcmPlayback({ workletUrl, workletSha256: assetHash, baseUrl: 'https://app.example/',
    AudioContextConstructor: Context, AudioWorkletNodeConstructor: Node, subtle: webcrypto.subtle, isCurrent: () => active,
    onEvent: event => events.push(event), pollIntervalMs: 2, commandTimeoutMs: 100, drainTimeoutMs: 150, ...overrides });
  t.after(() => player.dispose());
  return { player, contexts, nodes, events, Context, Node, active: value => { active = value; }, count: kind => events.filter(event => event.kind === kind).length };
}

test('prepare-only admission rejects corrupt bytes, text/owner/format/revision mismatch before constructing an audio graph', async t => {
  const f = harness(t), c = await clip();
  const bad = c.bytes.slice(0); new Uint8Array(bad)[0] ^= 1;
  assert.equal(await f.player.prepare(c.owner, textHash, c.manifest, bad), false);
  for (const change of [{ sampleRate: 8000 }, { byteLength: 2 }, { transcriptVerification: { ...c.manifest.transcriptVerification, status: 'unmatched' } },
    { owner: { ...c.owner, expectedMemoryRevision: 4 } }, { owner: { ...c.owner, scope: `https://service.example|${uid(100)}` } }]) {
    assert.equal(await f.player.prepare(c.owner, textHash, { ...c.manifest, ...change }, c.bytes), false);
  }
  assert.equal(await f.player.prepare(c.owner, 'c'.repeat(64), c.manifest, c.bytes), false);
  assert.equal(f.contexts.length, 0); assert.equal(f.nodes.length, 0); assert.equal(f.count('played_through'), 0);
});

test('next-turn gesture preflight unlocks only the empty context after completed or terminal clips while clip ownership stays strict', async t => {
  for (const ending of ['played_through', 'explicit_stop']) {
    let authorized = true;
    const f = harness(t, { canUnlockContext: () => authorized }), c = await clip();
    await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.play(c.owner);
    const ctx = f.contexts[0], node = f.nodes[0]; node.advance();
    if (ending === 'played_through') {
      while (!node.cursor.drained) node.advance(); ctx.outputTime = (f.player.state.finalContextFrameExclusive + 1) / ctx.sampleRate;
      await waitFor(() => f.count('played_through') === 1);
    } else f.player.cancel(c.owner);
    const starts = f.count('started'), completions = f.count('played_through'), resumeCalls = ctx.resumeCalls;
    f.active(false); // The old turn no longer owns output; the same call still does.
    ctx.state = 'suspended'; ctx.onstatechange();
    const unlocking = f.player.unlockFromGesture();
    assert.equal(ctx.resumeCalls, resumeCalls + 1, 'context resume is entered synchronously before any await');
    assert.equal(await unlocking, true); assert.equal(ctx.state, 'running'); assert.equal(ctx.gain.gain.value, 0);
    assert.equal(f.count('started'), starts); assert.equal(f.count('played_through'), completions); assert.equal(f.nodes.length, 1);
    assert.equal(f.player.play(c.owner), false); assert.equal(await f.player.prepare(c.owner, textHash, c.manifest, c.bytes), false);
    authorized = false; const beforeDenied = ctx.resumeCalls; assert.equal(await f.player.unlockFromGesture(), false); assert.equal(ctx.resumeCalls, beforeDenied);
    authorized = true; f.active(true);
    const next = await clip(own(2)); assert(await f.player.prepare(next.owner, textHash, next.manifest, next.bytes)); assert(f.player.play(next.owner));
    const nextNode = f.nodes[1]; while (!nextNode.cursor.drained) nextNode.advance(); ctx.outputTime = (f.player.state.finalContextFrameExclusive + 1) / ctx.sampleRate;
    await waitFor(() => f.count('played_through') === completions + 1);
    assert.equal(f.contexts.length, 1); assert.equal(f.count('started'), starts + 1);
  }
});

test('context-only preflight rechecks call authority after its await and never revives a revoked or disposed source', async t => {
  let authorized = true;
  const f = harness(t, { canUnlockContext: () => authorized }), c = await clip();
  await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.cancel(c.owner); f.active(false);
  const ctx = f.contexts[0]; let resume;
  ctx.resume = () => new Promise(resolve => { resume = () => { ctx.state = 'running'; resolve(); }; });
  const unlocking = f.player.unlockFromGesture(); authorized = false; resume();
  assert.equal(await unlocking, false); assert.equal(ctx.gain.gain.value, 0); assert.equal(f.count('started'), 0); assert.equal(f.count('played_through'), 0);
  authorized = true; f.player.dispose(); assert.equal(await f.player.unlockFromGesture(), false);
});

test('PCM ownership is immutable across digest awaits and caller byte mutation; stale owner never loads a worklet', async t => {
  let finishDigest;
  const f = harness(t, { subtle: { digest: (_kind, bytes) => new Promise(resolve => { finishDigest = () => webcrypto.subtle.digest('SHA-256', bytes).then(resolve); }) } });
  const c = await clip(), preparing = f.player.prepare(c.owner, textHash, c.manifest, c.bytes);
  f.active(false); finishDigest(); assert.equal(await preparing, false); assert.equal(f.contexts.length, 0);
  assert.equal(f.count('terminal'), 1);
  const g = harness(t), d = await clip(own(2)); const expected = new DataView(d.bytes).getInt16(2, true) / 32768;
  const pending = g.player.prepare(d.owner, textHash, d.manifest, d.bytes); new Uint8Array(d.bytes).fill(0); d.owner.scope = `https://changed.example|${uid(1)}`;
  assert.equal(await pending, true); assert.equal(g.nodes[0].cursor.samples[1], expected);
  assert.notEqual(g.player.state.owner.scope, d.owner.scope); assert(Object.isFrozen(g.player.state.owner));
});

test('same-site content-hashed Worklet URLs are mandatory and output reference branches after the gain', async t => {
  for (const value of ['blob:https://app.example/token', 'data:text/javascript,anything', 'https://other.example/assets/verified-pcm-worklet.bbbbbbbbbbbb.js',
    'https://app.example/verified-pcm-worklet.js', workletUrl + '?x=1']) assert.throws(() => createVerifiedPcmPlayback({ workletUrl: value, baseUrl: 'https://app.example/' }), /content-hashed/);
  assert.throws(() => createVerifiedPcmPlayback({ workletUrl, workletSha256: 'c'.repeat(64), baseUrl: 'https://app.example/' }), /content-hashed/);
  const f = harness(t), c = await clip(); assert.equal(await f.player.prepare(c.owner, textHash, c.manifest, c.bytes), true);
  const ctx = f.contexts[0]; assert.deepEqual(ctx.loads, [workletUrl]); assert.equal(f.nodes[0].name, 'loop-verified-pcm-v1');
  assert.equal(f.nodes[0].connected, ctx.gain); assert.deepEqual(ctx.gain.connections, [ctx.destination, ctx.reference]); assert.equal(f.player.referenceStream, ctx.reference.stream);
  let stopped = 0; ctx.reference.stream.getTracks = () => [{ stop: () => stopped++ }]; f.player.dispose(); f.player.dispose(); assert.equal(stopped, 1);
});

test('candidate reasons and decision epochs preserve the exact source cursor and cannot release another candidate', async t => {
  const f = harness(t), c = await clip(); await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.play(c.owner);
  const node = f.nodes[0]; node.advance(127); const before = node.cursor.snapshot();
  assert(f.player.pauseCandidate(c.owner, 'first', 1)); assert(f.player.pauseCandidate(c.owner, 'second', 2)); await settle();
  node.advance(513); assert.deepEqual(node.cursor.snapshot(), before);
  assert.equal(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'second', decisionEpoch: 1 }), false);
  assert.equal(f.player.resolveCandidate(c.owner, { kind: 'accepted_turn', candidateId: 'not-pending' }), false);
  assert.equal(f.player.resolveCandidate(c.owner, { kind: 'asr_failed', candidateId: 'first', decisionEpoch: 1 }), false);
  assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'first', decisionEpoch: 1 })); node.advance(); assert.deepEqual(node.cursor.snapshot(), before);
  assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_echo', candidateId: 'second', decisionEpoch: 2 })); await settle();
  const resumed = f.events.find(event => event.kind === 'resume_applied'); assert.deepEqual(resumed.cursor, before);
  assert.equal(f.player.pauseCandidate(c.owner, 'first', 1), 0, 'a duplicate old candidate cannot reopen its resolved pause');
  node.advance(); assert(node.cursor.sourceFrame > before.sourceFrame);
});

test('candidate holds survive digest and load-ACK waits and prevent the first sample until each reason is resolved', async t => {
  let finishDigest, releaseLoad;
  const f = harness(t, { subtle: { digest: (_kind, bytes) => new Promise(resolve => { finishDigest = () => webcrypto.subtle.digest('SHA-256', bytes).then(resolve); }) } });
  await f.player.unlockFromGesture();
  const actualEmit = f.Node.prototype.emit;
  f.Node.prototype.emit = function (kind, extra) {
    if (kind === 'loaded') releaseLoad = () => actualEmit.call(this, kind, extra);
    else actualEmit.call(this, kind, extra);
  };
  const c = await clip(), work = f.player.prepare(c.owner, textHash, c.manifest, c.bytes);
  assert.equal(f.player.pauseCandidate(c.owner, 'during-digest', 1), 0); assert.equal(f.player.state.paused, true);
  finishDigest(); await waitFor(() => typeof releaseLoad === 'function');
  assert.equal(f.player.pauseCandidate(c.owner, 'during-load', 2), 0);
  releaseLoad(); assert.equal(await work, true); await settle();
  assert.equal(f.player.play(c.owner), false); const node = f.nodes[0]; node.advance();
  assert.equal(node.cursor.sourceFrame, 0); assert.equal(f.count('started'), 0);
  assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'during-digest', decisionEpoch: 1 }));
  node.advance(); assert.equal(node.cursor.sourceFrame, 0);
  assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_echo', candidateId: 'during-load', decisionEpoch: 2 }));
  await settle(); node.advance(); assert(node.cursor.sourceFrame > 0); assert.equal(f.count('started'), 1);
});

test('explicit clear is synchronously gated and terminal despite late candidate, drain, prepare, or reconnect calls', async t => {
  const f = harness(t), c = await clip(); await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.play(c.owner);
  const node = f.nodes[0]; node.advance(); f.player.pauseCandidate(c.owner, 'noise', 1); await settle();
  assert(f.player.cancel(c.owner)); assert.equal(f.contexts[0].gain.gain.value, 0); assert.equal(node.cursor.terminal, true);
  node.emit('render_drained', { sourceFrames: c.manifest.sourceFrames, finalContextFrameExclusive: 1 });
  assert.equal(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'noise', decisionEpoch: 1 }), false);
  assert.equal(await f.player.prepare(c.owner, textHash, c.manifest, c.bytes), false); assert.equal(f.player.play(c.owner), false);
  await f.player.unlockFromGesture(); assert.equal(f.count('started'), 1); assert.equal(f.count('played_through'), 0);
  assert.equal(f.count('terminal'), 1);
});

test('generation/byte readiness and render drain cannot claim played-through before the actual output marker', async t => {
  const f = harness(t), c = await clip(); await f.player.unlockFromGesture(); assert(await f.player.prepare(c.owner, textHash, c.manifest, c.bytes));
  assert.equal(f.count('played_through'), 0); f.player.play(c.owner); const node = f.nodes[0], ctx = f.contexts[0];
  while (!node.cursor.drained) node.advance();
  assert.equal(f.count('render_drained'), 1); await new Promise(resolve => setTimeout(resolve, 8)); assert.equal(f.count('played_through'), 0);
  const boundary = f.player.state.finalContextFrameExclusive;
  ctx.outputTime = (boundary - 1) / ctx.sampleRate; await new Promise(resolve => setTimeout(resolve, 8)); assert.equal(f.count('played_through'), 0);
  ctx.outputTime = (boundary + 1) / ctx.sampleRate; await waitFor(() => f.count('played_through') === 1);
  assert.equal(f.events.find(event => event.kind === 'played_through').evidence, 'client_reported_playback_completed');
  assert.equal(f.player.state.playedThrough, true);
  assert.equal(await f.player.prepare(c.owner, textHash, c.manifest, c.bytes), false, 'completed playback cannot be re-admitted under its old epoch');
  assert.equal(f.player.play(c.owner), false); f.player.dispose(); assert.equal(f.count('terminal'), 0, 'cleanup cannot retroactively cancel already completed evidence');
});

test('missing output clock or lost device continuity yields only weak estimated drain, never completion evidence', async t => {
  const f = harness(t), c = await clip(); await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.play(c.owner);
  const ctx = f.contexts[0], node = f.nodes[0]; ctx.getOutputTimestamp = undefined;
  while (!node.cursor.drained) node.advance(); ctx.currentTime += 1;
  await waitFor(() => f.count('estimated_drain') === 1); assert.equal(f.count('played_through'), 0);
  assert.equal(f.player.state.playedThrough, false); assert.equal(f.player.state.completionKind, 'estimated_drain');
  const g = harness(t), d = await clip(own(2)); await g.player.unlockFromGesture(); await g.player.prepare(d.owner, textHash, d.manifest, d.bytes); g.player.play(d.owner); g.nodes[0].advance();
  const audio = g.contexts[0]; audio.state = 'suspended'; audio.onstatechange(); assert.equal(audio.gain.gain.value, 0); await settle();
  assert.equal(g.player.state.continuityUncertain, true); await g.player.unlockFromGesture();
  while (!g.nodes[0].cursor.drained) g.nodes[0].advance(); audio.currentTime += 1; audio.outputTime = audio.currentTime;
  await waitFor(() => g.count('estimated_drain') === 1); assert.equal(g.count('played_through'), 0);
});

test('context interruption after render drain can resume only weak drain polling without replaying consumed samples', async t => {
  const f = harness(t), c = await clip(); await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.play(c.owner);
  const ctx = f.contexts[0], node = f.nodes[0]; while (!node.cursor.drained) node.advance();
  const commands = node.commands.filter(command => ['play', 'resume'].includes(command.kind)).length;
  ctx.state = 'suspended'; ctx.onstatechange(); await settle(); assert.equal(f.player.state.paused, true);
  assert.equal(await f.player.unlockFromGesture(), true); ctx.currentTime += 1; ctx.outputTime = ctx.currentTime;
  await waitFor(() => f.count('estimated_drain') === 1);
  assert.equal(node.commands.filter(command => ['play', 'resume'].includes(command.kind)).length, commands, 'drained source must not receive another play/resume');
  assert.equal(ctx.gain.gain.value, 0); assert.equal(f.count('played_through'), 0); assert.equal(f.count('started'), 1);
});

test('autoplay retry starts the same admitted clip once while scope revocation and disposal make late unlock harmless', async t => {
  const f = harness(t), c = await clip(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes);
  const ctx = f.contexts[0]; ctx.blockResume = true;
  assert.equal(f.player.play(c.owner), false); assert.equal(await f.player.unlockFromGesture(), false); assert.equal(f.count('started'), 0);
  ctx.blockResume = false; assert(await f.player.unlockFromGesture()); f.nodes[0].advance();
  assert.equal(f.count('started'), 1); assert(f.player.play(c.owner)); f.nodes[0].advance(); assert.equal(f.count('started'), 1);
  f.active(false); await waitFor(() => f.player.state.terminal); assert.equal(ctx.gain.gain.value, 0); assert.equal(await f.player.unlockFromGesture(), false);
  const g = harness(t); let resume; g.Context.prototype.resume = () => new Promise(resolve => { resume = resolve; });
  const unlocking = g.player.unlockFromGesture(); g.player.dispose(); resume(); assert.equal(await unlocking, false); assert.equal(g.events.length, 0);
});

test('abort during preparation prevents late graph admission and releases the original owner only', async t => {
  let release; const controller = new AbortController(), f = harness(t, { subtle: { digest: (_kind, bytes) => new Promise(resolve => { release = () => webcrypto.subtle.digest('SHA-256', bytes).then(resolve); }) } }), c = await clip();
  const work = f.player.prepare(c.owner, textHash, c.manifest, c.bytes, controller.signal); controller.abort(); release();
  assert.equal(await work, false); assert.equal(f.contexts.length, 0); assert.equal(f.count('terminal'), 1); assert.equal(f.events[0].owner.sessionId, c.owner.sessionId);
});

test('explicit user resume is not a fabricated noise decision and cannot release another reason or stale candidate epoch', async t => {
  const f = harness(t), c = await clip(); await f.player.unlockFromGesture(); await f.player.prepare(c.owner, textHash, c.manifest, c.bytes); f.player.play(c.owner); f.nodes[0].advance(127);
  f.player.pauseCandidate(c.owner, 'uncertain', 1); f.player.pauseCandidate(c.owner, 'other', 2); await settle(); const cursor = f.player.state.cursor;
  assert.equal(await f.player.resumeFromGesture(c.owner), false);
  assert.equal(await f.player.resumeFromGesture(c.owner, { candidateId: 'not-pending' }), false);
  assert.equal(await f.player.resumeFromGesture(c.owner, { candidateId: 'uncertain', decisionEpoch: 0 }), false);
  assert.equal(await f.player.resumeFromGesture(c.owner, { candidateId: 'uncertain', decisionEpoch: 1 }), false, 'other unresolved candidate still blocks playback');
  f.nodes[0].advance(); assert.deepEqual(f.player.state.cursor, cursor);
  assert(await f.player.resumeFromGesture(c.owner, { candidateId: 'other', decisionEpoch: 2 })); await settle();
  assert.equal(f.count('candidate_dismissed_by_user'), 2); assert.deepEqual(f.events.find(event => event.kind === 'resume_applied').cursor, cursor);
  f.player.cancel(c.owner); assert.equal(await f.player.resumeFromGesture(c.owner), false);
});

test('44.1/48kHz rational cursor preserves bit-identical content across arbitrary pause blocks and terminal clear', () => {
  const samples = Float32Array.from({ length: 1009 }, (_, i) => Math.sin(i * .27) * .7);
  for (const rate of [44100, 48000]) {
    const render = (paused) => {
      const cursor = new PcmRenderCursor(samples, rate); cursor.resume(); let absolute = 4000, index = 0; const audio = [];
      while (!cursor.drained) {
        if (paused && index === 2) { cursor.pause(); const before = cursor.snapshot(), silence = new Float32Array(777); assert.equal(cursor.render(silence, absolute), 0); absolute += 777;
          assert(silence.every(value => value === 0)); assert.deepEqual(cursor.snapshot(), before); cursor.resume(); }
        const block = new Float32Array([127, 63, 129, 17][index++ % 4]); const written = cursor.render(block, absolute); audio.push(...block.subarray(0, written)); absolute += block.length;
      }
      return { audio, cursor, absolute };
    };
    const uninterrupted = render(false), paused = render(true); assert.deepEqual(paused.audio, uninterrupted.audio);
    assert.equal(paused.cursor.renderedContextFrames, Math.ceil(samples.length * rate / 24000));
    assert.equal(paused.cursor.finalContextFrameExclusive, uninterrupted.cursor.finalContextFrameExclusive + 777);
    const cursor = new PcmRenderCursor(samples, rate); cursor.resume(); cursor.render(new Float32Array(13), 0); cursor.clear(); cursor.resume();
    const silent = new Float32Array(100); assert.equal(cursor.render(silent, 13), 0); assert(silent.every(value => value === 0));
  }
});
