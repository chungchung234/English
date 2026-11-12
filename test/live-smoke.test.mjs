// Synthetic configuration and provider receipts verify the release-check
// contract. They do not grade model-generated conversational quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installRealtimeSmokeObserver, verifyManualRealtimeObservation } from '../scripts/live-smoke.mjs';

const base = 'https://synthetic-smoke.supabase.co';
const policy = { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: false };
const emptyContext = () => ({ scenario: '', prepared_target: null, continuity: null, memory: { facts: [], memories: [], focus: [], conversation_memories: [], recent_conversation: null } });
const emptyOpening = () => ({ version: 'opening-context-v1', purpose: 'call_opening', current_utterance: null,
  strategy: 'open_conversation', action: 'contribute_concrete_perspective', prepared_topic: null, continuity: null, recent_openings: [], reason: 'no_recent_handoff' });
const historicalOpening = () => ({ ...emptyOpening(), strategy: 'supported_continuity', action: 'connect_to_prior_detail', reason: 'eligible_continuity', continuity: {
  session_id: '11111111-1111-4111-8111-111111111111', evidence_id: '22222222-2222-4222-8222-222222222222',
  source_started_at: '2026-11-12T10:00:00Z', source_ended_at: '2026-11-12T10:02:00Z', source_spoken_at: '2026-11-12T10:01:00Z',
  source_time_zone: 'UTC', plan_timing: null,
  note: 'SYNTHETIC_HISTORY_NOTE', quote: 'SYNTHETIC_PRIVATE_HISTORICAL_QUOTE', state: 'stated', when: null,
  role: 'historical_background', must_not_infer_outcome: true }, recent_openings: [{
    session_id: '33333333-3333-4333-8333-333333333333', occurred_at: '2026-11-12T09:00:00Z',
    text: 'SYNTHETIC_STYLE_QUESTION: What did you enjoy yesterday?', role: 'style_only' }] });
const instructions = context => `ROLE_AND_SAFETY:\nSynthetic safety policy.\nPERSONA:\nSynthetic companion.\nTRUSTED_TIME_CONTEXT_JSON:\n{}\nUNTRUSTED_CONTEXT_JSON:\n${JSON.stringify(context)}`;

