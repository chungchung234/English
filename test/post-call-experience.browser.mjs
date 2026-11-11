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
    if(new URL(route.request().url()).pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}});
    const request = route.request(), url = new URL(request.url());
    if(url.pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}}); // Background delivery is outside this fixture's scope.
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
async function assertLayout(page) {
  const value = await page.evaluate(() => {
    const footer = document.querySelector('#session-review-footer'), bounds = footer?.getBoundingClientRect();
    const button = document.querySelector('#session-feedback-open'), action = button?.getBoundingClientRect();
    return { footer: bounds && { top: bounds.top, bottom: bounds.bottom, height: bounds.height }, action: action && { top: action.top, bottom: action.bottom, height: action.height }, height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth, visible: footer && getComputedStyle(footer).display !== 'none' };
  });
  assert.equal(value.overflow, false, 'the mobile view has no horizontal overflow');
  assert(value.visible && value.footer.height >= 76 && value.footer.top >= 0 && value.footer.bottom <= value.height + 1, `reserved feedback footer stays within viewport: ${JSON.stringify(value)}`);
  if (await page.locator('#session-feedback-open').isVisible()) assert(value.action.height >= 44 && value.action.bottom <= value.height, 'feedback action remains a reachable touch target');
}
async function exitReview(page) {
  if (await page.locator('#session-review-exit').isVisible()) await page.locator('#session-review-exit').click();
}
async function openCallFeedback(page, id) {
  await exitReview(page);
  await page.locator('[data-view="history"]').click();
  await page.locator(`.history-entry[data-session-id="${id}"] .history-open`).click();
  await page.locator('.call-feedback').click();
  await page.locator('#review-panel[data-mode="session"]').waitFor({ state: 'visible' });
}
async function stableScroll(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => scrollY);
}
try {
  await fixture('Earlier call waiting in the library', [{ original: 'I am agree.', improved: 'I agree.', category: 'error' }]);
  const mia = await fixture('Mia companion scoped feedback', [{ original: 'She go with me.', improved: 'She goes with me.' }], { companion: 'mia' });
  await fixture('OTHER_ACCOUNT_PRIVATE_FIXTURE', [{ original: 'They was ready.', improved: 'They were ready.' }], { user: otherUid });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', timezoneId: 'Asia/Seoul' });
  await context.addInitScript(() => {
    // Only the aligned design fixture advances the monotonic call clock. Timer
    // scheduling and the real browser rendering remain unchanged.
    const monotonicNow = performance.now.bind(performance); let fixtureOffset = 0;
    Object.defineProperty(performance, 'now', { value: () => monotonicNow() + fixtureOffset });
    window.advanceCallFixture = ms => { fixtureOffset += ms; };
    window.testPeer = null;
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack() {}
      createDataChannel() { return this.channel = { readyState: 'open', send() {} }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.connectedAt = performance.now(); this.channel.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); await attachRoutes(page); await login(page);
  const emit = (speaker, text, id) => page.evaluate(({ speaker, text, id }) => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: speaker === 'user' ? 'conversation.item.input_audio_transcription.completed' : 'response.output_audio_transcript.done', item_id: id, transcript: text }) }), { speaker, text, id });
  const start = async () => {
    await exitReview(page);
    await page.locator('[data-view="contacts"]').click(); await page.locator('#start-call').click();
    await page.locator('#end-call').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('#end-call').disabled);
    return (await query('select id from public.sessions where user_id=$1 order by created_at desc limit 1', [uid])).rows[0].id;
  };
  const transcript = page.locator('#post-call-transcript');
  let analysisGate = deferred(), failAnalysis = false, alignedDesign = false;
  transport.review = async (_path, body) => {
    if (failAnalysis) return { status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic analysis outage' } } };
    await analysisGate.promise;
    const existing = (await query("select * from public.analyses where session_id=$1 and kind='session' order by created_at desc limit 1", [body.sessionId])).rows[0];
    if (existing) return { json: { analysis: existing } };
    const rows = (await query('select * from public.transcript_events where session_id=$1 order by timestamp,id', [body.sessionId])).rows;
    const source = rows.find(row => row.speaker === 'user'); assert(source, 'feedback uses confirmed user speech');
    const reason = rows.find(row => row.text.includes('It was quiet')) || source;
    const reuse = rows.find(row => row.text.includes("I'd like to go")) || source;
    const content = { summary: '친구와 다녀온 카페 이야기를 나눴어요.', strengths: [{ text: '이유를 설명하고 상대에게도 질문했어요.', evidence_ids: [reason.id] }],
      corrections: [{ original: 'I go to a cafe with Mina.', improved: 'I went to a cafe with Mina.', reason: '어제 있었던 이야기라 과거형이 맞아요.', category: 'error', evidence_ids: [source.id] },
        { original: 'We talked for two hours.', improved: 'We chatted for a couple of hours.', reason: '편하게 나눈 대화를 나타내는 다른 표현이에요.', category: 'alternative', evidence_ids: [source.id] }],
      practice: [{ expression: "I'd like to go there again.", evidence_ids: [reuse.id] }], scope: { companionId: 'alex', session_count: 1, user_event_count: rows.filter(row => row.speaker === 'user').length }, next_scenario: '지난 주말 이야기' };
    if (alignedDesign) {
      content.corrections = [{ original: 'I go to a cafe with Mina.', improved: 'I went to a cafe with Mina.', reason: '지난 일을 말할 때는 went를 써요.', category: 'error', evidence_ids: [source.id] }];
      content.practice = [{ expression: 'What kind of cafes do you like?', evidence_ids: [reason.id] }, { expression: "I'd like to go there again.", evidence_ids: [reuse.id] }];
    }
    const id = await insertAnalysis(body.sessionId, source.id, content);
    return { json: { analysis: (await query('select * from public.analyses where id=$1', [id])).rows[0] } };
  };
  const finishGate = deferred(); transport.finishGate = finishGate.promise;
  const first = await start();
  const turns = [
    ['assistant', 'What did you do yesterday?'],
    ['user', 'I go to a cafe with Mina. We talked for two hours.'],
    ['assistant', 'What did you like about it?'],
    ['user', 'It was quiet, so we could talk easily. What kind of cafes do you like?'],
    ['assistant', 'I like quiet places too.'],
    ['user', "I'd like to go there again."],
    ['assistant', 'Did you try anything with your coffee?'],
    ['user', 'We shared cheesecake. I usually prefer something less sweet but this one was light.'],
    ['assistant', 'Would you go back to the same place?'],
    ['user', 'Maybe next month. I also want to try a new place near the station.'],
    ['assistant', 'What have you heard about that place?'],
    ['user', 'It opens early so we could eat breakfast before the park gets crowded.']
  ];
  for (let i = 0; i < turns.length; i++) await emit(...turns[i], `first-${i}`);
  await page.locator('#end-call').click();
  await page.locator('#review-panel[data-session-view="transcript"]').waitFor({ state: 'visible' });
  await transcript.getByText(turns[1][1], { exact: true }).waitFor({ state: 'visible' });
  assert.equal((await query('select status from public.sessions where id=$1', [first])).rows[0].status, 'active', 'received transcript opens before the server finish response');
  assert.equal(transport.calls.filter(row => row.path.endsWith('/coach/review') && row.body.sessionId === first).length, 0, 'unfinished storage never starts feedback');
  assert.doesNotMatch(await page.locator('#session-review-footer').innerText(), /학습 노트 준비 중/, 'final ASR/save verification is not mislabeled as generation');
  assert.equal(await page.locator('#learning-queue [data-session-id]:visible').count(), 0, 'older reports do not compete with this call');
  await assertLayout(page); await capture(page, '01-received-before-save-390');
  await page.evaluate(() => scrollTo({ top: 420, behavior: 'instant' }));
  const beforeSave = await stableScroll(page);
  // A late final utterance updates the received source without moving earlier turns.
  await emit('user', 'I will invite Mina next Saturday.', 'first-final');
  assert(Math.abs(await stableScroll(page) - beforeSave) <= 2, 'late final transcript preserves the reading position');
  finishGate.resolve(); transport.finishGate = null;
  await waitUntil(() => transport.calls.some(row => row.path.endsWith('/coach/review') && row.body.sessionId === first), 'analysis starts after confirmed call save');
  assert(Math.abs(await stableScroll(page) - beforeSave) <= 2, 'save acknowledgement preserves transcript reading position');
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await capture(page, '02-feedback-pending-390');
  const footerBefore = await page.locator('#session-review-footer').boundingBox();
  await page.evaluate(() => scrollTo({ top: 480, behavior: 'instant' }));
  const reading = await stableScroll(page);
  analysisGate.resolve(); await page.locator('#session-feedback-open').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'transcript', 'feedback readiness never navigates automatically');
  assert(Math.abs(await stableScroll(page) - reading) <= 2, 'ready button preserves long-transcript reading position');
  const footerAfter = await page.locator('#session-review-footer').boundingBox();
  assert(Math.abs(footerBefore.y - footerAfter.y) <= 1 && Math.abs(footerBefore.height - footerAfter.height) <= 1, 'pending and ready occupy the same reserved footer');
  assert.equal(await page.locator('#review-panel [data-action="practice"]:visible').count(), 0, 'solo-practice is absent from the result');
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' })); await capture(page, '03-feedback-ready-390');
  await page.setViewportSize({ width: 320, height: 568 }); await assertLayout(page); await capture(page, '04-transcript-320');
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  await assertLayout(page); await capture(page, '05-transcript-large-text-320');
  await page.evaluate(() => document.documentElement.style.fontSize = ''); await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo({ top: 460, behavior: 'instant' })); const beforeOpen = await stableScroll(page);
  const actionsBeforeView = transport.actionBodies.length;
  assert.equal((await eventRows('feedback_exposed')).filter(row => row.session_id === first).length, 0, 'transcript reading and the ready footer do not count as feedback exposure');
  await page.locator('#session-feedback-open').click();
  await page.locator('#review-panel[data-session-view="feedback"]').waitFor({ state: 'visible' });
  const feedback = page.locator('#session-feedback-content');
  await feedback.locator('[data-feedback-kind="strength"]').waitFor();
  assert.match(await feedback.innerText(), /이유를 설명하고 상대에게도 질문/);
  assert.match(await feedback.innerText(), /It was quiet, so we could talk easily/);
  assert.equal(await feedback.locator('[data-feedback-kind="correction"]').count(), 2, 'both useful corrections appear without an arbitrary one-expression cap');
  assert.match(await feedback.innerText(), /I went to a cafe with Mina/);
  assert.match(await feedback.innerText(), /We chatted for a couple of hours/);
  assert.doesNotMatch(await feedback.innerText(), /CEFR|발음 점수|유창성 점수|한 번 말해보기|혼자 말해보기/);
  await waitUntil(async () => (await eventRows('feedback_exposed')).some(row => row.session_id === first), 'actual visible feedback emits exposure after one second');
  await capture(page, '06-feedback-390');
  await feedback.locator('[data-reusable-expressions] summary').click();
  await feedback.locator('[data-feedback-kind="expression"]').waitFor({ state: 'visible' });
  const sourceLink = feedback.locator('[data-feedback-kind="correction"] [data-feedback-source]').last();
  await sourceLink.scrollIntoViewIfNeeded(); const feedbackReading = await stableScroll(page);
  await sourceLink.click();
  await page.locator('#review-panel[data-session-view="transcript"]').waitFor({ state: 'visible' });
  await transcript.getByText(turns[1][1], { exact: true }).waitFor({ state: 'visible' });
  await capture(page, '07-source-jump-390');
  await page.locator('#session-feedback-open').click();
  assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'feedback');
  assert(Math.abs(await stableScroll(page) - feedbackReading) <= 2, 'return from source restores feedback reading position');
  await page.locator('#session-transcript-back').click();
  assert(Math.abs(await stableScroll(page) - beforeOpen) <= 2, 'feedback back restores original transcript reading position');
  await page.locator('#session-feedback-open').click();
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await capture(page, '08-feedback-320');
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await capture(page, '09-feedback-large-text-320');
  await page.evaluate(() => document.documentElement.style.fontSize = ''); await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#session-review-exit').click();
  assert.equal(transport.actionBodies.length, actionsBeforeView, 'viewing, source navigation and finish never imply practice/defer/known actions');
  assert.equal((await item('I went to a cafe with Mina.')).practice_count, 0);
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('[data-view="review"]').click();
  assert.equal(await page.locator('#review-panel').getAttribute('data-mode'), 'hub', 'generic revisit opens the review hub');
  await openCallFeedback(page, first); await page.locator('#session-feedback-open').waitFor({ state: 'visible' });
  assert.match(await transcript.innerText(), /I will invite Mina next Saturday/);
  // Excluded expressions remain in the historical transcript, but disappear from
  // current feedback suggestions after a fresh owned snapshot.
  const excluded = await item('I went to a cafe with Mina.');
  await rpc('learning_action', { p_item_id: excluded.id, p_expected_revision: excluded.revision, p_action_id: randomUUID(), p_action: 'exclude', p_payload: {} });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await openCallFeedback(page, first); await page.locator('#session-feedback-open').click();
  await waitUntil(async () => await feedback.locator('[data-correction-expression="I went to a cafe with Mina."]:visible').count() === 0, 'confirmed exclusion suppresses only the corresponding feedback recommendation');
  assert.match(await feedback.innerText(), /We chatted for a couple of hours/);
  await exitReview(page);
  await page.locator('[data-view="contacts"]').click(); await page.locator('[data-companion="mia"]').click();
  await page.waitForFunction(() => document.querySelector('#companion-name').textContent === 'Mia');
  await openCallFeedback(page, mia.session.id); await page.locator('#session-feedback-open').click();
  assert.match(await feedback.innerText(), /She goes with me/);
  assert.doesNotMatch(await feedback.innerText(), /We chatted for a couple of hours|OTHER_ACCOUNT_PRIVATE_FIXTURE/);
  await exitReview(page); await page.locator('[data-view="contacts"]').click(); await page.locator('[data-companion="alex"]').click();
  await page.waitForFunction(() => document.querySelector('#companion-name').textContent === 'Alex');

  analysisGate = deferred();
  const background = await start(); await emit('user', turns[1][1], 'background-user'); await page.locator('#end-call').click();
  await page.locator('#review-panel').waitFor({ state: 'visible' });
  await waitUntil(() => transport.calls.some(row => row.path.endsWith('/coach/review') && row.body.sessionId === background), 'background feedback is requested');
  await exitReview(page); await page.locator('[data-view="history"]').click(); analysisGate.resolve();
  await waitUntil(async () => (await query('select id from public.analyses where session_id=$1', [background])).rows.length === 1, 'background feedback commits');
  await waitUntil(async () => (await rpc('learning_snapshot', { p_companion_id: 'alex' })).feedback.find(row => row.session_id === background)?.current, 'background feedback becomes current');
  assert(await page.locator('#history-panel').isVisible(), 'late feedback keeps the chosen destination');

  const empty = await start(); await page.locator('#end-call').click();
  await page.locator('#review-panel').waitFor({ state: 'visible' });
  await page.locator('#session-review-footer').getByText(/발화.*없|말.*없|학습 노트.*내용.*없/).first().waitFor();
  assert.doesNotMatch(await page.locator('#session-review-footer').innerText(), /학습 노트.*준비 중/);
  assert.equal(transport.calls.filter(row => row.path.endsWith('/coach/review') && row.body.sessionId === empty).length, 0);
  await capture(page, '10-no-user-speech-390');

  failAnalysis = true;
  const failed = await start(); await emit('user', turns[1][1], 'failed-user'); await page.locator('#end-call').click();
  await page.locator('#session-feedback-status[data-state=failed]').waitFor({ state: 'visible' });
  await page.locator('#session-feedback-retry').waitFor({ state: 'visible' });
  assert.equal((await query('select status from public.sessions where id=$1', [failed])).rows[0].status, 'ended', 'feedback outage cannot undo saved call');
  assert(await transcript.isVisible(), 'feedback failure leaves original conversation readable');
  assert.doesNotMatch(await page.locator('#session-review-footer').innerText(), /학습 노트.*준비 중/);
  await capture(page, '11-feedback-recovery-390');
  failAnalysis = false; await page.locator('#session-feedback-retry').click(); await page.locator('#session-feedback-open').waitFor({ state: 'visible' });
  assert.equal((await query('select count(*)::int as n from public.analyses where session_id=$1', [failed])).rows[0].n, 1, 'retry yields one stored feedback');
  await exitReview(page);

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
  assert.equal(await page.locator('#review-panel').getAttribute('data-mode'), 'weekly', 'late history projection cannot overwrite a weekly choice');
  assert.match(await page.locator('#review-content').innerText(), /주간 분석 선택을 유지하는 검증 문장/);
  assert.equal(await page.locator('#learning-session:visible').count(), 0);
  await capture(page, '12-weekly-after-history-race-390');
  // Same six-turn source content as the selected design. This is the actual app
  // using its normal save/review path, with synthetic voice/model/clock inputs.
  const toRestore = await item('I went to a cafe with Mina.');
  await rpc('learning_action', { p_item_id: toRestore.id, p_expected_revision: toRestore.revision, p_action_id: randomUUID(), p_action: 'restore', p_payload: {} });
  alignedDesign = true;
  await start();
  for (let i = 0; i < 6; i++) await emit(...turns[i], `aligned-${i}`);
  await page.evaluate(() => window.advanceCallFixture(272000 - (performance.now() - window.testPeer.connectedAt)));
  await page.locator('#end-call').click();
  await page.locator('#session-feedback-open').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.transcript-companion')?.textContent.includes('4분 32초'));
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  assert.equal(await transcript.locator('[data-transcript-event-id]').count(), 6);
  await assertLayout(page); await capture(page, '13-aligned-ready-390');
  await page.locator('#session-feedback-open').click();
  await feedback.locator('[data-source-quote]').waitFor({ state: 'visible' });
  assert.equal(await feedback.locator('[data-feedback-kind="correction"]').count(), 1);
  assert.equal(await feedback.locator('[data-feedback-kind="expression"]').count(), 2);
  await capture(page, '14-aligned-feedback-390');
  assert.deepEqual(transport.errors, []);
  assert.deepEqual(transport.routeErrors, []);
  console.log('PASS: transcript before save ACK; stable late ASR/save/feedback reading; 320/390/large text; full sourced feedback; source/back scroll; finish without learning actions; exclusion/account/companion protection; revisit, background, empty, retry and weekly race.');
  await context.close();
} finally { await browser.close(); server.kill('SIGTERM'); await db.close(); }
