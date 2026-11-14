import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSegmentedPcmPlayback } from '../web/segmented-pcm-playback.js';
import { pcmSha256 } from '../web/verified-pcm-playback.js';
import { PcmRenderCursor } from '../web/verified-pcm-worklet.js';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = (n = 1) => ({ scope: `https://service.example|${uid(1)}`, sessionId: uid(2), companionId: 'alex', callEpoch: 1,
  turnNonce: uid(10 + n), turnId: uid(30 + n), assistantEventId: uid(50 + n), authorityGeneration: 1, expectedMemoryRevision: 3, playbackEpoch: n });
const assetHash = 'b'.repeat(64), workletUrl = `https://app.example/assets/verified-pcm-worklet.${assetHash.slice(0, 12)}.js`;
const hash = bytes => pcmSha256(bytes instanceof ArrayBuffer ? bytes : new TextEncoder().encode(bytes).buffer, webcrypto.subtle);
const waitFor = async check => { const end = Date.now() + 1500; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2)); assert(check(), 'condition did not settle'); };

async function fixture(texts = ['Hello. ', 'How are you?'], owner = own(), frames = 240) {
  const text = texts.join(''), textSha256 = await hash(text), count = texts.length; let offset = 0;
  const parts = [], segments = [];
  for (const [index, partText] of texts.entries()) {
    const textBytes = new TextEncoder().encode(partText), partHash = await hash(partText), bytes = new ArrayBuffer(frames * 2), view = new DataView(bytes);
    for (let i = 0; i < frames; i++) view.setInt16(i * 2, 1000 + index * 100 + i % 20, true);
    const range = { index, startByte: offset, endByte: offset + textBytes.length, textSha256: partHash }; offset = range.endByte; parts.push(range);
    const manifest = { version: 'verified-pcm-segment-v1', owner: { ...owner }, ...range, count, parentTextSha256: textSha256,
      pcmSha256: await hash(bytes), format: 'pcm_s16le', sampleRate: 24000, channels: 1, sourceFrames: frames, byteLength: bytes.byteLength,
      synthesisId: uid(99), synthesisSpeed: .85, transcriptVerification: { status: 'matched', policyVersion: 'lexical-fidelity-v1', approvedTextSha256: partHash } };
    segments.push({ bytes, manifest });
  }
  const all = new Uint8Array(segments.reduce((sum, part) => sum + part.bytes.byteLength, 0)); let at = 0;
  for (const segment of segments) { all.set(new Uint8Array(segment.bytes), at); at += segment.bytes.byteLength; }
  const final = { version: 'verified-pcm-candidate-v1', owner: { ...owner }, textSha256, pcmSha256: await hash(all.buffer), format: 'pcm_s16le',
    sampleRate: 24000, channels: 1, sourceFrames: all.length / 2, byteLength: all.length, synthesisId: uid(99), synthesisSpeed: .85,
    transcriptVerification: { status: 'matched', policyVersion: 'lexical-fidelity-v1', approvedTextSha256: textSha256 } };
  return { owner, text, textSha256, plan: { version: 'verified-speech-segments-v1', count, textByteLength: offset, textSha256, parts }, segments, final };
}
function harness(t, overrides = {}, { timestamps = true, delayLoad = false } = {}) {
  const contexts = [], nodes = [], events = [], destinations = []; let active = true, maxConnected = 0;
  const track = () => ({ stops: 0, stop() { this.stops++; } });
  class Context {
    constructor() { contexts.push(this); this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0; this.outputTime = 0; this.destination = {};
      this.baseLatency = .001; this.outputLatency = .001; this.loads = []; this.closes = 0; this.sources = [];
      this.audioWorklet = { addModule: async url => { this.loads.push(url); } }; if (!timestamps) this.getOutputTimestamp = undefined; }
    createGain() { return { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { const ownedTrack = track(), dest = { stream: { getTracks: () => [ownedTrack] }, track: ownedTrack, disconnect() {} }; destinations.push(dest); return dest; }
    createMediaStreamSource(stream) { const source = { stream, connected: null, connect(to) { this.connected = to; }, disconnect() { this.connected = null; } }; this.sources.push(source); return source; }
    async resume() { this.resumes = (this.resumes || 0) + 1; this.state = 'running'; this.onstatechange?.(); }
    async close() { this.closes++; this.state = 'closed'; this.onstatechange?.(); }
    getOutputTimestamp() { return { contextTime: this.outputTime, performanceTime: this.outputTime * 1000 }; }
  }
  class Node {
    constructor(context) { this.context = context; nodes.push(this); this.connected = false; this.closed = false; this.commands = [];
      this.port = { onmessage: null, close: () => { this.closed = true; }, postMessage: message => {
        this.commands.push(message); this.token = message.token;
        const reply = (kind, extra = {}) => queueMicrotask(() => this.emit(kind, { commandId: message.commandId, ...extra }));
        if (message.kind === 'load') {
          this.cursor = new PcmRenderCursor(message.samples, context.sampleRate);
          if (delayLoad) this.releaseLoad = () => reply('loaded'); else reply('loaded');
        }
        if (message.kind === 'play') this.cursor.resume();
        if (message.kind === 'pause') { this.cursor.pause(); reply('pause_applied', { candidateId: message.candidateId, decisionEpoch: message.decisionEpoch }); }
        if (message.kind === 'resume') { this.cursor.resume(); reply('resume_applied'); }
        if (message.kind === 'clear') this.cursor?.clear();
      } };
    }
    connect() { this.connected = true; maxConnected = Math.max(maxConnected, nodes.filter(node => node.connected).length); }
    disconnect() { this.connected = false; }
    emit(kind, extra = {}) { this.port.onmessage?.({ data: { kind, token: this.token, cursor: this.cursor?.snapshot(), ...extra } }); }
    advance(frames = 128) {
      const first = Math.round(this.context.currentTime * this.context.sampleRate), output = new Float32Array(frames), written = this.cursor.render(output, first);
      this.context.currentTime = (first + frames) / this.context.sampleRate; this.context.outputTime = this.context.currentTime;
      if (written && !this.started) { this.started = true; this.emit('started'); }
      if (this.cursor.drained && !this.drained) { this.drained = true; this.emit('render_drained', { sourceFrames: this.cursor.sourceFrame, finalContextFrameExclusive: this.cursor.finalContextFrameExclusive }); }
      else this.emit('progress'); return output;
    }
  }
  const player = createSegmentedPcmPlayback({ workletUrl, workletSha256: assetHash, baseUrl: 'https://app.example/', AudioContextConstructor: Context,
    AudioWorkletNodeConstructor: Node, subtle: webcrypto.subtle, isCurrent: () => active, onEvent: event => events.push(event),
    pollIntervalMs: 2, commandTimeoutMs: 100, drainTimeoutMs: 100, ...overrides });
  t.after(() => player.dispose());
  return { player, contexts, nodes, events, destinations, active: value => { active = value; }, get maxConnected() { return maxConnected; },
    count: kind => events.filter(event => event.kind === kind).length,
    async begin(c, signal) { assert(await player.begin(c.owner, c.textSha256, c.text, c.plan, signal)); },
    async enqueue(c, index) { const part = c.segments[index]; return player.enqueue(c.owner, part.manifest, part.bytes); },
    async drain(index, weak = false) {
      await waitFor(() => nodes[index]?.cursor && nodes[index].commands.some(command => ['play', 'resume'].includes(command.kind)));
      let remaining = 1000; while (!nodes[index].cursor.drained && --remaining) nodes[index].advance(); assert(remaining > 0);
      if (weak) contexts[0].currentTime += .2;
      await waitFor(() => player.state.segmentIndex > index || player.state.terminal);
    } };
}

test('plan validates exact canonical UTF8 coverage and hashes before any native graph; literal BOM and multibyte ranges survive', async t => {
  for (const change of ['hash', 'split', 'gap', 'count']) {
    const f = harness(t), c = await fixture(['Hi. ', '안녕!']);
    if (change === 'hash') c.plan.parts[1].textSha256 = 'f'.repeat(64);
    if (change === 'split') { c.plan.parts[0].endByte++; c.plan.parts[1].startByte++; }
    if (change === 'gap') c.plan.parts[1].startByte++;
    if (change === 'count') c.plan.count = 17;
    assert.equal(await f.player.begin(c.owner, c.textSha256, c.text, c.plan), false); assert.equal(f.contexts.length, 0); assert.equal(f.nodes.length, 0);
  }
  const f = harness(t), c = await fixture(['\ufeffHey. ', '반가워!']); await f.begin(c); assert.equal(f.contexts.length, 0);
});

test('all bounded transport parts admit promptly while exactly two native slots share one Context/module and stable combined reference', async t => {
  const f = harness(t), c = await fixture(['One. ', 'Two. ', 'Three. ', 'Four.']);
  assert(await f.player.unlockFromGesture()); const reference = f.player.referenceStream;
  await f.begin(c); f.player.play(c.owner);
  for (let index = 0; index < 4; index++) assert(await f.enqueue(c, index));
  await waitFor(() => f.nodes.length === 2 && f.nodes.every(node => node.cursor));
  assert.equal(f.player.state.receivedSegments, 4); assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].loads.length, 1);
  assert.equal(new Set(f.nodes.map(node => node.context)).size, 1); assert.equal(f.contexts[0].sources.length, 2);
  assert.equal(f.player.referenceStream, reference); assert(await f.player.seal(c.owner, c.final));
  for (let index = 0; index < 4; index++) await f.drain(index);
  assert.equal(f.nodes.length, 4); assert.equal(f.maxConnected, 2); assert.equal(f.count('started'), 1); assert.equal(f.count('segment_started'), 3);
  assert.equal(f.count('played_through'), 1); assert.equal(f.player.state.playedThrough, true);
  assert(f.events.every(event => JSON.stringify(event.owner) === JSON.stringify(c.owner)));
  f.player.dispose(); f.player.dispose(); assert.equal(f.contexts[0].closes, 1); assert(f.nodes.every(node => !node.connected && node.closed));
  assert.equal(f.destinations.length, 3); assert(f.destinations.every(dest => dest.track.stops === 1)); assert(f.contexts[0].sources.every(source => source.connected === null));
});

