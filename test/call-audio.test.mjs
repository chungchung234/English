import test from 'node:test';
import assert from 'node:assert/strict';
import { validMicrophoneMode, captureAudioContext, createCallAudioObserver } from '../web/call-audio.js';

const stream = settings => ({ getAudioTracks: () => [{ getSettings: () => settings }] });
function fixture(options = {}) {
  const rows = []; let sequence = 0, output = 'idle';
  const observer = createCallAudioObserver({ mode: 'speakerphone', emit: row => rows.push(row),
    outputState: () => output, randomUUID: () => 'private-response-key-' + ++sequence, ...options });
  const start = id => observer.event({ type: 'response.created', response: { id } });
  const play = id => { output = 'playing'; observer.event({ type: 'output_audio_buffer.started', ...(id ? { response_id: id } : {}) }); };
  const cancelled = (id, reason) => observer.event({ type: 'response.done', response: { id, status: 'cancelled', status_details: { reason } } });
  return { observer, rows, start, play, cancelled };
}

test('microphone modes are explicit and capture exports only boolean processing flags', () => {
  assert.equal(validMicrophoneMode('speakerphone'), true); assert.equal(validMicrophoneMode('headset'), true);
  for (const invalid of [undefined, null, '', 'far_field', 'Speakerphone', {}, ['headset']]) assert.equal(validMicrophoneMode(invalid), false);
  const settings = { echoCancellation: true, noiseSuppression: false, autoGainControl: true,
    deviceId: 'private-device', groupId: 'private-group', label: 'private-room', sampleRate: 48000, channelCount: 2 };
  assert.deepEqual(captureAudioContext(stream(settings)), { capture_echo: 'on', capture_noise: 'off', capture_gain: 'on' });
  assert.deepEqual(captureAudioContext(stream({ echoCancellation: 'all', noiseSuppression: 1 })),
    { capture_echo: 'unreported', capture_noise: 'unreported', capture_gain: 'unreported' });
  assert.doesNotMatch(JSON.stringify(captureAudioContext(stream(settings))), /private|sampleRate|deviceId|label/);
});

test('unavailable or throwing capture settings remain unreported instead of claiming processing is off', () => {
  const unknown = { capture_echo: 'unreported', capture_noise: 'unreported', capture_gain: 'unreported' };
  assert.deepEqual(captureAudioContext(null), unknown);
  assert.deepEqual(captureAudioContext({ getAudioTracks() { throw Error('settings unavailable'); } }), unknown);
  assert.deepEqual(captureAudioContext({ getAudioTracks: () => [{ getSettings() { throw Error('permission unavailable'); } }] }), unknown);
});

test('partial session updates preserve separately observed effective processing and VAD settings', () => {
  const f = fixture(); f.observer.expected({ microphone_mode: 'speakerphone', expected_noise_reduction: 'far_field' });
  f.observer.event({ type: 'session.created', session: { audio: { input: { noise_reduction: { type: 'far_field' },
    turn_detection: { type: 'semantic_vad', eagerness: 'low', interrupt_response: true } } } } });
  const first = f.rows.at(-1); assert.equal(first.code, 'PROVIDER_AUDIO_SETTINGS');
  const count = f.rows.length;
  f.observer.event({ type: 'session.updated', session: { instructions: 'private instructions', audio: { output: { speed: .85 } } } });
  assert.equal(f.rows.length, count, 'unrelated settings updates must not erase effective capture configuration');
  f.observer.event({ type: 'session.updated', session: { audio: { input: { noise_reduction: { type: 'near_field' } } } } });
  assert.equal(f.rows.at(-1).code, 'AUDIO_INPUT_POLICY_MISMATCH');
  assert.equal(f.rows.at(-1).audio_context.vad_type, 'semantic_vad');
  assert.equal(f.rows.at(-1).audio_context.interrupt_response, 'on');
  f.observer.event({ type: 'session.updated', session: { audio: { input: { turn_detection: { type: 'server_vad', interrupt_response: false } } } } });
  assert.equal(f.rows.at(-1).audio_context.effective_noise, 'near_field');
  assert.equal(f.rows.at(-1).audio_context.interrupt_response, 'off');
  f.observer.event({ type: 'session.updated', session: { audio: { input: { noise_reduction: null, turn_detection: null } } } });
  assert.equal(f.rows.at(-1).audio_context.effective_noise, 'off'); assert.equal(f.rows.at(-1).audio_context.vad_type, 'off');
  assert.doesNotMatch(JSON.stringify(f.rows), /private instructions/);
});

test('capture settings deduplicate unchanged observations and report changed route flags without device identifiers', () => {
  const f = fixture();
  f.observer.capture(stream({ echoCancellation: true, noiseSuppression: true, deviceId: 'private-a' }));
  f.observer.capture(stream({ echoCancellation: true, noiseSuppression: true, deviceId: 'private-b' }));
  assert.equal(f.rows.length, 1, 'changing only device identifiers must not leak a new fingerprint');
  f.observer.capture(stream({ echoCancellation: false, noiseSuppression: true }));
  assert.equal(f.rows.length, 2); assert.equal(f.rows[1].audio_context.capture_echo, 'off');
  assert.doesNotMatch(JSON.stringify(f.rows), /private-a|private-b|deviceId/);
});