async function fixture({ opening = emptyOpening(), ordinaryOpening = emptyContext(), returnedPolicy = policy, manual = true } = {}) {
  const voice = instructions({ ...emptyContext(), memory: { ...emptyContext().memory, facts: [{ value: 'SYNTHETIC_PAST_ONLY' }] } });
  const greeting = instructions(ordinaryOpening) + '\nUNTRUSTED_OPENING_CONTEXT_JSON:\n' + JSON.stringify(opening) +
    '\nCURRENT_RESPONSE_PURPOSE:\nSynthetic opening purpose. Historical background is not a current learner utterance or request.';
  class Channel {
    listeners = []; sent = [];
    send(message) { this.sent.push(JSON.parse(message)); }
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
    emit(event) { for (const listener of this.listeners) listener({ data: JSON.stringify(event) }); }
  }
  class Peer {
    connectionState = 'connected';
    createDataChannel() { return new Channel(); }
    addEventListener() {}
  }
  const sandbox = { RTCPeerConnection: Peer, localStorage: { setItem() {} }, fetch: async url => new Response(JSON.stringify(url.endsWith('/config') ? { capabilities: { manual_turns_v1: true } } : {
    audio_policy: { turn_control: manual ? 'manual_turns_v1' : 'provider_vad', turn_detection: returnedPolicy },
    ...(manual ? { voice_instructions: voice, opening_instructions: greeting } : {}), sdp: 'SYNTHETIC_PRIVATE_SDP',
  })) };
  runInNewContext(`(${installRealtimeSmokeObserver.toString()})(${JSON.stringify({ base, session: { access_token: 'SYNTHETIC_PRIVATE_TOKEN', expires_in: 3600 } })})`, sandbox);
  await sandbox.fetch(base + '/functions/v1/coach/config');
  await sandbox.fetch(base + '/functions/v1/coach/voice', { body: JSON.stringify(manual ? { turnControl: 'manual_turns_v1' } : {}) });
  const channel = new Peer().createDataChannel();
  channel.emit({ type: 'session.created', session: { audio: { input: { turn_detection: manual ? policy : { ...policy, create_response: true, interrupt_response: true } }, output: { voice: 'cedar' } } } });
  let sequence = 0;
  function create(purpose, overrides = {}) {
    const response = { conversation: 'auto', input: purpose === 'startup' ? [] : [{ type: 'item_reference', id: 'synthetic-user-item' }], instructions: purpose === 'startup' ? greeting : voice,
      metadata: { turn_nonce: `synthetic-nonce-${sequence++}`, purpose }, ...overrides };
    channel.send(JSON.stringify({ type: 'response.create', response }));
    return response;
  }
  function acknowledge(response, { metadata = response.metadata, id = 'synthetic-response-' + sequence } = {}) {
    channel.emit({ type: 'response.created', response: { id, metadata } });
    return id;
  }
  function finish(response, id, { metadata = response.metadata, status = 'completed', drain = true, audio = true } = {}) {
    if (audio) channel.emit({ type: 'response.output_audio.done', response_id: id });
    channel.emit({ type: 'response.done', response: { id, metadata, status } });
    if (drain) channel.emit({ type: 'output_audio_buffer.stopped', response_id: id });
  }
  function user() {
    channel.emit({ type: 'input_audio_buffer.committed', item_id: 'synthetic-user-item' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'synthetic-user-item', transcript: 'SYNTHETIC_PRIVATE_SPEECH' });
  }
  function reply() { user(); const response = create('reply'), id = acknowledge(response); finish(response, id); }
  return { observed: sandbox.__liveSmoke, channel, create, acknowledge, finish, user, reply };
}

test('live manual smoke requires matching response receipts, completed generation and drained audio for opening and curated reply', async () => {
  const f = await fixture(), response = f.create('startup'), id = f.acknowledge(response);
  f.finish(response, id, { drain: false });
  f.reply();
  assert.equal(f.observed.manual.startupCompleted, 0);
  assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /Opening/);
  f.channel.emit({ type: 'output_audio_buffer.stopped', response_id: id });
  assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
  const output = JSON.stringify(f.observed);
  for (const privateValue of ['SYNTHETIC_PRIVATE', 'SYNTHETIC_PAST_ONLY', 'synthetic-user-item', 'synthetic-response-', 'synthetic-nonce-', 'ROLE_AND_SAFETY']) assert.equal(output.includes(privateValue), false);
});

test('live manual smoke accepts a skipped opening only when actual learner-first transcription and curated reply are observed', async () => {
  const f = await fixture(); f.reply();
  assert.equal(f.observed.manual.startupSent, 0); assert.equal(f.observed.manual.userBeforeStartup, true);
  assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
  assert.throws(() => verifyManualRealtimeObservation({ ...f.observed.manual, userBeforeStartup: false }), /Opening/);
  assert.throws(() => verifyManualRealtimeObservation({ ...f.observed.manual, startupAcknowledged: 1 }), /Opening/);
});

test('live manual smoke rejects metadata mismatches, failed output and incomplete audio receipts', async () => {
  for (const mode of ['ack-metadata', 'ack-purpose', 'done-metadata', 'incomplete', 'cancelled', 'missing-audio', 'missing-drain']) {
    const f = await fixture(), response = f.create('startup');
    const metadata = mode === 'ack-metadata' ? {} : mode === 'ack-purpose' ? { ...response.metadata, purpose: 'reply' } : response.metadata;
    const id = f.acknowledge(response, { metadata });
    f.finish(response, id, { metadata: mode === 'done-metadata' ? {} : response.metadata, status: ['incomplete', 'cancelled'].includes(mode) ? mode : 'completed', audio: mode !== 'missing-audio', drain: mode !== 'missing-drain' });
    f.reply();
    assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), undefined, mode);
  }
});

