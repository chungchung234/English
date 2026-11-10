import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceTurnControls } from '../web/voice-turn-controls.js';

const policy = { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true };
function fixture(options = {}) {
  const sent = [], output = [], failures = [];
  const control = createVoiceTurnControls({ send: event => sent.push(event), blockOutput: value => output.push(value), failed: message => failures.push(message), ...options });
  const emit = event => control.event(event);
  const settings = value => emit({ type: 'session.updated', session: { audio: { input: { turn_detection: value } } } });
  const clear = () => emit({ type: 'output_audio_buffer.cleared' });
  const held = { ...policy, create_response: false, interrupt_response: false };
  emit({ type: 'session.created', session: { audio: { input: { turn_detection: policy } } } });
  control.availability(true);
  return { control, sent, output, failures, emit, settings, clear, held };
}

test('hold preserves effective VAD and requests cancellation followed by playback clearing', t => {
  const f = fixture(); t.after(() => f.control.dispose());
  assert.equal(f.control.request(true), true);
  assert.equal(f.control.blocksResponse, true);
  assert.deepEqual(f.sent.map(event => event.type), ['session.update', 'response.cancel', 'output_audio_buffer.clear']);
  assert.deepEqual(f.sent[0].session.audio.input.turn_detection, f.held);
  assert.equal(f.sent.some(event => event.type === 'input_audio_buffer.clear'), false, 'learner audio must survive hold');
  assert.equal(f.control.state.phase, 'holding-pending');
  f.settings(f.held); f.clear();
  assert.equal(f.control.state.phase, 'holding');
  assert.equal(f.output.at(-1), true);
});

test('unrelated speed/checkpoint acks cannot confirm hold or overwrite VAD restore policy', t => {
  const f = fixture(); t.after(() => f.control.dispose()); f.control.request(true);
  f.emit({ type: 'session.updated', session: { instructions: 'new checkpoint', audio: { output: { speed: 0.8 } } } });
  assert.equal(f.control.state.pending, true);
  f.settings(f.held); f.clear(); f.control.request(false);
  assert.deepEqual(f.sent.slice(-3).map(event => event.type), ['response.cancel', 'output_audio_buffer.clear', 'session.update'], 'resume policy ack follows cancellation and clear requests');
  assert.deepEqual(f.sent.filter(event => event.type === 'session.update').at(-1).session.audio.input.turn_detection, policy);
  f.settings(policy);
  assert.equal(f.control.state.held, true, 'settings ack is not proof playback was cleared');
  f.clear(); assert.equal(f.control.state.held, false);
  assert.equal(f.sent.some(event => event.type === 'response.create'), false, 'no new user turn means no invented reply');
});

test('resume waits for every held user utterance to commit and requests exactly one reply', t => {
  const f = fixture(); t.after(() => f.control.dispose()); f.control.request(true); f.settings(f.held); f.clear();
  for (const id of ['u1', 'u2']) {
    f.emit({ type: 'input_audio_buffer.speech_started' });
    assert.equal(f.control.request(false), false);
    f.emit({ type: 'input_audio_buffer.speech_stopped' });
    assert.equal(f.control.request(false), false, 'do not respond before commit');
    f.emit({ type: 'input_audio_buffer.committed', item_id: id });
  }
  assert.equal(f.control.request(false), true); f.settings(policy); f.clear();
  assert.equal(f.sent.filter(event => event.type === 'response.create').length, 1);
  f.settings(policy); f.clear(); f.emit({ type: 'response.done', response: { id: 'reply', status: 'completed' } });
  assert.equal(f.sent.filter(event => event.type === 'response.create').length, 1);
});

