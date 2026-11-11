// E01–E05 acceptance uses actual Chromium, durable IndexedDB, and every real SQL
// migration under authenticated roles. Auth, coach/LLM, and WebRTC transports
// are explicit local fixtures. This is not a live voice or human-quality gate.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.ENHANCEMENT_TEST_PORT || 4190);
const base = `http://127.0.0.1:${port}`;
const project = 'https://enhancement-acceptance.supabase.co';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const db = new PGlite({ extensions: { pgcrypto } });
const quote = value => '"' + value.replaceAll('"', '""') + '"';
let sqlQueue = Promise.resolve();
function serial(work) { const pending = sqlQueue.then(work); sqlQueue = pending.catch(() => {}); return pending; }
function query(sql, values = []) { return serial(() => db.query(sql, values)); }
async function asUser(work, user = uid) {
  return serial(async () => {
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    try { return await work(); } finally { await db.exec('reset role'); }
  });
}
async function asService(work) {
  return serial(async () => {
    await db.exec('set role service_role');
    try { return await work(); } finally { await db.exec('reset role'); }
  });
}
let rpcMetadata;
async function invokeRpc(name, body, work, user) {
  const signatures = rpcMetadata.filter(row => row.name === name);
  const signature = signatures.find(row => Object.keys(body || {}).every(key => row.args.some(arg => arg.name === key)));
  assert(signature, `RPC ${name} and supplied parameter names are declared in real migrations`);
  const args = Object.entries(body || {}).map(([key, value], index) => {
    const argument = signature.args.find(arg => arg.name === key);
    return { sql: `${quote(key)} => $${index + 1}::${argument.type}`, value: ['jsonb', 'json'].includes(argument.type) ? JSON.stringify(value) : value };
  });
  return work(async () => {
    const invocation = `public.${quote(name)}(${args.map(arg => arg.sql).join(',')})`;
    // JSON serialization matches the RPC transport, including composite rows.
    const result = await db.query(signature.set ? `select * from ${invocation}` : `select to_jsonb(${invocation}) as result`, args.map(arg => arg.value));
    return signature.set ? result.rows : result.rows[0]?.result;
  }, user);
}
const rpc = (name, body, user = uid) => invokeRpc(name, body, asUser, user);
const serviceRpc = (name, body) => invokeRpc(name, body, asService);

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth; create schema extensions;
  create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to public;
`);
for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
  await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
}
await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.com',now()),($2,'other@example.com',now())", [uid, otherUid]);
await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com')");
rpcMetadata = (await db.query(`select p.proname as name, p.proretset as set,
  coalesce((select jsonb_agg(jsonb_build_object('name', p.proargnames[i], 'type', format_type(p.proargtypes[i-1],null))) from generate_series(1,p.pronargs) i),'[]'::jsonb) as args
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows;

