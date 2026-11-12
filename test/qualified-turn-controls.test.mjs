import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualifiedTurnControls } from '../web/qualified-turn-controls.js';

const policy = { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: false };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, options = {}) {
  const sent = [], output = [], failures = [], changes = [];
  let recent = -Infinity;
  const now = options.now || (() => performance.now());
  const control = createQualifiedTurnControls({ send: event => sent.push(event), instructions: () => 'Full safe persona and private context boundaries.',
    openingInstructions: () => 'Full safe persona. Say a short explicit greeting, never answer noise.',
    hasRecentVoice: since => recent >= since && now() - recent <= 500, now,
    changed: state => changes.push(state), blockOutput: value => output.push(value), failed: message => failures.push(message), graceMs: 0, ...options });
  t.after(() => control.dispose());
  const emit = event => control.event(event);
  const settings = value => emit({ type: 'session.updated', session: { audio: { input: { turn_detection: value } } } });
  const voice = (time = now()) => { recent = time; control.voice(time); };
  const creates = () => sent.filter(event => event.type === 'response.create');
  const ack = (id = 'r1', create = creates().at(-1)) => {
    assert.ok(create, 'response.create is required before its receipt');
    emit({ type: 'response.created', response: { id, metadata: { ...create.response.metadata } } }); return id;
  };
  function utter(id, { qualified = true, transcript = 'Hello there.', commit = true, final = true } = {}) {
    if (!qualified) recent = -Infinity;
    emit({ type: 'input_audio_buffer.speech_started', item_id: id });
    if (qualified) voice();
    emit({ type: 'input_audio_buffer.speech_stopped', item_id: id });
    if (commit) emit({ type: 'input_audio_buffer.committed', item_id: id });
    if (final) emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript });
  }
  function done(id = 'r1', { status = 'completed', audio = true, itemId = id + '-item', stop = true, start = true } = {}) {
    emit({ type: 'response.output_item.added', response_id: id, item: { id: itemId, type: 'message', role: 'assistant' } });
    if (audio && start) emit({ type: 'output_audio_buffer.started', response_id: id });
    emit({ type: 'response.done', response: { id, status, output: [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: audio ? 'audio' : 'text' }] }] } });
    if (audio && stop) emit({ type: 'output_audio_buffer.stopped', response_id: id });
  }
  settings(policy); control.availability(true);
  return { control, sent, output, failures, changes, emit, settings, voice, utter, ack, done, creates };
}

test('startup requires effective false/false policy, availability and full instructions', t => {
  const sent = [], control = createQualifiedTurnControls({ send: event => sent.push(event), instructions: () => 'base', graceMs: 0 });
  t.after(() => control.dispose()); control.start(); control.availability(true);
  assert.equal(control.state.ready, false); assert.equal(sent.length, 0);
  control.event({ type: 'session.created', session: { audio: { input: { turn_detection: { ...policy, create_response: true } } } } });
  assert.equal(sent.length, 0); assert.equal(control.blocksResponse, true);
  control.dispose();
  const f = fixture(t, { instructions: () => '', openingInstructions: () => '' });
  f.control.start(); assert.equal(f.creates().length, 0);
  assert.deepEqual(f.control.shutdownPolicy(), policy);
});

test('startup has one short grace and explicit isolated greeting with full instructions', async t => {
  const f = fixture(t, { graceMs: 15 }); f.control.start();
  assert.equal(f.creates().length, 0); await wait(25);
  assert.equal(f.creates().length, 1);
  const request = f.creates()[0];
  assert.deepEqual(request.response.input, []);
  assert.match(request.response.instructions, /Full safe persona/);
  assert.equal(request.response.metadata.purpose, 'startup'); assert.ok(request.response.metadata.turn_nonce);
  f.ack(); f.done(); f.control.start(); f.settings(policy);
  assert.equal(f.creates().length, 1);
});

test('qualified user speech before the greeting wins, and commit plus final ASR are required', t => {
  const f = fixture(t); f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'u1' }); f.voice(); f.control.start();
  assert.equal(f.creates().length, 0);
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'My question.' });
  assert.equal(f.creates().length, 0);
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  assert.equal(f.creates().length, 1); assert.equal(f.creates()[0].response.metadata.purpose, 'reply');
  assert.deepEqual(f.creates()[0].response.input, [{ type: 'item_reference', id: 'u1' }]);
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'My question.' });
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u1' }); assert.equal(f.creates().length, 1);
});