test('first verified part plays before later transport pieces but no parent completion exists before final EOF seal', async t => {
  const f = harness(t), c = await fixture(); await f.player.unlockFromGesture(); await f.begin(c); assert(await f.enqueue(c, 0)); f.player.play(c.owner);
  await f.drain(0); assert.equal(f.player.state.status, 'buffering'); assert.equal(f.count('played_through'), 0); assert.equal(f.player.state.receivedSegments, 1);
  assert(await f.enqueue(c, 1)); await f.drain(1); assert.equal(f.count('played_through'), 0); assert.equal(f.count('estimated_drain'), 0);
  assert(await f.player.seal(c.owner, c.final)); assert.equal(f.count('played_through'), 1); assert.equal(f.player.state.completed, true);
});

test('bad final concatenated digest cannot claim a fully played parent even after every individual part completed', async t => {
  const f = harness(t), c = await fixture(); await f.player.unlockFromGesture(); await f.begin(c);
  for (let i = 0; i < 2; i++) assert(await f.enqueue(c, i)); f.player.play(c.owner); for (let i = 0; i < 2; i++) await f.drain(i);
  assert.equal(await f.player.seal(c.owner, { ...c.final, pcmSha256: 'f'.repeat(64) }), false);
  assert.equal(f.count('played_through'), 0); assert.equal(f.player.state.terminal, true);
});

