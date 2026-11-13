// Synthetic configuration and provider receipts verify the release-check
// contract. They do not grade model-generated conversational quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installRealtimeSmokeObserver, verifyManualRealtimeObservation, verifyEvidence } from '../scripts/live-smoke.mjs';

test('post-call evidence retains original sharing and explicit-help questions while authored examples remain separate', () => {
  const events = [
    { id: 'sharing', speaker: 'user', text: 'I go to a cafe yesterday. The cake was worth the wait.' },
    { id: 'help', speaker: 'user', text: 'How can I say “나도 할래” in English?' },
    { id: 'assistant', speaker: 'assistant', text: 'You can say “I am in.”' },
  ];
  const content = {
    strengths: [{ text: '경험을 구체적으로 표현했어요.', expression: 'worth the wait', evidence_ids: ['sharing'] }],
    corrections: [{ original: 'I go to a cafe yesterday.', improved: 'I went to a cafe yesterday.', evidence_ids: ['sharing'] }],
    practice: [{ expression: 'I am in.', evidence_ids: ['help'], learning: {
      source_quote: 'How can I say “나도 할래” in English?', source_is_question: true,
      example: { prompt: 'Want to join us?', response: 'I am in.' },
    } }],
  };
  const original = structuredClone(events);
  assert.doesNotThrow(() => verifyEvidence(content, events));
  assert.deepEqual(events, original, 'post-call suggestions must not rewrite saved speech');
  assert.doesNotThrow(() => verifyEvidence({ strengths: [{ text: '이야기를 공유했어요.', evidence_ids: ['sharing'] }],
    corrections: [], practice: [{ expression: 'A possible alternative.', evidence_ids: ['sharing'] }] }, events),
  'older notes without learning metadata remain valid');
});

test('post-call evidence rejects assistant attribution and rewritten or invented source quotations', () => {
  const events = [
    { id: 'user', speaker: 'user', text: 'I go to a cafe yesterday. How can I say “나도 할래” in English?' },
    { id: 'assistant', speaker: 'assistant', text: 'I went to a cafe yesterday. I am in.' },
  ];
  for (const content of [
    { corrections: [{ original: 'I go to a cafe yesterday.', evidence_ids: ['assistant'] }] },
    { corrections: [{ original: 'I went to a cafe yesterday.', evidence_ids: ['user'] }] },
    { strengths: [{ expression: 'I went to a cafe yesterday.', evidence_ids: ['user'] }] },
    { practice: [{ expression: 'I am in.', evidence_ids: ['user'], learning: { source_quote: 'I am in.', source_is_question: true } }] },
    { practice: [{ expression: 'I am in.', evidence_ids: ['user'], learning: { source_quote: '', source_is_question: true } }] },
  ]) assert.throws(() => verifyEvidence(content, events), /evidence reference|saved user|saved user question/);
});

const base = 'https://synthetic-smoke.supabase.co';
const policy = { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: false };
const emptyContext = () => ({ companionId: 'alex', scenario: 'Natural English conversation about everyday life',
  memory: { facts: [], memories: [], conversation_memories: [], recent_conversation: null, suppress_memory: true }, checkpoint: null });
const conversationContext = () => ({ ...emptyContext(), memory: { ...emptyContext().memory, suppress_memory: false, memories: [{
  session_id: '11111111-1111-4111-8111-111111111111', session_created_at: '2026-11-12T10:00:00Z', session_ended_at: '2026-11-12T10:02:00Z', session_time_zone: 'UTC',
  evidence: [{ id: '22222222-2222-4222-8222-222222222222', text: 'SYNTHETIC_PAST_ONLY', timestamp: '2026-11-12T10:01:00Z' }] }] } });
const handoffContext = () => {
  const context = conversationContext();
  context.memory.recent_conversation = { session_id: '33333333-3333-4333-8333-333333333333', session_created_at: '2026-11-12T11:00:00Z',
    session_ended_at: '2026-11-12T11:02:00Z', session_time_zone: 'UTC', mode: 'handoff', summary: null,
    turns: [{ id: '44444444-4444-4444-8444-444444444444', speaker: 'user', text: 'I enjoyed my sister’s piano practice.', timestamp: '2026-11-12T11:01:00Z' }],
    threads: [{ note: 'Enjoyed their sister’s piano practice.', state: 'resolved', when: null, follow_up: null, evidence_ids: ['44444444-4444-4444-8444-444444444444'] }] };
  context.memory.facts = [{ key: 'preference', value: 'Unhurried conversation', forgotten: false, manual: true, updated_at: '2026-11-12T12:00:00Z' }];
  return context;
};
const emptyOpening = () => ({ version: 'opening-context-v2', purpose: 'call_opening', current_utterance: null,
  context_kind: 'none', role: 'optional_conversation_context', prepared_topic: null, continuity: null, recent_openings: [], reason: 'no_recent_handoff' });