test('noise ASR cannot invent a reply or permanently suppress the explicit greeting', t => {
  const f = fixture(t); f.utter('noise', { qualified: false, transcript: 'Thank you for watching.' }); f.control.start();
  assert.equal(f.creates().length, 1); assert.equal(f.creates()[0].response.metadata.purpose, 'startup');
  assert.deepEqual(f.creates()[0].response.input, []); assert.equal(f.control.state.needsManualReply, true);
  f.ack(); f.done(); assert.equal(f.creates().length, 1);
  f.utter('real'); assert.equal(f.creates().length, 2);
  assert.equal(f.creates()[1].response.input.some(item => item.id === 'noise'), false);
  assert.equal(f.creates()[1].response.input.some(item => item.id === 'real'), true);
});

test('empty or failed ASR never replies and user transcription is never filtered out', t => {
  const f = fixture(t); f.utter('empty', { transcript: '' }); f.control.start();
  assert.equal(f.creates().length, 0);
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'failed' }); f.voice();
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'failed' });
  const failure = { type: 'conversation.item.input_audio_transcription.failed', item_id: 'failed' };
  assert.equal(f.emit(failure), false); assert.equal(f.control.ignoresTranscript(failure), false);
  assert.equal(f.control.state.inputBusy, false); assert.equal(f.creates().length, 0);
  assert.equal(f.sent.some(event => event.type === 'input_audio_buffer.clear' || event.type === 'conversation.item.delete'), false);
});

test('only server candidate plus recent local voice interrupts; noise never cancels', t => {
  const f = fixture(t); f.control.start(); f.ack('greeting');
  f.emit({ type: 'output_audio_buffer.started', response_id: 'greeting' });
  f.voice(); assert.equal(f.sent.some(event => event.type === 'response.cancel'), false, 'local detector alone does not interrupt');
  f.utter('noise', { qualified: false, transcript: '' });
  const g = fixture(t); g.control.start(); g.ack('other'); g.emit({ type: 'output_audio_buffer.started', response_id: 'other' });
  g.emit({ type: 'input_audio_buffer.speech_started', item_id: 'noise-only' });
  assert.equal(g.sent.some(event => event.type === 'response.cancel'), false);
  g.voice();
  assert.deepEqual(g.sent.slice(-2).map(event => event.type), ['response.cancel', 'output_audio_buffer.clear']);
  assert.equal(g.sent.at(-2).response_id, 'other');
});

test('barge in waits for scoped generation done and output clear in either order before one reply', t => {
  for (const clearFirst of [false, true]) {
    const f = fixture(t); f.control.start(); f.ack('greeting'); f.emit({ type: 'output_audio_buffer.started', response_id: 'greeting' });
    f.utter('u1'); assert.equal(f.creates().length, 1); assert.equal(f.control.state.phase, 'interrupting');
    const generation = () => f.emit({ type: 'response.done', response: { id: 'greeting', status: 'cancelled', output: [] } });
    const clear = () => f.emit({ type: 'output_audio_buffer.cleared', response_id: 'greeting' });
    (clearFirst ? clear : generation)(); assert.equal(f.creates().length, 1);
    f.emit({ type: 'output_audio_buffer.cleared', response_id: 'unrelated' }); assert.equal(f.creates().length, 1);
    (clearFirst ? generation : clear)(); assert.equal(f.creates().length, 2);
    assert.deepEqual(f.creates()[1].response.input, [{ type: 'item_reference', id: 'u1' }]);
    assert.equal(f.control.ignoresTranscript({ type: 'response.output_audio_transcript.done', response_id: 'greeting' }), true);
  }
});

