// Real embedded libfvad classification on authored fixture PCM. These tests do
// not establish acoustic accuracy on users, microphones, noise, or speakerphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLocalVoiceActivity, createLocalVoiceAnalyzer, normalizedEchoCorrelation } from '../web/local-voice.js';

function wav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let rate, channels, bits, format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (name === 'fmt ') { format = bytes.readUInt16LE(offset + 8); channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22); }
    if (name === 'data') data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  assert.equal(format, 1); assert.equal(channels, 1); assert.equal(bits, 16); assert(data);
  return { rate, samples: Float32Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768) };
}
const fixture = wav(await readFile(new URL('./fixtures/live-smoke-utterance.wav', import.meta.url)));
function resample(input, from, to) {
  return Float32Array.from({ length: Math.floor(input.length / from * to) }, (_, index) => {
    const point = index * from / to, left = Math.floor(point), fraction = point - left;
    return input[left] + ((input[left + 1] || 0) - input[left]) * fraction;
  });
}
function feed(analyzer, mic, rate, reference = null, chunk = 1024, start = 0) {
  for (let index = 0; index < mic.length; index += chunk) {
    const end = Math.min(index + chunk, mic.length);
    analyzer.push(mic.subarray(index, end), reference?.subarray(index, end), rate, start + end / rate * 1000);
  }
}
function white(length, amplitude = .1, seed = 123) {
  return Float32Array.from({ length }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 2 ** 32 * 2 - 1) * amplitude; });
}

test('real WASM accepts speech at 44.1k/48k across block boundaries and publishes bounded monotonic observations', async () => {
  for (const rate of [44100, 48000]) {
    const observations = [], analyzer = await createLocalVoiceAnalyzer({ onVoice: time => observations.push(time) });
    try {
      const speech = resample(fixture.samples, fixture.rate, rate);
      feed(analyzer, speech, rate, null, 1024);
      assert(observations.length > 5, 'sustained authored speech should supply repeated local evidence');
      assert(observations[0] >= 100 && observations[0] < 1000, 'classification requires the short multi-frame window');
      for (let index = 1; index < observations.length; index++) assert(observations[index] - observations[index - 1] >= 99.99, 'callbacks must not exceed ten per second');
      assert(analyzer.recentVoice(observations.at(-1) - 1));
      const end = speech.length / rate * 1000;
      assert.equal(analyzer.recentVoice(end + 1), false, 'evidence cannot come from a future audio frame');
      feed(analyzer, new Float32Array(rate / 2), rate, null, 1024, end);
      assert.equal(analyzer.recentVoice(end + 350), false, 'silence cannot keep extending voice recency');
    } finally { analyzer.dispose(); }
    assert.equal(analyzer.recentVoice(0), false);
  }
});

test('quiet speech remains eligible; amplitude alone is not the positive decision', async () => {
  const rate = 48000, speech = Float32Array.from(resample(fixture.samples, fixture.rate, rate), value => value * .08);
  const rms = Math.sqrt(speech.reduce((total, value) => total + value * value, 0) / speech.length);
  assert(rms < .015, 'this fixture must exercise speech below a simple loud-input threshold');
  const observations = [], analyzer = await createLocalVoiceAnalyzer({ onVoice: time => observations.push(time) });
  try { feed(analyzer, speech, rate, null, 997); assert(observations.length > 5); }
  finally { analyzer.dispose(); }
});

test('real classifier plus persistence and noise rejection ignores silence, a single impulse and stationary white noise', async () => {
  for (const rate of [44100, 48000]) for (const kind of ['silence', 'impulse', 'white']) {
    const input = kind === 'white' ? white(rate * 2) : new Float32Array(rate * 2);
    if (kind === 'impulse') input[Math.round(rate * .08)] = 1;
    const observations = [], analyzer = await createLocalVoiceAnalyzer({ onVoice: time => observations.push(time) });
    try { feed(analyzer, input, rate); assert.deepEqual(observations, [], `${kind} at ${rate} must not create local voice evidence`); }
    finally { analyzer.dispose(); }
  }
});

