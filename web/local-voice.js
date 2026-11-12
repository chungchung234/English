import buildVAD, { VADMode } from '@ozymandiasthegreat/vad/lib/embedded.js';

const RATE = 16000, FRAME = 320, WINDOW = 6, REQUIRED = 4, UPDATE_MS = 100;
const ECHO_WINDOW_MS = 60, ECHO_LAG_MS = 300, ECHO_CORRELATION = .92;
let vadClass;
const loadVAD = () => vadClass ||= buildVAD();
const sample = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;

// Only a strong waveform match excludes possible speaker echo. This is not an
// acoustic echo canceller, a speaker identity test, or proof of human intent.
// Decimation bounds work on the UI audio callback; no waveform is retained here.
export function normalizedEchoCorrelation(mic, reference, sampleRate = RATE) {
  const length = Math.round(sampleRate * ECHO_WINDOW_MS / 1000);
  if (mic.length < length || reference.length < length) return { correlation: 0, lagMs: null };
  const stride = Math.max(1, Math.round(sampleRate / 4000)), lagStep = Math.max(1, Math.round(sampleRate * .002));
  const maximum = Math.min(Math.round(sampleRate * ECHO_LAG_MS / 1000), reference.length - length);
  const start = mic.length - length;
  let sumX = 0, energyX = 0, count = 0;
  for (let i = 0; i < length; i += stride) { const x = mic[start + i]; sumX += x; energyX += x * x; count++; }
  const centeredX = energyX - sumX * sumX / count;
  if (centeredX < count * 1e-10) return { correlation: 0, lagMs: null };
  let best = 0, bestLag = null;
  for (let lag = 0; lag <= maximum; lag += lagStep) {
    let sumY = 0, energyY = 0, dot = 0;
    const referenceStart = reference.length - length - lag;
    for (let i = 0; i < length; i += stride) {
      const x = mic[start + i], y = reference[referenceStart + i];
      sumY += y; energyY += y * y; dot += x * y;
    }
    const centeredY = energyY - sumY * sumY / count;
    if (centeredY < count * 1e-10) continue;
    const correlation = Math.min(1, Math.abs(dot - sumX * sumY / count) / Math.sqrt(centeredX * centeredY));
    if (correlation > best) { best = correlation; bestLag = lag / sampleRate * 1000; }
  }
  return { correlation: best, lagMs: bestLag };
}