test('provider turn detection and confirmed local cancellation keep response-specific provenance', () => {
  const f = fixture(); f.start('provider-response-a'); f.start('provider-response-b'); f.play('provider-response-a');
  f.observer.sent({ type: 'response.cancel', response_id: 'provider-response-b' }, 'client_hold');
  f.observer.event({ type: 'input_audio_buffer.speech_started' });
  f.cancelled('provider-response-a', 'turn_detected'); f.cancelled('provider-response-b', 'client_cancelled');
  const overlap = f.rows.find(row => row.code === 'SPEECH_DURING_OUTPUT');
  const a = f.rows.find(row => row.code === 'AUDIO_RESPONSE_CANCELLED' && row.audio_context.response_key === overlap.audio_context.response_key);
  const b = f.rows.find(row => row.code === 'AUDIO_RESPONSE_CANCELLED' && row !== a);
  assert.equal(a.audio_context.cancel_origin, 'provider_turn_detected');
  assert.equal(b.audio_context.cancel_origin, 'client_hold');
  assert.notEqual(a.audio_context.response_key, b.audio_context.response_key);
  assert.doesNotMatch(JSON.stringify(f.rows), /provider-response-a|provider-response-b/);
});

test('a sent cancellation is not proof that it caused interruption; provider reason has precedence', () => {
  const f = fixture(); f.start('a'); f.play('a');
  f.observer.sent({ type: 'response.cancel', response_id: 'a' }, 'client_end');
  f.cancelled('a', 'turn_detected'); assert.equal(f.rows.at(-1).audio_context.cancel_origin, 'provider_turn_detected');
  f.start('b'); f.observer.sent({ type: 'response.cancel', response_id: 'b' }, 'client_end');
  f.cancelled('b', undefined); assert.equal(f.rows.at(-1).audio_context.cancel_origin, 'unattributed');
  f.start('c'); f.cancelled('c', 'client_cancelled'); assert.equal(f.rows.at(-1).audio_context.cancel_origin, 'unattributed');
});

test('an ID-less output clear stays attached to known playing output rather than another generating response', () => {
  const f = fixture(); f.start('playing-a'); f.play('playing-a');
  f.observer.event({ type: 'input_audio_buffer.speech_started' });
  const playingKey = f.rows.at(-1).audio_context.response_key;
  f.observer.event({ type: 'response.done', response: { id: 'playing-a', status: 'completed' } });
  f.start('generating-b'); f.observer.sent({ type: 'response.cancel', response_id: 'generating-b' }, 'client_hold');
  f.observer.event({ type: 'output_audio_buffer.cleared' });
  assert.equal(f.rows.at(-1).audio_context.response_key, playingKey);
  assert.equal(f.rows.at(-1).audio_context.cancel_origin, 'unattributed');
});

test('ambiguous events do not invent a response association or cancellation cause', () => {
  const f = fixture(); f.start('a'); f.start('b'); f.play();
  f.observer.sent({ type: 'response.cancel' }, 'client_hold');
  f.observer.event({ type: 'input_audio_buffer.speech_started' });
  assert.equal(f.rows.at(-1).audio_context.response_key, undefined);
  f.observer.event({ type: 'output_audio_buffer.cleared' });
  assert.equal(f.rows.at(-1).audio_context.cancel_origin, 'unattributed');
  assert.equal(f.rows.at(-1).audio_context.response_key, undefined);
});

test('observing speech or clear events never sends control messages or mutates supplied events', () => {
  const f = fixture(); f.start('a'); f.play('a');
  const event = Object.freeze({ type: 'input_audio_buffer.speech_started', item_id: 'user-input' });
  assert.doesNotThrow(() => f.observer.event(event));
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].kind, 'audio_interruption');
  assert.equal(f.rows[0].code, 'SPEECH_DURING_OUTPUT');
  assert.equal(f.rows[0].request_type, 'unknown');
  assert.equal(f.rows[0].type, undefined, 'the observer reports diagnostics, not response.cancel or output clear');
});

test('failed diagnostic callbacks and output observers cannot escape into the call; disposal ignores late work', () => {
  const throwing = fixture({ emit() { throw Error('diagnostics unavailable'); } });
  assert.doesNotThrow(() => throwing.observer.capture(stream({ echoCancellation: true })));
  assert.doesNotThrow(() => throwing.observer.expected({ expected_noise_reduction: 'far_field' }));
  throwing.start('a'); throwing.play('a'); assert.doesNotThrow(() => throwing.observer.event({ type: 'input_audio_buffer.speech_started' }));
  const unavailable = fixture({ outputState() { throw Error('output unavailable'); } });
  unavailable.start('a'); assert.doesNotThrow(() => unavailable.observer.event({ type: 'input_audio_buffer.speech_started' }));
  const f = fixture(); f.start('a'); f.play('a'); f.observer.dispose();
  const count = f.rows.length;
  f.observer.capture({ getAudioTracks() { throw Error('stale capture'); } });
  f.observer.expected({ expected_noise_reduction: 'near_field' });
  f.observer.sent({ type: 'response.cancel', response_id: 'a' }, 'client_end');
  f.observer.event({ type: 'input_audio_buffer.speech_started' }); f.cancelled('a', 'turn_detected');
  assert.equal(f.rows.length, count);
});