test('each segment requires exact owner, range, job, fidelity, byte count and PCM digest before native admission', async t => {
  for (const change of [m => { m.owner = { ...m.owner, expectedMemoryRevision: 4 }; }, m => { m.startByte++; }, m => { m.parentTextSha256 = 'f'.repeat(64); },
    m => { m.transcriptVerification = { ...m.transcriptVerification, status: 'unmatched' }; }, m => { m.sourceFrames++; }, m => { m.pcmSha256 = 'f'.repeat(64); }]) {
    const f = harness(t), c = await fixture(); await f.begin(c); change(c.segments[0].manifest);
    assert.equal(await f.enqueue(c, 0), false); assert.equal(f.nodes.length, 0); assert.equal(f.contexts.length, 0); assert.equal(f.count('played_through'), 0);
  }
  const f = harness(t), c = await fixture(); await f.begin(c); assert(await f.enqueue(c, 0)); c.segments[1].manifest.synthesisId = uid(98);
  assert.equal(await f.enqueue(c, 1), false); assert.equal(f.player.state.terminal, true);
});

test('caller byte/manifest mutation after admission cannot alter retained final digest or native samples', async t => {
  const f = harness(t), c = await fixture(); await f.player.unlockFromGesture(); await f.begin(c);
  const first = c.segments[0], entering = f.enqueue(c, 0); new Uint8Array(first.bytes).fill(0); first.manifest.owner.scope = 'https://changed.example|' + uid(1);
  assert(await entering); assert(await f.enqueue(c, 1)); await waitFor(() => f.nodes.length === 2 && f.nodes[0].cursor);
  assert.equal(f.nodes[0].cursor.samples[0], 1000 / 32768); assert(await f.player.seal(c.owner, c.final));
});

