import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddingVector, memoryManagement, allowedOrigins, validateAnalysis, validateSdp, boundedJson, analysisChunks, mergeAnalyses, LIMITS, sourceIds, transcriptFingerprint } from './core.ts';
import { handler } from './index.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const event = { id: eventId, session_id: sessionId, speaker: 'user', text: 'Yesterday I go to the market.', timestamp: '2026-11-08T12:00:00Z' };
const content = () => ({ summary: 'Practiced past events.', strengths: [{ text: 'Explains an everyday activity.', evidence_ids: [eventId] }], corrections: [{ original: 'I go', improved: 'I went', reason: 'Use the past tense for yesterday.', evidence_ids: [eventId] }], practice: [{ expression: 'Yesterday I went to the market.', evidence_ids: [eventId] }], next_scenario: 'Describe your weekend.' });
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const authUser = { id: userId, email: 'Owner@Example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const config = { ACCESS_MODE: 'invite', ALLOWED_EMAILS: ' owner@example.com ', ALLOWED_ORIGINS: 'https://example.com,http://localhost:3000', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service', OPENAI_API_KEY: 'test-openai' };
globalThis.Deno = { env: { get: name => config[name] } };
const request = (endpoint, body, extra = {}) => new Request(`https://project.supabase.co/functions/v1/coach/${endpoint}`, { method: 'POST', headers: { Origin: 'https://example.com', Authorization: 'Bearer test-user', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
const memoryResponse = (memories = [], facts = [], revision = 0) => response({ revision, facts, memories, limited: false, retrieval: 'keyword' });
const response = (data, total = Array.isArray(data) ? data.length : null) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...(total === null ? {} : { 'Content-Range': `0-${Math.max(0, (data.length || 0) - 1)}/${total}` }) } });

test('origin allowlist is exact and disallows wildcard, paths, insecure remote origins', () => {
  assert.equal(allowedOrigins(config.ALLOWED_ORIGINS).has('https://example.com'), true);
  for (const value of ['*', 'https://example.com/', 'http://example.com', 'https://example.com/path']) assert.throws(() => allowedOrigins(value));
});
test('SDP and full serialized analysis input have byte limits', () => {
  assert.equal(validateSdp(sdp), sdp);
  assert.throws(() => validateSdp('hello'));
  assert.throws(() => validateSdp(sdp + 'a'.repeat(100_000)));
  assert.throws(() => boundedJson({ text: 'é'.repeat(70_000) }));
});
test('valid citations are retained and invented citations, assistant sources, fabricated quotes fail', () => {
  const good = content();
  assert.equal(validateAnalysis(good, [event], 'session'), good);
  assert.deepEqual(sourceIds(good), [eventId]);
  const wrongId = content(); wrongId.strengths[0].evidence_ids = [sessionId];
  assert.throws(() => validateAnalysis(wrongId, [event], 'session'));
  assert.throws(() => validateAnalysis(content(), [{ ...event, speaker: 'assistant' }], 'session'));
  const wrongQuote = content(); wrongQuote.corrections[0].original = 'I am eating';
  assert.throws(() => validateAnalysis(wrongQuote, [event], 'session'));
});
test('transcript fingerprint ignores ordering and changes with restored or edited evidence', async () => {
  const second = { ...event, id: sessionId, text: 'A second turn.' };
  assert.equal(await transcriptFingerprint([event, second]), await transcriptFingerprint([second, event]));
  assert.notEqual(await transcriptFingerprint([event]), await transcriptFingerprint([event, second]));
  assert.notEqual(await transcriptFingerprint([event]), await transcriptFingerprint([{ ...event, text: 'Changed evidence.' }]));
});
test('preflight rejects untrusted origins without reflecting them', async () => {
  const result = await handler(new Request('https://project.supabase.co/functions/v1/coach/voice', { method: 'OPTIONS', headers: { Origin: 'https://example.com.evil.test' } }));
  assert.equal(result.status, 403); assert.equal(result.headers.get('access-control-allow-origin'), null);
  const good = await handler(new Request('https://project.supabase.co/functions/v1/coach/voice', { method: 'OPTIONS', headers: { Origin: 'https://example.com' } }));
  assert.equal(good.status, 204); assert.equal(good.headers.get('access-control-allow-origin'), 'https://example.com');
});
test('missing bearer fails before any remote request', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network'); };
  try {
    const req = request('voice', { sessionId, sdp }); req.headers.delete('Authorization');
    assert.equal((await handler(req)).status, 401);
  } finally { globalThis.fetch = original; }
});
test('unapproved and unverified emails cannot reach the database or OpenAI', async () => {
  const original = globalThis.fetch;
  try {
    for (const user of [{ ...authUser, email: 'stranger@example.com' }, { ...authUser, email_confirmed_at: null, confirmed_at: '2026-01-01T00:00:00Z' }, { ...authUser, email: 'owner@example.com.attacker.test' }]) {
      const calls = [];
      globalThis.fetch = async url => { calls.push(String(url)); assert.ok(String(url).endsWith('/auth/v1/user')); return response(user); };
      const result = await handler(request('voice', { sessionId, sdp }));
      assert.equal(result.status, 403); assert.equal((await result.json()).error.code, 'ACCOUNT_NOT_ALLOWED');
      assert.equal(calls.length, 1);
    }
  } finally { globalThis.fetch = original; }
});
test('invite mode requires an email allowlist before authentication or spending', async () => {
  const original = globalThis.fetch, previous = config.ALLOWED_EMAILS;
  globalThis.fetch = () => { throw new Error('Unexpected network'); };
  delete config.ALLOWED_EMAILS;
  try {
    const result = await handler(request('voice', { sessionId, sdp }));
    assert.equal(result.status, 503); assert.equal((await result.json()).error.code, 'CONFIGURATION_REQUIRED');
  } finally { globalThis.fetch = original; config.ALLOWED_EMAILS = previous; }
});
test('unowned session cannot reserve or start voice', async () => {
  const original = globalThis.fetch; const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return response(String(url).includes('/auth/') ? authUser : []); };
  try {
    const result = await handler(request('voice', { sessionId, sdp }));
    assert.equal(result.status, 404); assert.equal(urls.length, 2);
  } finally { globalThis.fetch = original; }
});
test('review rejects active sessions before generating feedback', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => response(String(url).includes('/auth/') ? authUser : [{ id: sessionId, user_id: userId, status: 'active', scenario: 'Travel' }]);
  try { assert.equal((await handler(request('review', { sessionId }))).status, 409); }
  finally { globalThis.fetch = original; }
});
test('unreserved voice job never reaches OpenAI', async () => {
  const original = globalThis.fetch; let openai = 0;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes('api.openai.com')) { openai++; throw new Error('Must not call'); }
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, status: 'active', scenario: 'Travel' }]);
    if (path.includes('/memory_context')) return memoryResponse();
    return response({ reserved: false, state: 'running', reason: 'in_progress' });
  };
  try { assert.equal((await handler(request('voice', { sessionId, sdp }))).status, 409); assert.equal(openai, 0); }
  finally { globalThis.fetch = original; }
});
test('invalid generated evidence fails the reserved run and never stores analysis', async () => {
  const original = globalThis.fetch; let failed = false, stored = false;
  const bad = content(); bad.corrections[0].original = 'an invented quote';
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, status: 'ended', scenario: 'Travel', ended_at: '2026-11-08T12:00:00Z' }]);
    if (path.includes('/transcript_events?')) return response([event]);
    if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    if (path.includes('api.openai.com')) {
      const payload = JSON.parse(options.body); assert.equal(payload.text.format.type, 'json_schema'); assert.equal(payload.store, false);
      assert.ok(payload.instructions.includes('in Korean'));
      assert.ok(payload.instructions.includes('in English'));
      return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(bad) }] }] });
    }
    if (path.includes('/fail_run')) { failed = true; return response(true); }
    if (path.includes('/complete_analysis_run')) { stored = true; return response({}); }
    throw new Error('Unexpected request');
  };
  try {
    const result = await handler(request('review', { sessionId }));
    assert.equal(result.status, 502); assert.equal((await result.json()).error.code, 'INVALID_MODEL_OUTPUT');
    assert.equal(failed, true); assert.equal(stored, false);
  } finally { globalThis.fetch = original; }
});
test('oversized transcript pagination fails explicitly without reserving a job', async () => {
  const original = globalThis.fetch; let reserved = false;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, status: 'ended', scenario: 'Travel' }]);
    if (path.includes('/transcript_events?')) { const count = Number(new URL(path).searchParams.get('limit')); return response(Array.from({ length: count }, () => event), 12001); }
    reserved = true; throw new Error('Must not reserve');
  };
  try {
    const result = await handler(request('review', { sessionId }));
    assert.equal(result.status, 413); assert.equal(reserved, false);
  } finally { globalThis.fetch = original; }
});

