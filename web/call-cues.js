// Local interface sounds only. These never feed the microphone or the peer
// connection, and audio permission/playback failures never delay a call.
// Timing and volume are product choices, not measured learning optima.
const CONNECT_INTERVAL_MS = 1600;
const END_WINDOW_MS = 420;

export function createCallCues({
  AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
  setTimeout: later = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  let context = null, timer = null, phase = 'idle', revision = 0;
  const nodes = new Set();
  const ignore = result => { if (result && typeof result.catch === 'function') result.catch(() => {}); };
  function release(node, stop = false) {
    nodes.delete(node);
    if (node.oscillator) {
      node.oscillator.onended = null;
      if (stop) try { node.oscillator.stop(); } catch { /* Already ended. */ }
      try { node.oscillator.disconnect(); } catch { /* Best effort cleanup. */ }
    }
    try { node.gain?.disconnect(); } catch { /* Best effort cleanup. */ }
  }
  function clearSound() {
    if (timer !== null) cancel(timer);
    timer = null;
    for (const node of [...nodes]) release(node, true);
  }
  function closeContext() {
    const previous = context; context = null;
    try { ignore(previous?.close()); } catch { /* A closed context is harmless. */ }
  }
  function silence() { clearSound(); closeContext(); }
  function tone(active, frequency, delay, duration, volume) {
    const node = { oscillator: null, gain: null };
    try {
      node.oscillator = active.createOscillator(); node.gain = active.createGain();
      nodes.add(node);
      const start = active.currentTime + delay, finish = start + duration;
      node.oscillator.type = 'sine';
      node.oscillator.frequency.setValueAtTime(frequency, start);
      node.gain.gain.setValueAtTime(0, start);
      node.gain.gain.linearRampToValueAtTime(volume, start + .015);
      node.gain.gain.setValueAtTime(volume, finish - .025);
      node.gain.gain.linearRampToValueAtTime(0, finish);
      node.oscillator.connect(node.gain); node.gain.connect(active.destination);
      node.oscillator.onended = () => release(node);
      node.oscillator.start(start); node.oscillator.stop(finish + .01);
      return true;
    } catch { release(node, true); return false; }
  }
  function ready(expectedPhase, request, play) {
    let active;
    try {
      if (typeof AudioContext !== 'function') return;
      active = new AudioContext(); context = active;
      const valid = () => phase === expectedPhase && revision === request && context === active && active.state === 'running';
      if (active.state === 'running') { if (valid()) play(active); return; }
      // Calling resume synchronously keeps the original click's activation.
      Promise.resolve(active.resume()).then(() => {
        if (valid()) play(active);
      }).catch(() => {
        if (revision === request && context === active) silence();
      });
    } catch {
      if (revision === request) silence();
    }
  }
  function pulse(active, request) {
    if (phase !== 'connecting' || request !== revision || context !== active || active.state !== 'running') return;
    // Reap the previous pulse even if a suspended browser omitted onended.
    clearSound();
    if (!tone(active, 440, 0, .13, .035) || !tone(active, 554, .19, .15, .03)) { silence(); return; }
    timer = later(() => { timer = null; pulse(active, request); }, CONNECT_INTERVAL_MS);
  }
  function startConnecting() {
    if (phase === 'disposed' || phase === 'ending' || phase === 'ended' || phase === 'connecting') return;
    silence(); phase = 'connecting'; const request = ++revision;
    ready('connecting', request, active => pulse(active, request));
  }
  function stopConnecting() {
    if (phase === 'disposed' || phase === 'ending' || phase === 'ended') return;
    phase = 'idle'; revision++; silence();
  }
  function end() {
    if (phase === 'disposed' || phase === 'ending' || phase === 'ended') return;
    silence(); phase = 'ending'; const request = ++revision;
    // The end cue expires from the request time, even if resume never resolves.
    timer = later(() => {
      if (phase !== 'ending' || request !== revision) return;
      phase = 'ended'; revision++; silence();
    }, END_WINDOW_MS);
    ready('ending', request, active => {
      if (!tone(active, 392, 0, .13, .04) || !tone(active, 294, .17, .16, .035)) silence();
    });
  }
  function dispose() { if (phase === 'disposed') return; phase = 'disposed'; revision++; silence(); }
  return { startConnecting, connected: stopConnecting, stopConnecting, end, dispose };
}