const historicalOpening = () => ({ ...emptyOpening(), context_kind: 'recent_conversation', reason: 'eligible_continuity', continuity: {
  session_id: '11111111-1111-4111-8111-111111111111', evidence_id: '22222222-2222-4222-8222-222222222222',
  source_started_at: '2026-11-12T10:00:00Z', source_ended_at: '2026-11-12T10:02:00Z', source_spoken_at: '2026-11-12T10:01:00Z',
  source_time_zone: 'UTC', plan_timing: null,
  note: 'SYNTHETIC_HISTORY_NOTE', quote: 'SYNTHETIC_PRIVATE_HISTORICAL_QUOTE', state: 'stated', when: null,
  role: 'historical_background', must_not_infer_outcome: true }, recent_openings: [{
    session_id: '33333333-3333-4333-8333-333333333333', occurred_at: '2026-11-12T09:00:00Z',
    text: 'SYNTHETIC_STYLE_QUESTION: What did you enjoy yesterday?', role: 'style_only' }] });
const instructions = context => `ROLE_AND_SAFETY:\nSynthetic safety policy.\nPERSONA:\nSynthetic companion.\nTRUSTED_TIME_CONTEXT_JSON:\n{}\nUNTRUSTED_CONTEXT_JSON:\n${JSON.stringify(context)}`;