test('all pages are read despite a lower database page cap, then stored atomically', async () => {
  const original = globalThis.fetch; let pages = 0, stored;
  const second = { ...event, id: '44444444-4444-4444-8444-444444444444', speaker: 'assistant', text: 'What did you buy?' };
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, status: 'ended', scenario: 'Travel' }]);
    if (path.includes('/transcript_events?')) {
      assert.equal(options.headers.Prefer, 'count=exact'); pages++;
      return response([new URL(path).searchParams.get('offset') === '0' ? event : second], 2);
    }
    if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    if (path.includes('api.openai.com')) return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(content()) }] }] });
    if (path.includes('/complete_analysis_run')) {
      stored = JSON.parse(options.body); return response({ analysis: { id: sessionId, content: stored.p_content } });
    }
    throw new Error('Unexpected request');
  };
  try {
    const result = await handler(request('review', { sessionId }));
    assert.equal(result.status, 200); assert.equal(pages, 2);
    assert.deepEqual(stored.p_source_event_ids, [event.id, second.id]);
    assert.equal(stored.p_content.scope.event_count, 2);
    assert.equal(stored.p_content.scope.user_event_count, 1);
    assert.equal((await result.json()).analysis.content.based_on.length, 2);
  } finally { globalThis.fetch = original; }
});

test('voice uses server multipart exchange and persists no SDP or secret', async () => {
  const original = globalThis.fetch; let completed;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, status: 'active', scenario: 'Travel' }]);
    if (path.includes('/memory_context')) return memoryResponse();
    if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    if (path.includes('/realtime/calls')) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('sdp'), sdp);
      const session = JSON.parse(options.body.get('session'));
      assert.equal(session.model, 'gpt-realtime-mini');
      assert.equal(session.max_output_tokens, 512);
      assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
      assert.equal(session.audio.output.voice, 'cedar');
      assert.equal(options.headers.Authorization, 'Bearer test-openai');
      return new Response(sdp);
    }
    if (path.includes('/complete_run')) { completed = JSON.parse(options.body); return response(completed.p_result); }
    throw new Error('Unexpected request');
  };
  try {
    const result = await handler(request('voice', { sessionId, sdp }));
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { sdp });
    assert.deepEqual(completed.p_result, { connected: true });
  } finally { globalThis.fetch = original; }
});

test('memory retrieves old relevant corrections and practice through all-history search', async () => {
  const original = globalThis.fetch; let search;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/memory_context')) {
      search = JSON.parse(options.body);
      return memoryResponse([{ id: eventId, session_id: sessionId, content: content(), source_event_ids: [eventId], created_at: '2020-01-01T00:00:00Z' }]);
    }
    if (path.includes('/reserve_run')) return response({ reserved: false, reason: 'budget_exceeded' });
    throw new Error('Unexpected recent-history query');
  };
  try {
    const result = await handler(request('memory', { query: 'market' }));
    assert.equal(result.status, 200); const body = await result.json();
    assert.deepEqual(search, { p_user_id: userId, p_query: 'market', p_limit: 12, p_companion_id: 'alex', p_embedding: null, p_embedding_model: 'text-embedding-3-small' });
    assert.equal(body.memories[0].created_at, '2020-01-01T00:00:00Z');
    assert.equal(body.memories[0].corrections[0].improved, 'I went');
    assert.equal(body.memories[0].practice[0].expression, 'Yesterday I went to the market.');
    assert.deepEqual(body.memories[0].source_event_ids, [eventId]);
  } finally { globalThis.fetch = original; }
});