test('live manual smoke rejects implicit opening context, inline follow-up text and references absent from the actual provider session', async () => {
  for (const mode of ['opening-input-missing', 'opening-input-nonempty', 'inline-user', 'unknown-reference', 'wrong-instructions']) {
    const f = await fixture();
    const opening = f.create('startup', mode === 'opening-input-missing' ? { input: undefined } : mode === 'opening-input-nonempty' ? { input: [{ type: 'item_reference', id: 'old-item' }] } : {});
    f.finish(opening, f.acknowledge(opening)); f.user();
    const overrides = mode === 'inline-user' ? { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic inline text' }] }] } :
      mode === 'unknown-reference' ? { input: [{ type: 'item_reference', id: 'unknown-item' }] } : mode === 'wrong-instructions' ? { instructions: 'Incomplete response override.' } : {};
    const reply = f.create('reply', overrides); f.finish(reply, f.acknowledge(reply));
    assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /contract/, mode);
  }
});

test('live manual smoke allows selected historical/style background and a prepared topic without treating either as current speech', async () => {
  const prepared = { ...emptyOpening(), strategy: 'prepared_topic', action: 'enter_prepared_topic', reason: 'prepared_topic', prepared_topic: {
    text: 'SYNTHETIC_PREPARED_TOPIC', source: 'current_session_user_prepared', role: 'optional_topic_not_spoken_utterance' } };
  const planned = historicalOpening(); planned.continuity.state = 'planned'; planned.action = 'pick_up_unresolved_plan';
  const resolved = historicalOpening(); resolved.continuity.state = 'resolved'; resolved.action = 'add_perspective_to_known_result';
  const upcoming = historicalOpening(); upcoming.continuity.state = 'planned'; upcoming.action = 'pick_up_unresolved_plan';
  upcoming.continuity.when = 'tomorrow'; upcoming.continuity.quote += ' tomorrow';
  upcoming.continuity.plan_timing = { local_date: '2026-11-13', time_zone: 'UTC', relation: 'upcoming' };
  for (const opening of [emptyOpening(), historicalOpening(), planned, upcoming, resolved, prepared]) {
    const f = await fixture({ opening }), response = f.create('startup'); f.finish(response, f.acknowledge(response)); f.reply();
    assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
    assert.equal(f.observed.manual.openingContextValid, true); assert.equal(f.observed.manual.currentInputNone, true);
    assert.equal(f.observed.manual.historicalContextPresent, Boolean(opening.continuity || opening.recent_openings.length));
    assert.equal(f.observed.manual.preparedTopicPresent, Boolean(opening.prepared_topic));
    assert.doesNotMatch(JSON.stringify(f.observed), /SYNTHETIC_HISTORY_NOTE|SYNTHETIC_STYLE_QUESTION|SYNTHETIC_PRIVATE_HISTORICAL_QUOTE|SYNTHETIC_PREPARED_TOPIC|11111111-1111/);
  }
});