async function fixture({ opening = emptyOpening(), ordinaryOpening = emptyContext(), ordinaryVoice = conversationContext(), returnedPolicy = policy, manual = true } = {}) {
  const voice = instructions(ordinaryVoice);
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
  function user(transcript = 'SYNTHETIC_PRIVATE_SPEECH') {
    channel.emit({ type: 'input_audio_buffer.committed', item_id: 'synthetic-user-item' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'synthetic-user-item', transcript });
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

test('live manual smoke accepts optional historical/style background and a chosen topic without an opening assignment or current speech', async () => {
  const prepared = { ...emptyOpening(), context_kind: 'user_chosen_topic', reason: 'prepared_topic', prepared_topic: {
    text: 'SYNTHETIC_PREPARED_TOPIC', source: 'current_session_user_prepared', role: 'optional_topic_not_spoken_utterance' } };
  const planned = historicalOpening(); planned.continuity.state = 'planned';
  const resolved = historicalOpening(); resolved.continuity.state = 'resolved';
  const upcoming = historicalOpening(); upcoming.continuity.state = 'planned';
  upcoming.continuity.when = 'tomorrow'; upcoming.continuity.quote += ' tomorrow';
  upcoming.continuity.plan_timing = { local_date: '2026-11-13', time_zone: 'UTC', relation: 'upcoming' };
  for (const opening of [emptyOpening(), historicalOpening(), planned, upcoming, resolved, prepared]) {
    const f = await fixture({ opening }), response = f.create('startup'); f.finish(response, f.acknowledge(response)); f.reply();
    assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
    assert.equal(f.observed.manual.liveContextValid, true);
    assert.equal(f.observed.manual.openingContextValid, true); assert.equal(f.observed.manual.currentInputNone, true);
    assert.equal(f.observed.manual.historicalContextPresent, Boolean(opening.continuity || opening.recent_openings.length));
    assert.equal(f.observed.manual.preparedTopicPresent, Boolean(opening.prepared_topic));
    assert.doesNotMatch(JSON.stringify(f.observed), /SYNTHETIC_HISTORY_NOTE|SYNTHETIC_STYLE_QUESTION|SYNTHETIC_PRIVATE_HISTORICAL_QUOTE|SYNTHETIC_PREPARED_TOPIC|11111111-1111/);
  }
});

test('live manual smoke rejects raw-history leakage, false current speech, opening assignments and incompatible optional context', async () => {
  for (const mode of ['ordinary-history', 'current-speech', 'missing-current', 'untyped-style', 'current-role', 'wrong-version', 'missing-context', 'inconsistent-kind', 'missing-kind', 'unknown-kind', 'missing-role', 'assignment-role', 'legacy-strategy', 'legacy-action', 'missing-plan-timing', 'nonplanned-timing', 'invalid-plan-day', 'invalid-plan-zone', 'mismatched-plan-zone', 'inferred-outcome']) {
    const ordinaryOpening = emptyContext(), opening = historicalOpening();
    if (mode === 'ordinary-history') ordinaryOpening.memory.facts.push({ value: 'SYNTHETIC_PAST_ONLY' });
    if (mode === 'current-speech') opening.current_utterance = 'SYNTHETIC_CURRENT_SPEECH';
    if (mode === 'missing-current') delete opening.current_utterance;
    if (mode === 'untyped-style') opening.recent_openings[0].role = 'user_fact';
    if (mode === 'current-role') opening.continuity.role = 'current_utterance';
    if (mode === 'wrong-version') opening.version = 'unrecognized-opening-version';
    if (mode === 'inconsistent-kind') opening.context_kind = 'none';
    if (mode === 'missing-kind') delete opening.context_kind;
    if (mode === 'unknown-kind') opening.context_kind = 'lesson';
    if (mode === 'missing-role') delete opening.role;
    if (mode === 'assignment-role') opening.role = 'required_response_action';
    if (mode === 'legacy-strategy') opening.strategy = 'supported_continuity';
    if (mode === 'legacy-action') opening.action = 'pick_up_unresolved_plan';
    if (mode === 'missing-plan-timing') delete opening.continuity.plan_timing;
    if (mode === 'nonplanned-timing') opening.continuity.plan_timing = { local_date: '2026-11-13', time_zone: 'UTC', relation: 'upcoming' };
    if (['invalid-plan-day', 'invalid-plan-zone', 'mismatched-plan-zone'].includes(mode)) {
      opening.continuity.state = 'planned';
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

test('live manual smoke rejects teaching fields by their context structure even when empty or nested', async () => {
  for (const mutate of [
    value => { value.prepared_target = null; },
    value => { value.memory.focus = []; },
    value => { value.memory.practiced = []; },
    value => { value.memory.memories[0].corrections = []; },
    value => { value.memory.memories[0].practice = []; },
    value => { value.memory.memories[0].summary = 'SYNTHETIC_FEEDBACK_SUMMARY'; },
    value => { value.checkpoint = { summary: 'Continuing the cafe conversation.', next_scenario: 'SYNTHETIC_LESSON' }; },
  ]) {
    const ordinaryVoice = conversationContext(); mutate(ordinaryVoice);
    const f = await fixture({ ordinaryVoice }), opening = f.create('startup'); f.finish(opening, f.acknowledge(opening)); f.reply();
    assert.equal(f.observed.manual.liveContextValid, false);
    assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /conversation-only/);
    assert.doesNotMatch(JSON.stringify(f.observed), /SYNTHETIC_FEEDBACK_SUMMARY|SYNTHETIC_LESSON/);
  }
  const ordinaryOpening = emptyContext(); ordinaryOpening.memory.focus = [];
  const f = await fixture({ ordinaryOpening }), opening = f.create('startup'); f.finish(opening, f.acknowledge(opening)); f.reply();
  assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /conversation-only/);
});

test('live manual smoke preserves dated user handoffs and profile controls while rejecting authored future cues', async () => {
  const ordinaryVoice = handoffContext(), f = await fixture({ ordinaryVoice });
  f.reply(); assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
  ordinaryVoice.memory.recent_conversation.threads[0].follow_up = 'SYNTHETIC_INVITATION_TO_PRACTICE';
  const invalid = await fixture({ ordinaryVoice }); invalid.reply();
  assert.throws(() => verifyManualRealtimeObservation(invalid.observed.manual), /conversation-only/);
  assert.equal(JSON.stringify(invalid.observed).includes('SYNTHETIC_INVITATION_TO_PRACTICE'), false);
});

test('live manual smoke preserves current sharing and explicit language-help requests through the same curated reply contract', async () => {
  // The observer checks transport/evidence boundaries, not whether a model's
  // actual wording is friendly, useful or sufficiently brief.
  for (const utterance of ['I finally cooked dinner for my sister, and she loved it.', 'How can I say “나도 할래” in English?']) {
    const ordinaryVoice = conversationContext(); ordinaryVoice.memory.memories[0].evidence[0].text = 'I enjoyed my sister’s piano practice yesterday.';
    const f = await fixture({ ordinaryVoice }); f.user(utterance);
    const response = f.create('reply'); f.finish(response, f.acknowledge(response));
    assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
    assert.deepEqual(response.input, [{ type: 'item_reference', id: 'synthetic-user-item' }]);
    assert.equal(f.observed.manual.replyCompleted, 1);
    assert.equal(JSON.stringify(f.observed).includes(utterance), false, 'observations keep private speech out of reports');
  }
});

test('live manual smoke checks effective checkpoint updates without banning language in genuine conversation quotations', async () => {
  const f = await fixture(), opening = f.create('startup'); f.finish(opening, f.acknowledge(opening)); f.reply();
  const context = conversationContext(); context.checkpoint = { summary: 'The caller asked how to phrase an invitation; continue their current topic.' };
  f.channel.emit({ type: 'session.updated', session: { instructions: instructions(context) } });
  const afterCheckpoint = f.create('reply', { instructions: instructions(context) }); f.finish(afterCheckpoint, f.acknowledge(afterCheckpoint));
  assert.doesNotThrow(() => verifyManualRealtimeObservation(f.observed.manual));
  context.checkpoint.practice = [];
  f.channel.emit({ type: 'session.updated', session: { instructions: instructions(context) } });
  assert.equal(f.observed.manual.liveContextValid, false);
  assert.throws(() => verifyManualRealtimeObservation(f.observed.manual), /conversation-only/);
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
