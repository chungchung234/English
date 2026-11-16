import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeLatency } from '../web/realtime-latency.js';

const nonce = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const local = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const request = (purpose = 'reply', input = [{ type: 'item_reference', id: 'provider-user' }], turn = nonce) =>
  ({ type: 'response.create', response: { input, metadata: { purpose, turn_nonce: turn } } });
const created = (turn = nonce, response = 'provider-response', purpose = 'reply') => ({ type: 'response.created', response: { id: response, metadata: { turn_nonce: turn, purpose } } });
function fixture(options = {}) {
  let at = 1000, current = true;
  const rows = [];
  const helper = createRealtimeLatency({ now: () => at, randomUUID: () => local, isCurrent: () => current,
    emit: value => rows.push(value), ...options });
  return { helper, rows, tick: value => { at += value; }, clock: value => { at = value; }, leave: () => { current = false; } };
}

test('reply joins received speech-stop, ASR, request, ACK and separate provider/audio observations without carrying source content', () => {
  const f = fixture();
  f.helper.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'provider-user', transcript: 'private utterance' });
  f.tick(100); f.helper.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'provider-user', transcript: 'private utterance' });
  f.tick(20); f.helper.sent(request()); f.helper.event(created());
  f.tick(60); f.helper.saved(['provider-user']);
  f.tick(220); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  assert.equal(f.rows.length, 2);
  assert.deepEqual(f.rows[1].latency_context, { turn_key: local, purpose: 'reply', start_basis: 'speech_stop_received', measurement: 'provider_output_started',
    request_ms: 120, transcription_ms: 100, save_ack_ms: 180, provider_output_ms: 400 });
  assert(!Object.hasOwn(f.rows[1].latency_context, 'first_audio_ms'), 'a provider start is not audio rendering');
  f.tick(75); f.helper.audioObserved({ basis: 'remote_stream_samples' });
  assert.equal(f.rows[2].latency_context.first_audio_ms, 475);
  assert.equal(f.rows[2].latency_context.measurement, 'remote_stream_samples');
  const retained = JSON.stringify(f.rows);
  for (const privateValue of ['provider-user', 'provider-response', 'private utterance', nonce]) assert(!retained.includes(privateValue));
});

test('duplicate events and duplicate save notifications cannot invent extra timing receipts', () => {
  const f = fixture();
  f.helper.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'provider-user' });
  f.tick(10); f.helper.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'provider-user' });
  f.helper.sent(request()); f.helper.sent(request()); f.helper.event(created()); f.helper.event(created());
  f.tick(20); f.helper.saved(['provider-user']); f.helper.saved(['provider-user']);
  f.tick(30); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  f.tick(30); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  f.helper.audioObserved({ basis: 'native_render' }); f.helper.audioObserved({ basis: 'native_render' });
  assert.equal(f.rows.length, 3);
  assert.equal(f.rows[1].latency_context.provider_output_ms, 60);
});

test('startup and hint anchor their own requests, never a previous user turn', () => {
  for (const purpose of ['startup', 'hint']) {
    const f = fixture(); f.helper.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'provider-user' });
    f.tick(200); f.helper.sent(request(purpose, [])); f.helper.event(created(nonce, 'provider-response', purpose));
    f.tick(50); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
    assert.equal(f.rows[0].latency_context.start_basis, 'request_sent');
    assert.equal(f.rows[0].latency_context.provider_output_ms, 50);
    assert(!Object.hasOwn(f.rows[0].latency_context, 'transcription_ms'));
  }
});

test('unrelated, out-of-order or mismatched responses cannot be attributed to a turn', () => {
  const f = fixture();
  f.helper.event(created());
  f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  f.helper.audioObserved({ responseId: 'provider-response', basis: 'native_render' });
  f.helper.sent(request('startup', []));
  f.helper.event(created('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'provider-response', 'startup'));
  f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  assert.deepEqual(f.rows, []);
  f.helper.event(created(nonce, 'provider-response', 'startup'));
  f.helper.event(created(nonce, 'wrong-response', 'startup'));
  f.helper.event({ type: 'output_audio_buffer.started', response_id: 'wrong-response' });
  assert.deepEqual(f.rows, []);
  f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  assert.equal(f.rows.length, 1);
});

test('matching a turn nonce without its exact response purpose never binds timing ownership', () => {
  for (const purpose of ['reply', undefined, null, 'private source content']) {
    const f = fixture(); f.helper.sent(request('startup', []));
    f.helper.event({ type: 'response.created', response: { id: 'provider-response', metadata: { turn_nonce: nonce, purpose } } });
    f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
    f.helper.audioObserved({ responseId: 'provider-response', basis: 'native_render' });
    assert.deepEqual(f.rows, [], 'a wrong or absent purpose cannot claim this request');
    f.helper.event(created(nonce, 'provider-response', 'startup'));
    f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
    assert.equal(f.rows.length, 1, 'an unrelated receipt does not poison a later exact match');
    assert.equal(f.rows[0].latency_context.purpose, 'startup');
  }
});

test('reusing a provider response ID cannot transfer a prior turn to a different nonce', () => {
  const f = fixture(); f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup'));
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.helper.sent(request('hint', [], next)); f.helper.event(created(next, 'provider-response', 'hint'));
  f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].latency_context.purpose, 'startup');
});