test('weekly review selects ended sessions in a seven-day window and records its scope', async () => {
  const original = globalThis.fetch; let saved;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) {
      const params = new URL(path).searchParams;
      assert.equal(params.get('status'), 'eq.ended');
      assert.ok(params.get('ended_at').startsWith('gte.'));
      assert.ok(params.get('and').startsWith('(ended_at.lte.'));
      return response([{ id: sessionId, user_id: userId, status: 'ended', scenario: 'Travel', ended_at: '2026-11-08T12:00:00Z' }]);
    }
    if (path.includes('/transcript_events?')) return response([event]);
    if (path.includes('/reserve_run')) {
      const body = JSON.parse(options.body); assert.equal(body.p_kind, 'weekly');
      assert.match(body.p_request_key, /^v3:alex:\d{4}-\d{2}-\d{2}:[a-f0-9]{16}:[a-f0-9]{64}$/);
      return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    }
    if (path.includes('api.openai.com')) {
      assert.equal(JSON.parse(options.body).model, 'gpt-4.1');
      return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...content(), patterns: [{ text: 'Practicing past events.', evidence_ids: [eventId] }] }) }] }] });
    }
    if (path.includes('/complete_analysis_run')) { saved = JSON.parse(options.body); return response({ analysis: { content: saved.p_content } }); }
    throw new Error('Unexpected request');
  };
  try {
    const result = await handler(request('weekly', {}));
    assert.equal(result.status, 200);
    const scope = saved.p_content.scope;
    assert.equal(scope.session_count, 1); assert.equal(scope.user_event_count, 1);
    assert.equal(new Date(scope.period_end) - new Date(scope.period_start), 7 * 86_400_000);
    assert.deepEqual(saved.p_content.patterns[0].evidence_ids, [eventId]);
  } finally { globalThis.fetch = original; }
});

test('upstream failures never expose provider response text or credentials', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, status: 'active', scenario: 'Travel' }]);
    if (path.includes('/memory_context')) return memoryResponse();
    if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    if (path.includes('api.openai.com')) return new Response('private provider failure test-openai', { status: 500 });
    if (path.includes('/fail_run')) return response(true);
    throw new Error('Unexpected request');
  };
  try {
    const result = await handler(request('voice', { sessionId, sdp }));
    assert.equal(result.status, 502); const body = await result.text();
    assert.equal(body.includes('test-openai'), false); assert.equal(body.includes('private provider'), false);
    assert.equal(body.includes('VOICE_UNAVAILABLE'), true);
  } finally { globalThis.fetch = original; }
});

// Public service: every email-verified user can register; ownership remains enforced.
test('default public mode accepts a new verified email without an operator allowlist', async () => {
  const original=globalThis.fetch,mode=config.ACCESS_MODE,emails=config.ALLOWED_EMAILS;
  delete config.ACCESS_MODE;delete config.ALLOWED_EMAILS;const calls=[];
  globalThis.fetch=async url=>{calls.push(String(url));return response(String(url).includes('/auth/')?{...authUser,email:'new-user@example.org'}:[]);};
  try{const result=await handler(request('voice',{sessionId,sdp}));assert.equal(result.status,404);assert.equal(calls.length,2);assert.ok(calls[1].includes('/sessions?'));}
  finally{globalThis.fetch=original;config.ACCESS_MODE=mode;config.ALLOWED_EMAILS=emails;}
});
test('public mode rejects unverified accounts before DB access or model spending', async () => {
  const original=globalThis.fetch,mode=config.ACCESS_MODE;config.ACCESS_MODE='public';let count=0;
  globalThis.fetch=async()=>{count++;return response({...authUser,email:'new-user@example.org',email_confirmed_at:null});};
  try{assert.equal((await handler(request('voice',{sessionId,sdp}))).status,403);assert.equal(count,1);}
  finally{globalThis.fetch=original;config.ACCESS_MODE=mode;}
});

test('config exposes exactly the three companion profiles and their voices', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response(authUser);
  try {
    const result = await handler(new Request('https://project.supabase.co/functions/v1/coach/config', { headers: { Origin: 'https://example.com', Authorization: 'Bearer test-user' } }));
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.deepEqual(data.companions.map(({ id, voice }) => [id, voice]), [['mia', 'marin'], ['alex', 'cedar'], ['juno', 'verse']]);
    assert.equal(data.models.voice, 'gpt-realtime-mini');
    assert.equal(JSON.stringify(data).includes('test-service'), false);
  } finally { globalThis.fetch = original; }
});

test('each stored companion controls its voice, persona, and isolated retrieved practice', async () => {
  const original = globalThis.fetch;
  const profiles = [['mia', 'Mia', 'marin'], ['alex', 'Alex', 'cedar'], ['juno', 'Juno', 'verse']];
  try {
    for (const [id, name, voice] of profiles) {
      let searched = false, connected = false;
      globalThis.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/sessions?')) {
          assert.ok(new URL(path).searchParams.get('select').includes('companion_id'));
          return response([{ id: sessionId, user_id: userId, companion_id: id, status: 'active', scenario: 'Travel' }]);
        }
        if (path.includes('/memory_context')) {
          assert.equal(JSON.parse(options.body).p_companion_id, id); searched = true;
          return memoryResponse([{ id: eventId, session_id: eventId, content: { ...content(), summary: `${name} remembers practicing travel.`, practice: [{ expression: `${name} practice phrase`, evidence_ids: [eventId] }] }, source_event_ids: [eventId], created_at: '2026-01-01T00:00:00Z' }]);
        }
        if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
        if (path.includes('/realtime/calls')) {
          const session = JSON.parse(options.body.get('session')); connected = true;
          assert.equal(session.audio.output.voice, voice);
          assert.ok(session.instructions.includes(`Your name is ${name}.`));
          assert.ok(session.instructions.includes(`${name} practice phrase`));
          for (const [, other] of profiles) if (other !== name) assert.equal(session.instructions.includes(`${other} practice phrase`), false);
          return new Response(sdp);
        }
        if (path.includes('/complete_run')) return response({ connected: true });
        throw new Error('Unexpected cross-companion query');
      };
      assert.equal((await handler(request('voice', { sessionId, sdp }))).status, 200);
      assert.equal(searched, true); assert.equal(connected, true);
    }
  } finally { globalThis.fetch = original; }
});