async function tableRequest(table, url, request, user = uid) {
  assert(['sessions', 'analyses', 'transcript_events', 'memory_state', 'memory_fact_overrides', 'memory_session_exclusions'].includes(table) || /^learning_[a-z_]+$/.test(table), `Known PostgREST table ${table}`);
  return asUser(async () => {
    if (request.method() === 'POST') {
      const body = request.postDataJSON(), keys = Object.keys(body);
      return (await db.query(`insert into public.${quote(table)} (${keys.map(quote)}) values (${keys.map((_, index) => '$' + (index + 1))}) returning *`, Object.values(body))).rows;
    }
    assert.equal(request.method(), 'GET');
    const values = [], where = [];
    for (const [key, filter] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const column = key === 'content->scope->>companionId' ? `${quote('content')}->'scope'->>'companionId'` : quote(key);
      if (filter.startsWith('eq.')) { values.push(filter.slice(3)); where.push(`${column} = $${values.length}`); }
      else if (filter.startsWith('gte.')) { values.push(filter.slice(4)); where.push(`${column} >= $${values.length}`); }
      else if (key === 'and' && /^\(ended_at\.lte\..+\)$/.test(filter)) { values.push(filter.slice(14, -1)); where.push(`${quote('ended_at')} <= $${values.length}`); }
      else if (filter.startsWith('in.(')) where.push(`${column} in (${filter.slice(4, -1).split(',').map(value => { values.push(value); return '$' + values.length; }).join(',')})`);
      else throw Error(`Unsupported table filter ${key}=${filter}`);
    }
    let sql = `select * from public.${quote(table)}` + (where.length ? ' where ' + where.join(' and ') : '');
    if (url.searchParams.get('order')) sql += ' order by ' + url.searchParams.get('order').split(',').map(order => { const [column, direction = 'asc'] = order.split('.'); assert(['asc', 'desc'].includes(direction)); return quote(column) + ' ' + direction; }).join(',');
    return (await db.query(sql, values)).rows;
  }, user);
}
async function fixture(label, expression, { companion = 'alex', user = uid, original = 'Yesterday I go to the park.', analysis = true, endedAt = new Date().toISOString() } = {}) {
  const sessionId = randomUUID(), eventId = randomUUID();
  await query("insert into public.sessions(id,user_id,scenario,companion_id,status,created_at,ended_at) values($1,$2,$3,$4,'ended',$5,$5)", [sessionId, user, label, companion, endedAt]);
  await query("insert into public.transcript_events(id,user_id,session_id,event_key,speaker,text) values($1,$2,$3,$4,'user',$5)", [eventId, user, sessionId, eventId, original]);
  let analysisId;
  const content = { summary: '확인된 녹취에 연결된 로컬 검증 학습 노트입니다.', strengths: [], corrections: [{ original, improved: expression, reason: '과거 경험을 설명하는 표현입니다.', category: 'error', evidence_ids: [eventId] }], next_scenario: 'Discuss yesterday with a friend' };
  if (analysis) {
    analysisId = randomUUID();
    await query("insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids) values($1,$2,$3,'session',$4::jsonb,'explicit-local-fixture',$5::uuid[])", [analysisId, user, sessionId, JSON.stringify(content), [eventId]]);
  }
  return { sessionId, eventId, analysisId, content, expression, original, label };
}
const item = expression => query('select * from public.learning_state_items where user_id=$1 and expression=$2', [uid, expression]).then(result => result.rows[0]);
const snapshot = () => rpc('learning_snapshot', { p_companion_id: 'alex' });
const events = name => query('select * from public.learning_events where user_id=$1 and name=$2 order by received_at', [uid, name]).then(result => result.rows);
async function waitUntil(work, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  assert.fail(message);
}
async function revealAndClick(control) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const folds = control.locator('xpath=ancestor::details');
    const index = await folds.evaluateAll(nodes => nodes.map((node, index) => ({ node, index, depth: (() => { let depth = 0; for (let parent = node; parent; parent = parent.parentElement) depth++; return depth; })() })).filter(row => !row.node.open).sort((a, b) => a.depth - b.depth)[0]?.index ?? -1);
    if (index < 0) break;
    await folds.nth(index).locator('summary').first().click();
  }
  await control.click();
}
async function leaveReview(page) { if(await page.locator('#session-review-exit').isVisible())await page.locator('#session-review-exit').click(); }
async function refresh(page) { await leaveReview(page); await page.locator('[data-view="history"]').click(); await page.locator('#refresh-history').click(); }
async function openFeedback(page, source) {
  await leaveReview(page); await page.locator('[data-view="history"]').click();
  await page.locator(`.history-entry[data-session-id="${source.sessionId}"] .history-open`).click();
  await page.locator('.call-feedback').click();
  await page.locator('[data-panel="review"]').waitFor({ state: 'visible' });
  if((await page.locator('#review-panel').getAttribute('data-session-view'))!=='feedback'){await page.locator('#session-feedback-open').waitFor({state:'visible'}); await page.locator('#session-feedback-open').click();}
  await page.locator('#learning-session').waitFor({state:'attached'});
}
function itemCard(page, id, container = '#learning-session') { return page.locator(`${container} [data-item-id="${id}"]`).first(); }
async function login(page) {
  await page.goto(base);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'explicit-fixture-jwt', refresh_token: 'explicit-fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
}