test('abort or authority change during crypto admission never constructs late PCM or revives an invalidated parent', async t => {
  for (const mode of ['abort', 'authority']) {
    let deferred = false, release;
    const subtle = { digest: (algorithm, bytes) => deferred ? new Promise(resolve => { release = () => webcrypto.subtle.digest(algorithm, bytes).then(resolve); deferred = false; }) : webcrypto.subtle.digest(algorithm, bytes) };
    const f = harness(t, { subtle }), c = await fixture(), controller = new AbortController(); await f.begin(c, controller.signal); deferred = true;
    const work = f.enqueue(c, 0); assert.equal(typeof release, 'function');
    if (mode === 'abort') controller.abort(); else f.active(false);
    release(); assert.equal(await work, false); assert.equal(f.nodes.length, 0); assert.equal(f.count('played_through'), 0); assert.equal(f.player.state.terminal, true);
  }
});

test('noise candidates preserve exact fractional source cursor, reject stale epochs and resume across a silent segment boundary', async t => {
  const f = harness(t), c = await fixture(['One. ', 'Two. ', 'Three.'], own(), 2400); await f.player.unlockFromGesture(); await f.begin(c);
  for (let i = 0; i < 3; i++) assert(await f.enqueue(c, i)); f.player.play(c.owner);
  await waitFor(() => f.nodes[0]?.commands.some(command => command.kind === 'play')); f.nodes[0].advance(127);
  const before = f.nodes[0].cursor.snapshot(); assert(f.player.pauseCandidate(c.owner, 'noise', 2)); await new Promise(resolve => setTimeout(resolve, 0));
  f.nodes[0].advance(501); assert.deepEqual(f.nodes[0].cursor.snapshot(), before);
  assert.equal(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'noise', decisionEpoch: 1 }), false);
  assert.equal(f.player.resolveCandidate(c.owner, { kind: 'asr_failed', candidateId: 'noise', decisionEpoch: 2 }), false);
  assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'noise', decisionEpoch: 2 }));
  await waitFor(() => f.events.some(event => event.kind === 'resume_applied'));
  assert.deepEqual(f.events.find(event => event.kind === 'resume_applied').cursor, { ...before, sourceFrame: before.sourceFrame, partIndex: 0, partSourceFrame: before.sourceFrame });
  await f.drain(0); assert(f.player.pauseCandidate(c.owner, 'boundary', 3) >= 0);
  const second = f.nodes[1].cursor.snapshot(); f.nodes[1].advance(300); assert.deepEqual(f.nodes[1].cursor.snapshot(), second);
  assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_echo', candidateId: 'boundary', decisionEpoch: 3 }));
  await f.drain(1); assert(await f.player.seal(c.owner, c.final)); await f.drain(2); assert.equal(f.count('played_through'), 1);
});

