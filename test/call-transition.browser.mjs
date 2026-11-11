// Real UI, WebAudio nodes, microphone tracks and IndexedDB. Auth, WebRTC and
// provider/backend transports are fixtures; these are lifecycle assertions,
// not a judgment of real conversation or subjective sound quality.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 49202, project = 'https://call-transition-test.supabase.co', uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessions = [], saved = new Map(), finishes = [], errors = [], routeErrors = [];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let voiceGate = { started: defer(), release: defer() }, appendGate = null, failVoice = false;
async function milestone(promise, label) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(label);
}
const policy = { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true };
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Static server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.audioContexts = []; window.audioNodes = []; window.testMessages = []; window.testTracks = []; window.liveDraws = 0;
    const NativeAudio = window.AudioContext;
    window.AudioContext = class extends NativeAudio {
      constructor(...args) { if (window.blockAudio) throw Error('Fixture audio unavailable'); super(...args); window.audioContexts.push(this); }
      createOscillator() { const node = super.createOscillator(); const record = { node, context: this, started: false, stopped: false }; window.audioNodes.push(record);
        const start = node.start.bind(node), stop = node.stop.bind(node); node.start = (...args) => { record.started = true; return start(...args); }; node.stop = (...args) => { record.stopped = true; return stop(...args); }; return node; }
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const value = getContext.call(this, type, ...args);
      if (this.id === 'live-avatar' && type === 'webgl' && value && !value.transitionProbe) {
        value.transitionProbe = true; const draw = value.drawArrays.bind(value); value.drawArrays = (...args) => { window.liveDraws++; return draw(...args); };
      }
      return value;
    };
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; }
      addTrack(track) { window.testTracks.push(track); this.input = track; }
      createDataChannel() { return this.dc = { readyState: 'connecting', send: raw => {
        const event = JSON.parse(raw); window.testMessages.push(event);
        if (event.type === 'input_audio_buffer.commit') {
          this.dc.onmessage?.({ data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'last-turn' }) });
          setTimeout(() => this.dc.onmessage?.({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-turn', transcript: 'One last thought after hangup.' }) }), 200);
        }
      } }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() {
        this.descriptionApplied = true;
        const remote = new MediaStream([this.input.clone()]); this.remote = remote; this.ontrack?.({ streams: [remote], track: remote.getTracks()[0] });
        if (window.autoReady) { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.readyState = 'open'; this.dc.onopen?.(); }
      }
      close() { this.connectionState = 'closed'; this.dc.readyState = 'closed'; this.remote?.getTracks().forEach(track => track.stop()); }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : {};
    if(url.pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}}); // Background delivery is outside this fixture's scope.
    try {
      let data = [];
      if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
      else if (url.pathname === '/auth/v1/user') data = { id: uid };
      else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
      else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
      else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
      else if (url.pathname.endsWith('/coach/voice')) {
        const gate = voiceGate; if (gate) { gate.started.resolve(); await gate.release.promise; }
        if (failVoice) return route.fulfill({ status: 503, json: { error: { code: 'VOICE_UNAVAILABLE', message: 'Fixture connection unavailable.' } } });
        data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
      } else if (url.pathname.endsWith('/coach/review')) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'No model feedback in fixture.' } } });
      else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null, feedback: sessions.map(s => ({ session_id: s.id, current: false, job_state: 'not_requested', has_user_speech: [...saved.values()].some(e => e.session_id === s.id && e.speaker === 'user') })) };
      else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
      else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
      else if (url.pathname.endsWith('/rpc/append_events')) {
        const gate = appendGate; if (gate) { gate.started.resolve(); await gate.release.promise; }
        for (const event of body.p_events) saved.set(event.id, { ...event, session_id: body.p_session_id, timestamp: event.occurred_at });
        data = { inserted: body.p_events.length, event_ids: body.p_events.map(e => e.id) };
      } else if (url.pathname.endsWith('/rpc/finish_session')) {
        finishes.push(body.p_session_id); data = sessions.find(s => s.id === body.p_session_id); data.status = 'ended'; data.ended_at = new Date().toISOString();
      } else if (url.pathname === '/rest/v1/sessions') {
        if (request.method() === 'POST') { const row = { ...body, status: 'active', created_at: new Date().toISOString() }; sessions.unshift(row); data = [row]; }
        else data = sessions.filter(s => (!url.searchParams.get('id') || s.id === url.searchParams.get('id').slice(3)) && (!url.searchParams.get('companion_id') || s.companion_id === url.searchParams.get('companion_id').slice(3)) && (!url.searchParams.get('status') || s.status === url.searchParams.get('status').slice(3)));
      } else if (url.pathname === '/rest/v1/transcript_events') data = [...saved.values()].filter(e => !url.searchParams.get('session_id') || e.session_id === url.searchParams.get('session_id').slice(3));
      await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
    } catch (error) { routeErrors.push(error.message); await route.fulfill({ status: 500, json: { message: 'Fixture transport failed.' } }); }
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
  const emit = event => page.evaluate(event => window.testPeer.dc.onmessage({ data: JSON.stringify(event) }), event);
  const phase = () => page.locator('body').getAttribute('data-call-phase');
  await page.locator('#start-call').click();
  await page.waitForFunction(() => window.testPeer?.dc);
  await milestone(voiceGate.started.promise, 'voice request reaches the held provider response');
  assert.equal(await phase(), 'connecting');
  assert.equal(await page.locator('#call-timer').textContent(), '00:00');
  for (const id of ['mute-call', 'speed-call', 'hint-call']) assert(await page.locator('#' + id).isDisabled(), 'connection preparation locks ' + id);
  assert(await page.evaluate(() => window.testTracks.length > 0 && window.testTracks.every(track => !track.enabled)), 'pending microphone tracks do not transmit connecting cues');
  await page.waitForFunction(() => window.audioNodes.some(record => record.started));
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/call-transition-connecting.png', fullPage: true });
  voiceGate.release.resolve(); voiceGate = null;
  await page.waitForFunction(() => window.testPeer.descriptionApplied);
  await page.evaluate(() => { window.testPeer.connectionState = 'connected'; window.testPeer.onconnectionstatechange(); });
  assert.equal(await phase(), 'connecting', 'RTC alone does not claim the data channel is ready');
  assert.equal(await page.evaluate(() => window.testMessages.filter(event => event.type === 'response.create').length), 0);
  const ready = await page.evaluate(() => {
    window.testPeer.dc.readyState = 'open'; window.testPeer.dc.onopen();
    return { phase: document.body.dataset.callPhase, enabled: window.testTracks.every(track => track.enabled), greetings: window.testMessages.filter(event => event.type === 'response.create').length };
  });
  assert.deepEqual(ready, { phase: 'connected', enabled: true, greetings: 1 }, 'readiness takes effect synchronously without a simulated ringing delay');
  await page.evaluate(() => { window.testPeer.dc.onopen(); window.testPeer.onconnectionstatechange(); });
  assert.equal(await page.evaluate(() => window.testMessages.filter(event => event.type === 'response.create').length), 1, 'duplicate ready events never greet twice');
  await page.waitForFunction(() => window.audioNodes.every(record => record.context.state === 'closed'));
  await emit({ type: 'session.created', session: { instructions: 'Speak briefly in English. Fixture only.', audio: { input: { turn_detection: policy } } } });
  await emit({ type: 'response.done', response: { status: 'completed' } });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first-user', transcript: 'I would like to talk for a moment.' });
  await page.waitForFunction(() => document.querySelector('#turn-count').textContent === '1개 발화');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '저장 완료');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
  const starts = await page.evaluate(() => window.audioNodes.length); await page.clock.fastForward(4000);
  assert.equal(await page.evaluate(() => window.audioNodes.length), starts, 'connected calls never restart the connecting pulse');
  appendGate = { started: defer(), release: defer() };
  await emit({ type: 'input_audio_buffer.speech_started' });
  const frozenClock = await page.locator('#call-timer').textContent();
  await page.evaluate(() => document.getElementById('end-call').click());
  assert.equal(await phase(), 'ending');
  assert.equal(await page.locator('#call-status').textContent(), '통화가 종료됐어요');
  assert.equal(await page.locator('#review-panel').isVisible(), false, 'end cue retains the call view for its short transition');
  assert(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), 'microphone stops before the end transition');
  assert(await page.evaluate(() => document.querySelector('#remote-audio').paused && !document.querySelector('#remote-audio').srcObject), 'remote audio is detached synchronously');
  assert(await page.evaluate(() => ['.live-actions', '.transcript-details'].every(selector => document.querySelector(selector).inert)), 'call controls including transcript disclosure are inert');
  assert(await page.locator('#end-call').isDisabled());
  assert.equal(await page.locator('#hold-call').isVisible(), false, 'the removed hold control is not offered');
  const draws = await page.evaluate(() => window.liveDraws);
  await emit({ type: 'output_audio_buffer.started' });
  await page.clock.fastForward(300);
  assert.equal(await phase(), 'ending');
  assert.equal(await page.locator('#call-status').textContent(), '통화가 종료됐어요', 'late provider state cannot revive the ended call');
  assert.equal(await page.locator('#call-timer').textContent(), frozenClock);
  assert.equal(await page.evaluate(() => window.liveDraws), draws, 'avatar drawing is stopped throughout the ended frame');
  assert(await page.evaluate(() => window.audioNodes.length > 0 && window.audioNodes.some(record => record.context.state !== 'closed')), 'end cue uses real WebAudio nodes');
  await page.screenshot({ path: 'test-results/call-transition-ending.png', fullPage: true });
  assert.equal(finishes.length, 0, 'UI transition does not skip final speech collection');
  await page.clock.fastForward(350);
  await page.locator('#review-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'), 'transcript');
  assert(await page.locator('[data-transcript-events]').isVisible(), 'the short cue exposes received source without a manual escape');
  assert.equal(await page.locator('[data-call-save-duration]:not([hidden])').count(), 0, 'the cue never claims that server storage is finished');
  await page.clock.fastForward(2500);
  await eventually(() => page.locator('[data-post-call-transcript]').innerText().then(text => text.includes('One last thought after hangup.')), 'late transcription appears before storage acknowledgement');
  await milestone(appendGate.started.promise, 'late transcription reaches the held append request');
  assert.equal(finishes.length, 0, 'reading the source never acknowledges pending server writes');
  assert.equal(await page.evaluate(() => window.testMessages.filter(event => event.type === 'response.create').length), 1, 'late speech after hangup does not trigger another reply');
  await eventually(() => page.evaluate(() => window.audioContexts.every(audio => audio.state === 'closed')), 'all cue and presence contexts close');
  appendGate.release.resolve(); appendGate = null;
  await page.clock.fastForward(200);
  await eventually(() => page.evaluate(() => window.testPeer.connectionState === 'closed'), 'parallel finalization closes the peer');
  assert.equal(finishes.length, 1); assert.equal([...saved.values()].length, 2, 'the final utterance is saved once');
  await page.clock.resume();
  console.log('PASS: real pending connection cues, two-part readiness, no artificial connect delay, and one greeting.');
  console.log('PASS: immediate microphone/audio/control/avatar stop, short ended frame, automatic transcript reading and parallel late-transcript preservation.');

  await page.locator('#session-review-exit').click(); failVoice = true;
  await page.locator('#start-call').click(); await page.locator('#contacts-panel').waitFor({ state: 'visible' });
  assert(await page.locator('#start-call').isEnabled());
  await eventually(() => page.evaluate(() => window.audioContexts.every(audio => audio.state === 'closed')), 'all cue and presence contexts close');
  assert(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), 'failed connections release all microphone tracks');
  failVoice = false; await page.evaluate(() => { window.blockAudio = true; window.autoReady = true; });
  await page.locator('#call-help-retry').click(); await page.waitForFunction(() => document.body.dataset.callPhase === 'connected');
  assert(await page.locator('#end-call').isEnabled(), 'unavailable cue audio never blocks the call');
  const beforeClosed = finishes.length;
  await page.evaluate(() => { window.testPeer.dc.readyState = 'closed'; window.testPeer.dc.onclose(); window.testPeer.dc.onclose(); });
  assert.equal(await phase(), 'ending', 'a closed data channel immediately ends the visible call');
  await page.locator('#review-panel').waitFor({ state: 'visible', timeout: 1500 });
  await eventually(() => page.evaluate(() => window.testPeer.connectionState === 'closed'), 'parallel finalization closes the peer');
  assert.equal(finishes.length, beforeClosed + 1, 'duplicate data-channel closure saves once');
  assert.deepEqual(errors, []); assert.deepEqual(routeErrors, []);
  console.log('PASS: failed connection cleanup/retry, silent AudioContext fallback, and idempotent data-channel closure.');
  await context.close();
} finally { await browser.close(); server.kill('SIGTERM'); }
