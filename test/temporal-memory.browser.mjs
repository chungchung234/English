// Time/memory UI acceptance with real Chromium and IndexedDB. Auth, DB and
// WebRTC are explicit fixtures; this does not measure actual model recall.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const port = Number(process.env.TEMPORAL_BROWSER_PORT || 49201), base = `http://127.0.0.1:${port}`, project = 'https://temporal-test.supabase.co';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', legacy = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessions = [{ id: legacy, user_id: uid, companion_id: 'alex', scenario: 'Legacy conversation', status: 'ended', created_at: '2026-11-09T15:00:00Z', ended_at: '2026-11-09T15:05:00Z', time_zone: null }];
const saved = [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', session_id: legacy, event_key: 'legacy-user', speaker: 'user', text: 'This is an older recorded conversation.', timestamp: '2026-11-09T15:01:00Z' }];
const errors = [], requests = [], policy = { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true };
let reply = 'ready';
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Static server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  await context.addInitScript(() => {
    window.testMessages = [];
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack() {}
      createDataChannel() { return this.dc = { readyState: 'open', send: raw => window.testMessages.push(JSON.parse(raw)) }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : {};
    requests.push({ path: url.pathname, body }); let data = [];
    if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
    else if (url.pathname === '/auth/v1/user') data = { id: uid };
    else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
    else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
    else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
    else if (url.pathname.endsWith('/coach/voice')) {
      const session = sessions.find(row => row.id === body.sessionId);
      data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', ...(reply === 'legacy' ? {} : { clock: { server_now_utc: '2026-11-10T14:59:58Z', time_zone: session.time_zone, session_created_at: session.created_at }, memory_context: { status: reply, memory_count: reply === 'ready' ? 1 : 0, fact_count: reply === 'ready' ? 1 : 0, last_session_created_at: sessions[0].created_at } }) };
    } else if (url.pathname.endsWith('/coach/review')) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'No generated fixture feedback.' } } });
    else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null, feedback: sessions.map(s => ({ session_id: s.id, current: false, job_state: 'not_requested', has_user_speech: saved.some(e => e.session_id === s.id && e.speaker === 'user') })) };
    else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
    else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
    else if (url.pathname.endsWith('/rpc/append_events')) { for (const event of body.p_events) if (!saved.some(e => e.id === event.id)) saved.push({ ...event, session_id: body.p_session_id, timestamp: event.occurred_at }); data = { inserted: body.p_events.length, event_ids: body.p_events.map(e => e.id) }; }
    else if (url.pathname.endsWith('/rpc/finish_session')) { data = sessions.find(s => s.id === body.p_session_id); data.status = 'ended'; data.ended_at = '2026-11-10T15:02:00Z'; }
    else if (url.pathname === '/rest/v1/sessions') {
      if (request.method() === 'POST') { const row = { ...body, status: 'active', created_at: '2026-11-10T14:59:55Z' }; sessions.unshift(row); data = [row]; }
      else data = sessions.filter(s => (!url.searchParams.get('id') || s.id === url.searchParams.get('id').slice(3)) && (!url.searchParams.get('companion_id') || s.companion_id === url.searchParams.get('companion_id').slice(3)) && (!url.searchParams.get('status') || s.status === url.searchParams.get('status').slice(3)));
    } else if (url.pathname === '/rest/v1/transcript_events') data = saved.filter(e => !url.searchParams.get('session_id') || e.session_id === url.searchParams.get('session_id').slice(3));
    await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
  });
  await page.goto(base);
  await page.clock.install({ time: new Date('2034-01-01T12:00:00Z') });
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  const emit = event => page.evaluate(e => window.testPeer.dc.onmessage({ data: JSON.stringify(e) }), event);
  const start = async () => {
    await page.locator('#start-call').click(); await page.locator('#end-call').waitFor({ state: 'visible' });
    await emit({ type: 'session.created', session: { instructions: 'Fixture only.', audio: { input: { turn_detection: policy } } } });
  };
  const end = async () => { await page.locator('#end-call').click(); await page.clock.fastForward(2100); await page.waitForFunction(() => window.testPeer.connectionState === 'closed'); };
  await start();
  assert.equal(sessions[0].time_zone, 'Asia/Seoul', 'call stores device IANA time zone, not Korean UI language');
  assert.equal(await page.locator('#call-local-time,#call-memory-context,#hold-call').count(), 0, 'clock/memory receipts and manual wait are absent from live UI');
  assert.doesNotMatch(await page.locator('#live-call').innerText(), /현재 시각|이전 대화 1개|전달됨|Asia\/Seoul|2034/);
  await page.clock.fastForward(4000);
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first-user', transcript: 'I remember our last conversation.' });
  await page.waitForFunction(() => document.querySelector('#turn-count').textContent === '1개 발화');
  assert.match(await page.locator('#transcript .transcript-record-time').textContent(), /2026\. 11\. 11\. 00:00/);
  const first = sessions[0].id;
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/temporal-call-390.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.querySelectorAll('#live-call p,#live-call button,#live-call time').forEach(e => e.style.fontSize = `${parseFloat(getComputedStyle(e).fontSize) * 1.25}px`); const live = document.querySelector('#live-call'); live.scrollTop = live.scrollHeight; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert(await page.locator('#live-call').evaluate(e => e.getBoundingClientRect().bottom <= document.querySelector('#end-call').getBoundingClientRect().top));
  await page.screenshot({ path: 'test-results/temporal-call-320-large-text.png', fullPage: true });
  await end();
  assert(await page.locator('[data-post-call-transcript] [data-transcript-events]').isVisible(), 'received transcript is readable without opening a disclosure');
  await page.locator('.transcript-record-info > summary').click();
  await page.locator('[data-session-time]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-session-time]').textContent(), /Asia\/Seoul/);
  assert.match(await page.locator('[data-post-call-transcript] .transcript-record-time').first().textContent(), /2026\. 11\. 11\. 00:00/);
  assert(saved.some(e => e.session_id === first && e.timestamp.startsWith('2026-11-10T15:00:')));
  assert(requests.some(r => r.body?.p_name === 'call_connected' && r.body?.p_session_id === first && r.body.p_payload?.occurred_at?.startsWith('2026-11-10T14:59:')), 'connection receipt uses the same server-anchored clock despite device skew');
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('[data-view="history"]').click();
  await page.locator(`[data-session-id="${first}"] .history-open`).click();
  assert.match(await page.locator('#call-detail-meta').textContent(), /2026\. 11\. 10\. 23:59.*종료.*2026\. 11\. 11\. 00:02.*Asia\/Seoul/);
  await page.locator('#call-detail-content .transcript-record-time').waitFor({ state: 'visible' });
  assert.match(await page.locator('#call-detail-content .transcript-record-time').textContent(), /기록 시각.*00:00/);
  await page.locator('[data-close="call-detail-dialog"]').click();
  await page.locator(`[data-session-id="${legacy}"] .history-open`).click();
  assert.match(await page.locator('#call-detail-meta').textContent(), /Asia\/Seoul 표시 · 당시 시간대 미저장/);
  await page.locator('[data-close="call-detail-dialog"]').click();
  await page.locator('[data-view="contacts"]').click();
  await page.locator('[data-companion="juno"]').click(); reply = 'legacy';
  await start();
  assert.equal(await page.locator('#call-local-time,#call-memory-context').count(), 0, 'new companion does not reveal or inherit a prior live receipt');
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fallback-user', transcript: 'This new call uses a device-time fallback.' });
  await page.waitForFunction(() => document.querySelector('#turn-count').textContent === '1개 발화');
  const fallback = sessions[0].id;
  await end();
  assert(saved.some(event => event.session_id === fallback && event.timestamp.startsWith('2034-01-01T12:00:')), 'missing server clock falls back to current device time without reusing the prior server anchor');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('4 temporal-memory browser groups PASS: server clock/midnight/timezone with device skew; durable per-turn and session timestamps/reload; legacy-zone honesty; isolated new-call fallback and compact live layout without clock/memory clutter. Provider/DB are fixtures.');
} finally { await browser.close(); server.kill('SIGTERM'); }