test('memory derives the stored companion and rejects an explicit mismatch before retrieval', async () => {
  const original = globalThis.fetch;
  try {
    for (const companionId of [undefined, 'juno', 'mia']) {
      let searched = false;
      globalThis.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, companion_id: 'juno', scenario: 'Travel', status: 'active' }]);
        if (path.includes('/memory_context')) { searched = true; assert.equal(JSON.parse(options.body).p_companion_id, 'juno'); return memoryResponse(); }
        throw new Error('Unexpected request');
      };
      const result = await handler(request('memory', { sessionId, ...(companionId === undefined ? {} : { companionId }) }));
      if (companionId === 'mia') {
        assert.equal(result.status, 400); assert.equal((await result.json()).error.code, 'COMPANION_MISMATCH'); assert.equal(searched, false);
      } else { assert.equal(result.status, 200); assert.equal((await result.json()).companionId, 'juno'); assert.equal(searched, true); }
    }
  } finally { globalThis.fetch = original; }
});

test('invalid companion enums and voice/review client overrides fail before history retrieval', async () => {
  const original = globalThis.fetch;
  try {
    for (const [endpoint, body, code] of [
      ['weekly', { companionId: 'unknown' }, 'INVALID_COMPANION'],
      ['weekly', { companionId: null }, 'INVALID_COMPANION'],
      ['memory', { companionId: 'Mia' }, 'INVALID_COMPANION'],
      ['memory', { companionId: '' }, 'INVALID_COMPANION'],
      ['voice', { sessionId, sdp, companionId: 'mia' }, 'INVALID_BODY'],
      ['review', { sessionId, companionId: 'mia' }, 'INVALID_BODY'],
    ]) {
      let calls = 0;
      globalThis.fetch = async url => { calls++; assert.ok(String(url).includes('/auth/')); return response(authUser); };
      const result = await handler(request(endpoint, body));
      assert.equal(result.status, 400); assert.equal((await result.json()).error.code, code); assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('weekly history, model context, scope, and cache key are isolated to the selected companion', async () => {
  const original = globalThis.fetch;
  try {
    for (const companionId of ['mia', 'juno']) {
      let stored;
      globalThis.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/sessions?')) {
          assert.equal(new URL(path).searchParams.get('companion_id'), `eq.${companionId}`);
          return response([{ id: sessionId, user_id: userId, companion_id: companionId, scenario: 'Travel', status: 'ended', ended_at: event.timestamp }]);
        }
        if (path.includes('/transcript_events?')) {
          assert.equal(new URL(path).searchParams.get('session_id'), `in.(${sessionId})`);
          return response([event]);
        }
        if (path.includes('/reserve_run')) {
          assert.ok(JSON.parse(options.body).p_request_key.startsWith(`v3:${companionId}:`));
          return response({ reserved: true, job_id: sessionId, lease_token: eventId });
        }
        if (path.includes('/responses')) {
          const input = JSON.parse(JSON.parse(options.body).input);
          assert.equal(input.context.companion.id, companionId);
          return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...content(), patterns: [] }) }] }] });
        }
        if (path.includes('/complete_analysis_run')) { stored = JSON.parse(options.body).p_content; return response({ analysis: { content: stored } }); }
        throw new Error('Unexpected request');
      };
      assert.equal((await handler(request('weekly', { companionId }))).status, 200);
      assert.equal(stored.scope.companionId, companionId); assert.equal(stored.scope.session_count, 1);
      assert.deepEqual(stored.based_on.map(item => item.event_id), [eventId]);
    }
  } finally { globalThis.fetch = original; }
});

test('weekly rejects any unexpected cross-companion database rows before model spending', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async url => {
    calls++; const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    assert.ok(path.includes('/sessions?'));
    return response([{ id: sessionId, user_id: userId, companion_id: 'alex', scenario: 'Travel', status: 'ended' }]);
  };
  try {
    const result = await handler(request('weekly', { companionId: 'mia' }));
    assert.equal(result.status, 503); assert.equal((await result.json()).error.code, 'INCOMPLETE_HISTORY'); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('session review derives its companion identity without a client override', async () => {
  const original = globalThis.fetch; let stored;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, companion_id: 'mia', scenario: 'Travel', status: 'ended' }]);
    if (path.includes('/transcript_events?')) return response([event]);
    if (path.includes('/reserve_run')) {
      assert.ok(JSON.parse(options.body).p_request_key.startsWith(`v3:mia:${sessionId}:`));
      return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    }
    if (path.includes('/responses')) {
      assert.equal(JSON.parse(JSON.parse(options.body).input).context.companion.name, 'Mia');
      return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(content()) }] }] });
    }
    if (path.includes('/complete_analysis_run')) { stored = JSON.parse(options.body).p_content; return response({ analysis: { content: stored } }); }
    throw new Error('Unexpected request');
  };
  try { assert.equal((await handler(request('review', { sessionId }))).status, 200); assert.equal(stored.scope.companionId, 'mia'); }
  finally { globalThis.fetch = original; }
});