test('generation completion alone cannot release speaking output or race a next user response', t => {
  const f = fixture(t); f.utter('u1'); f.control.start(); f.ack(); f.done('r1', { stop: false });
  assert.equal(f.control.blocksResponse, true);
  f.utter('u2'); assert.equal(f.creates().length, 1);
  assert.equal(f.sent.filter(event => event.type === 'response.cancel').length, 0, 'generation already ended');
  assert.equal(f.sent.at(-1).type, 'output_audio_buffer.clear');
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'r1' }); assert.equal(f.creates().length, 2);
  assert.equal(f.creates()[1].response.input.some(item => item.id === 'r1-item'), false, 'interrupted output is excluded even if generation completed');
});

test('normal context includes only qualified users and completed, played assistant items in order', t => {
  const f = fixture(t); f.utter('u1'); f.control.start(); f.ack(); f.done();
  f.utter('noise', { qualified: false });
  const original = f.creates().length;
  f.emit({ type: 'conversation.item.deleted', item_id: 'u1' });
  f.utter('u2');
  assert.equal(f.creates().length, original + 1);
  const ids = f.creates().at(-1).response.input.map(item => item.id);
  assert.equal(ids.includes('u1'), false); assert.ok(ids.includes('u2')); assert.ok(ids.includes('r1-item'));
});

test('explicit stop stops only the current AI and lets the next user speech receive a reply', t => {
  const f = fixture(t); f.control.start(); f.ack(); f.emit({ type: 'output_audio_buffer.started', response_id: 'r1' });
  assert.equal(f.control.stop(), true); assert.equal(f.control.state.desiredHold, false);
  f.emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
  f.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  assert.equal(f.control.state.phase, 'listening'); assert.equal(f.control.blocksResponse, false);
  f.utter('next'); assert.equal(f.creates().length, 2);
  assert.equal(f.sent.some(event => event.type === 'session.update'), false, 'manual policy never flips automatic flags on stop');
});

test('hold keeps recording input, and resume replies once without restoring automatic VAD', t => {
  const f = fixture(t); f.control.start(); f.ack(); f.done();
  assert.equal(f.control.request(true), true); f.utter('u1'); f.utter('u2');
  assert.equal(f.creates().length, 1); assert.equal(f.control.state.phase, 'holding');
  assert.equal(f.control.request(false), true); assert.equal(f.creates().length, 2);
  assert.deepEqual(f.creates()[1].response.input.slice(-2).map(item => item.id), ['u1', 'u2']);
  assert.equal(f.sent.some(event => event.type === 'session.update'), false);
  assert.deepEqual(f.control.shutdownPolicy(), policy);
});

test('force reply is an explicit approval of nonempty ASR, never empty input', t => {
  const f = fixture(t); assert.equal(f.control.forceReply(), false);
  f.utter('uncertain', { qualified: false }); f.control.start(); f.ack(); f.done();
  assert.equal(f.control.state.needsManualReply, true); assert.equal(f.control.forceReply(), true);
  assert.equal(f.control.state.needsManualReply, false); assert.equal(f.creates().length, 2);
  assert.ok(f.creates()[1].response.input.some(item => item.id === 'uncertain'));
});

test('hint requests preserve full base instructions and curated input', t => {
  const f = fixture(t); f.utter('u1'); f.control.start(); f.ack(); f.done();
  assert.equal(f.control.requestHint('Give one concise example.'), true);
  const request = f.creates().at(-1);
  assert.equal(request.response.metadata.purpose, 'hint'); assert.match(request.response.instructions, /^Full safe persona/);
  assert.match(request.response.instructions, /For this response only: Give one concise example\./);
  assert.deepEqual(request.response.input.map(item => item.id), ['u1', 'r1-item']);
  assert.equal(f.control.requestHint('duplicate'), false);
});

test('stale pre-controller local voice cannot qualify input even if the analyzer returns true', t => {
  let mono = 1000; const f = fixture(t, { now: () => mono, hasRecentVoice: () => true });
  f.control.voice(999); f.utter('old', { qualified: false }); f.control.start();
  assert.equal(f.creates()[0].response.metadata.purpose, 'startup'); assert.equal(f.control.state.needsManualReply, true);
  mono += 100; f.ack(); f.done(); f.utter('new'); assert.equal(f.creates().at(-1).response.metadata.purpose, 'reply');
});

