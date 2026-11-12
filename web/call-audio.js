export const MICROPHONE_MODES = ['speakerphone', 'headset'];
export const validMicrophoneMode = value => MICROPHONE_MODES.includes(value);
const flag = value => value === true ? 'on' : value === false ? 'off' : 'unreported';

// Read only processing flags. Device identifiers, labels and audio never leave
// the capture stream through this module. Reported settings are not an acoustic
// effectiveness measurement.
export function captureAudioContext(stream) {
  let settings = {};
  try { settings = stream?.getAudioTracks?.()[0]?.getSettings?.() || {}; } catch { /* Unsupported settings remain unknown. */ }
  return { capture_echo: flag(settings.echoCancellation), capture_noise: flag(settings.noiseSuppression), capture_gain: flag(settings.autoGainControl) };
}

export function createCallAudioObserver({ mode, emit, outputState = () => 'unknown', randomUUID = () => crypto.randomUUID() }) {
  const context = { requested_mode: validMicrophoneMode(mode) ? mode : 'unknown', expected_noise: 'unreported',
    effective_noise: 'unreported', vad_type: 'unreported', interrupt_response: 'unreported' };
  const keys = new Map(), cancels = new Map(), reasons = new Map(), active = new Set();
  let playing = null, disposed = false, captureSignature = '', providerSignature = '';
  function key(id) {
    if (typeof id !== 'string' || !id) return undefined;
    if (!keys.has(id)) { try { keys.set(id, randomUUID()); } catch { return undefined; } }
    while (keys.size > 256) { const oldest = keys.keys().next().value; keys.delete(oldest); cancels.delete(oldest); reasons.delete(oldest); active.delete(oldest); }
    return keys.get(id);
  }
  const state = () => {
    try { const value = outputState(); return ['playing', 'generating', 'idle'].includes(value) ? value : 'unknown'; }
    catch { return 'unknown'; }
  };
  function record(kind, code, extra = {}) {
    if (disposed) return;
    try { emit({ kind, code, request_type: 'unknown', audio_context: { ...context, output_state: state(), ...extra } }); }
    catch { /* Observation must never affect call behavior. */ }
  }
  const responseId = event => typeof event?.response_id === 'string' ? event.response_id :
    typeof event?.response?.id === 'string' ? event.response.id : active.size === 1 ? [...active][0] : null;
  const origin = id => reasons.get(id) === 'turn_detected' ? 'provider_turn_detected' :
    reasons.get(id) === 'client_cancelled' ? cancels.get(id) || 'unattributed' : 'unattributed';
  return {
    capture(stream) {
      if (disposed) return;
      const value = captureAudioContext(stream), signature = JSON.stringify(value);
      if (signature === captureSignature) return;
      captureSignature = signature; Object.assign(context, value);
      record('audio_configuration', 'CAPTURE_AUDIO_SETTINGS');
    },
    expected(policy) {
      if (disposed || !policy) return;
      if (validMicrophoneMode(policy.microphone_mode)) context.requested_mode = policy.microphone_mode;
      if (['far_field', 'near_field', 'provider_default'].includes(policy.expected_noise_reduction)) context.expected_noise = policy.expected_noise_reduction;
      record('audio_configuration', 'EXPECTED_AUDIO_POLICY');
    },
    sent(event, cancelOrigin = 'client_other') {
      if (disposed || event?.type !== 'response.cancel') return;
      const id = responseId(event) || (active.size === 0 ? playing : null);
      if (id) { key(id); cancels.set(id, ['client_hold', 'client_end', 'client_other'].includes(cancelOrigin) ? cancelOrigin : 'client_other'); }
    },
    event(event) {
      if (disposed || !event) return;
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const input = event.session?.audio?.input;
        if (!input || typeof input !== 'object') return;
        let observed = false;
        if (Object.hasOwn(input, 'noise_reduction')) {
          observed = true;
          context.effective_noise = input.noise_reduction === null ? 'off' :
            ['far_field', 'near_field'].includes(input.noise_reduction?.type) ? input.noise_reduction.type : 'unreported';
        }
        if (Object.hasOwn(input, 'turn_detection')) {
          observed = true;
          if (input.turn_detection === null) { context.vad_type = 'off'; context.interrupt_response = 'unreported'; }
          else if (input.turn_detection && typeof input.turn_detection === 'object') {
            if (Object.hasOwn(input.turn_detection, 'type')) context.vad_type = ['semantic_vad', 'server_vad'].includes(input.turn_detection.type) ? input.turn_detection.type : 'unreported';
            if (Object.hasOwn(input.turn_detection, 'interrupt_response')) context.interrupt_response = flag(input.turn_detection.interrupt_response);
          }
        }
        if (!observed) return;
        const signature = JSON.stringify([context.effective_noise, context.vad_type, context.interrupt_response]);
        if (signature === providerSignature) return;
        providerSignature = signature;
        const mismatch = ['far_field', 'near_field'].includes(context.expected_noise) &&
          context.effective_noise !== 'unreported' && context.effective_noise !== context.expected_noise;
        record('audio_configuration', mismatch ? 'AUDIO_INPUT_POLICY_MISMATCH' : 'PROVIDER_AUDIO_SETTINGS');
        return;
      }
      if (event.type === 'response.created' && typeof event.response?.id === 'string') { active.add(event.response.id); key(event.response.id); }
      if (event.type === 'output_audio_buffer.started') playing = typeof event.response_id === 'string' ? event.response_id : null;
      if (event.type === 'input_audio_buffer.speech_started' && state() === 'playing') {
        const responseKey = key(playing);
        record('audio_interruption', 'SPEECH_DURING_OUTPUT', responseKey ? { response_key: responseKey } : {});
      }
      if (event.type === 'response.done') {
        const id = responseId(event);
        if (id && event.response?.status === 'cancelled') {
          const reason = event.response?.status_details?.reason;
          reasons.set(id, ['turn_detected', 'client_cancelled'].includes(reason) ? reason : 'unknown');
          record('audio_interruption', 'AUDIO_RESPONSE_CANCELLED', { response_key: key(id), cancel_origin: origin(id) });
        }
        if (id) active.delete(id);
      }
      if (event.type === 'output_audio_buffer.cleared') {
        const id = typeof event.response_id === 'string' ? event.response_id : playing, responseKey = key(id);
        record('audio_interruption', 'AUDIO_OUTPUT_CLEARED', { ...(responseKey ? { response_key: responseKey } : {}), cancel_origin: id ? origin(id) : 'unattributed' });
      }
      if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type)) {
        if (!event.response_id || event.response_id === playing) playing = null;
      }
    },
    dispose() { disposed = true; keys.clear(); cancels.clear(); reasons.clear(); active.clear(); playing = null; }
  };
}