test('large analyses preserve complete events, byte bounds, citations and latest factual slots', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ ...event, id: crypto.randomUUID(), text: '한'.repeat(9000), timestamp: new Date(Date.parse(event.timestamp) + i * 1000).toISOString() }));
  const context = { scenarios: [{ session_id: sessionId, scenario: 'Practice' }, { session_id: userId, scenario: 'Unrelated'.repeat(10000) }] };
  const chunks = analysisChunks(events, context);
  assert.equal(chunks.length, 5);
  assert.deepEqual(chunks.flat(), events);
  for (const part of chunks) assert.ok(Buffer.byteLength(JSON.stringify(part)) < LIMITS.chunkBytes);
  const parts = chunks.map((part,i) => ({ summary: `Part ${i}`, strengths: [{ text: `Strength ${i}`, evidence_ids: [part[0].id] }], corrections: [], practice: [], next_scenario: 'Continue', memory_facts: [{ key: 'goal', value: `Goal ${i}`, quote: '한', evidence_ids: [part[0].id] }] }));
  const merged = mergeAnalyses(parts, events, 'session');
  assert.equal(merged.strengths.length, 5);
  assert.equal(merged.memory_facts[0].value, 'Goal 4');
  assert.deepEqual(sourceIds(merged), chunks.map(part => part[0].id));
  assert.throws(() => analysisChunks([...events, ...events], context), /eight-part/);
  assert.throws(() => analysisChunks([{ ...event, text: '한'.repeat(21000) }], {}), /too large/);
});

test('factual memory rejects invented quotes, assistant evidence, duplicate slots and oversized values', () => {
  const good = { ...content(), memory_facts: [{ key: 'goal', value: 'Practice English', quote: 'Yesterday', evidence_ids: [eventId] }] };
  assert.equal(validateAnalysis(good, [event], 'session'), good);
  for (const fact of [ { ...good.memory_facts[0], quote: 'Invented' }, { ...good.memory_facts[0], key: 'sensitive' }, { ...good.memory_facts[0], value: 'x'.repeat(241) } ]) assert.throws(()=>validateAnalysis({ ...good, memory_facts: [fact] }, [event], 'session'));
  assert.throws(()=>validateAnalysis({ ...good, memory_facts: [...good.memory_facts, ...good.memory_facts] }, [event], 'session'));
  assert.throws(()=>validateAnalysis(good, [{ ...event, speaker:'assistant' }], 'session'));
});

test('large review resumes cached parts and never generates more than two per request', async () => {
  const original = globalThis.fetch, cached = new Map();let calls=0, saved;
  const events=Array.from({length:6},(_,i)=>({...event,id:crypto.randomUUID(),text:'I practice English. '+'x'.repeat(25000),timestamp:new Date(Date.parse(event.timestamp)+i*1000).toISOString()}));
  globalThis.fetch=async(url,options)=>{
    const path=String(url), body=options?.body?JSON.parse(options.body):null;
    if(path.includes('/auth/'))return response(authUser);
    if(path.includes('/sessions?'))return response([{id:sessionId,user_id:userId,companion_id:'alex',status:'ended',scenario:'Travel'}]);
    if(path.includes('/transcript_events?'))return response(events);
    if(path.includes('/analysis_jobs?')){const key=new URL(path).searchParams.get('request_key').slice(3);return response(cached.has(key)?[{result:cached.get(key)}]:[]);}
    if(path.includes('/reserve_run'))return response({reserved:true,job_id:body.p_request_key,lease_token:eventId});
    if(path.includes('/complete_run')){cached.set(body.p_job_id,body.p_result);return response({});}
    if(path.includes('/fail_run'))return response({});
    if(path.includes('/responses')){calls++;const input=JSON.parse(body.input),id=input.transcript_events[0].id;const output={summary:'연습한 대화',strengths:[{text:'Explains an idea',evidence_ids:[id]}],corrections:[],practice:[],memory_facts:[],next_scenario:'Continue'};return response({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]});}
    if(path.includes('/complete_analysis_run')){saved=body;return response({analysis:{content:body.p_content}});}
    throw Error('Unexpected '+path);
  };
  try{
    const first=await handler(request('review',{sessionId}));assert.equal(first.status,409);assert.equal((await first.json()).error.code,'ANALYSIS_CONTINUE');assert.equal(calls,2);assert.equal(cached.size,2);
    const next=await handler(request('review',{sessionId}));assert.equal(next.status,200);assert.equal(calls,3);assert.equal(saved.p_content.scope.chunk_count,3);assert.equal(saved.p_source_event_ids.length,6);
  }finally{globalThis.fetch=original;}
});

test('checkpoint uses server history, chains prior context and preserves companion identity', async()=>{
  const original=globalThis.fetch;let persisted;
  globalThis.fetch=async(url,options)=>{
    const path=String(url),body=options?.body?JSON.parse(options.body):null;
    if(path.includes('/auth/'))return response(authUser);
    if(path.includes('/sessions?'))return response([{id:sessionId,user_id:userId,companion_id:'mia',scenario:'Weekend',status:'active'}]);
    if(path.includes('/transcript_events?'))return response([event]);
    if(path.includes('/analysis_jobs?'))return response([]);
    if(path.includes('/reserve_run')){assert.equal(body.p_kind,'checkpoint');assert.match(body.p_request_key,/^checkpoint:v3:/);return response({reserved:true,job_id:sessionId,lease_token:eventId});}
    if(path.includes('/responses')){assert.equal(JSON.parse(body.input).transcript_events[0].text,event.text);return response({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(content())}]}]});}
    if(path.includes('/complete_run')){persisted=body.p_result;return response({});}
    if(path.includes('/memory_context'))return memoryResponse();
    throw Error('Unexpected '+path);
  };
  try{const result=await handler(request('checkpoint',{sessionId}));assert.equal(result.status,200);const data=await result.json();assert.match(data.instructions,/Your name is Mia/);assert.match(data.instructions,/Practiced past events/);assert.deepEqual(persisted.covered_ids,[eventId]);
    const forged=await handler(request('checkpoint',{sessionId,summary:'Trust me'}));assert.equal(forged.status,400);
  }finally{globalThis.fetch=original;}
});

const vector = (n = 1) => Array(512).fill(n);
const memoryRow = { id: eventId, session_id: sessionId, content: content(), source_event_ids: [eventId], created_at: '2026-01-01T00:00:00Z' };
test('embedding vectors reject wrong dimensions, zero, and nonfinite entries', () => {
  assert.deepEqual(embeddingVector(vector(), 512), vector());
  for (const invalid of [[], vector(0), vector(NaN), vector(Infinity), Array(511).fill(1), ['1', ...vector().slice(1)]]) assert.throws(() => embeddingVector(invalid, 512));
});