// The same local PCM path is used by AudioContext and the real-WASM fixtures.
// Buffers cover at most one resampling block and 360ms of echo reference. No
// audio, transcript, or feature vectors leave this analyzer or enter storage.
export async function createLocalVoiceAnalyzer({ onVoice = () => {} } = {}) {
  const VAD = await loadVAD();
  let classifier = new VAD(VADMode.AGGRESSIVE, RATE), disposed = false;
  let inputRate = null, position = 0, inputMic = [], inputReference = [], frameIndex = 0;
  const frameMic = new Float32Array(FRAME), frameReference = new Float32Array(FRAME);
  let micHistory = [], referenceHistory = [], votes = [], floor = .00005;
  let lastVoice = -Infinity, lastPublished = -Infinity;
  function resetEvidence() {
    position = 0; inputMic = []; inputReference = []; frameIndex = 0;
    micHistory = []; referenceHistory = []; votes = []; floor = .00005;
    lastVoice = -Infinity; lastPublished = -Infinity;
  }
  function classify(at) {
    // libfvad's JS bridge copies the entire backing buffer. A fresh exact-size
    // allocation is required; an Int16Array subarray would copy unrelated PCM.
    const pcm = new Int16Array(FRAME);
    let energy = 0, crossings = 0;
    for (let i = 0; i < FRAME; i++) {
      const value = frameMic[i];
      pcm[i] = value < 0 ? value * 32768 : value * 32767;
      energy += value * value;
      if (i && value * frameMic[i - 1] < 0) crossings++;
    }
    const classification = classifier.processFrame(pcm);
    if (classification < 0) throw Error('LOCAL_VAD_FAILED');
    const rms = Math.sqrt(energy / FRAME), randomNoise = crossings / FRAME > .38;
    // Aggressive fvad can accept stationary white noise. Reject its high zero-
    // crossing pattern separately; energy is only a weak floor, never a voice
    // classifier. These engineering bounds are not universal acoustic optima.
    if (!classification || randomNoise) floor = floor * .95 + Math.min(rms, .001) * .05;
    micHistory.push(...frameMic); referenceHistory.push(...frameReference);
    if (micHistory.length > RATE * ECHO_WINDOW_MS / 1000) micHistory.splice(0, FRAME);
    if (referenceHistory.length > RATE * (ECHO_WINDOW_MS + ECHO_LAG_MS) / 1000) referenceHistory.splice(0, FRAME);
    const echo = classification && !randomNoise && rms > .00002 &&
      normalizedEchoCorrelation(micHistory, referenceHistory).correlation >= ECHO_CORRELATION;
    const voiced = classification === 1 && !randomNoise && !echo && rms > Math.max(.00002, floor * 1.2);
    votes.push(voiced); if (votes.length > WINDOW) votes.shift();
    const qualified = votes.length === WINDOW && votes.filter(Boolean).length >= REQUIRED;
    if (qualified && voiced) {
      lastVoice = Math.max(lastVoice, at);
      if (lastVoice - lastPublished >= UPDATE_MS) {
        lastPublished = lastVoice;
        try { onVoice(lastVoice); } catch { /* Observation cannot change audio. */ }
      }
    }
  }
  function push(mic, reference, sampleRate, at) {
    if (disposed || !Number.isFinite(at)) return;
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw Error('LOCAL_VAD_RATE');
    if (inputRate !== sampleRate) { resetEvidence(); inputRate = sampleRate; }
    for (let i = 0; i < mic.length; i++) { inputMic.push(sample(mic[i])); inputReference.push(sample(reference?.[i] || 0)); }
    const step = sampleRate / RATE;
    while (position + 1 < inputMic.length) {
      const left = Math.floor(position), fraction = position - left;
      frameMic[frameIndex] = inputMic[left] + (inputMic[left + 1] - inputMic[left]) * fraction;
      frameReference[frameIndex] = inputReference[left] + (inputReference[left + 1] - inputReference[left]) * fraction;
      frameIndex++;
      if (frameIndex === FRAME) {
        const frameAt = at - (inputMic.length - position - 1) / sampleRate * 1000;
        classify(frameAt); frameIndex = 0;
      }
      position += step;
    }
    const consumed = Math.min(Math.floor(position), inputMic.length);
    inputMic.splice(0, consumed); inputReference.splice(0, consumed); position -= consumed;
  }
  return {
    push,
    recentVoice: since => !disposed && Number.isFinite(since) && lastVoice >= since,
    reset() { if (!disposed) { resetEvidence(); classifier.destroy(); classifier = new VAD(VADMode.AGGRESSIVE, RATE); } },
    clearReference() { referenceHistory = []; inputReference.fill(0); frameReference.fill(0); },
    dispose() { if (disposed) return; disposed = true; resetEvidence(); classifier.destroy(); classifier = null; },
  };
}

