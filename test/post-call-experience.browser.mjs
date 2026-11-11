// Local first-release acceptance: actual browser, durable IndexedDB, all SQL
// migrations and authenticated RLS/RPCs. Auth/coach/WebRTC transports are fixtures.
// No live API credential or hosted database is used by this suite.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.POST_CALL_EXPERIENCE_PORT || 4198), base = `http://127.0.0.1:${port}`;
const project = 'https://post-call-experience.supabase.co';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const db = new PGlite({ extensions: { pgcrypto } });
let queue = Promise.resolve();
function serial(work) { const pending = queue.then(work); queue = pending.catch(() => {}); return pending; }
function query(sql, values = []) { return serial(() => db.query(sql, values)); }
async function asUser(work, user = uid) {
  return serial(async () => {
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    try { return await work(); } finally { await db.exec('reset role'); }
  });
}
const quote = value => '"' + value.replaceAll('"', '""') + '"';
let rpcMetadata;
async function rpc(name, body, user = uid) {
  const signature = rpcMetadata.find(row => row.name === name);
  assert(signature, `RPC ${name} is declared in the real migration`);
  const args = Object.entries(body || {}).map(([key, value], index) => {
    const argument = signature.args.find(arg => arg.name === key);
    assert(argument, `${name} declares parameter ${key}`);
    return { sql: `${quote(key)} => $${index + 1}::${argument.type}`, value: argument.type === 'jsonb' || argument.type === 'json' ? JSON.stringify(value) : value };
  });
  return asUser(async () => {
    const invocation = `public.${quote(name)}(${args.map(arg => arg.sql).join(',')})`;
    const result = await db.query(signature.set ? `select * from ${invocation}` : `select to_jsonb(${invocation}) as result`, args.map(arg => arg.value));
    return signature.set ? result.rows : result.rows[0]?.result;
  }, user);
}
async function tableRequest(table, url, request) {
  assert(['sessions', 'analyses', 'transcript_events', 'memory_state', 'memory_fact_overrides', 'memory_session_exclusions'].includes(table) || /^learning_[a-z_]+$/.test(table), `Known PostgREST table ${table}`);
  return asUser(async () => {
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      const keys = Object.keys(body);
      return (await db.query(`insert into public.${quote(table)} (${keys.map(quote)}) values (${keys.map((_, i) => '$' + (i + 1))}) returning *`, Object.values(body))).rows;
    }
    assert.equal(request.method(), 'GET');
    const values = [], where = [];
    for (const [key, filter] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      if (filter.startsWith('eq.')) {
        values.push(filter.slice(3));
        const column = key === 'content->scope->>companionId' ? `${quote('content')}->'scope'->>'companionId'` : quote(key);
        where.push(`${column} = $${values.length}`);
      }
      else if (filter.startsWith('gte.')) { values.push(filter.slice(4)); where.push(`${quote(key)} >= $${values.length}`); }
      else if (key === 'and' && /^\(ended_at\.lte\..+\)$/.test(filter)) { values.push(filter.slice(14,-1)); where.push(`${quote('ended_at')} <= $${values.length}`); }
      else if (filter.startsWith('in.(')) {
        const parts = filter.slice(4, -1).split(',');
        where.push(`${quote(key)} in (${parts.map(value => { values.push(value); return '$' + values.length; }).join(',')})`);
      } else throw Error(`Unsupported table filter ${key}=${filter}`);
    }
    let sql = `select * from public.${quote(table)}` + (where.length ? ' where ' + where.join(' and ') : '');
    if (url.searchParams.get('order')) sql += ' order by ' + url.searchParams.get('order').split(',').map(order => { const [column, direction = 'asc'] = order.split('.'); assert(['asc', 'desc'].includes(direction)); return quote(column) + ' ' + direction; }).join(',');
    return (await db.query(sql, values)).rows;
  });
}
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth; create schema extensions;
  create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to public;