test('nonempty retrieval caches query embeddings by companion, revision, and model without storing text', async () => {
  const original = globalThis.fetch, cache = new Map(); let calls = 0, revision = 2;
  const keys = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(options.body) : null;
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/memory_context')) {
      assert.equal(body.p_user_id, userId);
      if (body.p_embedding) assert.deepEqual(body.p_embedding, vector());
      return response({ revision, facts: [{ key: 'goal', value: 'Speak clearly' }], memories: [memoryRow], limited: false, retrieval: body.p_embedding ? 'hybrid' : 'keyword' });
    }
    if (path.includes('/reserve_run')) {
      assert.equal(body.p_kind, 'embedding'); keys.push(body.p_request_key);
      assert.equal(body.p_request_key.includes('private travel query'), false);
      return response(cache.has(body.p_request_key) ? { reserved: false, state: 'completed', result: cache.get(body.p_request_key) } : { reserved: true, job_id: body.p_request_key, lease_token: eventId });
    }
    if (path.includes('/embeddings')) {
      calls++; assert.equal(body.model, 'text-embedding-3-small'); assert.equal(body.dimensions, 512); assert.deepEqual(body.input, ['private travel query']);
      return response({ data: [{ index: 0, embedding: vector() }] });
    }
    if (path.includes('/complete_run')) { assert.deepEqual(Object.keys(body.p_result), ['vectors']); cache.set(body.p_job_id, body.p_result); return response(true); }
    throw Error(`Unexpected ${path}`);
  };
  try {
    for (let i = 0; i < 2; i++) {
      const result = await handler(request('memory', { companionId: 'mia', query: 'private travel query' }));
      assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.retrieval, 'hybrid'); assert.equal(data.facts[0].value, 'Speak clearly');
    }
    assert.equal(calls, 1); assert.equal(keys[0], keys[1]);
    revision++;
    assert.equal((await handler(request('memory', { companionId: 'mia', query: 'private travel query' }))).status, 200);
    assert.equal(calls, 2); assert.notEqual(keys[1], keys[2]);
    assert.equal((await handler(request('memory', { companionId: 'alex', query: 'private travel query' }))).status, 200);
    assert.notEqual(keys[2], keys[3]);
  } finally { globalThis.fetch = original; }
});

test('empty retrieval spends nothing; provider errors, malformed vectors and quota degrade to keyword', async () => {
  const original = globalThis.fetch;
  try {
    for (const mode of ['empty', 'no-history', 'quota', 'provider', 'malformed', 'json', 'null-row']) {
      let calls = 0, failed = false;
      globalThis.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/memory_context')) return memoryResponse(mode === 'no-history' ? [] : [memoryRow], [{ key: 'name', value: 'A' }], 1);
        if (path.includes('/reserve_run')) { assert.ok(!['empty', 'no-history'].includes(mode)); return response(mode === 'quota' ? { reserved: false, reason: 'budget_exceeded' } : { reserved: true, job_id: sessionId, lease_token: eventId }); }
        if (path.includes('/embeddings')) { calls++; return mode === 'provider' ? new Response('private provider secret', { status: 500 }) : mode === 'json' ? new Response('not json') : response({ data: mode === 'null-row' ? [null] : [{ index: 0, embedding: vector(0) }] }); }
        if (path.includes('/fail_run')) { failed = true; return response(true); }
        throw Error(`Unexpected ${path}`);
      };
      const result = await handler(request('memory', { companionId: 'mia', query: mode === 'empty' ? '  ' : 'hi' }));
      assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.retrieval, 'keyword'); assert.equal(data.facts[0].value, 'A');
      assert.equal(calls, ['empty', 'no-history', 'quota'].includes(mode) ? 0 : 1); assert.equal(failed, !['empty', 'no-history', 'quota'].includes(mode));
    }
  } finally { globalThis.fetch = original; }
});

test('memory database failures fail closed and never disclose raw database text', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('/auth/')) return response(authUser);
    if (String(url).includes('/memory_context')) return new Response('private database text', { status: 500 });
    calls++; throw Error('Unexpected model call');
  };
  try { const result = await handler(request('memory', { query: 'travel' })); assert.equal(result.status, 503); assert.equal((await result.text()).includes('private database'), false); assert.equal(calls, 0); }
  finally { globalThis.fetch = original; }
});

test('memory management enforces action-specific bodies and uses only authenticated identity', async () => {
  const original = globalThis.fetch; const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/auth/')) return response(authUser);
    assert.ok(String(url).endsWith('/rpc/memory_manage')); bodies.push(JSON.parse(options.body));
    return response({ revision: 3, facts: [], excluded_sessions: [], history_suppressed: true });
  };
  try {
    for (const action of ['list', 'setFact', 'forgetFact', 'excludeSession', 'restoreSession']) {
      const input = { companionId: 'juno', action, ...(action.includes('Fact') ? { key: 'goal' } : {}), ...(action === 'setFact' ? { value: '  Travel  ' } : {}), ...(action.includes('Session') ? { sessionId } : {}) };
      const result = await handler(request('memory-manage', input)); assert.equal(result.status, 200); assert.equal((await result.json()).revision, 3);
      assert.equal(bodies.at(-1).p_user_id, userId); assert.equal(bodies.at(-1).p_companion_id, 'juno');
      if (action === 'setFact') assert.equal(bodies.at(-1).p_value, 'Travel');
    }
    for (const input of [
      { action: 'list' }, { companionId: 'mia', action: ['list'] }, { companionId: 'mia', action: 'list', userId: sessionId },
      { companionId: 'mia', action: 'list', key: 'goal' }, { companionId: 'mia', action: 'setFact', key: 'sensitive', value: 'x' },
      { companionId: 'mia', action: 'setFact', key: 'goal', value: '' }, { companionId: 'mia', action: 'forgetFact', key: 'goal', value: 'x' },
      { companionId: 'mia', action: 'excludeSession', sessionId: 'not-a-uuid' }, { companionId: 'mia', action: 'restoreSession', sessionId, key: 'name' },
    ]) assert.equal((await handler(request('memory-manage', input))).status, 400);
    assert.equal(bodies.length, 5);
  } finally { globalThis.fetch = original; }
});

