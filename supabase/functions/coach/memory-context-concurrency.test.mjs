import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handler } from './index.ts';

const userId = '11111111-1111-4111-8111-111111111111', sessionId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333', sourceId = '44444444-4444-4444-8444-444444444444';
const callerId = '55555555-5555-4555-8555-555555555555', companionId = '66666666-6666-4666-8666-666666666666';
const turnId = '77777777-7777-4777-8777-777777777777', assistantId = '88888888-8888-4888-8888-888888888888', nonce = '99999999-9999-4999-8999-999999999999';
const currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const configuration = { ACCESS_MODE: 'invite', ALLOWED_EMAILS: 'owner@example.com', ALLOWED_ORIGINS: 'https://example.com', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service', OPENAI_API_KEY: 'test-model', AUTHORED_DIALOGUE_ENABLED: 'true', AUTHORED_DIALOGUE_FIDELITY_VERIFIED: 'true' };
globalThis.Deno = { env: { get: name => configuration[name] } };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('The independent read did not start')), 2000); })]); }
  finally { clearTimeout(timer); }
}
const request = (endpoint = 'voice', body = { sessionId, sdp }) => new Request('https://project.supabase.co/functions/v1/coach/' + endpoint, { method: 'POST', headers: { Origin: 'https://example.com', Authorization: 'Bearer test-user', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const authoredRequest = () => request('dialogue-turn', { protocol: 'authored_dialogue_v1', sessionId, callEpoch: 1, authorityGeneration: 1, turnNonce: nonce, expectedGeneration: 0,
  playbackEpoch: 1, purpose: 'reply', currentUserEventIds: [currentId], acceptedHistoryEventIds: [], expectedMemoryRevision: 1, omitLearningContext: false, speechSpeed: .85 });
const sharedExchange = () => ({ version: 'conversation-exchange-v1', source_session_id: sourceId, companion_id: 'alex', memory_revision: 1,
  session_created_at: '2026-01-01T10:00:00Z', session_ended_at: '2026-01-01T10:05:00Z', session_time_zone: 'UTC', admission: 'client_reported_playback_completed',
  caller: { id: callerId, speaker: 'user', quote: 'I am trying a new recipe.', timestamp: '2026-01-01T10:01:00Z', truncated: false },
  companion: { id: companionId, speaker: 'assistant', quote: 'The lemon version sounds interesting.', timestamp: '2026-01-01T10:02:00Z', truncated: false } });
const memory = () => ({ revision: 1, facts: [], memories: [], shared_exchanges: [sharedExchange()], limited: false, retrieval: 'keyword' });

async function withFixture(options, inspect) {
  const originalFetch = globalThis.fetch;
  const keys = options.gates ?? [], gates = new Map(keys.map(key => [key, deferred()])), bothStarted = deferred();
  const state = { memoryReads: 0, learningReads: 0, provider: 0, completed: 0, reserved: 0, failed: 0, dispatches: 0, completionGuards: 0, excluded: false, returned: false, started: [], finished: [], mutate: false,
    release: kind => { for (const [key, gate] of gates) if (key.startsWith(kind + ':')) gate.resolve(); }, bothStarted: bothStarted.promise };
  const turn = { id: turnId, assistant_event_id: assistantId, session_id: sessionId, user_id: userId, companion_id: 'alex', call_epoch: 1, authority_generation: 1,
    turn_generation: 1, playback_epoch: 1, turn_nonce: nonce, memory_mode: 'included', memory_revision: 1, status: 'reserved', speech_speed: .85 };
  async function read(kind, number, body) {
    assert.equal(body.p_user_id, userId); assert.equal(body.p_companion_id, 'alex');
    const key = kind + ':' + number; state.started.push(key);
    if (keys.every(item => state.started.includes(item))) bothStarted.resolve();
    if (gates.has(key)) await gates.get(key).promise;
    const value = kind === 'memory' ? options.memory?.(number, state) ?? memory() : options.learning?.(number, state) ?? { focus: [], suppress_memory: false };
    state.finished.push(key);
    return value instanceof Response ? value : response(value);
  }
  globalThis.fetch = async (url, options_) => {
    const path = String(url), body = typeof options_?.body === 'string' ? JSON.parse(options_.body) : null;
    if (path.includes('/auth/v1/user')) return response({ id: userId, email: options.denied ? 'other@example.com' : 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' });
    if (path.includes('/sessions?')) return response(options.foreign ? [] : [{ id: sessionId, user_id: userId, companion_id: 'alex', scenario: options.scenario ?? '', status: 'active' }]);
    if (path.includes('/learning_usage_prepare')) return response({ targets: [], source_version: 'session-v1' });
    if (path.includes('/learning_voice_context')) return read('learning', ++state.learningReads, body);
    if (path.includes('/memory_context')) return read('memory', ++state.memoryReads, body);
    if (path.includes('/conversation_context_authorized')) return response(true);
    if (path.includes('/authored_dialogue_state')) return response({ call_epoch: 1, authority_generation: 1, turn_generation: 0, memory_mode: 'included', memory_revision: 1, checkpoint: null });
    if (path.includes('/authored_dialogue_history')) return response({ current_user_ids: [currentId], history_ids: [], events: [{ id: currentId, session_id: sessionId, speaker: 'user', text: 'A new detail for this conversation.', timestamp: '2026-11-14T10:00:00Z' }], source_event_digests: { [currentId]: 'd'.repeat(32) } });
    if (path.includes('/authored_dialogue_begin')) return response({ turn });
    if (path.includes('/authored_dialogue_dispatch') || path.includes('/authored_dialogue_complete_text')) {
      const dispatch = path.includes('/authored_dialogue_dispatch'); if (dispatch) state.dispatches++; else state.completionGuards++;
      // Fake the existing SQL guard's fresh suppression check. Separate SQL
      // integration tests cover authored_turn_lock/authored_verify_sources.
      if (state.excluded) return new Response(JSON.stringify({ message: 'DIALOGUE_SOURCE_CHANGED' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (dispatch) return response(true);
      state.completed++;
      return response({ turn: { ...turn, status: 'text_complete', written_text_sha256: createHash('sha256').update(body.p_text).digest('hex') }, assistant_event: { id: assistantId, session_id: sessionId, speaker: 'assistant', text: body.p_text, event_key: 'authored:' + turnId, timestamp: '2026-11-14T10:00:01Z' } });
    }
    if (path.includes('/reserve_run')) { state.reserved++; return response({ reserved: true, job_id: jobId, lease_token: jobId }); }
    if (path.includes('/reserve_model_spend')) return response(true);
    if (path.includes('/record_model_spend')) return response(null);
    if (path.includes('/embeddings')) { state.provider++; return response({ data: [{ index: 0, embedding: Array(512).fill(1) }], usage: { prompt_tokens: 1 } }); }
    if (path.includes('/realtime/calls')) { state.provider++; return new Response(sdp); }
    if (path.includes('/responses')) { state.provider++; return response({ id: 'response-fixture', status: 'completed', model: body.model, store: false, metadata: body.metadata, text: { format: { type: 'text' } }, usage: { input_tokens: 100, output_tokens: 20 },
      output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A prepared reply.' }] }] }); }
    if (path.includes('/complete_run')) { state.completed++; return response(true); }
    if (path.includes('/fail_run')) { state.failed++; return response(true); }
    throw Error('Unexpected or premature provider/publication request: ' + path);
  };
  const pending = handler(options.request ?? (options.authored ? authoredRequest() : request())).then(value => { state.returned = true; return value; });
  try { return await inspect(state, pending); }
  finally { for (const gate of gates.values()) gate.resolve(); await pending; globalThis.fetch = originalFetch; }
}

test('initial reads and authored SQL-guarded verification start together and keep provider/publication behind both results', async () => {
  for (const phase of ['initial', 'before-provider', 'after-provider']) for (const first of ['memory', 'learning']) {
    const counts = phase === 'initial' ? [1, 1] : phase === 'before-provider' ? [2, 3] : [3, 4];
    await withFixture({ authored: phase !== 'initial', gates: ['memory:' + counts[0], 'learning:' + counts[1]] }, async (state, pending) => {
      await bounded(state.bothStarted);
      assert.equal(state.provider, phase === 'after-provider' ? 1 : 0, phase);
      assert.equal(state.completed, 0); assert.equal(state.returned, false);
      if (phase === 'initial') assert.equal(state.reserved, 0);
      state.release(first); await tick();
      assert.equal(state.provider, phase === 'after-provider' ? 1 : 0); assert.equal(state.completed, 0); assert.equal(state.returned, false);
      state.release(first === 'memory' ? 'learning' : 'memory');
      const result = await bounded(pending); assert.equal(result.status, 200, phase + ':' + first);
      assert.equal(state.provider, 1); assert.equal(state.completed, 1);
      assert.equal(state.memoryReads, 3); assert.equal(state.learningReads, 4, 'the later eligibility refresh is retained');
    });
  }
});

test('memory retrieval cannot spend on embeddings or publish selected history before both initial reads validate', async () => {
  for (const mode of ['memory-first', 'learning-first', 'suppressed', 'invalid-learning']) {
    await withFixture({ request: request('memory', { companionId: 'alex', query: 'A private recipe query' }), gates: ['memory:1', 'learning:1'],
      memory: () => ({ ...memory(), memories: [{ id: jobId, session_id: sourceId, created_at: '2026-01-01T10:05:00Z', content: { summary: 'Private selected history.' }, source_event_ids: [callerId] }] }),
      learning: () => mode === 'invalid-learning' ? { suppress_memory: 'invalid' } : { focus: [], suppress_memory: mode === 'suppressed' },
    }, async (state, pending) => {
      await bounded(state.bothStarted); const first = mode === 'learning-first' ? 'learning' : 'memory';
      state.release(first); await tick(); assert.equal(state.provider, 0); assert.equal(state.reserved, 0); assert.equal(state.returned, false);
      state.release(first === 'memory' ? 'learning' : 'memory');
      const result = await bounded(pending), body = await result.json();
      assert.equal(result.status, mode === 'invalid-learning' ? 503 : 200, mode);
      assert.equal(state.provider, mode.endsWith('-first') ? 1 : 0); assert.equal(state.reserved, mode.endsWith('-first') ? 1 : 0);
      if (mode === 'suppressed') { assert.deepEqual(body.memories, []); assert.equal(body.shared_exchanges, undefined); assert.equal(body.suppress_memory, true); }
      if (mode === 'invalid-learning') { assert.equal(body.error.code, 'LEARNING_CONTEXT_UNAVAILABLE'); assert.equal(body.memories, undefined); }
      else assert.equal(state.learningReads, 2, 'eligibility is refreshed after the retrieval/provider phase');
    });
  }
});

test('revision, selected source, forget marker and learning exclusion changes still block pre/post-provider publication', async () => {
  for (const phase of ['before', 'after']) for (const change of ['revision', 'source', 'forget', 'exclusion', 'learning-failure']) {
    const memoryAt = phase === 'before' ? 2 : 3, learningAt = phase === 'before' ? 3 : 4;
    await withFixture({ authored: true, gates: ['memory:' + memoryAt, 'learning:' + learningAt],
      memory: (_number, state) => state.mutate && change === 'revision' ? { ...memory(), revision: 2 } : state.mutate && change === 'source' ? { ...memory(), shared_exchanges: [] } : state.mutate && change === 'forget' ? { ...memory(), facts: [{ key: 'recipe', value: '', forgotten: true, updated_at: new Date().toISOString() }] } : memory(),
      learning: (_number, state) => state.mutate && change === 'learning-failure' ? { suppress_memory: 'invalid' } : { focus: [], suppress_memory: state.mutate && change === 'exclusion' },
    }, async (state, pending) => {
      await bounded(state.bothStarted); state.mutate = true; state.release('learning'); await tick();
      assert.equal(state.returned, false); assert.equal(state.completed, 0);
      state.release('memory'); const result = await bounded(pending);
      assert.equal(result.status, change === 'learning-failure' ? 503 : 409, phase + ':' + change);
      const body = await result.json(); assert.equal(body.error.code, change === 'learning-failure' ? 'LEARNING_CONTEXT_UNAVAILABLE' : 'MEMORY_CHANGED');
      assert.equal(body.sdp, undefined); assert.equal(body.voice_instructions, undefined); assert.equal(body.opening_instructions, undefined);
      assert.equal(state.provider, phase === 'after' ? 1 : 0); assert.equal(state.completed, 0); assert.equal(state.failed, 1);
    });
  }
});

test('parallel failures retain initial learning priority and verification memory/source priority regardless of completion order', async () => {
  for (const phase of ['initial', 'verify-read', 'verify-revision', 'verify-source']) for (const first of ['learning', 'memory']) {
    const initial = phase === 'initial', memoryAt = initial ? 1 : 2, learningAt = initial ? 1 : 3;
    await withFixture({ authored: !initial, gates: ['memory:' + memoryAt, 'learning:' + learningAt],
      memory: number => number !== memoryAt ? memory() : phase === 'verify-revision' ? { ...memory(), revision: 2 } : phase === 'verify-source' ? { ...memory(), shared_exchanges: [] } : { ...memory(), revision: 'invalid' },
      learning: number => number === learningAt ? { suppress_memory: 'invalid' } : { focus: [], suppress_memory: false },
    }, async (state, pending) => {
      await bounded(state.bothStarted); state.release(first); await tick();
      assert.equal(state.returned, false); assert.equal(state.provider, 0); assert.equal(state.completed, 0);
      state.release(first === 'learning' ? 'memory' : 'learning');
      const result = await bounded(pending), body = await result.json();
      const code = initial ? 'LEARNING_CONTEXT_UNAVAILABLE' : phase === 'verify-read' ? 'DATABASE_UNAVAILABLE' : 'MEMORY_CHANGED';
      assert.equal(body.error.code, code, phase + ':' + first); assert.equal(state.completed, 0); assert.equal(state.provider, 0);
    });
  }
});

test('initial eligibility failure still wins over malformed scenario/query processing', async () => {
  await withFixture({ scenario: { invalid: true }, learning: () => ({ suppress_memory: 'invalid' }) }, async (_state, pending) => {
    const result = await pending; assert.equal((await result.json()).error.code, 'LEARNING_CONTEXT_UNAVAILABLE');
  });
});

test('parallel internal reads remain after approved-account and owned-session gates', async () => {
  for (const mode of ['denied', 'foreign']) await withFixture({ [mode]: true }, async (state, pending) => {
    assert.equal((await pending).status, mode === 'denied' ? 403 : 404);
    assert.equal(state.memoryReads, 0); assert.equal(state.learningReads, 0); assert.equal(state.provider, 0); assert.equal(state.completed, 0);
  });
});

test('legacy default keeps eligibility after delayed memory and catches a later exclusion with no selected shared sources', async () => {
  for (const phase of ['initial', 'before-provider', 'after-provider']) {
    const memoryAt = phase === 'initial' ? 1 : phase === 'before-provider' ? 2 : 3;
    const completedLearning = phase === 'initial' ? 1 : phase === 'before-provider' ? 2 : 3;
    await withFixture({ gates: ['memory:' + memoryAt], memory: () => ({ ...memory(), shared_exchanges: [] }),
      learning: (_number, state) => ({ focus: [], suppress_memory: state.excluded }),
    }, async (state, pending) => {
      await bounded(state.bothStarted); await tick();
      assert.equal(state.learningReads, completedLearning, 'legacy final eligibility must not start ahead of its memory read');
      assert(state.finished.includes('learning:' + completedLearning));
      state.excluded = true; state.release('memory');
      const result = await bounded(pending), body = await result.json();
      assert.equal(result.status, 409, phase); assert.equal(body.error.code, 'MEMORY_CHANGED');
      assert.equal(state.provider, phase === 'after-provider' ? 1 : 0); assert.equal(state.completed, 0);
      assert.equal(state.learningReads, completedLearning + 1, 'fresh eligibility observes the late exclusion');
      assert.equal(body.sdp, undefined); assert.equal(body.voice_instructions, undefined);
    });
  }
});

test('authored-only parallel opt-in cannot bypass final dispatch/complete-text guards when exclusion changes after early learning settles', async () => {
  for (const phase of ['before-provider', 'after-provider']) {
    const memoryAt = phase === 'before-provider' ? 2 : 3, learningAt = phase === 'before-provider' ? 3 : 4;
    await withFixture({ authored: true, gates: ['memory:' + memoryAt], memory: () => ({ ...memory(), shared_exchanges: [] }),
      learning: (_number, state) => ({ focus: [], suppress_memory: state.excluded }),
    }, async (state, pending) => {
      await bounded(state.bothStarted); await tick();
      assert.equal(state.learningReads, learningAt); assert(state.finished.includes('learning:' + learningAt), 'early false eligibility has settled before revocation');
      state.excluded = true; state.release('memory');
      const result = await bounded(pending), body = await result.json();
      assert.equal(result.status, 409); assert.equal(body.error.code, 'MEMORY_SOURCE_CHANGED');
      assert.equal(state.provider, phase === 'after-provider' ? 1 : 0); assert.equal(state.completed, 0);
      assert.equal(state.dispatches, 1); assert.equal(state.completionGuards, phase === 'after-provider' ? 1 : 0);
      assert.equal(body.text, undefined); assert.equal(body.assistantEvent, undefined); assert.equal(state.failed, 1);
    });
  }
});