test('text-only response settles without an audio receipt but is not included as heard speech', t => {
  const f = fixture(t); f.utter('u1'); f.control.start(); f.ack(); f.done('r1', { audio: false });
  assert.equal(f.control.blocksResponse, false);
  f.utter('u2'); assert.equal(f.creates().length, 2);
  assert.equal(f.creates()[1].response.input.some(item => item.id === 'r1-item'), false);
});

test('create timeout stays blocked and late ack is cancelled, never duplicated on retry', async t => {
  const f = fixture(t, { timeoutMs: 15 }); f.control.start(); const create = f.creates()[0]; await wait(25);
  assert.equal(f.control.state.phase, 'error'); assert.equal(f.control.retry(), false); assert.equal(f.creates().length, 1);
  f.ack('late', create); assert.equal(f.sent.at(-2).response_id, 'late');
  f.emit({ type: 'response.done', response: { id: 'late', status: 'cancelled', output: [] } });
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'late' });
  assert.equal(f.control.retry(), true); assert.equal(f.creates().length, 1); assert.equal(f.control.state.phase, 'listening');
});

test('stop before response-created waits for its ID rather than issuing a wildcard cancellation', t => {
  const f = fixture(t); f.control.start(); f.control.stop();
  assert.equal(f.sent.some(event => event.type === 'response.cancel'), false);
  f.ack('late'); assert.equal(f.sent.at(-2).response_id, 'late');
  f.utter('u1'); assert.equal(f.creates().length, 1);
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'late' });
  f.emit({ type: 'response.done', response: { id: 'late', status: 'cancelled', output: [] } }); assert.equal(f.creates().length, 2);
});

