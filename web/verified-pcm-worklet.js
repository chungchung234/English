// Standalone worklet asset. The pure cursor is also used by deterministic tests.
// It consumes source samples only when playing; pause preserves the rational
// resampling phase. Completion is a render boundary, never physical hearing.
export class PcmRenderCursor {
  constructor(samples, outputRate, sourceRate = 24000) {
    if (!(samples instanceof Float32Array) || !samples.length || !Number.isSafeInteger(outputRate) || outputRate < 8000 || outputRate > 192000 || sourceRate !== 24000) throw new TypeError('Invalid PCM cursor');
    this.samples = samples; this.outputRate = outputRate; this.sourceRate = sourceRate;
    this.sourceFrame = 0; this.phase = 0; this.renderedContextFrames = 0;
    this.paused = true; this.terminal = false; this.drained = false; this.finalContextFrameExclusive = null;
  }
  snapshot() { return { sourceFrame: this.sourceFrame, phaseNumerator: this.phase, phaseDenominator: this.outputRate, renderedContextFrames: this.renderedContextFrames }; }
  pause() { if (!this.terminal) this.paused = true; }
  resume() { if (!this.terminal && !this.drained) this.paused = false; }
  clear() { this.terminal = true; this.paused = true; this.samples = null; }
  render(output, absoluteContextFrame) {
    output.fill(0);
    if (this.terminal || this.paused || this.drained) return 0;
    let written = 0;
    for (let i = 0; i < output.length; i++) {
      const left = this.samples[this.sourceFrame], right = this.samples[Math.min(this.sourceFrame + 1, this.samples.length - 1)];
      output[i] = left + (right - left) * (this.phase / this.outputRate);
      this.phase += this.sourceRate;
      const advance = Math.floor(this.phase / this.outputRate);
      this.phase -= advance * this.outputRate; this.sourceFrame += advance;
      this.renderedContextFrames++; written++;
      if (this.sourceFrame >= this.samples.length) {
        this.sourceFrame = this.samples.length; this.drained = true; this.paused = true;
        // This linear resampler has no additional filter tail. The marker is
        // absolute in the output context and EXCLUDES the last emitted frame.
        this.finalContextFrameExclusive = absoluteContextFrame + i + 1;
        break;
      }
    }
    return written;
  }
}

if (typeof globalThis.AudioWorkletProcessor === 'function' && typeof globalThis.registerProcessor === 'function') {
  class VerifiedPcmProcessor extends AudioWorkletProcessor {
    constructor() {
      super(); this.token = null; this.cursor = null; this.lastCommand = 0; this.started = false; this.drainSent = false; this.progressFrames = 0;
      this.port.onmessage = ({ data }) => this.command(data);
    }
    reply(kind, commandId, extra = {}) { this.port.postMessage({ kind, token: this.token, commandId, cursor: this.cursor?.snapshot(), ...extra }); }
    command(message) {
      if (!message || !Number.isSafeInteger(message.commandId) || message.commandId <= this.lastCommand) return;
      if (message.kind === 'load') {
        if (this.token !== null || typeof message.token !== 'string') return;
        try { this.cursor = new PcmRenderCursor(message.samples, sampleRate); }
        catch { this.port.postMessage({ kind: 'error', token: message.token, commandId: message.commandId, code: 'INVALID_PCM' }); return; }
        this.token = message.token; this.lastCommand = message.commandId; this.reply('loaded', message.commandId); return;
      }
      if (!this.cursor || this.cursor.terminal || message.token !== this.token) return;
      this.lastCommand = message.commandId;
      if (message.kind === 'clear') { const cursor = this.cursor.snapshot(); this.cursor.clear(); this.reply('cleared', message.commandId, { cursor }); }
      else if (message.kind === 'pause') { this.cursor.pause(); this.reply('pause_applied', message.commandId, { candidateId: message.candidateId, decisionEpoch: message.decisionEpoch }); }
      else if (message.kind === 'play' || message.kind === 'resume') {
        this.cursor.resume();
        if (message.kind === 'resume') this.reply('resume_applied', message.commandId);
      }
    }
    process(_inputs, outputs) {
      const channels = outputs[0];
      if (!channels?.length) return true;
      for (const channel of channels) channel.fill(0);
      if (!this.cursor) return true;
      const written = this.cursor.render(channels[0], currentFrame);
      for (let i = 1; i < channels.length; i++) channels[i].set(channels[0]);
      if (written && !this.started) { this.started = true; this.reply('started', this.lastCommand); }
      this.progressFrames += written;
      if (this.cursor.drained && !this.drainSent) {
        this.drainSent = true; this.reply('render_drained', this.lastCommand, { sourceFrames: this.cursor.sourceFrame, finalContextFrameExclusive: this.cursor.finalContextFrameExclusive });
      } else if (this.progressFrames >= sampleRate / 20) { this.progressFrames = 0; this.reply('progress', this.lastCommand); }
      return !this.cursor.terminal;
    }
  }
  registerProcessor('loop-verified-pcm-v1', VerifiedPcmProcessor);
}