test('a response racing resume is cancelled and must finish clearing before playback or replacement reply', t => {
  const f = fixture(); t.after(() => f.control.dispose()); f.control.request(true); f.settings(f.held); f.clear();
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u' }); f.control.request(false);
  f.emit({ type: 'response.created', response: { id: 'raced' } });
  f.emit({ type: 'response.output_item.added', response_id: 'raced', item: { id: 'raced-item' } });
  f.settings(policy); f.clear(); f.clear();
  assert.equal(f.control.state.held, true, 'active cancellation has not completed');
  f.emit({ type: 'response.done', response: { id: 'raced', status: 'cancelled' } });
  assert.equal(f.control.state.held, false);
  assert.equal(f.sent.filter(event => event.type === 'response.create').length, 1);
  assert.equal(f.control.ignoresTranscript({ type: 'response.output_audio_transcript.done', response_id: 'raced' }), true);
  assert.equal(f.control.ignoresTranscript({ type: 'response.output_audio_transcript.done', item_id: 'raced-item' }), true);
  assert.equal(f.control.ignoresTranscript({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u' }), false);
});

test('new user speech during resume defers to automatic completion and never races a manual reply', t => {
  const f = fixture(); t.after(() => f.control.dispose()); f.control.request(true); f.settings(f.held); f.clear();
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u1' }); f.control.request(false);
  f.emit({ type: 'input_audio_buffer.speech_started' }); f.settings(policy); f.clear();
  f.emit({ type: 'input_audio_buffer.speech_stopped' });
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u2' });
  f.emit({ type: 'response.created', response: { id: 'automatic' } });
  assert.equal(f.sent.some(event => event.type === 'response.create'), false);
});

test('hold timeout stays blocked, allows retry, and only matching late ack resolves uncertainty', async t => {
  const f = fixture({ timeoutMs: 15 }); t.after(() => f.control.dispose()); f.control.request(true); f.clear();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.control.state.phase, 'error'); assert.equal(f.control.state.held, true); assert.equal(f.failures.length, 1);
  f.settings(policy); assert.equal(f.control.state.phase, 'error');
  f.settings(f.held); assert.equal(f.control.state.phase, 'holding');
  f.control.request(false); f.clear();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.control.state.phase, 'error'); assert.equal(f.control.state.held, true);
  assert.equal(f.control.retry(), true); f.settings(policy); f.clear();
  assert.equal(f.control.state.phase, 'idle'); assert.equal(f.control.state.held, false);
});

test('settings and clear errors are handled as control errors and retain blocked output', t => {
  const f = fixture(); t.after(() => f.control.dispose()); f.control.request(true);
  const update = f.sent[0]; assert.equal(f.emit({ type: 'error', error: { event_id: update.event_id } }), true);
  assert.equal(f.control.state.phase, 'error'); assert.equal(f.control.state.held, true);
  f.control.retry(); f.settings(f.held); f.clear(); f.clear(); f.control.request(false); f.settings(policy);
  const clear = f.sent.filter(event => event.type === 'output_audio_buffer.clear').at(-1);
  f.emit({ type: 'error', error: { event_id: clear.event_id } });
  assert.equal(f.control.state.phase, 'error');
  f.emit({ type: 'session.updated', session: { audio: { output: { speed: 1 } } } });
  assert.equal(f.control.state.held, true, 'a failed output clear is not a clear receipt');
});

test('disposal prevents late updates, replies and timeouts and shutdown retains policy type', async () => {
  const f = fixture({ timeoutMs: 10 }); f.control.request(true); const count = f.sent.length;
  assert.deepEqual(f.control.shutdownPolicy(), f.held);
  f.control.dispose(); f.settings(f.held); f.emit({ type: 'response.created', response: { id: 'late' } }); f.clear();
  assert.equal(f.control.request(false), false); assert.equal(f.sent.length, count);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(f.failures, []);
});

test('unsupported or absent effective configuration never enables a fabricated policy', () => {
  const sent = [], c = createVoiceTurnControls({ send: event => sent.push(event) }); c.availability(true);
  c.event({ type: 'session.created', session: { audio: { input: { turn_detection: null } } } });
  assert.equal(c.state.ready, false); assert.equal(c.request(true), false); assert.equal(c.shutdownPolicy(), null); assert.deepEqual(sent, []); c.dispose();
});

test('a server VAD effective configuration is restored exactly rather than changed to semantic defaults', t => {
  const sent = [], c = createVoiceTurnControls({ send: event => sent.push(event) }); t.after(() => c.dispose());
  const server = { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 500, silence_duration_ms: 1700, create_response: true, interrupt_response: true };
  c.event({ type: 'session.created', session: { audio: { input: { turn_detection: server } } } }); c.availability(true); c.request(true);
  const held = sent[0].session.audio.input.turn_detection;
  c.event({ type: 'session.updated', session: { audio: { input: { turn_detection: held } } } }); c.event({ type: 'output_audio_buffer.cleared' }); c.request(false);
  assert.deepEqual(sent.filter(event => event.type === 'session.update').at(-1).session.audio.input.turn_detection, server);
});
