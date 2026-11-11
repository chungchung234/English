// Post-call transcript acceptance uses the real bundled UI and IndexedDB.
// WebRTC/auth/coach transports are local fixtures; network gates prove that
// readable received speech does not depend on finish/review acknowledgement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 4197, base = `http://127.0.0.1:${port}`;
const project = 'https://end-transcript-test.supabase.co';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessions = [], saved = new Map(), finishes = [], partialFinishes = [], reviewRequests = [], errors = [], routeErrors = [];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let appendGate = null, finishGate = null, sessionMetadataGate = null, failReview = false;
const emptyEnhancements = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
async function waitUntil(work, message, timeout = 15000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(message);
}
async function milestone(promise, message) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Static server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.testMessages = [];
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack() {}
      createDataChannel() { return this.dc = { readyState: 'open', send: value => window.testMessages.push(JSON.parse(value)) }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_local_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() : undefined;
    try {
      let data = [];
      if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
      else if (url.pathname === '/auth/v1/user') data = { id: uid };
      else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'gpt-realtime-mini', coach: 'gpt-4.1-mini', analysis: 'gpt-4.1' } };
      else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
      else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
      else if (url.pathname.endsWith('/coach/voice')) data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
      else if (url.pathname.endsWith('/coach/review')) {
        reviewRequests.push(body.sessionId);
        if (failReview) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Feedback fixture unavailable' } } });
        assert.fail('This suite intentionally does not supply generated feedback');
      } else if (url.pathname.endsWith('/rpc/append_events')) {
        const gate = appendGate;
        if (gate) { gate.started.resolve(); await gate.release.promise; }
        for (const event of body.p_events) {
          const previous = saved.get(event.id); if (previous) assert.deepEqual(previous.event, event, 'retry keeps the same received event');
          saved.set(event.id, { sessionId: body.p_session_id, event });
        }
        data = { inserted: body.p_events.length, event_ids: body.p_events.map(event => event.id) };
      } else if (url.pathname.endsWith('/rpc/finish_session')) {
        finishes.push(body.p_session_id);
        const gate = finishGate;
        if (gate) { gate.started.resolve(); await gate.release.promise; }
        const session = sessions.find(row => row.id === body.p_session_id); assert(session);
        session.status = 'ended'; session.ended_at = new Date().toISOString(); data = session;
      } else if (url.pathname.endsWith('/rpc/learning_finish_partial')) {
        partialFinishes.push(body.p_session_id);
        const session = sessions.find(row => row.id === body.p_session_id); assert(session);
        session.status = 'ended'; session.record_incomplete = true; session.ended_at = new Date().toISOString(); data = session;
      } else if (url.pathname.endsWith('/rpc/learning_snapshot')) {
        data = { items: [], recommended_item_ids: [], next_plan: null,
          feedback: sessions.filter(session => session.companion_id === body.p_companion_id).map(session => ({ session_id: session.id, current: false, job_state: 'not_requested', has_user_speech: [...saved.values()].some(row => row.sessionId === session.id && row.event.speaker === 'user') })) };
      } else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = emptyEnhancements;
      else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
      else if (url.pathname.endsWith('/rpc/learning_plan')) data = { scenario: null };
      else if (url.pathname === '/rest/v1/sessions') {
        if (request.method() === 'POST') { const session = { ...body, status: 'active', created_at: new Date().toISOString() }; sessions.unshift(session); data = [session]; }
        else {
          data = sessions.filter(session => !url.searchParams.get('companion_id') || session.companion_id === url.searchParams.get('companion_id').slice(3));
          if (url.searchParams.get('status') === 'eq.ended') data = data.filter(session => session.status === 'ended');
          const id = url.searchParams.get('id');
          if (id?.startsWith('eq.')) {
            data = data.filter(session => session.id === id.slice(3));
            const gate = sessionMetadataGate;
            if (gate?.sessionId === id.slice(3)) { gate.started.resolve(); await gate.release.promise; }
          } else if (sessionMetadataGate) {
            // Exercise the partial session projection used by review selection:
            // full optional time metadata must come from its independent lookup.
            data = data.map(session => { if (session.id !== sessionMetadataGate.sessionId) return session; const { time_zone, ...partial } = session; return partial; });
          }
        }
      } else if (url.pathname === '/rest/v1/transcript_events') {
        data = [...saved.values()].map(row => ({ ...row.event, session_id: row.sessionId, timestamp: row.event.occurred_at }));
        const session = url.searchParams.get('session_id'); if (session?.startsWith('eq.')) data = data.filter(event => event.session_id === session.slice(3));
        const ids = url.searchParams.get('id'); if (ids?.startsWith('in.(')) data = data.filter(event => ids.slice(4, -1).split(',').includes(event.id));
      } else if (url.pathname === '/rest/v1/analyses' || /^\/rest\/v1\/(memory_|learning_)/.test(url.pathname)) data = [];
      else throw Error('Unexpected fixture transport ' + url.pathname);
      const total = Array.isArray(data) ? data.length : null;
      if (Array.isArray(data) && url.searchParams.has('offset')) {
        const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit') || 500); data = data.slice(offset, offset + limit);
      }
      await route.fulfill({ json: data, headers: total === null ? {} : { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${total}`, 'Access-Control-Expose-Headers': 'Content-Range' } });
    } catch (error) { routeErrors.push(error.message); await route.fulfill({ status: 400, json: { message: error.message, code: 'FIXTURE_TRANSPORT' } }); }
  });
  await page.goto(base);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture-jwt', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  const emit = event => page.evaluate(event => window.testPeer.dc.onmessage({ data: JSON.stringify(event) }), event);
  const start = async () => { await page.locator('[data-view="contacts"]').click(); await page.locator('#start-call').click(); await page.locator('#end-call').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('#end-call').disabled); return sessions[0].id; };
  const transcript = () => page.locator('[data-post-call-transcript]');
  const textRows = () => transcript().locator('[data-transcript-events]');
  const transcriptStatus = () => transcript().locator('[data-transcript-status]');

  appendGate = { started: defer(), release: defer() }; finishGate = { started: defer(), release: defer() }; failReview = true;
  const firstId = await start();
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'received-user-1', transcript: 'I would like to review what we said.' });
  await emit({ type: 'response.output_audio_transcript.done', item_id: 'received-ai-1', transcript: 'Of course. What stood out to you?' });
  await milestone(appendGate.started.promise, 'captured speech reaches the held append request');
  await page.locator('#end-call').click();
  await page.locator('[data-panel="review"]').waitFor({ state: 'visible', timeout: 1500 });
  await transcript().waitFor({ state: 'visible', timeout: 1500 });
  assert.match(await textRows().innerText(), /I would like to review what we said\./);
  assert.match(await textRows().innerText(), /Of course\. What stood out to you\?/);
  assert.match(await transcript().innerText(), /중간에 멈춘 답변은 실제로 들은 내용과 다를 수 있어요/);
  assert.equal(saved.size, 0, 'readable received turns precede append acknowledgement');
  assert.equal(finishes.length, 0, 'immediate transcript does not wait for finish RPC');
  assert.match(await transcriptStatus().innerText(), /전사|전송|저장.*확인|대기/);
  assert.doesNotMatch(await transcriptStatus().innerText(), /서버 저장 완료|통화 저장 완료/);
  assert.equal(await transcriptStatus().getAttribute('role'), 'status');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'toggle-post-call-transcript', 'hangup moves keyboard focus to the newly opened transcript');
  await emit({ type: 'input_audio_buffer.committed', item_id: 'late-final-user' });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-final-user', transcript: 'This is my final sentence after hangup.' });
  await textRows().getByText('This is my final sentence after hangup.', { exact: false }).waitFor();
  assert.equal(await transcript().locator('[data-transcript-event-id]').count(), 3, 'late final completion updates the same open transcript without duplicate rows');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'toggle-post-call-transcript', 'late speech updates preserve transcript focus');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the open mobile transcript fits the existing layout');
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/end-transcript-pending.png', fullPage: true });
  appendGate.release.resolve(); appendGate = null;
  await milestone(finishGate.started.promise, 'completed final transcription reaches the held finish request');
  assert.equal(sessions.find(session => session.id === firstId).status, 'active', 'finish acknowledgement remains held');
  assert.equal((await textRows().innerText()).includes('This is my final sentence after hangup.'), true);
  assert.doesNotMatch(await transcriptStatus().innerText(), /통화 저장 완료/);
  finishGate.release.resolve(); finishGate = null;
  await waitUntil(() => sessions.find(session => session.id === firstId).status === 'ended', 'server confirms finish');
  await waitUntil(() => reviewRequests.includes(firstId), 'feedback request is independent of the immediately visible transcript');
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  assert.equal([...saved.values()].filter(row => row.sessionId === firstId).length, 3, 'all received final rows reach acknowledged storage');
  assert.match(await textRows().innerText(), /This is my final sentence after hangup\./);
  await page.screenshot({ path: 'test-results/end-transcript-saved.png', fullPage: true });
  await page.screenshot({ path: 'test-results/end-transcript-feedback-failed.png', fullPage: true });
  console.log('PASS: received and late-final speech is readable immediately during held append/finish; failed feedback keeps the full transcript.');

  sessionMetadataGate = { sessionId: firstId, started: defer(), release: defer() };
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('[data-view="review"]').click(); await transcript().waitFor({ state: 'visible' });
  await milestone(sessionMetadataGate.started.promise, 'reload requests the held optional session metadata');
  const savedIds = [...saved.values()].filter(row => row.sessionId === firstId).map(row => row.event.id).sort();
  await page.waitForFunction(({ sessionId, ids }) => {
    const host = document.querySelector('[data-post-call-transcript]');
    const restored = [...(host?.querySelectorAll('[data-transcript-event-id][data-storage="server"]') || [])].map(row => row.dataset.transcriptEventId).sort();
    return host?.dataset.sessionId === sessionId && JSON.stringify(restored) === JSON.stringify(ids);
  }, { sessionId: firstId, ids: savedIds });
  assert.match(await transcriptStatus().innerText(), /대화문 서버 저장 확인/, 'saved transcript is ready while optional session metadata remains held');
  assert.match(await transcript().locator('[data-session-time]').innerText(), /확인하고 있어요/, 'pending metadata is not mislabeled as a legacy unstored time zone');
  assert.match(await transcript().innerText(), /중간에 멈춘 답변은 실제로 들은 내용과 다를 수 있어요/, 'reload retains the generated-versus-heard transcript limitation');
  assert.match(await textRows().innerText(), /I would like to review what we said\./);
  assert.match(await textRows().innerText(), /This is my final sentence after hangup\./);
  sessionMetadataGate.release.resolve(); sessionMetadataGate = null;
  await page.waitForFunction(zone => document.querySelector('[data-post-call-transcript] [data-session-time]')?.textContent.includes(zone), sessions.find(session => session.id === firstId).time_zone);
  await page.screenshot({ path: 'test-results/end-transcript-reloaded.png', fullPage: true });
  await page.locator('[data-view="history"]').click();
  await page.locator(`.history-entry[data-session-id="${firstId}"] .history-open`).click();
  const historyTranscript = page.locator('#call-detail-content .call-transcript');
  assert(await historyTranscript.evaluate(node => node.open), 'opening ended-call details opens transcript without another disclosure click');
  await historyTranscript.getByText(/I would like to review what we said\./).waitFor();
  await page.locator('[data-close="call-detail-dialog"]').click();
  console.log('PASS: reload restores exact server transcript rows and the generated/heard warning before optional time metadata; ended-call history opens its actual transcript directly.');

  const emptyId = await start(); await page.locator('#end-call').click();
  await transcript().waitFor({ state: 'visible', timeout: 1500 });
  assert.equal(await transcript().locator('[data-transcript-event-id]').count(), 0, 'a zero-turn call does not invent transcript rows');
  assert.match(await transcript().innerText(), /발화.*없|대화.*없|0개/);
  await waitUntil(() => sessions.find(session => session.id === emptyId).status === 'ended', 'zero-turn call can still finish honestly');
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  assert(!reviewRequests.includes(emptyId), 'zero-user-turn call does not request unsupported feedback');
  console.log('PASS: zero-turn transcript states that no speech is available and never invents a successful review.');

  const partialId = await start();
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'partial-user', transcript: 'Keep this received sentence even if another one failed.' });
  await page.locator('#transcript').getByText(/Keep this received sentence/).waitFor({ state: 'attached' });
  await emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'missing-user' });
  await page.locator('#end-call').click(); await transcript().waitFor({ state: 'visible', timeout: 1500 });
  assert.match(await textRows().innerText(), /Keep this received sentence/);
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  assert.equal(sessions.find(session => session.id === partialId).status, 'active', 'missing transcription never becomes a false completed server call');
  assert.match(await transcript().innerText(), /누락|실패|미완료|일부|수신된/);
  assert(!finishes.includes(partialId), 'partial transcription blocks normal finish acknowledgement');
  assert.equal(await page.locator('[data-panel="review"]').isVisible(), true, 'partial failure keeps the already-open readable transcript');
  await page.screenshot({ path: 'test-results/end-transcript-partial.png', fullPage: true });
  console.log('PASS: transcription failure preserves received speech and visible partial/save recovery without claiming completion.');
  await page.locator('#learning-session [data-action="finish-partial"]').click();
  await waitUntil(() => sessions.find(session => session.id === partialId).record_incomplete === true, 'explicit received-only recovery completes the partial server session');
  await page.waitForFunction(() => document.querySelector('[data-transcript-status]')?.textContent.includes('수신된 기록으로 마무리'));
  assert.deepEqual(partialFinishes, [partialId], 'partial completion is an explicit distinct recovery request');
  assert.match(await textRows().innerText(), /Keep this received sentence/);
  assert.match(await transcriptStatus().innerText(), /누락된 음성은 포함되지 않/);
  assert.doesNotMatch(await transcriptStatus().innerText(), /전사 또는 통화 저장이 미완료/);
  await page.screenshot({ path: 'test-results/end-transcript-partial-recovered.png', fullPage: true });
  console.log('PASS: explicit received-only recovery updates partial status while preserving the missing-audio limitation.');

  const storageFailureId = await start();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value) {
      if (this.name === 'pending') throw Error('Fixture device storage unavailable');
      return original.call(this, value);
    };
  });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'device-failed-user', transcript: 'Show this received text even when device storage fails.' });
  await page.locator('#end-call').click(); await transcript().waitFor({ state: 'visible', timeout: 1500 });
  assert.match(await textRows().innerText(), /Show this received text even when device storage fails\./);
  await transcript().locator('[data-transcript-event-id][data-storage="failed"]').waitFor();
  assert.match(await textRows().innerText(), /기기 보관과 서버 저장을 확인하지 못/);
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  assert(![...saved.values()].some(row => row.sessionId === storageFailureId), 'device failure never invents server persistence');
  assert(!finishes.includes(storageFailureId), 'device failure never turns the call into completed storage');
  await page.screenshot({ path: 'test-results/end-transcript-device-failed.png', fullPage: true });
  assert.deepEqual(routeErrors, []); assert.deepEqual(errors, []);
  console.log('PASS: device-save failure still exposes received text with explicit unconfirmed storage and no false completed call.');
  await context.close();
} finally { await browser.close(); server.kill('SIGTERM'); }