test('memory active-session conflicts are readable and foreign session failures disclose no details', async () => {
  const original = globalThis.fetch;
  try {
    for (const [code, status] of [['55000', 409], ['P0002', 404], ['42501', 503]]) {
      globalThis.fetch = async url => String(url).includes('/auth/') ? response(authUser) : new Response(JSON.stringify({ code, message: 'private foreign session' }), { status: 400 });
      const result = await handler(request('memory-manage', { companionId: 'mia', action: 'excludeSession', sessionId }));
      assert.equal(result.status, status); const data = await result.text(); assert.equal(data.includes('private foreign'), false); if (status === 409) assert.match(data, /진행 중인 대화/);
    }
  } finally { globalThis.fetch = original; }
});

test('bounded indexing honors provider ordering and stores only source-verified candidates', async () => {
  const original = globalThis.fetch; let candidateCalls = 0, sentBytes = 0; const stored = [];
  const candidates = [sessionId, eventId, userId, '44444444-4444-4444-8444-444444444444'].map((id, i) => ({ analysis_id: id, session_id: sessionId, document: String(i).repeat(8000), content_hash: `hash${i}`, revision: 4 }));
  globalThis.fetch = async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(options.body) : null;
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/memory_index_candidates')) { assert.equal(body.p_user_id, userId); assert.equal(body.p_companion_id, 'mia'); candidateCalls++; assert.equal(body.p_limit, candidateCalls === 1 ? 4 : 1); return response(candidateCalls === 1 ? candidates : [candidates[3]]); }
    if (path.includes('/reserve_run')) { assert.equal(body.p_kind, 'embedding'); assert.ok(body.p_request_key.includes(':index:')); return response({ reserved: true, job_id: sessionId, lease_token: eventId }); }
    if (path.includes('/embeddings')) {
      sentBytes = body.input.reduce((sum, input) => sum + Buffer.byteLength(input), 0); assert.equal(body.input.length, 3); assert.equal(sentBytes, 24000);
      return response({ data: [2, 0, 1].map(index => ({ index, embedding: vector(index + 1) })) });
    }
    if (path.includes('/complete_run')) return response(true);
    if (path.includes('/memory_store_embedding')) { stored.push(body); assert.equal(body.p_embedding[0], stored.length); return response(stored.length !== 2); }
    throw Error(`Unexpected ${path}`);
  };
  try {
    const result = await handler(request('memory-index', { companionId: 'mia' })); assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { indexed: 2, remaining: true, limited: true, model: 'text-embedding-3-small' });
    assert.equal(sentBytes, 24000); assert.equal(stored.length, 3);
    for (const body of stored) { assert.equal(body.p_user_id, userId); assert.equal(body.p_revision, 4); assert.equal(body.p_companion_id, 'mia'); assert.ok(body.p_content_hash.startsWith('hash')); }
  } finally { globalThis.fetch = original; }
});

test('indexing invalid vectors never reach storage and oversized documents never spend', async () => {
  const original = globalThis.fetch;
  try {
    for (const mode of ['oversized', 'invalid', 'duplicate-index']) {
      let spend = 0, stored = false;
      globalThis.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/memory_index_candidates')) return response([{ analysis_id: sessionId, session_id: sessionId, document: 'x'.repeat(mode === 'oversized' ? 24001 : 10), content_hash: 'hash', revision: 1 }]);
        if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
        if (path.includes('/embeddings')) { spend++; return response({ data: [{ index: mode === 'duplicate-index' ? 1 : 0, embedding: mode === 'invalid' ? vector(0) : vector() }] }); }
        if (path.includes('/fail_run')) return response(true);
        if (path.includes('/memory_store_embedding')) { stored = true; throw Error('No invalid vectors'); }
        throw Error(`Unexpected ${path}`);
      };
      const result = await handler(request('memory-index', { companionId: 'mia' }));
      assert.equal(result.status, mode === 'oversized' ? 200 : 502); assert.equal(spend, mode === 'oversized' ? 0 : 1); assert.equal(stored, false);
    }
  } finally { globalThis.fetch = original; }
});

test('checkpoint ignores previous revisions, routes independently, and voice facts omit provenance', async () => {
  const original = globalThis.fetch, previousCoach = config.COACH_MODEL, previousCheckpoint = config.CHECKPOINT_MODEL;
  config.COACH_MODEL = 'review-only-model'; config.CHECKPOINT_MODEL = 'checkpoint-only-model';
  let persisted, generated = false;
  globalThis.fetch = async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(options.body) : null;
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, companion_id: 'mia', scenario: 'Weekend', status: 'active' }]);
    if (path.includes('/transcript_events?')) return response([event]);
    if (path.includes('/memory_context')) return memoryResponse([], [{ key: 'name', value: '', forgotten: true, quote: 'OLD PRIVATE NAME', evidence_ids: [eventId] }], 8);
    if (path.includes('/analysis_jobs?')) {
      const params = new URL(path).searchParams; assert.equal(params.get('kind'), 'eq.checkpoint'); assert.ok(params.get('request_key').includes(':8:'));
      // Even if a database response includes stale rows, Edge checks metadata.
      return response([{ result: { revision: 7, model: 'checkpoint-only-model', prompt_version: 'v3', covered_ids: [eventId], checkpoint: { summary: 'OLD PRIVATE NAME' } } }]);
    }
    if (path.includes('/reserve_run')) { assert.equal(body.p_kind, 'checkpoint'); assert.ok(body.p_request_key.length < 200); return response({ reserved: true, job_id: sessionId, lease_token: eventId }); }
    if (path.includes('/responses')) {
      generated = true; assert.equal(body.model, 'checkpoint-only-model'); const input = JSON.parse(body.input); assert.equal(input.context.previous_checkpoint, null); assert.equal(body.input.includes('OLD PRIVATE NAME'), false);
      return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(content()) }] }] });
    }
    if (path.includes('/complete_run')) { persisted = body.p_result; return response(true); }
    throw Error(`Unexpected ${path}`);
  };
  try {
    const result = await handler(request('checkpoint', { sessionId })); assert.equal(result.status, 200); const data = await result.json();
    assert.equal(generated, true); assert.equal(persisted.revision, 8); assert.equal(persisted.model, 'checkpoint-only-model');
    assert.equal(data.instructions.includes('OLD PRIVATE NAME'), false);
    const context = JSON.parse(data.instructions.split('UNTRUSTED_CONTEXT_JSON:\n')[1]);
    assert.deepEqual(context.memory.facts, [{ key: 'name', value: '', forgotten: true }]);
  } finally { globalThis.fetch = original; if (previousCoach === undefined) delete config.COACH_MODEL; else config.COACH_MODEL = previousCoach; if (previousCheckpoint === undefined) delete config.CHECKPOINT_MODEL; else config.CHECKPOINT_MODEL = previousCheckpoint; }
});