test('strong delayed waveform echo is excluded while unrelated active reference does not block speech', async () => {
  const rate = 48000, reference = resample(fixture.samples, fixture.rate, rate), delay = Math.round(rate * .08);
  const echo = Float32Array.from(reference, (_, index) => index >= delay ? reference[index - delay] * .25 : 0);
  const echoObservations = [], echoAnalyzer = await createLocalVoiceAnalyzer({ onVoice: time => echoObservations.push(time) });
  try { feed(echoAnalyzer, echo, rate, reference); assert.deepEqual(echoObservations, [], 'a scaled delayed copy is speaker echo, not barge-in evidence'); }
  finally { echoAnalyzer.dispose(); }
  const humanObservations = [], humanAnalyzer = await createLocalVoiceAnalyzer({ onVoice: time => humanObservations.push(time) });
  try { feed(humanAnalyzer, reference, rate, white(reference.length, .2)); assert(humanObservations.length > 5, 'reference activity alone must not suppress a different waveform'); }
  finally { humanAnalyzer.dispose(); }
});

test('normalized echo helper finds an 80ms delayed copy within the 300ms reference window', () => {
  const rate = 16000, reference = white(6400, .4);
  const delay = rate * .08, mic = Float32Array.from(reference, (_, index) => index >= delay ? reference[index - delay] * .1 : 0);
  const result = normalizedEchoCorrelation(mic, reference, rate);
  assert(result.correlation > .99); assert(Math.abs(result.lagMs - 80) <= 2);
  assert.equal(normalizedEchoCorrelation(new Float32Array(960), new Float32Array(5760)).correlation, 0);
  assert(normalizedEchoCorrelation(reference, white(reference.length, .1, 987), rate).correlation < .5);
});

function fakeAudio(options = {}) {
  const contexts = [];
  class Node {
    constructor() { this.connections = []; this.disconnected = 0; }
    connect(...args) { this.connections.push(args); return args[0]; }
    disconnect() { this.disconnected++; this.connections = []; }
  }
  class Context {
    constructor() { this.state = options.state || 'running'; this.sampleRate = 48000; this.destination = {}; this.sources = []; this.closed = 0; contexts.push(this); }
    resume() {
      this.resumeCalled = true;
      if (options.rejectResume) return Promise.reject(Error('autoplay denied'));
      if (options.deferResume) return new Promise(resolve => { this.resolveResume = () => { this.state = 'running'; resolve(); }; });
      this.state = 'running'; return Promise.resolve();
    }
    createChannelMerger(count) { this.mergerCount = count; return this.merger = new Node(); }
    createScriptProcessor(...args) { this.processorArgs = args; return this.processor = new Node(); }
    createGain() { this.silent = new Node(); this.silent.gain = { value: 1 }; return this.silent; }
    createMediaStreamSource(stream) { const source = new Node(); source.stream = stream; this.sources.push(source); return source; }
    close() { this.closed++; this.state = 'closed'; this.onstatechange?.(); return Promise.resolve(); }
    setState(value) { this.state = value; this.onstatechange?.(); }
  }
  const track = { readyState: 'live', stopped: 0, stop() { this.stopped++; } };
  const referenceTrack = { ...track, stopped: 0 };
  return { Context, contexts, track, referenceTrack, stream: { getAudioTracks: () => [track] }, referenceStream: { getAudioTracks: () => [referenceTrack] } };
}
function process(context, mic, reference = null) {
  const output = new Float32Array(mic.length).fill(1);
  context.processor.onaudioprocess?.({ inputBuffer: { numberOfChannels: 2, getChannelData: index => index ? reference || new Float32Array(mic.length) : mic },
    outputBuffer: { numberOfChannels: 1, getChannelData: () => output } });
  assert(output.every(value => value === 0), 'the analysis graph must never play its microphone input');
}