`);
for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.com',now()),($2,'other@example.com',now())", [uid, otherUid]);
await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com')");
rpcMetadata = (await db.query(`select p.proname as name, p.proretset as set,
  coalesce((select jsonb_agg(jsonb_build_object('name', p.proargnames[i], 'type', format_type(p.proargtypes[i-1],null))) from generate_series(1,p.pronargs) i),'[]'::jsonb) as args
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows;

async function fixture(label, corrections, { companion = 'alex', analysis = true, user = uid, summary = '오늘은 지난 경험을 설명했어요.' } = {}) {
  const session = { id: randomUUID(), user_id: user, scenario: label, companion_id: companion };
  const event = { id: randomUUID(), text: corrections.map(correction => correction.original).join(' ') || 'A clear conversation with my friend.' };
  await query(`insert into public.sessions(id,user_id,scenario,companion_id,status,created_at,ended_at) values($1,$2,$3,$4,'ended',now(),now())`, [session.id, user, label, companion]);
  await query(`insert into public.transcript_events(id,user_id,session_id,event_key,speaker,text) values($1,$2,$3,$4,'user',$5)`, [event.id, user, session.id, event.id, event.text]);
  const content = { summary, strengths: [{ text: '경험을 분명하게 공유했어요.', evidence_ids: [event.id] }], corrections: corrections.map(correction => ({ reason: '현재 맥락에 맞게 표현해요.', category: 'error', evidence_ids: [event.id], ...correction })), next_scenario: 'Discussing yesterday with a friend' };
  let analysisId;
  if (analysis) analysisId = await insertAnalysis(session.id, event.id, content, user);
  return { session, event, content, analysisId };
}
async function insertAnalysis(sessionId, eventId, content, user = uid) {
  const id = randomUUID();
  const ids = (await query('select id from public.transcript_events where session_id=$1 order by id', [sessionId])).rows.map(row => row.id);
  await query(`insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids) values($1,$2,$3,'session',$4::jsonb,'local-external-fixture',$5::uuid[])`, [id, user, sessionId, JSON.stringify(content), ids]);
  return id;
}
async function item(expression) { return (await query('select * from public.learning_state_items where user_id=$1 and expression=$2', [uid, expression])).rows[0]; }
async function eventRows(name) { return (await query('select * from public.learning_events where user_id=$1 and name=$2 order by received_at', [uid, name])).rows; }
const transport = { offline: false, calls: [], errors: [], routeErrors: [], review: null, voice: [], actionBodies: [], actionGate: null, historyGate: null, failRestore: false, finishGate: null };
async function attachRoutes(page, html) {
  page.on('pageerror', error => transport.errors.push(error.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_local_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let body = request.postData() ? request.postDataJSON() : undefined;
    transport.calls.push({ path: url.pathname, body });
    try {
      if (url.pathname === '/auth/v1/settings') return route.fulfill({ json: { external: { google: false, kakao: false } } });
      if (url.pathname.endsWith('/coach/memory-manage')) return route.fulfill({ json: { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false } });
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: uid } });
      if (url.pathname.endsWith('/coach/config')) return route.fulfill({ json: { models: { voice: 'gpt-realtime-mini', coach: 'gpt-4.1-mini', analysis: 'gpt-4.1' } } });
      if (url.pathname.endsWith('/coach/weekly')) { const row=(await query("select * from public.analyses where user_id=$1 and kind='weekly' order by created_at desc limit 1",[uid])).rows[0]; assert(row, 'weekly response explicitly seeded'); return route.fulfill({json:{analysis:row}}); }
      if (url.pathname.endsWith('/coach/memory')) return route.fulfill({ json: { memories: [] } });
      if (url.pathname.endsWith('/coach/voice')) { transport.voice.push(body); return route.fulfill({ json: { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } }); }
      if (url.pathname.endsWith('/coach/review') || url.pathname.endsWith('/coach/status')) {
        assert(transport.review, 'Test explicitly configures analysis transport');
        return route.fulfill(await transport.review(url.pathname, body));
      }
      if (url.pathname.includes('/rpc/')) {
        const name = url.pathname.split('/').at(-1);
        if (name === 'finish_session' && transport.finishGate) await transport.finishGate;
        if (name === 'learning_restore' && transport.failRestore) { transport.failRestore = false; return route.fulfill({ status: 503, json: { message: 'fixture restore batch interrupted' } }); }
        if (/learning_action/.test(name)) {
          transport.actionBodies.push(structuredClone(body));
          if (transport.actionGate?.action === body.p_action) { transport.actionGate.started.resolve(); await transport.actionGate.release.promise; }
          if (transport.offline) return route.fulfill({ status: 503, json: { message: 'fixture network unavailable' } });
        }
        const result = await rpc(name, body);
        return route.fulfill({ json: result });
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        if (url.pathname === '/rest/v1/analyses' && !url.searchParams.has('session_id') && transport.historyGate) { const gate = transport.historyGate; transport.historyGate = null; gate.started.resolve(); await gate.release.promise; }
        const rows = await tableRequest(url.pathname.split('/').at(-1), url, request);
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || rows.length || 1);
        return route.fulfill({ json: rows.slice(offset, offset + limit), headers: { 'Content-Range': `${offset}-${Math.max(offset, Math.min(rows.length, offset + limit) - 1)}/${rows.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } });
      }
      throw Error('Unconfigured external transport ' + url.pathname);
    } catch (error) {
      transport.routeErrors.push(`${url.pathname}: ${error.message}`);
      console.error('Route bridge:', url.pathname, error.message);
      return route.fulfill({ status: 400, json: { message: error.message, code: error.code || 'FIXTURE_BRIDGE' } });
    }
  });
  // The static server serves dist assets at /built/ under the generated CSP.
}
async function login(page, path = '/') {
  await page.goto(base + path);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture-jwt', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
}
async function waitUntil(work, message) {
  const expires = Date.now() + 12000;
  while (Date.now() < expires) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  assert.fail(message);
}
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Static server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
// Focused UX regressions use the real app, SQL, RLS and durable outbox. Voice,
// authentication and generated prose are synthetic; no live account is accessed.
const output = 'test-results/post-call-experience';
const captures = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function capture(page, name) {
  await mkdir(output, { recursive: true });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pose = () => page.evaluate(() => ({ x: scrollX, y: scrollY, vx: visualViewport?.pageLeft, vy: visualViewport?.pageTop, height: document.documentElement.scrollHeight }));
  // Capture the raw rendered viewport surface, including fixed navigation,
  // without a separately calculated clip or image compositing.
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let tries = 0; tries < 3; tries++) {
      const before = await pose();
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
      if (JSON.stringify(before) === JSON.stringify(await pose())) break;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  } finally { await cdp.detach(); }
  const metrics = await page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector), bounds = element?.getBoundingClientRect();
      return bounds ? { top: bounds.top, bottom: bounds.bottom, height: bounds.height } : null;
    };
    return { viewport: [innerWidth, innerHeight], scrollY, visualViewport: { top: visualViewport?.pageTop, offset: visualViewport?.offsetTop, scale: visualViewport?.scale }, mode: document.querySelector('#review-panel').dataset.mode,
      title: document.querySelector('#review-title')?.textContent, action: rect('#learning-session [data-action="practice"]'),
      transcript: rect('#post-call-transcript'), transcriptOpen: document.querySelector('#post-call-transcript details.call-transcript')?.open,
      dock: rect('.glass-dock'), overflow: document.documentElement.scrollWidth > innerWidth,
      text: document.querySelector('#review-panel').innerText };
  });
  captures.push({ name, ...metrics });
  await writeFile(`${output}/metrics.json`, JSON.stringify(captures, null, 2) + '\n');
}
async function assertFirstAction(page) {
  const value = await page.evaluate(() => {
    const action = document.querySelector('#learning-session [data-action="practice"]');
    const bounds = action?.getBoundingClientRect(), dock = document.querySelector('.glass-dock').getBoundingClientRect();
    return { action: bounds && { top: bounds.top, bottom: bounds.bottom }, dockTop: dock.top, height: innerHeight, scrollY, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert(value.action, 'result has a direct practice action');
  assert.equal(value.scrollY, 0, 'a user can understand the result without scrolling');
  assert(value.action.top >= 0 && value.action.bottom <= Math.min(value.height, value.dockTop), `main action is visible above the dock: ${JSON.stringify(value)}`);
  assert.equal(value.overflow, false);
}
async function openCallFeedback(page, id) {
  await page.locator('[data-view="history"]').click();
  await page.locator(`.history-entry[data-session-id="${id}"] .history-open`).click();
  await page.locator('.call-feedback').click();
  await page.locator('#review-panel[data-mode="session"]').waitFor({ state: 'visible' });
}
try {
  await fixture('Earlier call waiting in the library', [{ original: 'I am agree.', improved: 'I agree.', category: 'error' }]);
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', timezoneId: 'Asia/Seoul' });
  await context.addInitScript(() => {
    window.testPeer = null;
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack() {}
      createDataChannel() { return this.channel = { readyState: 'open', send() {} }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.channel.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); await attachRoutes(page); await login(page);
  const emit = (speaker, text, id) => page.evaluate(({ speaker, text, id }) => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: speaker === 'user' ? 'conversation.item.input_audio_transcription.completed' : 'response.output_audio_transcript.done', item_id: id, transcript: text }) }), { speaker, text, id });
  const start = async () => {
    await page.locator('[data-view="contacts"]').click(); await page.locator('#start-call').click();
    await page.locator('#end-call').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('#end-call').disabled);
    return (await query('select id from public.sessions where user_id=$1 order by created_at desc limit 1', [uid])).rows[0].id;
  };
  const transcript = page.locator('#post-call-transcript details.call-transcript');
  const practice = () => page.locator('#learning-session [data-action="practice"]').first();
  let analysisGate = deferred(), failAnalysis = false;
  transport.review = async (_path, body) => {
    if (failAnalysis) return { status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic analysis outage' } } };
    await analysisGate.promise;
    const existing = (await query("select * from public.analyses where session_id=$1 and kind='session' order by created_at desc limit 1", [body.sessionId])).rows[0];
    if (existing) return { json: { analysis: existing } };
    const rows = (await query('select * from public.transcript_events where session_id=$1 order by timestamp,id', [body.sessionId])).rows;
    const source = rows.find(row => row.speaker === 'user'); assert(source, 'feedback uses confirmed user speech');
    const content = { summary: '친구와 다녀온 카페 이야기를 나눴어요.', strengths: [{ text: '좋았던 이유를 구체적으로 덧붙였어요.', evidence_ids: [source.id] }],
      corrections: [{ original: 'Yesterday I go to a cafe.', improved: 'Yesterday I went to a cafe.', reason: '어제 있었던 일이므로 went로 말해요.', category: 'error', evidence_ids: [source.id] }],
      practice: [], scope: { companionId: 'alex', session_count: 1, user_event_count: rows.filter(row => row.speaker === 'user').length }, next_scenario: '지난 주말 이야기' };
    const id = await insertAnalysis(body.sessionId, source.id, content);
    return { json: { analysis: (await query('select * from public.analyses where id=$1', [id])).rows[0] } };
  };
  const finishGate = deferred(); transport.finishGate = finishGate.promise;
  const first = await start();
  const turns = [
    'Yesterday I go to a cafe. I stayed there with a friend for almost two hours.',
    'That sounds relaxing. What did you like about it?',
    'The windows were big and the music was quiet. We could talk without shouting.',
    'Did you try anything with your coffee?',
    'We shared cheesecake. I usually prefer something less sweet but this one was light.',
    'Would you go back to the same place?',
    'Maybe next month. I also want to try a new place near the station.',
    'What have you heard about that place?',
    'It opens early so we could eat breakfast before the park gets crowded.',
    'Breakfast and a walk sound like a good plan.',
    'I will invite my friend next Saturday. I hope the weather will be good.',
    'That sounds like a lovely plan.'
  ];
  for (let i = 0; i < turns.length; i++) await emit(i % 2 ? 'assistant' : 'user', turns[i], `first-${i}`);
  await page.locator('#end-call').click();
  assert.equal(await page.locator('body').getAttribute('data-call-phase'), 'ending');
  assert.equal(await page.locator('#review-panel').isVisible(), false, 'the ended call waits for actual save acknowledgement');
  await capture(page, '01-finishing-390');
  finishGate.resolve(); transport.finishGate = null;
  await page.locator('#review-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#review-panel').getAttribute('data-mode'), 'session');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'review-title');
  assert.equal(await transcript.evaluate(node => node.open), false, 'long transcript defaults to optional exploration');
  assert.equal(await page.locator('#learning-queue [data-session-id]:visible').count(), 0, 'previous reports do not compete with this call');
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  await waitUntil(() => transport.calls.some(row => row.path.endsWith('/coach/review') && row.body.sessionId === first), 'analysis starts only after call save');
  await capture(page, '02-analysis-pending-390');
  analysisGate.resolve(); await practice().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#learning-session [data-action="practice"]').disabled);
  assert.equal(await transcript.evaluate(node => node.open), false);
  assert(await page.evaluate(() => Boolean(document.querySelector('#learning-session').compareDocumentPosition(document.querySelector('#post-call-transcript')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'result comes before transcript');
  await assertFirstAction(page); await capture(page, '03-result-390');
  await page.setViewportSize({ width: 320, height: 568 }); await assertFirstAction(page); await capture(page, '04-result-320');
  await page.setViewportSize({ width: 390, height: 844 });
  await practice().click(); await page.locator('.learning-practice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.learning-practice [data-practice-expression]').isVisible(), false);
  assert(!(await page.locator('#review-panel').innerText()).includes('Yesterday I went to a cafe.'), 'retrieval does not leak answer copies');
  await capture(page, '05-practice-390');
  transport.offline = true;
  await page.locator('.learning-practice [data-action="save-practice"]').click();
  await page.locator('[data-practice-status]').filter({ hasText: /서버.*대기|저장하지/ }).waitFor();
  assert.equal((await item('Yesterday I went to a cafe.')).practice_count, 0, 'failed persistence never becomes a completed practice');
  assert.equal(await page.locator('.learning-practice [data-action="prepare-next"]:visible').count(), 0);
  const queuedPractice = transport.actionBodies.filter(body => body.p_action === 'practice').at(-1);
  assert(queuedPractice, 'failed save has an explicit durable action');
  const retryPractice = page.locator('.learning-practice [data-action="retry-practice"]');
  await retryPractice.waitFor({ state: 'visible' });
  assert.equal(await retryPractice.isEnabled(), true, 'the current practice exposes its recovery without closing the task');
  transport.offline = false; await retryPractice.click();
  await waitUntil(async () => (await item('Yesterday I went to a cafe.')).practice_count === 1, 'same queued practice is acknowledged');
  await page.locator('.learning-practice [data-action="home"]').waitFor({ state: 'visible' });
  const replayedPractice = transport.actionBodies.filter(body => body.p_item_id === queuedPractice.p_item_id && body.p_action === 'practice');
  assert(replayedPractice.length >= 2 && replayedPractice.every(body => body.p_action_id === queuedPractice.p_action_id), 'explicit recovery retries the same durable practice ID');
  assert.equal(await page.locator('.learning-practice [data-action="retry-practice"]:visible').count(), 0);
  assert.equal(await page.locator('.learning-practice [data-action="home"]:visible').count(), 1, 'completion has one exit');
  assert.equal(await page.locator('.learning-practice [data-action="defer"]:visible, .learning-practice [data-action="close-practice"]:visible, .learning-practice [data-action="save-practice"]:visible').count(), 0, 'completed task has no stale task controls');
  assert.match(await page.locator('.learning-practice').innerText(), /저장/);
  assert.doesNotMatch(await page.locator('#notice').innerText(), /요청의 완료 여부를 확인하지 못|서버 반영 대기/, 'acknowledged completion does not retain a contradictory transient failure');
  await capture(page, '06-completion-390');
  await page.locator('.learning-practice [data-action="home"]').click();
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('[data-view="review"]').click();
  assert.equal(await page.locator('#review-panel').getAttribute('data-mode'), 'hub', 'generic revisit opens a hub, not an arbitrary old report');
  await capture(page, '07-returning-hub-390');
  await openCallFeedback(page, first); await practice().waitFor({ state: 'visible' });
  assert.equal((await item('Yesterday I went to a cafe.')).practice_count, 1, 'reload retains server-confirmed progress');
  assert.equal(await transcript.evaluate(node => node.open), false);

  analysisGate = deferred();
  const background = await start(); await emit('user', 'Yesterday I go to a cafe.', 'background-user'); await page.locator('#end-call').click();
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  await waitUntil(() => transport.calls.some(row => row.path.endsWith('/coach/review') && row.body.sessionId === background), 'background analysis is requested');
  await page.locator('[data-view="history"]').click(); analysisGate.resolve();
  await waitUntil(async () => (await query('select id from public.analyses where session_id=$1', [background])).rows.length === 1, 'background result commits');
  await waitUntil(async () => (await rpc('learning_snapshot', { p_companion_id: 'alex' })).feedback.find(row => row.session_id === background)?.current, 'background result is current');
  assert(await page.locator('#history-panel').isVisible(), 'late result never takes a user away from another tab');

  const empty = await start(); await page.locator('#end-call').click();
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  await page.locator('#learning-session').getByText(/발화.*없|표현.*없/).first().waitFor();
  const emptyText = await page.locator('#review-panel').innerText();
  assert.doesNotMatch(emptyText, /피드백을 만들고|피드백.*준비 중|표현.*정리 중/);
  assert.equal(transport.calls.filter(row => row.path.endsWith('/coach/review') && row.body.sessionId === empty).length, 0);
  await capture(page, '08-no-user-speech-390');

  failAnalysis = true;
  const failed = await start(); await emit('user', 'Yesterday I go to a cafe.', 'failed-user'); await page.locator('#end-call').click();
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  await page.locator('#learning-session [data-action="request-feedback"]').waitFor({ state: 'visible' });
  await page.locator('#learning-session').getByText(/피드백 서비스를 확인|완료 여부|준비하지 못/).first().waitFor();
  assert.doesNotMatch(await page.locator('#review-panel').innerText(), /피드백을 만들고|피드백.*준비 중|표현.*정리 중/);
  assert.equal((await query('select status from public.sessions where id=$1', [failed])).rows[0].status, 'ended', 'analysis outage does not undo saved call');
  await capture(page, '09-analysis-recovery-390');
  failAnalysis = false; await page.locator('#learning-session [data-action="request-feedback"]').click(); await practice().waitFor({ state: 'visible' });
  assert.equal((await query('select count(*)::int as n from public.analyses where session_id=$1', [failed])).rows[0].n, 1, 'retry yields one stored result');
  // Changing tabs closes only the visual attempt, not its persisted history.
  await practice().click(); await page.locator('.learning-practice').waitFor({ state: 'visible' });
  await page.locator('[data-view="contacts"]').click();
  const afterAbandon = await start();
  await emit('user', 'Yesterday I go to a cafe.', 'after-abandon-user'); await page.locator('#end-call').click();
  await practice().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.learning-practice:visible').count(), 0, 'a new call cannot inherit a previous visual practice attempt');
  assert.equal(await page.locator('#learning-session').getAttribute('data-feedback-session'), afterAbandon);
  assert(await page.locator('#review-content').isVisible(), 'new result remains readable after leaving an earlier practice');
  await capture(page, '10-return-after-abandoned-practice-390');

  // A confirmed defer is durable, but its late UI callback cannot navigate away
  // from a destination chosen after the save began.
  await practice().click();
  transport.actionGate = { action: 'defer', started: deferred(), release: deferred() };
  const deferGate = transport.actionGate;
  await page.locator('.learning-practice [data-action="defer"]').click();
  await deferGate.started.promise;
  await page.locator('[data-view="history"]').click();
  deferGate.release.resolve(); transport.actionGate = null;
  await waitUntil(async () => (await item('Yesterday I went to a cafe.')).status === 'deferred', 'delayed defer is stored');
  assert(await page.locator('#history-panel').isVisible(), 'late defer acknowledgement does not navigate back to home');
  assert.equal(await page.locator('.learning-practice:visible').count(), 0);

  await page.locator('[data-view="review"]').click();
  const hubPractice = page.locator('#learning-queue [data-action="practice"]').first();
  await hubPractice.waitFor({ state: 'visible' }); await hubPractice.click();
  await page.locator('.learning-practice [data-action="save-practice"]').click();
  await page.locator('.learning-practice [data-action="home"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.learning-practice [data-action="home"]:visible').count(), 1, 'hub completion has a single explicit exit');
  assert.equal(await page.locator('.learning-practice [data-action="save-practice"]:visible').count(), 0);
  await capture(page, '11-hub-practice-completion-390');
  await page.locator('.learning-practice [data-action="home"]').click();
  const periodEnd = new Date().toISOString(), periodStart = new Date(Date.now() - 7 * 86400000).toISOString();
  await query("insert into public.analyses(user_id,kind,content,model) values($1,'weekly',$2::jsonb,'local-weekly-fixture')", [uid, JSON.stringify({ summary: '주간 분석 선택을 유지하는 검증 문장입니다.', scope: { companionId: 'alex', period_start: periodStart, period_end: periodEnd } })]);
  await page.locator('[data-view="history"]').click();
  transport.historyGate = { started: deferred(), release: deferred() };
  const historyGate = transport.historyGate;
  await page.locator('#refresh-history').click(); await historyGate.started.promise;
  await page.locator('[data-view="review"]').click(); await page.locator('#weekly').click();
  await page.locator('#review-panel[data-mode="weekly"]').waitFor({ state: 'visible' });
  await page.locator('#review-content').getByText('주간 분석 선택을 유지하는 검증 문장입니다.', { exact: true }).waitFor();
  historyGate.release.resolve();
  await page.waitForFunction(() => !document.querySelector('#refresh-history').disabled);
  // The captured session projection must not overwrite a weekly selection made
  // while that history request was in flight.
  assert.equal(await page.locator('#review-panel').getAttribute('data-mode'), 'weekly');
  assert.match(await page.locator('#review-content').innerText(), /주간 분석 선택을 유지하는 검증 문장/);
  assert.equal(await page.locator('#learning-session:visible').count(), 0);
  await capture(page, '12-weekly-after-history-race-390');
  assert.deepEqual(transport.errors, []);
  assert.deepEqual(transport.routeErrors, []);
  console.log('PASS: mobile first action, collapsed transcript, current-call scope, direct recall, honest durable save and clean completion, restored hub, background completion, empty speech and analysis recovery.');
  await context.close();
} finally { await browser.close(); server.kill('SIGTERM'); await db.close(); }