test('live manual smoke rejects raw-history leakage, false current speech, untyped background and incompatible opening context', async () => {
  for (const mode of ['ordinary-history', 'current-speech', 'missing-current', 'untyped-style', 'current-role', 'wrong-version', 'missing-context', 'inconsistent-strategy', 'missing-action', 'unknown-action', 'state-action-conflict', 'missing-plan-timing', 'nonplanned-timing', 'invalid-plan-day', 'invalid-plan-zone', 'mismatched-plan-zone', 'inferred-outcome']) {
    const ordinaryOpening = emptyContext(), opening = historicalOpening();
    if (mode === 'ordinary-history') ordinaryOpening.memory.facts.push({ value: 'SYNTHETIC_PAST_ONLY' });
    if (mode === 'current-speech') opening.current_utterance = 'SYNTHETIC_CURRENT_SPEECH';
    if (mode === 'missing-current') delete opening.current_utterance;
    if (mode === 'untyped-style') opening.recent_openings[0].role = 'user_fact';
    if (mode === 'current-role') opening.continuity.role = 'current_utterance';
    if (mode === 'wrong-version') opening.version = 'unrecognized-opening-version';
    if (mode === 'inconsistent-strategy') opening.strategy = 'open_conversation';
    if (mode === 'missing-action') delete opening.action;
    if (mode === 'unknown-action') opening.action = 'repeat_a_help_menu';
    if (mode === 'state-action-conflict') opening.action = 'pick_up_unresolved_plan';
    if (mode === 'missing-plan-timing') delete opening.continuity.plan_timing;
    if (mode === 'nonplanned-timing') opening.continuity.plan_timing = { local_date: '2026-11-13', time_zone: 'UTC', relation: 'upcoming' };
    if (['invalid-plan-day', 'invalid-plan-zone', 'mismatched-plan-zone'].includes(mode)) {
      opening.continuity.state = 'planned'; opening.action = 'pick_up_unresolved_plan';
      opening.continuity.plan_timing = { local_date: '2026-11-13', time_zone: 'UTC', relation: 'upcoming' };
      if (mode === 'invalid-plan-day') opening.continuity.plan_timing.local_date = '2026-02-30';
      if (mode === 'invalid-plan-zone') opening.continuity.plan_timing.time_zone = opening.continuity.source_time_zone = 'Not/A_Time_Zone';
      if (mode === 'mismatched-plan-zone') opening.continuity.plan_timing.time_zone = 'Asia/Seoul';
    }
    if (mode === 'inferred-outcome') opening.continuity.must_not_infer_outcome = false;
    const f = await fixture({ opening: mode === 'missing-context' ? null : opening, ordinaryOpening });
    const response = f.create('startup'); f.finish(response, f.acknowledge(response)); f.reply();
    assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /typed/, mode);
  }
});

test('live manual smoke rejects a policy mismatch in the backend response or actual provider session', async () => {
  for (const mode of ['returned-policy', 'effective-policy']) {
    const f = await fixture({ returnedPolicy: mode === 'returned-policy' ? { ...policy, interrupt_response: true } : policy });
    if (mode === 'effective-policy') f.observed.manual.effectivePolicy = false;
    const response = f.create('startup'); f.finish(response, f.acknowledge(response)); f.reply();
    assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), undefined, mode);
  }
});

test('live manual smoke counts duplicate provider receipts once and treats provider errors as failures without copying error text', async () => {
  const f = await fixture(), response = f.create('startup'), id = f.acknowledge(response);
  f.acknowledge(response, { id }); f.finish(response, id); f.finish(response, id); f.reply();
  assert.equal(f.observed.manual.startupAcknowledged, 1); assert.equal(f.observed.manual.startupCompleted, 1);
  assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
  f.channel.emit({ type: 'error', error: { code: 'invalid_value', message: 'SYNTHETIC_PRIVATE_PROVIDER_BODY' } });
  assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /contract/);
  assert.equal(JSON.stringify(f.observed).includes('SYNTHETIC_PRIVATE_PROVIDER_BODY'), false);
});

test('legacy provider speech and voice observations remain available without falsely passing manual negotiation', async () => {
  const f = await fixture({ manual: false }); f.user();
  f.channel.send(JSON.stringify({ type: 'response.create' }));
  f.channel.emit({ type: 'response.created', response: { id: 'legacy-response' } });
  f.channel.emit({ type: 'response.output_audio_transcript.done', transcript: 'Synthetic legacy response.' });
  assert.equal(f.observed.userTurns, 1); assert.equal(f.observed.assistantAfterUser, 1); assert.deepEqual(Array.from(f.observed.voices), ['cedar']);
  assert.equal(f.observed.manual.invalidRequests, 0); assert.equal(f.observed.manual.unexpectedResponses, 0);
  assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /negotiate/);
});