const transport = { calls: [], errors: [], offline: false, voice: [], reconsider: null, review: null, usage: null, weekly: null, prepared: [] };
async function attachRoutes(page) {
  page.on('pageerror', error => transport.errors.push(error.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_local_fixture' })};` }));
  await page.route(project + '/**', async route => {
    if(new URL(route.request().url()).pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}});
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : undefined;
    transport.calls.push({ path: url.pathname, body });
    try {
      if (url.pathname === '/auth/v1/settings') return route.fulfill({ json: { external: { google: false, kakao: false } } });
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: uid } });
      if (url.pathname.endsWith('/coach/config')) return route.fulfill({ json: { models: { voice: 'gpt-realtime-mini', coach: 'gpt-4.1-mini', analysis: 'gpt-4.1' } } });
      if (url.pathname.endsWith('/coach/memory-manage')) return route.fulfill({ json: { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false } });
      if (url.pathname.endsWith('/coach/memory')) return route.fulfill({ json: { memories: [] } });
      if (url.pathname.endsWith('/coach/voice')) {
        transport.voice.push(body);
        transport.prepared.push(await serviceRpc('learning_usage_prepare', { p_user_id: uid, p_session_id: body.sessionId }));
        return route.fulfill({ json: { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
      }
      for (const action of ['reconsider', 'review', 'usage-observe', 'weekly']) if (url.pathname.endsWith('/coach/' + action)) {
        const handler = transport[action === 'usage-observe' ? 'usage' : action];
        assert(handler, `Coach ${action} transport is explicitly configured`);
        return route.fulfill(await handler(body));
      }
      if (url.pathname.includes('/rpc/')) {
        if (transport.offline && !['learning_snapshot', 'learning_review', 'learning_plan'].includes(url.pathname.split('/').at(-1))) return route.fulfill({ status: 503, json: { message: 'Explicit fixture offline boundary' } });
        return route.fulfill({ json: await rpc(url.pathname.split('/').at(-1), body) });
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const rows = await tableRequest(url.pathname.split('/').at(-1), url, request);
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || rows.length || 1);
        return route.fulfill({ json: rows.slice(offset, offset + limit), headers: { 'Content-Range': `${offset}-${Math.max(offset, Math.min(rows.length, offset + limit) - 1)}/${rows.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } });
      }
      throw Error('Unconfigured external transport ' + url.pathname);
    } catch (error) {
      console.error('Enhancement bridge:', url.pathname, error.message);
      return route.fulfill({ status: 400, json: { message: error.message, code: error.code || 'FIXTURE_BRIDGE' } });
    }
  });
}

const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Static server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  let passed = 0;
  const pass = message => { passed++; console.log(`PASS ${message}`); };
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); await attachRoutes(page); await login(page);
  const scope = `${project}|${uid}`;
  const readLocalQueue = () => page.evaluate(async scope => (await import('/src/learning-outbox.js')).createLearningOutbox().list(scope), scope);
  const readDiagnostics = () => page.evaluate(scope => JSON.parse(localStorage.getItem('loop.telemetry:' + scope) || '[]'), scope);

  // A successful SDP response is deliberately separate from an RTC connected
  // event. The peer fixture gives the test explicit control of that boundary.
  await page.evaluate(() => {
    window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; window.acceptancePeer = this; }
      addTrack(track) { this.track = track; }
      createDataChannel() { return this.channel = { readyState: 'open', send() {} }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.hasRemoteDescription = true; }
      close() { this.connectionState = 'closed'; }
    };
  });
  await page.locator('#start-call').click();
  await page.waitForFunction(() => window.acceptancePeer?.hasRemoteDescription);
  const connectionSession = transport.voice.at(-1).sessionId;
  assert.equal((await events('call_connected')).length, 0, 'SDP success cannot stand in for RTC connection');
  assert.equal((await readLocalQueue()).filter(row => row.body.p_name === 'call_connected').length, 0);
  assert.equal((await readDiagnostics()).length, 0, 'no connection receipt is synthesized before RTC connects');
  transport.offline = true;
  await page.evaluate(() => {
    const nativeAdd = IDBObjectStore.prototype.add;
    window.injectedStorageFailures = 0;
    IDBObjectStore.prototype.add = function(value, ...rest) {
      if (this.name === 'learning' && value?.body?.p_name === 'call_connected' && !window.injectedStorageFailures++) throw new DOMException('Explicit fixture IDB failure', 'QuotaExceededError');
      return nativeAdd.call(this, value, ...rest);
    };
    window.acceptancePeer.connectionState = 'connected'; window.acceptancePeer.onconnectionstatechange();
  });
  await waitUntil(async () => (await readLocalQueue()).some(row => row.body.p_name === 'call_connected'), 'a storage retry persists connection without a second RTC event');
  assert.equal(await page.evaluate(() => window.injectedStorageFailures), 2, 'first real IndexedDB add fails and a separate retry performs the successful add');
  const queuedConnection = (await readLocalQueue()).find(row => row.body.p_name === 'call_connected');
  assert.equal(queuedConnection.body.p_session_id, connectionSession);
  assert.equal(queuedConnection.body.p_event_id, queuedConnection.id);
  assert.equal(queuedConnection.created_at, queuedConnection.body.p_payload.occurred_at);
  assert.equal(queuedConnection.body.p_payload.telemetry_schema, 1);
  assert.match(queuedConnection.body.p_payload.client_build, /^(dev:unversioned|git:[0-9a-f]{7,64}|source:[0-9a-f]{12,64})$/);
  assert.equal((await events('call_connected')).length, 0, 'local persistence does not claim server receipt while offline');
  assert.equal((await readDiagnostics()).find(row => row.eventId === queuedConnection.id).stage, 'device_persisted');
  await page.evaluate(() => { window.acceptancePeer.onconnectionstatechange(); window.acceptancePeer.onconnectionstatechange(); });
  assert.equal((await readLocalQueue()).filter(row => row.body.p_name === 'call_connected').length, 1, 'duplicate RTC notifications retain one durable receipt');
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.deepEqual((await readLocalQueue()).find(row => row.id === queuedConnection.id), queuedConnection, 'reload preserves the exact receipt ID, timestamp, and body');
  transport.offline = false; await refresh(page);
  await waitUntil(async () => (await events('call_connected')).some(row => row.id === queuedConnection.id || row.event_id === queuedConnection.id), 'server acknowledges the original receipt after reconnection');
  const receivedConnection = (await events('call_connected')).find(row => row.id === queuedConnection.id || row.event_id === queuedConnection.id);
  assert.equal(receivedConnection.session_id, connectionSession);
  assert.equal(new Date(receivedConnection.occurred_at).toISOString(), queuedConnection.created_at);
  assert.equal(receivedConnection.payload.client_build, queuedConnection.body.p_payload.client_build);
  assert(transport.calls.filter(call => call.path.endsWith('/rpc/learning_record_event') && call.body.p_name === 'call_connected').every(call => call.body.p_event_id === queuedConnection.id && call.body.p_payload.occurred_at === queuedConnection.created_at), 'every offline transmission retry preserves the event ID and creation time');
  assert.equal((await query('select client_build from public.sessions where id=$1', [connectionSession])).rows[0].client_build, receivedConnection.payload.client_build);
  await waitUntil(async () => !(await readLocalQueue()).some(row => row.id === queuedConnection.id), 'only server acknowledgement removes the durable receipt');
  assert.equal((await readDiagnostics()).find(row => row.eventId === queuedConnection.id).stage, 'server_ack');
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await refresh(page);
  assert.equal((await events('call_connected')).filter(row => row.session_id === connectionSession).length, 1, 'acknowledged receipt never duplicates on subsequent reload');
  pass('E01: real RTC boundary, one failed IndexedDB write, autonomous retry, offline reload and exact server acknowledgement preserve one connection receipt.');

  const reconsiderSource = await fixture('E02 accept explicitly', 'Yesterday I went to the park.');
  const dismissedSource = await fixture('E02 dismiss explicitly', 'My friend will call me tomorrow.', { original: 'My friend call me tomorrow.' });
  const savedOriginal = await query('select text from public.transcript_events where id=$1', [reconsiderSource.eventId]);
  const savedAnalysis = await query('select content from public.analyses where id=$1', [reconsiderSource.analysisId]);
  for (const source of [reconsiderSource, dismissedSource]) {
    const canonical = await item(source.expression);
    await rpc('learning_action', { p_item_id: canonical.id, p_expected_revision: canonical.revision, p_action_id: randomUUID(), p_action: 'hold_intent', p_payload: { source_session_id: source.sessionId, source_analysis_id: source.analysisId } });
  }
  transport.reconsider = async body => {
    const context = await serviceRpc('learning_review_context', { p_user_id: uid, p_review_id: body.requestId });
    assert(context.evidence.every(event => event.speaker === 'user' && event.session_id === context.review.source_session_id));
    const proposal = { expression: context.review.source_session_id === reconsiderSource.sessionId ? 'I took a walk in the park yesterday.' : 'My friend is calling me tomorrow.', reason: '추가한 의도와 원래 발화 근거에 연결된 로컬 제안입니다.', category: 'alternative', evidence_ids: context.evidence.map(event => event.id) };
    const result = await serviceRpc('learning_review_complete', { p_user_id: uid, p_review_id: context.review.id, p_expected_revision: context.review.revision, p_source_version: context.review.source_version, p_proposal: proposal });
    return { json: { review: result.review } };
  };
  await refresh(page); await openFeedback(page, reconsiderSource);
  const held = await item(reconsiderSource.expression);
  await revealAndClick(itemCard(page, held.id).locator('[data-intent-explanation]'));
  await itemCard(page, held.id).locator('[data-intent-explanation]').fill('어제 공원에서 산책했다는 뜻이에요. 추가 설명은 원래 녹취와 별도로 남겨 주세요.');
  await itemCard(page, held.id).locator('[data-action="submit-intent"]').click();
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).reviews.some(row => row.item_id === held.id && row.status === 'pending'), 'intent explanation is durably saved');
  assert.equal((await snapshot()).items.find(row => row.id === held.id).has_valid_source, false);
  assert(!(await snapshot()).recommended_item_ids.includes(held.id));
  await revealAndClick(itemCard(page, held.id).locator('[data-action="reconsider"]'));
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).reviews.some(row => row.item_id === held.id && row.status === 'proposed'), 'model fixture returns a proposal without accepting it');
  assert.equal((await snapshot()).items.find(row => row.id === held.id).has_valid_source, false, 'generated proposal never silently releases a source hold');
  assert(!(await snapshot()).recommended_item_ids.includes(held.id));
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await openFeedback(page, reconsiderSource);
  await revealAndClick(itemCard(page, held.id).locator('[data-action="accept-reconsideration"]'));
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).reviews.some(row => row.item_id === held.id && row.status === 'accepted'), 'only explicit acceptance releases the proposed expression');
  const acceptedReview = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).reviews.find(row => row.item_id === held.id);
  assert(acceptedReview.accepted_item_id);
  assert.equal((await snapshot()).items.find(row => row.id === acceptedReview.accepted_item_id).has_valid_source, true);
  assert.equal((await snapshot()).items.find(row => row.id === held.id).has_valid_source, false, 'original held correction remains held after accepting a different expression');
  assert.deepEqual(await query('select text from public.transcript_events where id=$1', [reconsiderSource.eventId]), savedOriginal, 'intent resolution never overwrites the original transcript');
  assert.deepEqual(await query('select content from public.analyses where id=$1', [reconsiderSource.analysisId]), savedAnalysis, 'intent resolution never overwrites the original analysis');
  await refresh(page); await openFeedback(page, dismissedSource);
  const dismissed = await item(dismissedSource.expression);
  await revealAndClick(itemCard(page, dismissed.id).locator('[data-intent-explanation]'));
  await itemCard(page, dismissed.id).locator('[data-intent-explanation]').fill('내일 친구에게 전화가 올 예정이라는 뜻이에요.');
  await itemCard(page, dismissed.id).locator('[data-action="submit-intent"]').click();
  await revealAndClick(itemCard(page, dismissed.id).locator('[data-action="reconsider"]'));
  await revealAndClick(itemCard(page, dismissed.id).locator('[data-action="dismiss-reconsideration"]'));
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).reviews.some(row => row.item_id === dismissed.id && row.status === 'dismissed'), 'dismissal is durably saved');
  assert.equal((await snapshot()).items.find(row => row.id === dismissed.id).has_valid_source, false);
  assert(!(await snapshot()).recommended_item_ids.includes(dismissed.id));
  await assert.rejects(rpc('learning_review_decide', { p_review_id: acceptedReview.id, p_expected_revision: acceptedReview.revision, p_action_id: randomUUID(), p_decision: 'accept' }, otherUid), /not found|not approved|invalid|denied/i);
  pass('E02: held intent → separate explanation → proposal → explicit acceptance/dismissal survives reload, preserves originals and never reuses held content automatically.');

  const recallSource = await fixture('E03 delayed recall choices', 'Could you repeat that more slowly?', { original: 'Please say again slow.' });
  const recallItem = await item(recallSource.expression);
  await refresh(page); await openFeedback(page, recallSource);
  assert(!(await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).schedules.some(row => row.item_id === recallItem.id), 'delayed recall requires opt-in');
  for (const days of [1, 3, 7]) {
    await revealAndClick(itemCard(page, recallItem.id).locator(`[data-action="recall-${days}-days"]`));
    await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).schedules.some(row => row.item_id === recallItem.id && row.days === days), `explicit ${days}-day schedule persists`);
    const schedule = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).schedules.find(row => row.item_id === recallItem.id);
    const expected = (await query("select (((now() at time zone 'Asia/Seoul')::date+$1::integer)::timestamp at time zone 'Asia/Seoul') as due", [days])).rows[0].due;
    assert.equal(new Date(schedule.due_at).toISOString(), new Date(expected).toISOString(), `${days}-day due time is KST midnight`);
  }
  // Existing manual-practice history remains compatible, but its removed UI is
  // not recreated. The distinct delayed recall path below is exercised in-browser.
  await rpc('learning_action',{p_item_id:recallItem.id,p_expected_revision:recallItem.revision,p_action_id:randomUUID(),p_action:'practice',p_payload:{attempt_id:randomUUID(),attribution:'library'}});
  assert.equal((await item(recallSource.expression)).practice_count,1);
  assert.equal((await rpc('learning_enhancement_snapshot',{p_companion_id:'alex'})).recalls.filter(row=>row.item_id===recallItem.id).length,0);
  await refresh(page); await openFeedback(page,recallSource);
  assert(await itemCard(page, recallItem.id).locator('[data-action="start-delayed-recall"]').isDisabled(), 'future recall cannot be reported immediately');
  for (const rating of ['hard', 'assisted', 'independent']) {
    await query("update public.learning_schedules set due_at=now()-interval '1 day' where item_id=$1", [recallItem.id]);
    await refresh(page); await openFeedback(page, recallSource);
    await revealAndClick(itemCard(page, recallItem.id).locator('[data-action="start-delayed-recall"]'));
    const delayed = page.locator('.learning-practice[data-practice-kind="delayed"]');
    assert(await delayed.locator('[data-practice-expression]').isHidden(), 'delayed recall initially hides the expression from visual and accessibility output');
    assert(await page.locator('#review-content').isHidden(), 'the surrounding source feedback does not reveal the answer during delayed recall');
    assert.match(await delayed.locator('[data-practice-cue]').innerText(), /Please say again slow/);
    assert(!(await page.locator('body').innerText()).includes(recallSource.expression), 'no visible feedback, library, transcript or weekly-goal copy reveals the answer');
    if (rating === 'assisted') {
      await delayed.locator('[data-action="reveal-delayed-expression"]').click();
      assert(await delayed.locator('[data-action="recall-independent"]').isDisabled(), 'revealed answer cannot be self-reported as independent recall');
    }
    await delayed.locator(`[data-action="recall-${rating}"]`).click();
    await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).recalls.some(row => row.item_id === recallItem.id && row.rating === rating), `${rating} delayed self-report persists`);
    const nextSchedule = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).schedules.find(row => row.item_id === recallItem.id);
    const nextDays = { hard: 1, assisted: 3, independent: 7 }[rating];
    assert.equal(nextSchedule.last_rating, rating); assert.equal(nextSchedule.days, nextDays);
    const nextDue = (await query("select (((now() at time zone 'Asia/Seoul')::date+$1::integer)::timestamp at time zone 'Asia/Seoul') as due", [nextDays])).rows[0].due;
    assert.equal(new Date(nextSchedule.due_at).toISOString(), new Date(nextDue).toISOString(), `${rating} self-report adjusts the next KST recall day`);
    await delayed.locator('[data-action="home"]').click();
  }
  const recallState = await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' });
  assert.deepEqual(recallState.recalls.filter(row => row.item_id === recallItem.id).map(row => row.rating).sort(), ['assisted', 'hard', 'independent']);
  assert(recallState.recalls.filter(row => row.item_id === recallItem.id).every(row => row.kind === 'delayed'));
  assert((await snapshot()).recommended_item_ids.length <= 1, 'default recommendation cap remains one expression');
  assert(recallState.personalized_item_ids.length <= 1, 'personalization preserves the default one-expression cap');
  pass('E03: optional 1/3/7-day KST schedules, concealed delayed recall and three self-report choices remain separate from immediate practice and preserve the default cap.');

  const periodEnd = new Date(Date.now() - 1).toISOString();
  const periodStart = new Date(Date.parse(periodEnd) - 168 * 3600000).toISOString();
  const weeklyId = randomUUID();
  const weeklyContent = { summary: '시간을 둔 회상과 확인된 발화를 돌아보는 로컬 주간 분석입니다.', scope: { companionId: 'alex', period_start: periodStart, period_end: periodEnd }, learning_plan: { keep: { goal: '다음 대화에서 상대의 말을 천천히 다시 요청하기', item_id: recallItem.id }, try: { goal: '새 상황에서 정중하게 다시 요청하기', item_id: recallItem.id } } };
  await query("insert into public.analyses(id,user_id,kind,content,model,source_event_ids) values($1,$2,'weekly',$3::jsonb,'explicit-local-weekly-fixture',$4::uuid[])", [weeklyId, uid, JSON.stringify(weeklyContent), [recallSource.eventId]]);
  transport.weekly = async () => ({ json: { analysis: (await query('select * from public.analyses where id=$1', [weeklyId])).rows[0] } });
  await refresh(page); await page.locator('[data-view="review"]').click();
  await page.locator('#weekly').click();
  await page.waitForFunction(() => document.querySelector('#review-content h3')?.textContent === 'Alex · 최근 7일 분석');
  const expectedPeriod = await page.evaluate(({ start, end }) => [start, end].map(value => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value))), { start: periodStart, end: periodEnd });
  for (const expected of expectedPeriod) assert((await page.locator('#review-content').innerText()).includes(expected));
  assert.match(await page.locator('#review-content').innerText(), /최근 7일/);
  assert.match(await page.locator('#review-content').innerText(), /생성:/);
  await revealAndClick(page.locator('#learning-queue [data-action="choose-weekly-keep"]'));
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.some(row => row.analysis_id === weeklyId && row.kind === 'keep'), 'weekly goal selection persists');
  let selectedGoal = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.find(row => row.analysis_id === weeklyId);
  assert.equal(new Date(selectedGoal.period_start).toISOString(), periodStart);
  assert.equal(new Date(selectedGoal.period_end).toISOString(), periodEnd);
  assert.equal(Date.parse(selectedGoal.period_end) - Date.parse(selectedGoal.period_start), 168 * 3600000);
  assert.equal(selectedGoal.prepared_at, null); assert.equal(selectedGoal.call_session_id, null); assert.equal(selectedGoal.recall_id, null);
  await revealAndClick(page.locator('#learning-queue [data-action="prepare-weekly-goal"]'));
  await waitUntil(async () => Boolean((await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.find(row => row.analysis_id === weeklyId)?.prepared_at), 'weekly goal connects to explicit call preparation');
  assert.equal((await snapshot()).next_plan.item_id, recallItem.id);

  transport.review = async body => {
    const sourceIds = (await query("select id from public.transcript_events where session_id=$1 and speaker='user' order by timestamp,id", [body.sessionId])).rows.map(row => row.id);
    assert(sourceIds.length, 'review fixture only analyzes actual saved data-channel user speech');
    const analysisId = randomUUID();
    await query("insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids) values($1,$2,$3,'session',$4::jsonb,'explicit-local-call-review-fixture',$5::uuid[])", [analysisId, uid, body.sessionId, JSON.stringify({ summary: '저장된 실제 발화의 관찰 기록입니다.', strengths: [], corrections: [] }), sourceIds]);
    const usageContext = await serviceRpc('learning_usage_context', { p_user_id: uid, p_session_id: body.sessionId });
    assert.equal(usageContext.targets.length, 1, 'review fixture requires one service-prepared, actually connected observation target');
    const actualUserEvidence = usageContext.events.filter(event => event.speaker === 'user' && event.text === recallSource.expression);
    assert.equal(actualUserEvidence.length, 1);
    await serviceRpc('learning_usage_capture', { p_user_id: uid, p_target_id: usageContext.targets[0].id, p_source_version: usageContext.source_version, p_observation: { kind: 'observed', mode: 'undetermined', evidence_ids: actualUserEvidence.map(event => event.id), mode_evidence_ids: [] } });
    return { json: { analysis: (await query('select * from public.analyses where id=$1', [analysisId])).rows[0] } };
  };
  await page.evaluate(() => {
    window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; window.acceptancePeer = this; }
      addTrack(track) { this.track = track; }
      createDataChannel() { return this.channel = { readyState: 'open', send() {} }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.hasRemoteDescription = true; }
      close() { this.connectionState = 'closed'; }
    };
  });
  await page.locator('#start-call').click(); await page.waitForFunction(() => window.acceptancePeer?.hasRemoteDescription);
  const followupSession = transport.voice.at(-1).sessionId;
  assert.equal((await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.find(row => row.analysis_id === weeklyId).call_session_id, null, 'SDP completion cannot satisfy a weekly follow-up call');
  assert.equal(transport.prepared.at(-1).targets[0].item_id, recallItem.id);
  await page.evaluate(expression => {
    window.acceptancePeer.connectionState = 'connected'; window.acceptancePeer.onconnectionstatechange();
    window.acceptancePeer.channel.onmessage({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'actual-followup-user-turn', transcript: expression }) });
  }, recallSource.expression);
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.find(row => row.analysis_id === weeklyId).call_session_id === followupSession, 'actual connection links the weekly goal to its prepared follow-up');
  await page.locator('#end-call').click();
  await waitUntil(async () => (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).usage.some(row => row.session_id === followupSession), 'ended-call observation is stored against actual speech evidence');
  const followup = { sessionId: followupSession };
  await refresh(page); await openFeedback(page, followup);
  const observed = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).usage.find(row => row.session_id === followupSession);
  assert.equal(observed.kind, 'observed'); assert.equal(observed.mode, 'undetermined'); assert.equal(observed.review_status, 'unreviewed');
  await rpc('learning_usage_review',{p_usage_id:observed.id,p_expected_revision:observed.revision,p_action_id:randomUUID(),p_status:'confirmed'});
  const reviewedUsage=(await rpc('learning_enhancement_snapshot',{p_companion_id:'alex'})).usage.find(row=>row.id===observed.id);
  assert.equal(reviewedUsage.review_status,'confirmed'); assert.equal(reviewedUsage.mode,'undetermined');
  assert.equal((await query('select text from public.transcript_events where id=$1',[observed.evidence_ids[0]])).rows[0].text,recallSource.expression);
  assert.equal((await item(recallSource.expression)).practice_count, 1, 'observed usage never increments immediate-practice mastery counters');
  pass('E04: a service-prepared actual connection binds original user evidence; observation requires explicit self-review, leaves context/opportunity unknown and never labels success/mastery.');

  // This represents the following eligible KST recall day without waiting days
  // in wall-clock time. The real schedule RPC still verifies due_at <= now().
  await query('update public.sessions set ended_at=now()-interval \'2 days\' where id=$1', [followupSession]);
  await query("update public.learning_schedules set due_at=now()-interval '1 day' where item_id=$1", [recallItem.id]);
  await refresh(page); await openFeedback(page, recallSource);
  await revealAndClick(itemCard(page, recallItem.id).locator('[data-action="start-delayed-recall"]'));
  await page.locator('.learning-practice[data-practice-kind="delayed"] [data-action="recall-independent"]').click();
  await waitUntil(async () => Boolean((await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.find(row => row.analysis_id === weeklyId)?.recall_id), 'delayed recall links back to selected weekly goal after its follow-up call');
  selectedGoal = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).weekly_goals.find(row => row.analysis_id === weeklyId);
  assert.equal(selectedGoal.call_session_id, followupSession); assert(selectedGoal.prepared_at); assert(selectedGoal.recall_id);
  const linkedRecall = (await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' })).recalls.find(row => row.id === selectedGoal.recall_id);
  assert.equal(linkedRecall.kind, 'delayed'); assert.equal(linkedRecall.item_id, recallItem.id);
  assert.equal(new Date(selectedGoal.period_start).toISOString(), periodStart); assert.equal(new Date(selectedGoal.period_end).toISOString(), periodEnd, 'later follow-up and recall never expand the saved weekly analysis window');
  await page.locator('.learning-practice [data-action="home"]').click();
  pass('E05: exact saved 168-hour period and generation disclosure remain fixed through goal selection → preparation → actual connection → delayed recall.');

  await fixture('PRIVATE_OTHER_ACCOUNT_MARKER', 'Other account private expression.', { user: otherUid });
  await fixture('PRIVATE_MIA_COMPANION_MARKER', 'Mia only expression.', { companion: 'mia' });
  const foreignEnhancements = await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' }, otherUid);
  assert.equal(foreignEnhancements.reviews.length, 0); assert.equal(foreignEnhancements.recalls.length, 0); assert.equal(foreignEnhancements.usage.length, 0); assert.equal(foreignEnhancements.weekly_goals.length, 0);
  const miaEnhancements = await rpc('learning_enhancement_snapshot', { p_companion_id: 'mia' });
  assert.equal(miaEnhancements.reviews.length, 0); assert.equal(miaEnhancements.recalls.length, 0); assert.equal(miaEnhancements.usage.length, 0); assert.equal(miaEnhancements.weekly_goals.length, 0);
  await query('insert into public.memory_session_exclusions(user_id,companion_id,session_id) values($1,\'alex\',$2)', [uid, recallSource.sessionId]);
  const privateSnapshot = await rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' });
  assert(!privateSnapshot.usage.some(row => row.id === observed.id), 'excluding source removes derived usage evidence');
  assert(!privateSnapshot.weekly_goals.some(row => row.id === selectedGoal.id), 'excluding source removes derived weekly goal');
  const privateWeekly = await serviceRpc('learning_weekly_context', { p_user_id: uid, p_companion_id: 'alex', p_start: periodStart, p_end: periodEnd });
  assert(!privateWeekly.items.some(row => row.id === recallItem.id)); assert(!privateWeekly.usage.some(row => row.id === observed.id));
  await refresh(page); await page.locator('[data-view="review"]').click();
  assert(!await page.locator('body').innerText().then(value => value.includes('PRIVATE_OTHER_ACCOUNT_MARKER') || value.includes('Mia only expression.')));
  await query("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(rpc('learning_enhancement_snapshot', { p_companion_id: 'alex' }), /not approved/i);
  await assert.rejects(serviceRpc('learning_weekly_context', { p_user_id: uid, p_companion_id: 'alex', p_start: periodStart, p_end: periodEnd }), /not approved/i);
  pass('Privacy: authenticated roles isolate accounts/companions, excluded sources revoke derivative evidence/plans, and approval guards both client and service RPCs.');
  await context.close();
  assert.deepEqual(transport.errors, [], 'no browser JavaScript errors');
  console.log(`PASS: ${passed} enhancement acceptance scenarios; live voice and human quality gates remain external.`);
} finally {
  await browser.close(); server.kill('SIGTERM'); await db.close();
}