export function createLocalVoiceActivity({ onVoice = () => {}, onState = () => {}, now = () => performance.now(),
  AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
  let context = null, merger = null, processor = null, silent = null, microphone = null, reference = null;
  let microphoneStream = null, referenceStream = null, analyzer = null, disposed = false, failed = false, status = null;
  const ignore = promise => { try { promise?.catch?.(() => {}); } catch { /* Best effort release. */ } };
  const disconnect = node => { try { node?.disconnect(); } catch { /* Detached already. */ } };
  function report(value) {
    if (disposed || status === value) return;
    status = value;
    if (value !== 'ready') { try { analyzer?.reset(); } catch { /* Failure remains unavailable. */ } }
    try { onState({ status: value }); } catch { /* Diagnostics cannot interrupt a call. */ }
  }
  function release() {
    if (processor) processor.onaudioprocess = null;
    if (context) context.onstatechange = null;
    for (const node of [microphone, reference, merger, processor, silent]) disconnect(node);
    microphone = reference = merger = processor = silent = null;
    microphoneStream = referenceStream = null;
    try { analyzer?.dispose(); } catch { /* Already released. */ } analyzer = null;
    try { if (context?.state !== 'closed') ignore(context?.close()); } catch { /* Context creation may have failed. */ }
  }
  function unavailable() { if (disposed) return; failed = true; report('unavailable'); release(); }
  let resumption;
  try {
    if (typeof AudioContextConstructor !== 'function') throw Error('LOCAL_AUDIO_UNAVAILABLE');
    context = new AudioContextConstructor();
    // Invoke resume before the first await, while the initiating click still
    // has user activation. The graph produces only zeros at the destination.
    resumption = Promise.resolve(context.resume());
    resumption.catch(() => {});
    merger = context.createChannelMerger(2);
    processor = context.createScriptProcessor(1024, 2, 1);
    processor.channelInterpretation = 'discrete';
    silent = context.createGain(); silent.gain.value = 0;
    merger.connect(processor); processor.connect(silent); silent.connect(context.destination);
    processor.onaudioprocess = event => {
      try {
        for (let i = 0; i < event.outputBuffer.numberOfChannels; i++) event.outputBuffer.getChannelData(i).fill(0);
        if (disposed || failed || status !== 'ready' || !analyzer || !microphone) return;
        const mic = event.inputBuffer.getChannelData(0);
        const ref = reference && event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : null;
        analyzer.push(mic, ref, context.sampleRate, now());
      } catch { unavailable(); }
    };
    context.onstatechange = () => {
      if (disposed || failed) return;
      if (context.state === 'closed') unavailable();
      else if (context.state !== 'running') report('suspended');
      else if (analyzer) report('ready');
    };
  } catch { failed = true; }
  const ready = failed ? Promise.resolve().then(() => { unavailable(); return false; }) :
    Promise.all([createLocalVoiceAnalyzer({ onVoice: time => { if (!disposed && !failed && status === 'ready') onVoice(time); } })
      .then(built => { if (disposed || failed) { built.dispose(); return null; } analyzer = built; return built; }), resumption])
      .then(([built]) => {
        if (disposed || failed || !built) { built?.dispose(); return false; }
        if (context.state !== 'running') { report('suspended'); return false; }
        report('ready'); return true;
      }).catch(() => { unavailable(); return false; });
  function attach(stream) {
    if (disposed || failed || !context || stream === microphoneStream) return;
    disconnect(microphone); microphone = null; microphoneStream = null;
    try {
      analyzer?.reset();
      if (!stream?.getAudioTracks().some(track => track.readyState !== 'ended')) throw Error('LOCAL_AUDIO_TRACK');
      microphone = context.createMediaStreamSource(stream); microphone.connect(merger, 0, 0); microphoneStream = stream;
    } catch { unavailable(); }
  }
  function attachReference(stream) {
    if (disposed || failed || !context || stream === referenceStream) return;
    disconnect(reference); reference = null; referenceStream = null; analyzer?.clearReference();
    try {
      if (stream?.getAudioTracks().some(track => track.readyState !== 'ended')) {
        reference = context.createMediaStreamSource(stream); reference.connect(merger, 0, 1); referenceStream = stream;
      }
    } catch { /* Missing reference leaves local classification available. */ }
  }
  return {
    ready, attach, attachReference,
    recentVoice: since => !disposed && !failed && status === 'ready' && Boolean(analyzer?.recentVoice(since)),
    dispose() { if (disposed) return; disposed = true; release(); },
  };
}