test('checkpoint revision races fail closed for newly generated, cached and no-new-speech paths', async () => {
  const original = globalThis.fetch;
  try {
    for (const mode of ['generated', 'cached', 'covered']) {
      let reads = 0, generated = false, completed = false, failed = false;
      const cached = { revision: 1, model: 'gpt-4.1-mini', prompt_version: 'v3', covered_ids: [eventId], checkpoint: { summary: 'stale' } };
      globalThis.fetch = async (url, options) => {
        const path = String(url), body = options?.body ? JSON.parse(options.body) : null;
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, companion_id: 'mia', scenario: 'Weekend', status: 'active' }]);
        if (path.includes('/transcript_events?')) return response([event]);
        if (path.includes('/memory_context')) return memoryResponse([], [], ++reads === 1 ? 1 : 2);
        if (path.includes('/analysis_jobs?')) return response(mode === 'covered' ? [{ result: cached }] : []);
        if (path.includes('/reserve_run')) return response(mode === 'cached' ? { reserved: false, state: 'completed', result: cached } : { reserved: true, job_id: sessionId, lease_token: eventId });
        if (path.includes('/responses')) { generated = true; return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(content()) }] }] }); }
        if (path.includes('/complete_run')) { completed = true; return response(true); }
        if (path.includes('/fail_run')) { failed = true; return response(true); }
        throw Error(`Unexpected ${path}`);
      };
      const result = await handler(request('checkpoint', { sessionId })); assert.equal(result.status, 409); const data = await result.json();
      assert.equal(data.error.code, 'MEMORY_CHANGED'); assert.equal(data.instructions, undefined); assert.equal(completed, false); assert.equal(generated, mode === 'generated'); assert.equal(failed, mode === 'generated');
    }
  } finally { globalThis.fetch = original; }
});

test('voice revision races never return stale SDP or persist a successful connection', async () => {
  const original = globalThis.fetch;
  try {
    for (const changedAt of [2, 3]) {
      let reads = 0, provider = 0, completed = false, failed = false;
      globalThis.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/auth/')) return response(authUser);
        if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, companion_id: 'mia', scenario: 'Weekend', status: 'active' }]);
        if (path.includes('/memory_context')) return memoryResponse([], [], ++reads >= changedAt ? 2 : 1);
        if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
        if (path.includes('/realtime/calls')) { provider++; return new Response(sdp); }
        if (path.includes('/complete_run')) { completed = true; return response(true); }
        if (path.includes('/fail_run')) { failed = true; return response(true); }
        throw Error(`Unexpected ${path}`);
      };
      const result = await handler(request('voice', { sessionId, sdp })); assert.equal(result.status, 409); const data = await result.json();
      assert.equal(data.error.code, 'MEMORY_CHANGED'); assert.equal(data.sdp, undefined); assert.equal(provider, changedAt === 3 ? 1 : 0); assert.equal(completed, false); assert.equal(failed, true);
    }
  } finally { globalThis.fetch = original; }
});

test('model configuration exposes separate roles and long model IDs keep cache keys bounded', async () => {
  const original = globalThis.fetch, names = ['VOICE_MODEL', 'COACH_MODEL', 'CHECKPOINT_MODEL', 'ANALYSIS_MODEL', 'EMBEDDING_MODEL'];
  const saved = names.map(name => config[name]); const requested = [];
  names.forEach((name, i) => { config[name] = `independent-${i}-` + 'x'.repeat(180); });
  globalThis.fetch = async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(options.body) : null;
    if (path.includes('/auth/')) return response(authUser);
    if (path.includes('/memory_context')) return memoryResponse([memoryRow]);
    if (path.includes('/reserve_run')) { assert.ok(body.p_request_key.length <= 200); requested.push(body.p_kind); return response({ reserved: true, job_id: sessionId, lease_token: eventId }); }
    if (path.includes('/embeddings')) { assert.equal(body.model, config.EMBEDDING_MODEL); return response({ data: [{ index: 0, embedding: vector() }] }); }
    if (path.includes('/complete_run')) return response(true);
    if (path.includes('/sessions?')) return response([{ id: sessionId, user_id: userId, companion_id: 'mia', status: 'ended', scenario: 'Practice' }]);
    if (path.includes('/transcript_events?')) return response([event]);
    if (path.includes('/responses')) { assert.equal(body.model, config.COACH_MODEL); return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(content()) }] }] }); }
    if (path.includes('/complete_analysis_run')) return response({ analysis: { content: body.p_content } });
    throw Error(`Unexpected ${path}`);
  };
  try {
    const result = await handler(new Request('https://project.supabase.co/functions/v1/coach/config', { headers: { Origin: 'https://example.com', Authorization: 'Bearer test-user' } }));
    assert.deepEqual((await result.json()).models, { voice: config.VOICE_MODEL, coach: config.COACH_MODEL, checkpoint: config.CHECKPOINT_MODEL, analysis: config.ANALYSIS_MODEL, embedding: config.EMBEDDING_MODEL });
    assert.equal((await handler(request('memory', { companionId: 'mia', query: 'hi' }))).status, 200);
    assert.equal((await handler(request('review', { sessionId }))).status, 200);
    assert.deepEqual(requested, ['embedding', 'session']);
  } finally { globalThis.fetch = original; names.forEach((name, i) => { if (saved[i] === undefined) delete config[name]; else config[name] = saved[i]; }); }
});