test('a hold created while no segment exists is dismissed only by its current epoch and does not stop prompt transport admission', async t => {
  const f = harness(t), c = await fixture(); await f.begin(c);
  assert.equal(f.player.pauseCandidate(c.owner, 'pending', 1), 0);
  assert.equal(await f.player.resumeFromGesture(c.owner, { candidateId: 'pending', decisionEpoch: 0 }), false);
  assert.equal(await f.player.resumeFromGesture(c.owner, { candidateId: 'pending', decisionEpoch: 1 }), true);
  assert.equal(f.count('candidate_dismissed_by_user'), 1);
  assert(await f.enqueue(c, 0)); await waitFor(() => f.nodes[0]?.commands.some(command => command.kind === 'play'));
  assert.equal(f.player.pauseCandidate(c.owner, 'pending', 1), 0);
});

test('one weak native part permanently excludes the parent strong receipt while later valid parts still play', async t => {
  const f = harness(t, {}, { timestamps: false }), c = await fixture(); await f.player.unlockFromGesture(); await f.begin(c);
  for (let i = 0; i < 2; i++) assert(await f.enqueue(c, i)); assert(await f.player.seal(c.owner, c.final)); f.player.play(c.owner);
  await f.drain(0, true); await f.drain(1, true); assert.equal(f.count('estimated_drain'), 1); assert.equal(f.count('played_through'), 0); assert.equal(f.player.state.continuityUncertain, true);
});

test('cancel and terminal child failure synchronously detach both slots; late parts and duplicate parent jobs cannot play', async t => {
  const f = harness(t), c = await fixture(['One. ', 'Two. ', 'Three.']); await f.player.unlockFromGesture(); await f.begin(c);
  for (let i = 0; i < 2; i++) assert(await f.enqueue(c, i)); await waitFor(() => f.nodes.length === 2 && f.nodes.every(node => node.cursor));
  f.player.play(c.owner); assert(f.player.cancel(c.owner, 'explicit_stop')); assert(f.nodes.every(node => !node.connected && node.closed));
  assert.equal(await f.enqueue(c, 2), false); assert.equal(await f.player.seal(c.owner, c.final), false); assert.equal(await f.player.begin(c.owner, c.textSha256, c.text, c.plan), false);
  assert.equal(f.count('played_through'), 0);
  const next = await fixture(['Next.'], own(2)); await f.begin(next); assert(await f.enqueue(next, 0)); await waitFor(() => f.nodes.length === 3 && f.nodes[2].cursor);
  f.nodes[2].onprocessorerror(); assert.equal(f.player.state.terminal, true); assert.equal(f.count('played_through'), 0);
});

test('duplicate begin during plan admission or after parts never cancels or replays the immutable parent', async t => {
  let deferred = true, release;
  const subtle = { digest: (algorithm, bytes) => deferred ? new Promise(resolve => { release = () => webcrypto.subtle.digest(algorithm, bytes).then(resolve); deferred = false; }) : webcrypto.subtle.digest(algorithm, bytes) };
  const f = harness(t, { subtle }), c = await fixture();
  const beginning = f.player.begin(c.owner, c.textSha256, c.text, c.plan);
  assert.equal(await f.player.begin(c.owner, c.textSha256, c.text, c.plan), false); assert.equal(f.count('terminal'), 0);
  release(); assert(await beginning); assert(await f.enqueue(c, 0));
  assert.equal(await f.player.begin(c.owner, c.textSha256, c.text, c.plan), false); assert.equal(f.count('terminal'), 0); assert.equal(f.player.state.receivedSegments, 1);
  assert.equal(await f.player.begin({ ...c.owner, playbackEpoch: Number.MAX_SAFE_INTEGER }, c.textSha256, c.text, c.plan), false);
  const g = harness(t), malformed = await fixture(['\ud800']);
  assert.equal(await g.player.begin(malformed.owner, malformed.textSha256, malformed.text, malformed.plan), false); assert.equal(g.contexts.length, 0);
});

