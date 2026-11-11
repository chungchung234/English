// Local first-release acceptance: actual browser, durable IndexedDB, all SQL
// migrations and authenticated RLS/RPCs. Auth/coach/WebRTC transports are fixtures.
// No live API credential or hosted database is used by this suite.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const port = 4188, base = `http://127.0.0.1:${port}`;
const project = 'https://post-call-acceptance.supabase.co';
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
    const result = await db.query(signature.set ? `select * from ${invocation}` : `select ${invocation} as result`, args.map(arg => arg.value));
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
async function openFeedback(page, label) {
  await page.locator('[data-view="history"]').click();
  const sessionId = (await query('select id from public.sessions where scenario=$1 and user_id=$2 order by created_at desc limit 1', [label, uid])).rows[0].id;
  await page.locator(`.history-entry[data-session-id="${sessionId}"] .history-open`).click();
  await page.locator('.call-feedback').click();
  await page.locator('[data-panel="review"]').waitFor({ state: 'visible' });
  await page.locator('#learning-session').waitFor();
}
async function openSessionActions(page) {
  const details = page.locator('#learning-session > details').filter({ has: page.locator('[data-action="practice"]') }).first();
  if (await details.count() && !await details.evaluate(node => node.open)) await details.locator('summary').first().click();
}
async function refresh(page) { await page.locator('[data-view="history"]').click(); await page.locator('#refresh-history').click(); }
function itemCard(page, itemId, root = '#learning-session') { return page.locator(`${root} [data-item-id="${itemId}"]`).first(); }
const practiceBox = page => page.locator('.learning-practice').filter({ has: page.locator('[data-practice-expression]') }).first();
async function practice(page, itemId) { await openSessionActions(page); await clickControl(page, itemCard(page, itemId).locator('[data-action="practice"]')); await practiceBox(page).waitFor({ state: 'visible' }); }
async function openQueue(page) { const fold=page.locator('#learning-queue > details').filter({has:page.getByText('복습 보관함',{exact:true})}); if(await fold.count()&&!await fold.evaluate(node=>node.open))await fold.locator('summary').first().click(); }
async function clickControl(page, control) {
  // Keep locators live: acknowledging an earlier queued action may replace the
  // disclosure while Playwright waits for its summary to stop moving.
  for(let tries=0;tries<12;tries++) {
    const folds=control.locator('xpath=ancestor::details');
    const index=await folds.evaluateAll(nodes=>{
      const closed=nodes.map((node,index)=>({node,index,depth:(()=>{let depth=0;for(let n=node;n;n=n.parentElement)depth++;return depth;})()})).filter(row=>!row.node.open).sort((a,b)=>a.depth-b.depth);
      return closed[0]?.index??-1;
    });
    if(index<0)break;
    await folds.nth(index).locator('summary').first().click();
  }
  await control.click();
}
async function closePractice(page, {conflict=false} = {}) {
  const close = practiceBox(page).locator('[data-action="close-practice"]');
  if (await close.count()) { await close.focus(); await page.keyboard.press('Enter'); await page.waitForFunction(conflict=>conflict?['retry-conflict','discard-conflict','restore'].includes(document.activeElement?.dataset.action):document.activeElement?.dataset.action==='practice',conflict); } else await practiceBox(page).locator('[data-action="home"]').last().click();
}
const transport = { offline: false, calls: [], errors: [], review: null, voice: [], actionBodies: [], failRestore: false, finishGate: null };
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
          if (transport.offline) return route.fulfill({ status: 503, json: { message: 'fixture network unavailable' } });
        }
        const result = await rpc(name, body);
        return route.fulfill({ json: result });
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const rows = await tableRequest(url.pathname.split('/').at(-1), url, request);
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || rows.length || 1);
        return route.fulfill({ json: rows.slice(offset, offset + limit), headers: { 'Content-Range': `${offset}-${Math.max(offset, Math.min(rows.length, offset + limit) - 1)}/${rows.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } });
      }
      throw Error('Unconfigured external transport ' + url.pathname);
    } catch (error) {
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
try {
  const normal = await fixture('Acceptance: concise feedback', [
    { original: 'Yesterday I go to the park.', improved: 'Yesterday I went to the park.', category: 'error' },
    { original: 'I would like a coffee, please.', improved: 'Could I have a coffee, please?', category: 'alternative' },
    { original: 'Can you say again?', improved: 'Could you repeat that?' }
  ]);
  const miaFixture = await fixture('Acceptance: Mia private scope', [{ original: 'She go with me.', improved: 'She goes with me.' }], { companion: 'mia' });
  await fixture('OTHER_ACCOUNT_PRIVATE_FIXTURE', [{ original: 'They was ready.', improved: 'They were ready.' }], { user: otherUid });
  const main = await item('Yesterday I went to the park.');
  const alternate = await item('Could I have a coffee, please?');
  const extra = await item('Could you repeat that?');
  assert(main.enrolled); assert(!alternate.enrolled); assert(!extra.enrolled);
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); await attachRoutes(page); await login(page);
  assert.equal((await eventRows('feedback_exposed')).length, 0, 'home render does not expose feedback');
  const openedAt = Date.now();
  await openFeedback(page, normal.session.scenario);
  const core = page.locator('#review-core');
  const takeaway = page.locator('#learning-session [data-feedback-core]');
  await takeaway.waitFor({ state: 'visible' });
  await takeaway.evaluate(node => node.scrollIntoView({block: 'center'}));
  assert.match(await takeaway.innerText(), /Yesterday I went/);
  assert.match(await takeaway.innerText(), /오류|교정/);
  await waitUntil(async () => (await eventRows('feedback_exposed')).some(event => event.analysis_id === normal.analysisId), 'one-second visible core emits exposure');
  const exposure = (await eventRows('feedback_exposed')).find(event => event.analysis_id === normal.analysisId);
  assert.equal(exposure.session_id, normal.session.id);
  assert(new Date(exposure.occurred_at).getTime() - openedAt >= 1000, `actual foreground exposure waits at least one second (delta=${new Date(exposure.occurred_at).getTime()-openedAt}, occurred=${exposure.occurred_at}, opened=${new Date(openedAt).toISOString()})`);
  assert(exposure.payload.visible_ratio >= 0.5);
  await core.locator('summary').first().click();
  assert.match(await core.innerText(), /오늘은 지난 경험/);
  assert.match(await core.innerText(), /대안|선택/);
  await core.getByRole('button', { name: '근거 발화', exact: true }).first().click();
  await core.locator('blockquote').first().getByText(normal.event.text, { exact: true }).waitFor();
  await core.evaluate(node => { const preserved = document.createElement('p'); preserved.hidden = true; preserved.dataset.preserveHidden = ''; node.append(preserved); });
  await practice(page, main.id);
  const expression = page.locator('.learning-practice [data-practice-expression]');
  assert(await expression.isHidden(), 'rephrasing starts with the answer concealed');
  assert.match(await page.locator('.learning-practice [data-practice-cue]').innerText(), /Yesterday I go/);
  assert(!(await page.locator('body').innerText()).includes(main.expression), 'surrounding answer copies are concealed during rephrasing');
  await page.evaluate(expression => { const transcript = document.createElement('section'); transcript.id = 'post-call-transcript'; transcript.dataset.lateTranscriptFixture = ''; transcript.textContent = expression; document.querySelector('#review-content').before(transcript); }, main.expression);
  await page.locator('[data-late-transcript-fixture]').waitFor({ state: 'hidden' });
  await page.locator('.learning-practice [data-action="toggle-expression"]').click();
  assert(await expression.isVisible());
  assert.match(await expression.innerText(), /Yesterday I went/);
  await page.locator('.learning-practice [data-action="toggle-expression"]').click();
  assert(await expression.evaluate(node => node.hidden || node.getAttribute('aria-hidden') === 'true'), 'hidden expression is hidden from assistive technology');
  await closePractice(page);
  await page.locator('.learning-practice').waitFor({ state: 'hidden' });
  assert(await core.isVisible(), 'closing rephrasing restores the original feedback surface');
  assert((await page.locator('body').innerText()).includes(main.expression), 'closing restores the concealed answer');
  assert(await page.locator('[data-preserve-hidden]').isHidden(), 'previously hidden content remains hidden after practice');
  assert(await page.locator('[data-late-transcript-fixture]').isVisible(), 'late transcript visibility is restored after practice');
  await page.locator('[data-late-transcript-fixture]').evaluate(node => node.remove());
  await openFeedback(page, normal.session.scenario);
  assert.equal((await item(main.expression)).status, 'active', 'closing preserves the item state');

  await practice(page, main.id);
  await page.locator('.learning-practice [data-action="save-practice"]').click();
  await waitUntil(async () => (await item(main.expression)).status === 'practiced', 'manual practice persists in SQL');
  const saved = (await eventRows('practice_saved')).filter(event => event.item_id === main.id);
  assert.equal(saved.length, 1); assert(saved[0].attempt_id); assert(saved[0].paired);
  const started = (await eventRows('practice_started')).filter(event => event.item_id === main.id);
  assert.equal(started.length, 2, 'close and new practice are different attempts');
  assert.equal(started.filter(event => event.attempt_id === saved[0].attempt_id).length, 1);
  assert.equal((await item(main.expression)).practice_count, 1);
  await page.locator('.learning-practice [data-action="prepare-next"]').click();
  await waitUntil(async () => (await query('select * from public.learning_next_plans where user_id=$1 and companion_id=$2', [uid, 'alex'])).rows.length === 1, 'optional next-call plan is saved');
  assert.equal(transport.voice.length, 0, 'preparing next call does not connect a call');
  await page.locator('[data-panel="contacts"]').waitFor({ state: 'visible' });
  await page.locator('#next-plan').filter({ hasText: normal.content.next_scenario }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await openFeedback(page, normal.session.scenario);
  await openSessionActions(page);
  assert.match(await itemCard(page, main.id).innerText(), /연습|저장/);
  assert.equal((await item(main.expression)).practice_count, 1, 'reload restores authoritative server progress');
  console.log('PASS T01/T02/T05/T08/T09/T23/T25/T30: concise source-backed feedback, category distinction, one default, visibility exposure, keyboard close, manual save and exact attempt linkage.');

  // Additional candidates require explicit enrollment; defer and source hold
  // use separate source-backed feedback to avoid conflating their meanings.
  await page.getByText('원하면 추가 표현 선택 · 후보 최대 3개', { exact: true }).click();
  await clickControl(page, itemCard(page, alternate.id).locator('[data-action="enroll"]'));
  await waitUntil(async () => (await item(alternate.expression)).enrolled, 'candidate enrollment is saved');
  await clickControl(page, itemCard(page, extra.id).locator('[data-action="enroll"]'));
  await waitUntil(async () => (await item(extra.expression)).enrolled, 'third candidate enrollment is explicit');
  await page.locator('[data-view="review"]').click();
  await openQueue(page); await page.locator('#learning-queue [data-action="recommend-more"]').click();
  const moreSnapshot = await rpc('learning_snapshot', { p_companion_id: 'alex' });
  assert(moreSnapshot.recommended_item_ids.length <= 3);
  const deferredFixture = await fixture('Acceptance: explicit defer', [{ original: 'I am wait for you.', improved: 'I am waiting for you.' }]);
  const deferredItem = await item('I am waiting for you.');
  await refresh(page); await openFeedback(page, deferredFixture.session.scenario);
  await clickControl(page, itemCard(page, deferredItem.id).locator('[data-action="defer"]'));
  await waitUntil(async () => (await item(deferredItem.expression)).status === 'deferred', 'defer is distinct from close');
  const deferred = await item(deferredItem.expression);
  assert(deferred.next_eligible_at); assert.equal(deferred.practice_count, 0); assert.equal(deferred.defer_count, 1);
  const heldFixture = await fixture('Acceptance: source dispute', [{ original: 'I thinked so.', improved: 'I thought so.' }]);
  const heldItem = await item('I thought so.');
  await refresh(page); await openFeedback(page, heldFixture.session.scenario);
  await clickControl(page, itemCard(page, heldItem.id).locator('[data-action="hold_wrong_transcript"]'));
  await waitUntil(async () => (await query('select * from public.learning_source_holds where session_id=$1', [heldFixture.session.id])).rows.length === 1, 'source hold persists');
  assert.equal((await query('select text from public.transcript_events where id=$1', [heldFixture.event.id])).rows[0].text, heldFixture.event.text, 'source hold leaves original transcript intact');
  assert.equal((await rpc('learning_snapshot', { p_companion_id: 'alex' })).items.find(row => row.id === heldItem.id).has_valid_source, false);
  console.log('PASS T04/T05/T08: explicit candidate enrollment and extra recommendation cap, defer date, source hold without editing transcript.');

  const offlineFixture = await fixture('Acceptance: offline exclusion', [{ original: 'I want check the bill.', improved: 'I would like to check the bill.' }]);
  const offlineItem = await item('I would like to check the bill.');
  await refresh(page); await openFeedback(page, offlineFixture.session.scenario);
  transport.offline = true;
  await clickControl(page, itemCard(page, offlineItem.id).locator('[data-action="exclude"]'));
  await page.getByText(/기기 보관 확인.*서버 반영/).first().waitFor();
  assert.equal((await item(offlineItem.expression)).status, 'active', 'offline choice is not shown as server success');
  await waitUntil(async () => transport.actionBodies.some(body => body.p_item_id === offlineItem.id), 'durable offline action reaches the explicitly failing server transport');
  const action = transport.actionBodies.find(body => body.p_item_id === offlineItem.id);
  assert(action);
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.RTCPeerConnection = class {
    constructor() { window.acceptancePeer = this; this.connectionState = 'new'; }
    addTrack() {}
    createDataChannel() { return this.channel = { readyState: 'open', send() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.channel.onopen?.(); }
    close() { this.connectionState = 'closed'; }
  }; });
  await page.locator('[data-view="contacts"]').click(); await page.locator('#start-call').click();
  await page.locator('#end-call').waitFor({ state: 'visible' });
  assert.equal(transport.voice.length, 1);
  assert.equal((await eventRows('call_connected')).length, 0, 'SDP response alone does not count as connected voice');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(async scope => { const { createLearningOutbox } = await import('/src/learning-outbox.js'); return (await createLearningOutbox().list(scope)).filter(row => row.kind === 'event' && row.body.p_name === 'call_connected').length; }, project + '|' + uid), 0, 'SDP response does not queue a connected event');
  await page.evaluate(() => { window.acceptancePeer.connectionState = 'connected'; window.acceptancePeer.onconnectionstatechange?.(); });
  await waitUntil(async () => page.evaluate(async scope => { const { createLearningOutbox } = await import('/src/learning-outbox.js'); return (await createLearningOutbox().list(scope)).some(row => row.kind === 'event' && row.body.p_name === 'call_connected'); }, project + '|' + uid), 'peer connected event is durably queued behind offline intent');
  assert(!JSON.stringify(transport.voice[0]).includes(offlineItem.expression), 'pending exclusion cannot enter next-call request');
  assert.equal(transport.voice[0].omitLearningContext, true, 'unknown pending exclusion scope omits all prior learning context');
  // Reload releases the simulated peer; it is not evidence of real upstream voice.
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  transport.offline = false;
  await refresh(page);
  await waitUntil(async () => (await item(offlineItem.expression)).status === 'excluded', 'durable offline exclusion syncs after reconnect');
  await waitUntil(async () => (await eventRows('call_connected')).length === 1, 'connected event reaches SQL after queue recovery');
  const replays = transport.actionBodies.filter(body => body.p_item_id === offlineItem.id);
  assert(replays.length >= 2); assert(replays.every(body => body.p_action_id === action.p_action_id), 'reload retries the original durable action ID');
  assert.equal((await query('select * from public.learning_actions where action_id=$1', [action.p_action_id])).rows.length, 1);
  console.log('PASS T10/T11/T29: offline exclusion retained across reload, no premature server success, exact-ID retry and next-call context suppression (voice transport simulated).');

  const conflictFixture = await fixture('Acceptance: two-device conflict', [{ original: 'I have saw that.', improved: 'I have seen that.' }]);
  const conflictItem = await item('I have seen that.');
  await refresh(page); await openFeedback(page, conflictFixture.session.scenario);
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const second = await secondContext.newPage(); await attachRoutes(second); await login(second); await openFeedback(second, conflictFixture.session.scenario);
  await practice(page, conflictItem.id); await practice(second, conflictItem.id);
  await page.locator('.learning-practice [data-action="save-practice"]').click();
  await waitUntil(async () => (await item(conflictItem.expression)).practice_count === 1, 'one of two devices saves its own attempt');
  await closePractice(page);
  await page.locator('.learning-practice').waitFor({ state: 'hidden' });
  await openFeedback(page, conflictFixture.session.scenario);
  const twoStarts = (await eventRows('practice_started')).filter(event => event.item_id === conflictItem.id);
  const oneSaved = (await eventRows('practice_saved')).filter(event => event.item_id === conflictItem.id);
  assert.equal(twoStarts.length, 2); assert.equal(oneSaved.length, 1);
  assert.equal(twoStarts.filter(event => event.attempt_id === oneSaved[0].attempt_id).length, 1);
  assert.equal(twoStarts.filter(event => event.paired).length, 1);
  await clickControl(page, itemCard(page, conflictItem.id).locator('[data-action="exclude"]'));
  await waitUntil(async () => (await item(conflictItem.expression)).status === 'excluded', 'first device exclusion applies');
  await second.locator('.learning-practice [data-action="save-practice"]').click();
  await second.locator('[data-practice-status]').filter({hasText:'최신 상태가 달라'}).waitFor();
  await closePractice(second,{conflict:true});
  await second.locator('[data-view="review"]').click();
  await second.locator('.learning-practice').waitFor({ state: 'hidden' });
  await second.locator('#learning-queue [data-conflict-id]').waitFor();
  assert.match(await second.locator('#learning-queue').innerText(), /다른 기기|최신 상태/);
  assert.equal((await item(conflictItem.expression)).status, 'excluded', 'stale practice does not overwrite newer exclusion');
  const stale = transport.actionBodies.filter(body => body.p_item_id === conflictItem.id && body.p_action === 'practice').at(-1);
  const conflictResult = (await query('select result from public.learning_actions where action_id=$1', [stale.p_action_id])).rows[0].result;
  assert.equal(conflictResult.outcome, 'conflict'); assert.equal(conflictResult.item.status, 'excluded');
  const oldConflictId = await second.locator('#learning-queue [data-conflict-id]').getAttribute('data-conflict-id');
  await second.locator('[data-action="retry-conflict"]').click();
  assert.equal(await second.locator('#learning-queue [data-conflict-id]').getAttribute('data-conflict-id'), oldConflictId, 'excluded practice retry retains a resolvable conflict');
  const secondQueue = await second.evaluate(async scope => { const { createLearningOutbox } = await import('/src/learning-outbox.js'); return createLearningOutbox().list(scope); }, project + '|' + uid);
  assert(secondQueue.filter(row => row.kind === 'action').every(row => row.state === 'conflict'), 'invalid retry cannot create a wedged pending action');
  await second.locator('[data-action="discard-conflict"]').click();
  await second.locator('#learning-queue [data-conflict-id]').waitFor({ state: 'hidden' });
  await openQueue(second); await second.getByText('지난 피드백·표현 보관함', { exact: true }).click();
  await clickControl(second, itemCard(second, conflictItem.id, '#learning-queue').locator('[data-action="restore"]'));
  await waitUntil(async () => (await item(conflictItem.expression)).status === 'active', 'explicit latest-version restore works after discarding stale practice');
  await secondContext.close();
  console.log('PASS T11/T30: two devices start separate attempts, one save pairs only its attempt and daily count is1; stale intent returns CAS conflict/latest state and discard preserves exclusion.');

  // Late transcript source mutation invalidates recommendation without erasing practice.
  await query(`insert into public.transcript_events(user_id,session_id,event_key,speaker,text) values($1,$2,'late-user','user','One more thing.')`, [uid, normal.session.id]);
  let snapshot = await rpc('learning_snapshot', { p_companion_id: 'alex' });
  assert.equal(snapshot.feedback.find(row => row.session_id === normal.session.id).current, false);
  assert.equal(snapshot.items.find(row => row.id === main.id).has_valid_source, false);
  assert.equal(snapshot.items.find(row => row.id === main.id).practice_count, 1);
  await refresh(page); await openFeedback(page, normal.session.scenario);
  assert.match(await page.locator('#review-content').innerText(), /대화문이 달라|원문|갱신|새.*발화/);
  const reanalysisId = await insertAnalysis(normal.session.id, normal.event.id, normal.content);
  snapshot = await rpc('learning_snapshot', { p_companion_id: 'alex' });
  assert(snapshot.feedback.find(row => row.session_id === normal.session.id).current);
  assert.equal(snapshot.items.find(row => row.id === main.id).practice_count, 1, 'identical expression retains self-report history');
  assert.equal(snapshot.items.find(row => row.id === main.id).source_analysis_id, reanalysisId);
  const changed = { ...normal.content, corrections: [{ ...normal.content.corrections[0], improved: 'I visited the park yesterday.' }] };
  await insertAnalysis(normal.session.id, normal.event.id, changed);
  snapshot = await rpc('learning_snapshot', { p_companion_id: 'alex' });
  assert.equal(snapshot.items.find(row => row.id === main.id).has_valid_source, false);
  assert.equal(snapshot.items.find(row => row.id === main.id).practice_count, 1);
  assert.equal((await item('I visited the park yesterday.')).practice_count, 0, 'changed grammar is a new item');
  console.log('PASS T19/T22: late transcript invalidates old feedback, same-expression reanalysis keeps history and changed expression gets no inherited practice.');

  const background = await fixture('Acceptance: pending background analysis', [{ original: 'I am agree.', improved: 'I agree.' }], { analysis: false });
  await query(`insert into public.analysis_jobs(user_id,session_id,kind,request_key,state,lease_token,lease_expires_at) values($1,$2,'session',$3,'running',$4,now()+interval '5 minutes')`, [uid, background.session.id, 'acceptance:' + background.session.id, randomUUID()]);
  await refresh(page); await openFeedback(page, background.session.scenario);
  assert.match(await page.locator('#review-content').innerText(), /준비하고|정리하고/);
  assert.equal(await page.locator('#review-content [data-action="request-feedback"]').count(), 0, 'valid running lease prevents duplicate analysis');
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await openFeedback(page, background.session.scenario);
  assert.match(await page.locator('#review-content').innerText(), /준비하고|정리하고/);
  await openFeedback(page, normal.session.scenario);
  await insertAnalysis(background.session.id, background.event.id, background.content);
  await query(`update public.analysis_jobs set state='completed',updated_at=now() where session_id=$1`, [background.session.id]);
  await page.locator('[data-view="history"]').click();
  await page.locator('#refresh-history').click();
  assert.equal(await page.locator('#learning-session').getAttribute('data-feedback-session'), normal.session.id, 'background completion does not change selected feedback');
  assert(await page.locator('[data-panel="history"]').isVisible(), 'background completion does not force the review tab');
  await page.locator('[data-view="review"]').click();
  const backgroundLink = page.locator(`#learning-queue [data-session-id="${background.session.id}"]`);
  await backgroundLink.waitFor({ state: 'attached' });
  const unseenFold = backgroundLink.locator('xpath=ancestor::details');
  if (!await unseenFold.evaluate(node => node.open)) await unseenFold.locator('summary').click();
  await backgroundLink.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#review-panel').getAttribute('data-mode'), 'hub', 'general review makes background feedback discoverable without changing the selected call');
  console.log('PASS T12/T13: running server job survives reload, blocks duplicate generation and completes without forced navigation.');

  const quota = await fixture('Acceptance: quota error', [{ original: 'I has an idea.', improved: 'I have an idea.' }], { analysis: false });
  transport.review = async () => {
    await query(`insert into public.api_daily_usage(user_id,day,kind,reservations) values($1,(now() at time zone 'UTC')::date,'session',20) on conflict(user_id,day,kind) do update set reservations=20`, [uid]);
    return { status: 429, json: { error: { code: 'BUDGET_EXCEEDED', message: 'RAW_UPSTREAM_DEBUG_SECRET' } } };
  };
  await refresh(page); await openFeedback(page, quota.session.scenario);
  await page.locator('#review-content [data-action="request-feedback"]').click();
  await page.locator('#review-content').getByText(/오늘 피드백 생성 한도를/).waitFor();
  assert.match(await page.locator('#review-content').innerText(), /09:00|오전 9:00/);
  assert(await page.locator('#review-content [data-action="request-feedback"]').isDisabled());
  assert(!await page.locator('body').innerText().then(text => text.includes('RAW_UPSTREAM_DEBUG_SECRET')));
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await openFeedback(page, quota.session.scenario);
  assert(await page.locator('#review-content [data-action="request-feedback"]').isDisabled(), 'server quota block survives reload');
  const quotaState = (await rpc('learning_snapshot', { p_companion_id: 'alex' })).feedback.find(row => row.session_id === quota.session.id);
  assert.equal(quotaState.blocked_reason, 'quota'); assert.equal(new Date(quotaState.blocked_until).getUTCHours(), 0);
  assert.equal(new Date(quotaState.blocked_until).getUTCMinutes(), 0, 'UTC midnight is the precise KST09 reset');
  await query(`delete from public.api_daily_usage where user_id=$1 and kind='session'`, [uid]);
  await page.evaluate(({ project }) => { const key = 'loop.auth:' + project, auth = JSON.parse(localStorage.getItem(key)); auth.expires_at += 172800; localStorage.setItem(key, JSON.stringify(auth)); }, { project });
  await page.clock.install({ time: new Date(new Date(quotaState.blocked_until).getTime() + 1000) });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await openFeedback(page, quota.session.scenario);
  assert(await page.locator('#review-content [data-action="request-feedback"]').isEnabled(), 'KST09 clock and server reset release quota blocker');
  await page.clock.setSystemTime(new Date());
  const oversized = await fixture('Acceptance: input error', [{ original: 'I do a reservation.', improved: 'I would like to make a reservation.' }], { analysis: false });
  transport.review = async () => ({ status: 413, json: { error: { code: 'ANALYSIS_TOO_LARGE', message: 'RAW_MODEL_REQUEST' } } });
  await refresh(page); await openFeedback(page, oversized.session.scenario);
  await page.locator('#review-content [data-action="request-feedback"]').click();
  await page.locator('#review-content').getByText(/이번 기록은 자동 분석 크기 한도를/).waitFor();
  assert(await page.locator('#review-content [data-action="request-feedback"]').isDisabled());
  assert.equal((await query('select text from public.transcript_events where id=$1', [oversized.event.id])).rows[0].text, oversized.event.text);
  assert(!await page.locator('body').innerText().then(text => text.includes('RAW_MODEL_REQUEST')));
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await openFeedback(page, oversized.session.scenario);
  assert(await page.locator('#review-content [data-action="request-feedback"]').isDisabled(), 'input-size block survives reload');
  await query(`insert into public.transcript_events(user_id,session_id,event_key,speaker,text) values($1,$2,'changed-input','user','A new source version.')`, [uid, oversized.session.id]);
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await openFeedback(page, oversized.session.scenario);
  assert(await page.locator('#review-content [data-action="request-feedback"]').isEnabled(), 'source version change releases an old input blocker');
  console.log('PASS T16/T18: quota shows KST reset and prevents repeated requests; oversized analysis preserves full source and hides raw errors.');

  const noSpeech = randomUUID();
  await query(`insert into public.sessions(id,user_id,scenario,companion_id,status,ended_at) values($1,$2,'Acceptance: no user speech','alex','ended',now())`, [noSpeech, uid]);
  await refresh(page); await openFeedback(page, 'Acceptance: no user speech');
  assert.match(await page.locator('#review-content').innerText(), /확인된 (사용자|내) 발화가 없어/);
  assert.equal(await page.locator('#review-content [data-action="request-feedback"]').count(), 0, 'no user speech cannot start analysis');
  await page.locator('#review-content [data-action="home"]').click();
  await page.locator('[data-panel="contacts"]').waitFor({ state: 'visible' });
  console.log('PASS T03: no-user-speech record offers home without invented corrections or analysis request.');

  const partial = await fixture('Acceptance: explicit partial finalization', [{ original: 'Only this part arrived.', improved: 'This is the part that arrived.' }], { analysis: false });
  await query(`update public.sessions set status='active',ended_at=null where id=$1`, [partial.session.id]);
  transport.review = async (_path, body) => {
    assert.equal(body.sessionId, partial.session.id);
    const id=await insertAnalysis(partial.session.id, partial.event.id, partial.content);
    return { json: { analysis: (await query('select * from public.analyses where id=$1',[id])).rows[0] } };
  };
  await refresh(page); await openFeedback(page, partial.session.scenario);
  await page.locator('#review-content [data-action="finish-partial"]').click();
  await waitUntil(async () => (await query('select record_incomplete from public.sessions where id=$1', [partial.session.id])).rows[0].record_incomplete, 'partial finalization flag persists on server');
  await waitUntil(async () => (await query('select * from public.analyses where session_id=$1', [partial.session.id])).rows.length === 1, 'received source is analyzed after explicit finalize');
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await openFeedback(page, partial.session.scenario);
  assert.match(await page.locator('#review-content').innerText(), /누락된 음성은 포함되지/);
  console.log('PASS T15: explicit partial finalization persists a missing-audio warning through reload and analysis.');

  const longExpression = 'Could you please help me understand ' + 'the details of this particular reservation '.repeat(32) + 'before I make a decision?';
  const long = await fixture('Acceptance: long expression', [{ original: 'Explain reservation please.', improved: longExpression }]);
  const longItem = await item(longExpression);
  await refresh(page); await openFeedback(page, long.session.scenario);
  await mkdir('test-results', { recursive: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await practice(page, longItem.id);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}px`);
    assert(await practiceBox(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1), `long expression fits inline practice at ${width}px`);
    await page.locator('.learning-practice [data-action="save-practice"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/post-call-${width}.png`, fullPage: true });
    await closePractice(page);
    await openFeedback(page, long.session.scenario);
  }
  assert.match(await page.locator('#review-content').innerText(), /자동 숙달|연습|말해보기/);
  console.log('PASS T27: 320/390/desktop long-expression layout, accessible recall hiding, reachable save and keyboard close/focus return.');

  const merged = await fixture('Acceptance: merged source library', [{ original: 'Help me with this reservation.', improved: longExpression }]);
  assert.equal((await query('select * from public.learning_sources where item_id=$1', [longItem.id])).rows.length, 2, 'canonical expression merges sources for this companion');
  await refresh(page); await page.locator('[data-view="review"]').click();
  await openQueue(page); await page.getByText('지난 피드백·표현 보관함', { exact: true }).click();
  await clickControl(page, itemCard(page, longItem.id, '#learning-queue').locator('[data-action="practice"]'));
  await page.locator('.learning-practice').waitFor({ state: 'visible' });
  await page.locator('.learning-practice [data-action="save-practice"]').click();
  await waitUntil(async () => (await item(longExpression)).practice_count === 1, 'library practice stores progress');
  const librarySave = (await eventRows('practice_saved')).find(event => event.item_id === longItem.id);
  assert.equal(librarySave.attribution, 'library'); assert.equal(librarySave.session_id, null); assert.equal(librarySave.analysis_id, null);
  const libraryStart = (await eventRows('practice_started')).find(event => event.attempt_id === librarySave.attempt_id);
  assert.equal(libraryStart.attribution, 'library'); assert.equal(libraryStart.session_id, null);
  for (const event of await query('select payload from public.learning_events').then(result => result.rows)) {
    assert(!JSON.stringify(event.payload).includes('reservation'), 'analytics payload does not duplicate expression content');
  }
  await closePractice(page);
  console.log('PASS T07/T31: same-companion merged expression retains two sources; library save/start share one attempt and remain unassigned to source sessions.');

  const periodEnd = new Date(Date.now() - 24 * 3600000).toISOString();
  const periodStart = new Date(new Date(periodEnd).getTime() - 168 * 3600000).toISOString();
  await query(`insert into public.analyses(user_id,kind,content,model) values($1,'weekly',$2::jsonb,'local-weekly-fixture')`, [uid, JSON.stringify({ summary: '저장된 168시간 분석입니다.', scope: { companionId: 'alex', period_start: periodStart, period_end: periodEnd } })]);
  await refresh(page); await page.locator('[data-view="review"]').click();
  await page.locator('#weekly').click();
  await page.waitForFunction(()=>document.querySelector('#review-content h3')?.textContent==='Alex · 최근 7일 분석');
  const weekly = page.locator('#review-content');
  assert.match(await weekly.innerText(), /직전 168시간/);
  assert.match(await weekly.innerText(), /생성:/);
  assert.match(await weekly.innerText(), /이후 통화는 이 결과에 자동 포함되지/);
  const expectedPeriod = await page.evaluate(({ start, end }) => [start, end].map(value => new Intl.DateTimeFormat('ko-KR', {dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value))), { start: periodStart, end: periodEnd });
  for (const expected of expectedPeriod) assert((await weekly.innerText()).includes(expected));
  console.log('PASS T28: stored weekly result displays exact 168-hour period and generation time without including later calls.');

  await page.locator('[data-view="contacts"]').click(); await page.locator('[data-companion="mia"]').click();
  await page.waitForFunction(() => document.querySelector('#companion-name').textContent === 'Mia');
  await page.locator('[data-view="history"]').click();
  await page.locator(`.history-entry[data-session-id="${miaFixture.session.id}"]`).waitFor();
  assert(!await page.locator('#learning-queue').innerText().then(text => text.includes(main.expression)));
  assert(!await page.locator('body').innerText().then(text => text.includes('OTHER_ACCOUNT_PRIVATE_FIXTURE')));
  assert.equal(await page.locator('.learning-practice').count(), 0);
  await page.locator('[data-view="contacts"]').click(); await page.locator('[data-companion="alex"]').click();
  await page.waitForFunction(() => document.querySelector('#companion-name').textContent === 'Alex');
  await page.locator('[data-view="history"]').click();
  await page.locator(`.history-entry[data-session-id="${normal.session.id}"]`).waitFor();
  assert(!await page.locator('#learning-queue').innerText().then(text => text.includes('She goes with me.')));
  console.log('PASS T20: companion switch closes practice and scopes visible feedback; authenticated SQL excludes another account.');

  await page.locator('[data-view="history"]').click(); await page.locator('#account-open').click();
  const downloading = page.waitForEvent('download'); await page.locator('#export').click();
  const backup = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  assert.equal(backup.schema_version, 2);
  assert(backup.learning_progress.some(row => row.expression === main.expression && row.practice_count === 1));
  assert(backup.learning_progress.some(row => row.expression === longExpression && row.practice_count === 1));
  assert(backup.learning_progress.some(row => row.companion_id === 'mia'), 'backup includes all owned companions');
  assert(!backup.sessions.some(row => row.user_id === otherUid), 'backup is protected by real RLS');
  assert(backup.events.some(row => row.id === normal.event.id));
  assert.equal(backup.sessions.find(row => row.id === partial.session.id).record_incomplete, true, 'backup preserves the partial-record marker');
  const currentLong = await item(longExpression);
  await rpc('learning_action', { p_item_id: currentLong.id, p_expected_revision: currentLong.revision, p_action_id: randomUUID(), p_action: 'exclude', p_payload: {} });
  const originalEventCount = (await query('select count(*)::integer as n from public.transcript_events')).rows[0].n;
  transport.failRestore = true;
  const upload = { name: 'v2-acceptance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) };
  await page.locator('#restore').setInputFiles(upload);
  await page.waitForFunction(() => /배치.*확인하지 못/.test(document.querySelector('#notice').textContent));
  assert.equal((await query('select count(*)::integer as n from public.transcript_events')).rows[0].n, originalEventCount, 'earlier source batches are safely repeatable');
  await page.locator('#restore').setInputFiles(upload);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('대화와 복습 이력을 복원했습니다'));
  assert.equal((await item(longExpression)).status, 'excluded', 'old backup cannot replace newer server exclusion');
  const legacy = { schema_version: 1, sessions: backup.sessions, events: backup.events };
  await page.locator('#restore').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('대화와 복습 이력을 복원했습니다'));
  assert.equal((await item(longExpression)).practice_count, 1);
  await page.locator('[data-close="account-dialog"]').click();
  console.log('PASS T21: v2 export includes source and learning history; interrupted learning batch is retryable, v1 remains accepted, older backup preserves latest state.');

  const delayContext = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const delayed = await delayContext.newPage(); await attachRoutes(delayed); await login(delayed);
  let releaseFinish;
  transport.finishGate = new Promise(resolve => { releaseFinish = resolve; });
  try {
    await delayed.evaluate(() => { window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; }
      addTrack() {}
      createDataChannel() { return this.channel = { readyState: 'open', send() {} }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.channel.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    }; });
    const reviewCount = transport.calls.filter(call => call.path.endsWith('/coach/review')).length;
    await delayed.locator('#start-call').click(); await delayed.locator('#end-call').waitFor({ state: 'visible' });
    const delayedSessionId = transport.voice.at(-1).sessionId;
    await delayed.locator('#end-call').click();
    await delayed.locator('#wrapup-home').waitFor({ state: 'visible', timeout: 15000 });
    const finalizing = delayed.locator('[data-review-state="finalizing"]');
    assert(await finalizing.isVisible(), 'the post-call save state is visible without opening the transcript');
    assert.match(await finalizing.innerText(), /끝났어요[\s\S]*저장.*확인/, 'the visible post-call view distinguishes ended audio from pending storage');
    assert.equal((await query('select status from public.sessions where id=$1', [delayedSessionId])).rows[0].status, 'active', 'waiting does not invent server completion');
    await delayed.locator('#wrapup-home').click();
    assert.match(await delayed.locator('#notice').innerText(), /서버 저장 완료 전/);
    assert(await delayed.locator('[data-panel="contacts"]').isVisible());
    assert(await delayed.locator('#start-call').isDisabled(), 'another call waits until previous resources are released');
    releaseFinish(); transport.finishGate = null;
    await delayed.waitForFunction(() => !document.querySelector('#start-call').disabled);
    assert.equal((await query('select status from public.sessions where id=$1', [delayedSessionId])).rows[0].status, 'ended');
    assert(await delayed.locator('[data-panel="contacts"]').isVisible(), 'background finish respects the user home exit');
    assert.equal(transport.calls.filter(call => call.path.endsWith('/coach/review')).length, reviewCount, 'no-speech delayed finish never generates feedback');
    console.log('PASS T14: real ten-second finish delay offers home, keeps save state honest, blocks overlap, releases start and avoids forced navigation.');
  } finally { releaseFinish?.(); transport.finishGate = null; await delayContext.close(); }

  await context.close();
  const buildEnv = { ...process.env, PUBLIC_SUPABASE_URL: project, PUBLIC_SUPABASE_KEY: 'sb_publishable_local_fixture' };
  try {
    execFileSync(process.execPath, ['scripts/build-web.mjs', '--require-config'], { env: buildEnv, stdio: 'pipe' });
    const html = await readFile('dist/index.html', 'utf8');
    assert(html.includes("script-src 'sha256-"), 'production output declares hashed CSP');
    assert(!html.includes('src="app.js"'));
    const built = await browser.newPage(); await attachRoutes(built, html); await login(built, '/built/');
    assert.match(await built.locator('#privacy-dialog .privacy-copy').first().textContent(), /복습 수행·미루기·제외·보류/);
    await openFeedback(built, deferredFixture.session.scenario);
    await built.locator('#learning-session').waitFor();
    assert.match(await built.locator('#review-content').innerText(), /I am waiting for you/);
    await practice(built, deferredItem.id);
    assert(await built.locator('[data-practice-expression]').isHidden());
    await built.locator('.learning-practice [data-action="toggle-expression"]').click();
    assert(await built.locator('[data-practice-expression]').isVisible());
    await closePractice(built);
    await built.close();
    console.log('PASS: production bundle runs post-call feedback under hashed CSP without JavaScript errors.');
  } finally {
    execFileSync(process.execPath, ['scripts/build-web.mjs'], { env: { ...process.env, PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
  }
  assert.deepEqual(transport.errors, [], 'no browser JavaScript errors');
} finally {
  await browser.close(); server.kill('SIGTERM'); await db.close();
}