test('unexpected response metadata is muted, scoped-cancelled and cannot enter history', t => {
  const f = fixture(t); f.control.start();
  f.emit({ type: 'response.created', response: { id: 'foreign', metadata: { turn_nonce: 'other', purpose: 'reply' } } });
  assert.equal(f.control.state.phase, 'error'); assert.equal(f.output.at(-1), true);
  assert.ok(f.sent.some(event => event.type === 'response.cancel' && event.response_id === 'foreign'));
  assert.equal(f.control.ignoresTranscript({ type: 'response.output_audio_transcript.done', response_id: 'foreign' }), true);
  assert.equal(f.control.ignoresTranscript({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1' }), false);
});

test('manual configuration changes cannot accidentally reenable automatic responses', t => {
  const f = fixture(t); f.control.start(); f.ack(); f.done();
  f.settings({ ...policy, create_response: true, interrupt_response: true });
  assert.equal(f.control.state.ready, false); assert.equal(f.control.blocksResponse, true);
  assert.equal(f.control.retry(), true);
  const update = f.sent.at(-1); assert.equal(update.type, 'session.update');
  assert.deepEqual(update.session.audio.input.turn_detection, policy);
  f.settings(policy); assert.equal(f.control.state.phase, 'error', 'matching late policy cannot clear explicit recovery requirement');
  assert.equal(f.control.retry(), true); assert.equal(f.control.state.phase, 'listening');
});

test('provider errors are handled only for owned events and no automatic failure retry is sent', t => {
  const f = fixture(t); f.utter('u1'); f.control.start(); f.ack();
  assert.equal(f.emit({ type: 'error', error: { event_id: 'unowned' } }), false);
  f.done('r1', { status: 'failed', audio: false });
  assert.equal(f.control.state.needsManualReply, true); assert.equal(f.creates().length, 1);
  assert.equal(f.control.forceReply(), true); assert.equal(f.creates().length, 2);
  const create = f.creates().at(-1);
  assert.equal(f.emit({ type: 'error', error: { event_id: create.event_id, code: 'invalid_request' } }), true);
  assert.equal(f.control.blocksResponse, true);
});

test('availability pauses new replies, and disposal prevents all late actions and timers', async t => {
  const f = fixture(t, { timeoutMs: 10, graceMs: 5 }); f.control.start(); f.control.availability(false);
  await wait(10); assert.equal(f.creates().length, 0);
  f.control.availability(true); assert.equal(f.creates().length, 1);
  const count = f.sent.length; f.control.dispose();
  f.control.voice(); f.control.start(); f.control.stop(); f.control.forceReply(); f.settings(policy);
  f.emit({ type: 'response.created', response: { id: 'late' } });
  await wait(15); assert.equal(f.sent.length, count); assert.equal(f.failures.length, 0);
});

test('duplicate response-created receipts do not reopen an already completed response', t => {
  const f = fixture(t); f.control.start(); const create = f.creates()[0]; f.ack(); f.done();
  f.ack('r1', create); assert.equal(f.control.state.phase, 'listening'); assert.equal(f.failures.length, 0);
});

test('availability recovery unmutes the same active response without creating a duplicate', t => {
  const f = fixture(t); f.control.start(); f.ack(); f.emit({ type: 'output_audio_buffer.started', response_id: 'r1' });
  f.control.availability(false); assert.equal(f.output.at(-1), true);
  f.control.availability(true); assert.equal(f.output.at(-1), false); assert.equal(f.creates().length, 1);
  f.control.request(true); f.control.availability(false); f.control.availability(true);
  assert.equal(f.output.at(-1), true, 'held or cancelled output stays muted');
});

test('a missing generation done receipt times out and scoped stop can recover after both receipts', async t => {
  const f = fixture(t, { generationTimeoutMs: 10 }); f.control.start(); f.ack(); await wait(20);
  assert.equal(f.control.state.phase, 'error'); assert.equal(f.control.retry(), false);
  assert.equal(f.control.stop(), true);
  f.emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  assert.equal(f.control.retry(), true); assert.equal(f.creates().length, 1);
});

test('normal playback may last longer than the short cancel acknowledgement timeout', async t => {
  const f = fixture(t, { timeoutMs: 8, playbackTimeoutMs: 60 }); f.control.start(); f.ack(); f.done('r1', { stop: false });
  await wait(15); assert.equal(f.control.state.phase, 'responding'); assert.equal(f.failures.length, 0);
  f.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' }); assert.equal(f.control.blocksResponse, false);
});

test('a racing scoped cancel-not-active error does not replace required done and clear receipts', t => {
  const f = fixture(t); f.control.start(); f.ack(); f.utter('u1');
  const cancel = f.sent.find(event => event.type === 'response.cancel');
  assert.equal(f.emit({ type: 'error', error: { event_id: cancel.event_id, code: 'response_cancel_not_active' } }), true);
  assert.equal(f.failures.length, 0); assert.equal(f.creates().length, 1);
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'r1' }); assert.equal(f.creates().length, 1);
  f.emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
  assert.equal(f.creates().length, 2); assert.equal(f.failures.length, 0);
});

test('persistent unqualified VAD noise cannot delay greeting and the same item may later qualify', async t => {
  const f = fixture(t, { graceMs: 12, timeoutMs: 8 });
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'long-candidate' });
  f.control.start(); assert.equal(f.control.state.inputBusy, false);
  await wait(16); assert.equal(f.creates().length, 1); assert.equal(f.creates()[0].response.metadata.purpose, 'startup');
  f.ack(); f.emit({ type: 'output_audio_buffer.started', response_id: 'r1' });
  f.voice(); assert.equal(f.sent.at(-2).type, 'response.cancel'); assert.equal(f.sent.at(-2).response_id, 'r1');
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'long-candidate' });
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'long-candidate' });
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'long-candidate', transcript: 'This is my real question.' });
  f.emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  assert.equal(f.creates().length, 2); assert.deepEqual(f.creates()[1].response.input, [{ type: 'item_reference', id: 'long-candidate' }]);
});

test('an unqualified noise commit without ASR cannot block another qualified reply', t => {
  const f = fixture(t); f.utter('noise', { qualified: false, final: false });
  assert.equal(f.control.state.inputBusy, false);
  f.utter('real'); f.control.start();
  assert.equal(f.creates().length, 1); assert.deepEqual(f.creates()[0].response.input, [{ type: 'item_reference', id: 'real' }]);
});

test('local voice qualifies the current server candidate without reviving an older noise candidate', t => {
  const f = fixture(t);
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'old-noise' });
  f.utter('real'); f.control.start();
  assert.equal(f.creates().length, 1); assert.deepEqual(f.creates()[0].response.input, [{ type: 'item_reference', id: 'real' }]);
  assert.equal(f.control.state.inputBusy, false);
});