test('a context that returns running cannot be reopened by noise resolution; both explicit gesture APIs recover only weak continuity', async t => {
  for (const recovery of ['resumeFromGesture', 'unlockFromGesture']) {
    const f = harness(t), c = await fixture(['Hello.'], own(), 2400); await f.player.unlockFromGesture(); await f.begin(c); assert(await f.enqueue(c, 0));
    assert(await f.player.seal(c.owner, c.final)); f.player.play(c.owner); await waitFor(() => f.nodes[0]?.commands.some(command => command.kind === 'play'));
    f.nodes[0].advance(127); assert(f.player.pauseCandidate(c.owner, 'noise', 1)); await new Promise(resolve => setTimeout(resolve, 0));
    const context = f.contexts[0]; context.state = 'suspended'; context.onstatechange();
    context.state = 'running'; context.onstatechange(); const before = f.nodes[0].cursor.snapshot(), commands = f.nodes[0].commands.length;
    assert(f.player.resolveCandidate(c.owner, { kind: 'rejected_noise', candidateId: 'noise', decisionEpoch: 1 }));
    assert.equal(f.nodes[0].commands.slice(commands).some(command => ['play', 'resume'].includes(command.kind)), false);
    f.nodes[0].advance(100); assert.deepEqual(f.nodes[0].cursor.snapshot(), before); assert.equal(f.player.state.paused, true);
    assert(await f.player[recovery](c.owner)); f.nodes[0].advance(100); assert(f.nodes[0].cursor.sourceFrame > before.sourceFrame);
    await f.drain(0, true); assert.equal(f.count('played_through'), 0); assert.equal(f.count('estimated_drain'), 1);
  }
});

test('a newer same-ID candidate during an awaited user gesture cannot be dismissed or resumed by the old epoch', async t => {
  const f = harness(t), c = await fixture(['Hello.']); await f.player.unlockFromGesture(); await f.begin(c); assert(await f.enqueue(c, 0));
  await waitFor(() => f.nodes[0]?.cursor); f.player.play(c.owner); f.nodes[0].advance(127);
  assert(f.player.pauseCandidate(c.owner, 'same', 1)); await new Promise(resolve => setTimeout(resolve, 0));
  const context = f.contexts[0], realResume = context.resume.bind(context); let finishResume;
  context.resume = () => new Promise(resolve => { finishResume = () => { context.state = 'running'; resolve(); }; });
  const old = f.player.resumeFromGesture(c.owner, { candidateId: 'same', decisionEpoch: 1 }); assert.equal(typeof finishResume, 'function');
  assert(f.player.pauseCandidate(c.owner, 'same', 2)); finishResume(); assert.equal(await old, false);
  assert.equal(f.count('candidate_dismissed_by_user'), 0); assert.equal(f.player.state.paused, true);
  context.resume = realResume; assert(await f.player.resumeFromGesture(c.owner, { candidateId: 'same', decisionEpoch: 2 }));
  assert.equal(f.count('candidate_dismissed_by_user'), 1); assert.equal(f.events.find(event => event.kind === 'candidate_dismissed_by_user').decisionEpoch, 2);
});

test('canceling head and prefetch before load ACK makes late ACKs, render events and preparation flights inert', async t => {
  const f = harness(t, {}, { delayLoad: true }), c = await fixture(); await f.player.unlockFromGesture(); await f.begin(c);
  for (let i = 0; i < 2; i++) assert(await f.enqueue(c, i)); f.player.play(c.owner);
  await waitFor(() => f.nodes.length === 2 && f.nodes.every(node => node.releaseLoad));
  const handlers = f.nodes.map(node => node.port.onmessage); assert(f.player.cancel(c.owner));
  for (let i = 0; i < 2; i++) {
    const node = f.nodes[i]; node.releaseLoad();
    handlers[i]({ data: { kind: 'loaded', token: node.token, commandId: 1 } });
    handlers[i]({ data: { kind: 'render_drained', token: node.token, sourceFrames: 240, finalContextFrameExclusive: 1 } });
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(f.nodes.every(node => node.closed && !node.connected && !node.commands.some(command => ['play', 'resume'].includes(command.kind))));
  assert.equal(f.count('started'), 0); assert.equal(f.count('played_through'), 0); assert.equal(f.count('estimated_drain'), 0);
});

test('raw PCM budget is enforced over all retained parts, independent of completed native slots', async t => {
  const f = harness(t), c = await fixture(['First. ', 'Second.'], own(), 1080001); await f.begin(c);
  assert(await f.enqueue(c, 0)); assert.equal(await f.enqueue(c, 1), false); assert.equal(f.player.state.terminal, true); assert.equal(f.count('played_through'), 0);
});
