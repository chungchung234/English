import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, validateAnalysis, validateSdp, boundedJson, sourceIds, transcriptFingerprint } from './core.ts';
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
    if (path.includes('/memory_search')) return response([]);
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
    if (path.includes('/transcript_events?')) { const count = Number(new URL(path).searchParams.get('limit')); return response(Array.from({ length: count }, () => event), 1501); }
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
    if (path.includes('/memory_search')) return response([]);
    if (path.includes('/reserve_run')) return response({ reserved: true, job_id: sessionId, lease_token: eventId });
    if (path.includes('/realtime/calls')) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('sdp'), sdp);
      const session = JSON.parse(options.body.get('session'));
      assert.equal(session.model, 'gpt-realtime-mini');
      assert.equal(session.max_output_tokens, 512);
      assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
      assert.equal(session.audio.output.voice, 'marin');
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
    if (path.includes('/memory_search')) {
      search = JSON.parse(options.body);
      return response([{ id: eventId, session_id: sessionId, content: content(), source_event_ids: [eventId], created_at: '2020-01-01T00:00:00Z' }]);
    }
    throw new Error('Unexpected recent-history query');
  };
  try {
    const result = await handler(request('memory', { query: 'market' }));
    assert.equal(result.status, 200); const body = await result.json();
    assert.deepEqual(search, { p_user_id: userId, p_query: 'market', p_limit: 12 });
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
      assert.match(body.p_request_key, /^\d{4}-\d{2}-\d{2}:[a-f0-9]{64}$/);
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
    if (path.includes('/memory_search')) return response([]);
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
