// The real UI and IndexedDB use explicit server gates to distinguish audio end,
// transcript delivery, finish acknowledgement and later feedback. Providers and
// authentication are fixtures; timings here are controlled cases, not averages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const port = 49203, project = 'https://save-completion-test.supabase.co', uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ started: defer(), release: defer() });
async function until(work, label) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await work()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail(label); }
async function openTranscript(page) { await page.locator('[data-transcript-events]').waitFor({ state: 'visible' }); }
async function milestone(promise, label) { let timer; try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 15000); })]); } finally { clearTimeout(timer); } }
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
async function harness() {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const state = { sessions: [], events: new Map(), errors: [], routes: [], finishCalls: 0, reviews: 0, analyses: [], reviewSuccess: false, finishGate: null, appendGate: null, reviewGate: null, malformed: false, failFinish: false, arrayAck: false };
  await context.addInitScript(() => {
    window.testMessages = []; window.AudioContext = undefined; window.webkitAudioContext = undefined;
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack(track) { this.input = track; }
      createDataChannel() { return this.dc = { readyState: 'open', send: value => window.testMessages.push(JSON.parse(value)) }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => state.errors.push(e.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_local_fixture' })}` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : undefined;
    if(url.pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}}); // Background delivery is outside this fixture's scope.
    try {
      let data = [];
      if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
      else if (url.pathname === '/auth/v1/user') data = { id: uid };
      else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
      else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
      else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
      else if (url.pathname.endsWith('/coach/voice')) data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
      else if (url.pathname.endsWith('/coach/review')) {
        state.reviews++; const held = state.reviewGate; if (held) { held.started.resolve(); await held.release.promise; }
        if (!state.reviewSuccess) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Feedback remains separate.' } } });
        const source = [...state.events.values()].find(row => row.session_id === body.sessionId && row.speaker === 'user');
        const analysis = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'session', session_id: body.sessionId, created_at: new Date().toISOString(), source_event_ids: [source.id], content: { scope: { companionId: 'alex', user_event_count: state.events.size }, summary: '지난 경험을 이야기했어요.', strengths: [{ text: '하고 싶은 말을 직접 요청했어요.', evidence_ids: [source.id] }], corrections: [], practice: [] } };
        state.analyses = [analysis]; data = { analysis };
      }
      else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null, feedback: state.sessions.map(s => { const analysis = state.analyses.find(row => row.session_id === s.id); return { session_id: s.id, current: Boolean(analysis), analysis_id: analysis?.id, job_state: analysis ? 'completed' : 'not_requested', has_user_speech: [...state.events.values()].some(e => e.session_id === s.id && e.speaker === 'user') }; }) };
      else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
      else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
      else if (url.pathname.endsWith('/rpc/record_call_diagnostics')) data = { event_ids: body.p_events.map(event => event.event_id), dropped_event_ids: [] };
      else if (url.pathname.endsWith('/rpc/append_events')) { const held = state.appendGate; if (held) { held.started.resolve(); await held.release.promise; } for (const event of body.p_events) state.events.set(event.id, { ...event, session_id: body.p_session_id, timestamp: event.occurred_at }); data = { inserted: body.p_events.length, event_ids: body.p_events.map(e => e.id) }; }
      else if (url.pathname.endsWith('/rpc/finish_session')) {
        state.finishCalls++; const held = state.finishGate; if (held) { held.started.resolve(); await held.release.promise; }
        if (state.failFinish) return route.fulfill({ status: 503, json: { message: 'Fixture save acknowledgement unavailable.' } });
        if (state.malformed) data = { id: state.malformed === 'wrong-session' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : body.p_session_id, status: state.malformed === 'active' ? 'active' : 'ended', ended_at: state.malformed === 'invalid-time' ? 'not-a-time' : new Date().toISOString() };
        else { data = state.sessions.find(s => s.id === body.p_session_id); data.status = 'ended'; data.ended_at = new Date().toISOString(); }
        if (state.malformed === 'multiple') data = [data, { ...data, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
        else if (state.arrayAck) data = [data];
      } else if (url.pathname === '/rest/v1/sessions') {
        if (request.method() === 'POST') { const row = { ...body, status: 'active', created_at: new Date().toISOString() }; state.sessions.unshift(row); data = [row]; }
        else data = state.sessions.filter(s => (!url.searchParams.get('id') || s.id === url.searchParams.get('id').slice(3)) && (!url.searchParams.get('companion_id') || s.companion_id === url.searchParams.get('companion_id').slice(3)) && (!url.searchParams.get('status') || s.status === url.searchParams.get('status').slice(3)));
      } else if (url.pathname === '/rest/v1/analyses') data = state.analyses.filter(row => !url.searchParams.get('session_id') || row.session_id === url.searchParams.get('session_id').slice(3));
      else if (url.pathname === '/rest/v1/transcript_events') data = [...state.events.values()].filter(e => !url.searchParams.get('session_id') || e.session_id === url.searchParams.get('session_id').slice(3));
      await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
    } catch (e) { state.routes.push(e.message); await route.fulfill({ status: 500, json: { message: 'Fixture error' } }); }
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#start-call').click(); await page.locator('#end-call').waitFor({ state: 'visible' });
  const emit = event => page.evaluate(event => window.testPeer.dc.onmessage({ data: JSON.stringify(event) }), event);
  await emit({ type: 'response.done', response: { status: 'completed' } });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'saved-user', transcript: 'Please save what I said.' });
  await until(() => state.events.size === 1, 'initial speech is stored');
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
  return { context, page, state, emit, async close() { state.finishGate?.release.resolve(); state.appendGate?.release.resolve(); state.reviewGate?.release.resolve(); assert.deepEqual(state.errors, []); assert.deepEqual(state.routes, []); await context.close(); } };
}
try {
  // The minimum sound window must not be reported as server storage duration.
  {
    const h = await harness(), { page, state } = h; state.reviewGate = gate();
    await page.evaluate(() => { window.testPeer.dc.readyState = 'closed'; document.getElementById('end-call').click(); });
    await until(() => state.finishCalls === 1 && state.sessions[0].status === 'ended', 'fast server finish completes');
    assert.equal(await page.locator('body').getAttribute('data-call-phase'), 'ending');
    await page.clock.fastForward(590); assert.equal(await page.locator('#review-panel').isVisible(), false, 'the short end cue still has its minimum window');
    await page.clock.fastForward(20); await until(() => page.locator('#review-panel').isVisible(), 'fast acknowledgement opens review after the cue');
    await milestone(state.reviewGate.started.promise, 'feedback is independent of completed storage');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'session-record-title', 'automatic completion announces the source conversation');
    assert(await page.locator('[data-transcript-events]').isVisible(), 'automatic completion immediately exposes the source conversation');
    assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'transcript');
    await openTranscript(page);
    const duration = await page.locator('[data-call-save-duration]').textContent(); assert.match(duration, /0\.0\s*초/, 'measured ACK duration excludes the 600ms display floor');
    await page.clock.fastForward(5000); assert.equal(await page.locator('[data-call-save-duration]').textContent(), duration, 'feedback delay never extends the completed save measurement');
    await h.close();
  }
  // Slow ACK never blocks the received conversation or starts feedback early.
  {
    const h = await harness(), { page, state } = h; state.finishGate = gate(); state.reviewGate = gate(); state.arrayAck = true;
    await page.evaluate(() => document.getElementById('end-call').click());
    assert.equal(await page.evaluate(() => window.testPeer.input.readyState), 'ended');
    await page.clock.fastForward(1900); await milestone(state.finishGate.started.promise, 'final drain reaches held finish acknowledgement');
    assert(await page.locator('#review-panel').isVisible(), 'received conversation is visible before server finish');
    assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'transcript');
    assert.equal(state.reviews, 0, 'feedback never starts before the transcript and finish acknowledgements');
    assert.equal(await page.locator('[data-call-save-duration]:not([hidden])').count(), 0, 'pending save has no successful duration');
    assert.match(await page.locator('#session-review-footer').innerText(), /확인|저장/);
    const sourceScroll = await page.evaluate(() => scrollY);
    state.finishGate.release.resolve(); state.finishGate = null;
    await until(() => page.locator('[data-call-save-duration]:not([hidden])').count(), 'actual acknowledgement updates storage evidence');
    assert.equal(await page.evaluate(() => scrollY), sourceScroll, 'save acknowledgement preserves the source position');
    await milestone(state.reviewGate.started.promise, 'feedback remains held after saved review opens');
    await openTranscript(page);
    assert.match(await page.locator('[data-call-save-duration]').textContent(), /1\.9\s*초/);
    assert.equal(state.finishCalls, 1); await h.close();
  }
  // Long writes keep the source readable and offer an exit without pretending storage succeeded.
  {
    const h = await harness(), { page, state, emit } = h; state.appendGate = gate(); state.finishGate = gate();
    await page.evaluate(() => document.getElementById('end-call').click());
    await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-user', transcript: 'This arrives after I hang up.' });
    await milestone(state.appendGate.started.promise, 'late speech reaches the held append');
    await page.clock.fastForward(3100);
    assert.equal(state.finishCalls, 0, 'finish never races unacknowledged transcript writes');
    await until(() => page.locator('[data-transcript-events]').isVisible(), 'source appears automatically during slow saving');
    assert.equal(state.reviews, 0, 'feedback does not race pending transcript writes');
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/save-completion-waiting.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 568 });
    const escapeBox = await page.locator('#session-review-exit').boundingBox();
    assert(escapeBox && escapeBox.y >= 0 && escapeBox.y + escapeBox.height <= 568, 'the 320px exit stays inside the visible viewport');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the 320px save state has no horizontal overflow');
    await page.screenshot({ path: 'test-results/save-completion-waiting-320.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.locator('#review-panel').isVisible(), 'source stays readable while storage continues');
    assert.match(await page.locator('[data-post-call-transcript]').innerText(), /This arrives after I hang up\./);
    assert.equal(await page.locator('[data-call-save-duration]:not([hidden])').count(), 0, 'pending storage has no invented completion time');
    assert.match(await page.locator('[data-transcript-status]').innerText(), /전사|저장.*확인|대기|마지막 대화/);
    await page.locator('#session-review-exit').click(); assert(await page.locator('#contacts-panel').isVisible()); assert(await page.locator('#start-call').isDisabled());
    state.appendGate.release.resolve(); state.appendGate = null; await milestone(state.finishGate.started.promise, 'drained writes proceed to finish');
    state.finishGate.release.resolve(); state.finishGate = null;
    await until(() => page.locator('#start-call').isEnabled(), 'server finish releases the old call');
    assert(await page.locator('#contacts-panel').isVisible(), 'late save must not pull the user away from home'); assert.equal(state.events.size, 2); await h.close();
  }
  // Feedback readiness changes only the reserved footer, not what the learner
  // is reading or where they are. A useful observed strength needs no correction.
  {
    const h = await harness(), { page, state, emit } = h; state.reviewGate = gate(); state.reviewSuccess = true;
    for (let i = 0; i < 24; i++) await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'long-user-' + i, transcript: `I enjoyed the quiet cafe and told my friend about our afternoon. This is conversation turn ${i + 1}.` });
    await until(() => state.events.size === 25, 'long source is durably stored');
    await page.evaluate(() => document.getElementById('end-call').click()); await page.clock.fastForward(2000);
    await milestone(state.reviewGate.started.promise, 'feedback waits behind the explicit generation gate');
    await openTranscript(page); await page.evaluate(() => scrollTo(0, 520));
    const position = await page.evaluate(() => scrollY), footer = await page.locator('#session-review-footer').boundingBox();
    assert(position > 0, 'the source is long enough to exercise reading position');
    state.reviewGate.release.resolve();
    await until(() => page.locator('#session-feedback-open').isVisible(), 'ready feedback offers an explicit button');
    assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'transcript', 'readiness never navigates automatically');
    assert.equal(await page.evaluate(() => scrollY), position, 'feedback readiness preserves the exact reading position');
    assert.deepEqual(await page.locator('#session-review-footer').boundingBox(), footer, 'pending and ready occupy the same reserved area');
    await page.locator('#session-feedback-open').click(); await page.clock.runFor(20);
    assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'feedback');
    assert.match(await page.locator('#session-feedback-content').innerText(), /하고 싶은 말을 직접 요청했어요/);
    assert.doesNotMatch(await page.locator('#session-feedback-content').innerText(), /한 번 말해보기|혼자 말해보기|오늘은 여기까지/);
    await page.locator('#session-transcript-back').click(); await page.clock.runFor(20);
    assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'transcript');
    assert.equal(await page.evaluate(() => scrollY), position, 'returning from feedback restores the source position');
    await h.close();
  }
  // A transport failure or an acknowledgement without the correct call, ended
  // status and valid completion time must not create a successful measurement.
  for (const malformed of [false, 'wrong-session', 'active', 'invalid-time', 'multiple']) {
    const h = await harness(), { page, state } = h; state.malformed = malformed; state.failFinish = !malformed;
    await page.evaluate(() => document.getElementById('end-call').click()); await page.clock.fastForward(2000);
    await until(() => page.locator('#review-panel').isVisible(), 'save failure opens the recoverable result');
    await openTranscript(page);
    await until(() => page.locator('[data-transcript-storage-detail]').textContent().then(value => /미완료|확인하지 못/.test(value)), 'failed finish remains visibly incomplete');
    assert.equal(await page.locator('[data-call-save-duration]:not([hidden])').count(), 0); assert.match(await page.locator('[data-transcript-storage-detail]').textContent(), /미완료|확인하지 못/);
    assert.equal(state.sessions[0].status, 'active'); assert.equal(state.reviews, 0); assert.match(await page.locator('[data-post-call-transcript]').innerText(), /Please save what I said\./); await h.close();
  }
  console.log('9 save-completion browser cases PASS: measured ACK excludes cue/feedback; source opens before object/single-row ACK; slow storage keeps transcript and exit available; feedback readiness preserves scroll/footer and opens separately; transport failure and invalid session/status/time/multiple-row ACK remain incomplete. Fixture timings are not production averages.');
} finally { await browser.close(); server.kill('SIGTERM'); }
