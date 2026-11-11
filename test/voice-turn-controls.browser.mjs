// Real UI/microphone tracks/IndexedDB; authentication, provider events and the
// backend are explicit local fixtures. This checks protocol/UI integration,
// not the quality of real speech recognition or the model's turn prediction.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const port = Number(process.env.VOICE_FLOOR_TEST_PORT || 4198), base = `http://127.0.0.1:${port}`, project = 'https://voice-floor-test.supabase.co';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessions = [], saved = [], errors = [];
const policy = { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true };
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.testMessages = []; window.testTracks = []; window.clearsAcked = 0;
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack(track) { window.testTracks.push(track); }
      createDataChannel() { return this.dc = { readyState: 'open', send: raw => {
        const event = JSON.parse(raw); window.testMessages.push(event);
        if (event.type === 'input_audio_buffer.commit') {
          if (window.emptyFinalCommit) {
            this.dc.onmessage({ data: JSON.stringify({ type: 'error', error: { event_id: event.event_id, code: 'input_audio_buffer_commit_empty' } }) }); return;
          }
          this.dc.onmessage({ data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'last-user' }) });
          setTimeout(() => this.dc.onmessage({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-user', transcript: 'My final thought is saved.' }) }), 10);
        }
      } }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.onopen?.(); }
      close() { this.connectionState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : {};
    if(url.pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}}); // Background delivery is outside this fixture's scope.
    let data = [];
    if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
    else if (url.pathname === '/auth/v1/user') data = { id: uid };
    else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
    else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
    else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
    else if (url.pathname.endsWith('/coach/voice')) data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
    else if (url.pathname.endsWith('/coach/review')) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'No model fixture output' } } });
    else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null, feedback: sessions.map(s => ({ session_id: s.id, current: false, job_state: 'not_requested', has_user_speech: saved.some(e => e.session_id === s.id && e.speaker === 'user') })) };
    else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
    else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
    else if (url.pathname.endsWith('/rpc/append_events')) { for (const event of body.p_events) if (!saved.some(e => e.id === event.id)) saved.push({ ...event, session_id: body.p_session_id }); data = { inserted: body.p_events.length, event_ids: body.p_events.map(e => e.id) }; }
    else if (url.pathname.endsWith('/rpc/finish_session')) { data = sessions.find(s => s.id === body.p_session_id); data.status = 'ended'; data.ended_at = new Date().toISOString(); }
    else if (url.pathname === '/rest/v1/sessions') { if (request.method() === 'POST') { const row = { ...body, status: 'active', created_at: new Date().toISOString() }; sessions.push(row); data = [row]; } else data = sessions; }
    else if (url.pathname === '/rest/v1/transcript_events') data = saved.map(e => ({ ...e, timestamp: e.occurred_at }));
    await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
  });
  const emit = event => page.evaluate(event => window.testPeer.dc.onmessage({ data: JSON.stringify(event) }), event);
  const replies = () => page.evaluate(() => window.testMessages.filter(e => e.type === 'response.create').length);
  await page.goto(base);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture-jwt', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await page.locator('#start-call').click();
  await page.locator('#end-call').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#hold-call').count(), 0, 'removed manual wait control does not remain in the DOM');
  assert.equal(await page.locator('#call-local-time,#call-memory-context').count(), 0, 'live call avoids wall-clock and memory receipt clutter');
  await emit({ type: 'session.created', session: { instructions: 'Speak English. Honor spoken requests to wait or continue. Fixture instructions.', audio: { input: { turn_detection: policy } } } });
  await emit({ type: 'response.created', response: { id: 'greeting' } }); await emit({ type: 'response.done', response: { id: 'greeting', status: 'completed' } });
  assert.equal(await page.evaluate(() => window.testTracks.every(track => track.enabled)), true);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/voice-conversation-390.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => {
    window.floorScaledText = [...document.querySelectorAll('#live-call h1,#live-call p,#live-call button,#live-call summary,#live-call summary span')]
      .map(element => ({ element, original: element.style.fontSize, size: parseFloat(getComputedStyle(element).fontSize) }));
    window.floorScaledText.forEach(({ element, size }) => element.style.fontSize = `${size * 1.25}px`);
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'simplified live view fits compact width with enlarged text');
  assert(await page.locator('#end-call').evaluate(button => { const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'hangup stays reachable with enlarged text');
  assert(await page.locator('#live-call').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('#end-call').getBoundingClientRect().top), 'compact scroll region ends above fixed hangup');
  await page.evaluate(() => { const live = document.querySelector('#live-call'); live.scrollTop = live.scrollHeight; });
  assert(await page.locator('.transcript-details').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('#end-call').getBoundingClientRect().top), 'transcript remains readable above fixed hangup after scrolling');
  await page.screenshot({ path: 'test-results/voice-conversation-320-large-text.png' });
  await page.evaluate(() => { window.floorScaledText.forEach(({ element, original }) => element.style.fontSize = original); document.querySelector('#live-call').scrollTop = 0; scrollTo(0, 0); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mute-call').click(); assert.equal(await page.evaluate(() => window.testTracks.every(track => !track.enabled)), true);
  await page.locator('#mute-call').click(); assert.equal(await page.evaluate(() => window.testTracks.every(track => track.enabled)), true);
  const before = await replies();
  const policyUpdatesBefore = await page.evaluate(() => window.testMessages.filter(event => event.type === 'session.update' && event.session?.audio?.input).length);
  for (const [id, text] of [['u1', 'Please give me a moment to think.'], ['u2', 'I am ready to continue.']]) {
    await emit({ type: 'input_audio_buffer.speech_started' });
    await emit({ type: 'input_audio_buffer.speech_stopped' });
    await emit({ type: 'input_audio_buffer.committed', item_id: id });
    await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
  }
  assert.equal(await page.locator('#transcript li').count(), 2, 'spoken wait/continue requests survive capture without an extra control');
  assert.equal(await page.evaluate(() => window.testMessages.filter(event => event.type === 'session.update' && event.session?.audio?.input).length), policyUpdatesBefore, 'spoken intent remains provider conversation input, not a fabricated client policy switch');
  assert.equal(await page.locator('#hint-call').isDisabled(), true, 'pending response prevents a competing hint');
  await page.evaluate(() => document.querySelector('#hint-call').onclick()); assert.equal(await replies(), before);
  await emit({ type: 'response.created', response: { id: 'cancelled' } });
  await emit({ type: 'response.output_item.added', response_id: 'cancelled', item: { id: 'cancelled-item' } });
  await emit({ type: 'response.done', response: { id: 'cancelled', status: 'cancelled' } });
  await emit({ type: 'response.output_audio_transcript.done', response_id: 'cancelled', item_id: 'cancelled-item', transcript: 'This cancelled answer was never played.' });
  assert.equal(await page.locator('#transcript li').count(), 2, 'unheard cancelled output remains excluded');
  await emit({ type: 'input_audio_buffer.speech_started' }); await page.locator('#end-call').click();
  await page.waitForFunction(() => window.testPeer.connectionState === 'closed');
  assert.equal(sessions[0].status, 'ended', 'completed capture permits acknowledged finish');
  assert(saved.some(e => e.text === 'My final thought is saved.'), 'speaking audio is committed and saved on hangup');
  const finalConfig = await page.evaluate(() => window.testMessages.filter(e => e.type === 'session.update' && e.session?.audio?.input).at(-1).session.audio.input.turn_detection);
  assert.deepEqual(finalConfig, { ...policy, create_response: false, interrupt_response: false });
  assert.equal(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), true);
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  const another = async () => {
    await page.locator('#session-review-exit').click(); await page.locator('#start-call').click(); await page.locator('#end-call').waitFor({ state: 'visible' });
    await emit({ type: 'session.created', session: { instructions: 'Speak English.', audio: { input: { turn_detection: policy } } } });
    await emit({ type: 'response.created', response: { id: 'greeting' } }); await emit({ type: 'response.done', response: { id: 'greeting', status: 'completed' } });
  };
  await another();
  await emit({ type: 'input_audio_buffer.speech_started' }); await emit({ type: 'input_audio_buffer.speech_stopped' });
  const commitsBefore = await page.evaluate(() => window.testMessages.filter(e => e.type === 'input_audio_buffer.commit').length);
  await page.locator('#end-call').click();
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(sessions[1].status, 'active', 'stopped speech with pending semantic commit cannot finish after the initial drain');
  assert.equal(await page.evaluate(() => window.testMessages.filter(e => e.type === 'input_audio_buffer.commit').length), commitsBefore, 'hangup must not duplicate the VAD commit already pending');
  await emit({ type: 'input_audio_buffer.committed', item_id: 'late-commit' });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-commit', transcript: 'This turn commits later.' });
  await page.waitForFunction(() => window.testPeer.connectionState === 'closed');
  assert.equal(sessions[1].status, 'ended'); assert(saved.some(e => e.text === 'This turn commits later.'));
  await page.waitForFunction(() => !document.querySelector('[data-view="contacts"]').disabled);
  await another(); await page.evaluate(() => window.emptyFinalCommit = true);
  await emit({ type: 'input_audio_buffer.speech_started' }); await page.locator('#end-call').click();
  await emit({ type: 'input_audio_buffer.committed', item_id: 'already-committed' });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'already-committed', transcript: 'The VAD committed this before the final request.' });
  await page.waitForFunction(() => window.testPeer.connectionState === 'closed');
  assert.equal(sessions[2].status, 'ended', 'empty duplicate final commit does not invalidate received and saved ASR');
  assert(saved.some(e => e.text === 'The VAD committed this before the final request.'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []); await context.close();
  console.log('4 voice browser groups PASS: removed manual wait/time clutter and 390/320 enlarged-text layout; microphone and spoken wait/continue capture; hint/cancelled-output safety; final/delayed/duplicate commits on hangup. Provider behavior is fixture-only; manual engine races remain covered by voice-turn-controls.test.mjs.');
} finally { await browser.close(); server.kill('SIGTERM'); }