test('cancelled or cleared output cannot gain a late audio-start measurement', () => {
  for (const cancellation of [
    { type: 'response.cancel', response_id: 'provider-response' },
    { type: 'output_audio_buffer.cleared', response_id: 'provider-response' },
    { type: 'response.done', response: { id: 'provider-response', status: 'cancelled' } },
    { type: 'response.done', response: { id: 'provider-response', status: 'failed' } },
    { type: 'response.done', response: { id: 'provider-response', status: 'incomplete' } },
  ]) {
    const f = fixture(); f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup'));
    if (cancellation.type === 'response.cancel') f.helper.sent(cancellation); else f.helper.event(cancellation);
    f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
    f.helper.audioObserved({ responseId: 'provider-response', basis: 'native_render' });
    assert.deepEqual(f.rows, []);
  }
});

test('stopped output is terminal for sample observations even after duplicate metadata or late provider start', () => {
  for (const started of [false, true]) {
    const f = fixture(); f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup'));
    if (started) { f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' }); }
    const before = f.rows.length;
    f.helper.event({ type: 'output_audio_buffer.stopped', response_id: 'provider-response' });
    f.helper.event({ type: 'response.done', response: { id: 'provider-response', status: 'completed' } });
    f.helper.event(created(nonce, 'provider-response', 'startup'));
    f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
    f.helper.audioObserved({ basis: 'remote_stream_samples' });
    f.helper.audioObserved({ responseId: 'provider-response', basis: 'native_render' });
    assert.equal(f.rows.length, before, 'a completed output cannot acquire a new first sample');
  }
});

test('unrelated output stop cannot retire currently correlated remote stream samples', () => {
  const f = fixture(); f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup'));
  f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' });
  f.helper.event({ type: 'output_audio_buffer.stopped', response_id: 'unrelated' });
  f.tick(10); f.helper.audioObserved({ basis: 'remote_stream_samples' });
  assert.equal(f.rows.length, 2); assert.equal(f.rows[1].latency_context.first_audio_ms, 10);
});

test('generation completed before actual audio can still gain a separately labelled render measurement', () => {
  const f = fixture(); f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup'));
  f.helper.event({ type: 'response.done', response: { id: 'provider-response', status: 'completed' } });
  f.tick(50); f.helper.audioObserved({ responseId: 'provider-response', basis: 'native_render' });
  assert.equal(f.rows[0].latency_context.first_audio_ms, 50);
  assert(!Object.hasOwn(f.rows[0].latency_context, 'provider_output_ms'));
});

test('merged response requires every source save, and old user references do not become a new turn anchor', () => {
  const f = fixture();
  for (const item_id of ['provider-user', 'provider-user-two']) { f.helper.event({ type: 'input_audio_buffer.speech_stopped', item_id }); f.tick(50); }
  f.helper.sent(request('reply', [{ type: 'item_reference', id: 'provider-user' }, { type: 'item_reference', id: 'provider-user-two' }]));
  f.helper.saved(['provider-user']); assert.deepEqual(f.rows, []);
  f.tick(30); f.helper.saved(['provider-user-two']); assert.equal(f.rows[0].latency_context.save_ack_ms, 80);
  f.helper.sent(request('reply', [{ type: 'item_reference', id: 'provider-user' }], 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  f.helper.event(created('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'second'));
  f.tick(10); f.helper.event({ type: 'output_audio_buffer.started', response_id: 'second' });
  assert.equal(f.rows.at(-1).latency_context.start_basis, 'request_sent');
  assert(!Object.hasOwn(f.rows.at(-1).latency_context, 'save_ack_ms'));
});

test('scope/lifecycle changes and diagnostic exceptions cannot affect response ownership or revive metrics', () => {
  const f = fixture(); f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup')); f.leave();
  f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' }); f.helper.saved(['provider-user']);
  f.helper.audioObserved({ responseId: 'provider-response', basis: 'native_render' }); assert.deepEqual(f.rows, []);
  const throwing = fixture({ emit() { throw Error('diagnostics unavailable'); } });
  throwing.helper.sent(request('startup', [])); throwing.helper.event(created(nonce, 'provider-response', 'startup'));
  assert.doesNotThrow(() => throwing.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' }));
  throwing.helper.dispose();
  assert.doesNotThrow(() => throwing.helper.sent(request()));
});

test('invalid or backward clocks, arbitrary purposes and unbound samples do not fabricate durations', () => {
  const f = fixture();
  f.helper.sent(request('private transcript', [])); f.helper.event(created());
  f.helper.audioObserved({ basis: 'native_render' }); assert.deepEqual(f.rows, []);
  f.helper.sent(request('startup', [])); f.helper.event(created(nonce, 'provider-response', 'startup')); f.clock(999);
  f.helper.event({ type: 'output_audio_buffer.started', response_id: 'provider-response' }); assert.deepEqual(f.rows, []);
  f.clock(Number.NaN); assert.doesNotThrow(() => f.helper.saved(['provider-user']));
  f.helper.dispose();
});