test('AudioContext graph resumes in the initiating call, remains silent, and releases only owned resources', async () => {
  const fake = fakeAudio(), states = [], observations = []; let time = 0;
  const activity = createLocalVoiceActivity({ AudioContextConstructor: fake.Context, now: () => time, onVoice: value => observations.push(value), onState: value => states.push(value.status) });
  assert.equal(fake.contexts.length, 1); assert.equal(fake.contexts[0].resumeCalled, true, 'resume must happen synchronously before WASM awaits');
  activity.attach(fake.stream); activity.attachReference(fake.referenceStream);
  assert.equal(await activity.ready, true);
  const context = fake.contexts[0]; assert.deepEqual(context.processorArgs, [1024, 2, 1]); assert.equal(context.mergerCount, 2);
  assert.deepEqual(context.sources.map(source => source.connections[0].slice(1)), [[0, 0], [0, 1]]);
  assert.equal(context.silent.gain.value, 0);
  const speech = resample(fixture.samples, fixture.rate, 48000);
  for (let index = 0; index < speech.length; index += 1024) { const end = Math.min(index + 1024, speech.length); time = end / 48; process(context, speech.subarray(index, end)); }
  assert(observations.length > 5); assert(activity.recentVoice(time - 150));
  activity.attachReference(null); assert(context.sources[1].disconnected > 0);
  activity.dispose(); activity.dispose();
  assert.equal(context.closed, 1); assert.equal(context.processor.onaudioprocess, null);
  assert(context.sources.every(source => source.disconnected > 0));
  assert.equal(fake.track.stopped, 0); assert.equal(fake.referenceTrack.stopped, 0);
  assert.equal(activity.recentVoice(0), false); assert.deepEqual(states, ['ready']);
});

test('suspended contexts supply no recency, then require fresh evidence when running resumes', async () => {
  const fake = fakeAudio(), states = []; let time = 0;
  const activity = createLocalVoiceActivity({ AudioContextConstructor: fake.Context, now: () => time, onState: value => states.push(value.status) });
  activity.attach(fake.stream); await activity.ready;
  const context = fake.contexts[0], speech = resample(fixture.samples, fixture.rate, 48000);
  for (let index = 0; index < speech.length; index += 1024) { const end = Math.min(index + 1024, speech.length); time = end / 48; process(context, speech.subarray(index, end)); }
  assert(activity.recentVoice(time - 150));
  context.setState('suspended'); assert.equal(activity.recentVoice(0), false);
  context.setState('running'); assert.equal(activity.recentVoice(0), false, 'old voice cannot revive on a state change');
  assert.deepEqual(states, ['ready', 'suspended', 'ready']); activity.dispose();
});

test('constructor/resume failures and disposal before late initialization never revive local evidence or stop tracks', async () => {
  const failedStates = [], unsupported = createLocalVoiceActivity({ AudioContextConstructor: class { constructor() { throw Error('disabled'); } }, onState: value => failedStates.push(value.status) });
  assert.equal(await unsupported.ready, false); assert.deepEqual(failedStates, ['unavailable']); unsupported.dispose();
  const rejected = fakeAudio({ rejectResume: true }), rejectedStates = [];
  const unavailable = createLocalVoiceActivity({ AudioContextConstructor: rejected.Context, onState: value => rejectedStates.push(value.status) });
  unavailable.attach(rejected.stream); assert.equal(await unavailable.ready, false);
  assert.deepEqual(rejectedStates, ['unavailable']); assert.equal(rejected.contexts[0].closed, 1); assert.equal(rejected.track.stopped, 0);
  const late = fakeAudio({ deferResume: true, state: 'suspended' }), lateStates = [];
  const disposed = createLocalVoiceActivity({ AudioContextConstructor: late.Context, onState: value => lateStates.push(value.status) });
  disposed.attach(late.stream); disposed.dispose(); late.contexts[0].resolveResume();
  assert.equal(await disposed.ready, false); assert.equal(disposed.recentVoice(0), false); assert.deepEqual(lateStates, []);
  assert.equal(late.contexts[0].closed, 1); assert.equal(late.track.stopped, 0);
});

test('WASM denial becomes unavailable rather than changing microphone ownership or rejecting ready', async () => {
  const instantiate = WebAssembly.instantiate, fake = fakeAudio(), states = [];
  try {
    WebAssembly.instantiate = async () => { throw Error('CSP denies WASM'); };
    const isolated = await import('../web/local-voice.js?wasm-denied');
    const activity = isolated.createLocalVoiceActivity({ AudioContextConstructor: fake.Context, onState: value => states.push(value.status) });
    activity.attach(fake.stream); assert.equal(await activity.ready, false);
    assert.deepEqual(states, ['unavailable']); assert.equal(fake.track.stopped, 0); assert.equal(fake.contexts[0].closed, 1);
    activity.dispose();
  } finally { WebAssembly.instantiate = instantiate; }
});