test('manual approval after a normal reply cannot revive an earlier noise transcript', t => {
  const f = fixture(t); f.utter('old-noise', { qualified: false }); f.utter('u1'); f.control.start(); f.ack(); f.done();
  assert.equal(f.control.state.needsManualReply, false); assert.equal(f.control.forceReply(), false);
  f.utter('u2-missed-by-local-vad', { qualified: false });
  assert.equal(f.control.state.needsManualReply, true); assert.equal(f.control.forceReply(), true);
  const ids = f.creates().at(-1).response.input.map(item => item.id);
  assert.ok(ids.includes('u1')); assert.ok(ids.includes('u2-missed-by-local-vad')); assert.equal(ids.includes('old-noise'), false);
  assert.equal(f.control.ignoresTranscript({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-noise' }), false);
  assert.equal(f.sent.some(event => ['conversation.item.delete', 'input_audio_buffer.clear'].includes(event.type)), false);
});

test('one manual click approves only the latest current candidate and repeated clicks cannot approve older noise', t => {
  const f = fixture(t); f.control.start(); f.ack(); f.emit({ type: 'output_audio_buffer.started', response_id: 'r1' });
  f.utter('noise-before-real', { qualified: false }); f.utter('real-missed-by-local-vad', { qualified: false });
  assert.equal(f.control.forceReply(), true); assert.equal(f.control.forceReply(), false);
  assert.equal(f.control.state.needsManualReply, false); assert.equal(f.creates().length, 1);
  f.emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  assert.equal(f.creates().length, 2);
  assert.deepEqual(f.creates()[1].response.input, [{ type: 'item_reference', id: 'real-missed-by-local-vad' }]);
});

test('an old candidate whose ASR finishes late remains before the manual approval boundary', t => {
  const f = fixture(t); f.utter('old-noise', { qualified: false, final: false }); f.utter('u1'); f.control.start(); f.ack(); f.done();
  f.utter('u2', { qualified: false });
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-noise', transcript: 'An old hallucination arriving late.' });
  assert.equal(f.control.forceReply(), true);
  assert.deepEqual(f.creates().at(-1).response.input.map(item => item.id), ['u1', 'r1-item', 'u2']);
});

test('accepted checkpoint items preserve deleted approved turns while excluding raw noise and cancelled output', t => {
  const f = fixture(t); f.utter('noise', { qualified: false }); f.utter('u1'); f.control.start(); f.ack(); f.done();
  assert.deepEqual(f.control.acceptedItemIds(), ['u1', 'r1-item']);
  f.emit({ type: 'conversation.item.deleted', item_id: 'u1' }); f.emit({ type: 'conversation.item.deleted', item_id: 'r1-item' });
  assert.deepEqual(f.control.acceptedItemIds(), ['u1', 'r1-item'], 'saved accepted turns survive realtime context deletion');
  f.utter('u2'); assert.deepEqual(f.creates().at(-1).response.input, [{ type: 'item_reference', id: 'u2' }]);
  f.ack('r2'); f.emit({ type: 'response.output_item.added', response_id: 'r2', item: { id: 'cancelled-item' } });
  f.emit({ type: 'output_audio_buffer.started', response_id: 'r2' }); f.control.stop();
  f.emit({ type: 'response.done', response: { id: 'r2', status: 'cancelled', output: [{ id: 'cancelled-item', content: [{ type: 'audio' }] }] } });
  f.emit({ type: 'output_audio_buffer.cleared', response_id: 'r2' });
  assert.deepEqual(f.control.acceptedItemIds(), ['u1', 'r1-item', 'u2']);
});

test('a new normal turn supersedes an older failed-turn manual retry suggestion', t => {
  const f = fixture(t); f.utter('u1'); f.control.start(); f.ack(); f.done('r1', { status: 'failed', audio: false });
  assert.equal(f.control.state.needsManualReply, true);
  f.utter('u2'); f.ack('r2'); f.done('r2');
  assert.equal(f.control.state.needsManualReply, false); assert.equal(f.control.forceReply(), false);
});
