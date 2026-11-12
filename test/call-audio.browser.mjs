// Real browser controls, microphone tracks and account-scoped diagnostics.
// Provider configuration, interruption events and diagnostic HTTP are fixtures;
// these assertions do not establish acoustic noise suppression effectiveness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 49445, base = `http://127.0.0.1:${port}`, project = 'https://call-audio-test.supabase.co';
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let activeUser = userA;
const sessions = [], saved = new Map(), diagnostics = [], diagnosticDeliveries = [], voiceRequests = [], errors = [], routeErrors = [];
const policy = { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true };
const eventually = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(label);
};
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe'
});
await new Promise((resolve, reject) => {
  server.stdout.once('data', resolve); server.once('error', reject);
  server.once('exit', code => reject(Error('Fixture server exited: ' + code)));
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    window.legacyMicrophoneReads = [];
    Storage.prototype.getItem = function (key) {
      if (String(key).startsWith('loop.microphone-mode:')) window.legacyMicrophoneReads.push(key);
      return getItem.call(this, key);
    };
    const settings = MediaStreamTrack.prototype.getSettings;
    MediaStreamTrack.prototype.getSettings = function () {
      return { ...settings.call(this), echoCancellation: true, noiseSuppression: true, autoGainControl: false,
        deviceId: 'fixture-private-device', groupId: 'fixture-private-group', label: 'fixture-private-label' };
    };
    window.testMessages = []; window.testTracks = [];
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; this.connectionState = 'new'; this.tracks = []; }
      addTrack(track) { this.tracks.push(track); window.testTracks.push(track); }
      emit(event) { this.dc.onmessage?.({ data: JSON.stringify(event) }); }
      createDataChannel() {
        return this.dc = { readyState: 'open', send: raw => {
          const event = JSON.parse(raw); window.testMessages.push(event);
          if (event.type === 'input_audio_buffer.commit') queueMicrotask(() => {
            this.emit({ type: 'input_audio_buffer.committed', item_id: 'final-fixture-input' });
            this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'final-fixture-input', transcript: 'One final fixture thought.' });
          });
        } };
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.onopen?.(); }
      close() { this.connectionState = 'closed'; this.dc.readyState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript',
    body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : {};
    try {
      let data = [];
      if (url.pathname === '/auth/v1/user') data = { id: activeUser };
      else if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
      else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
      else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
      else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
      else if (url.pathname.endsWith('/coach/memory-prepare')) data = { status: 'unavailable' };
      else if (url.pathname.endsWith('/coach/voice')) {
        voiceRequests.push(body);
        data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', audio_policy: {
          microphone_mode: 'unknown', expected_noise_reduction: 'far_field', turn_detection: policy } };
      } else if (url.pathname.endsWith('/coach/review')) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'No model output in fixture.' } } });
      else if (url.pathname.endsWith('/rpc/record_call_diagnostics')) {
        const rows = body.p_events || [], owner = request.headers().authorization?.replace('Bearer fixture-jwt-', '');
        assert(rows.every(row => sessions.find(session => session.id === row.session_id)?.user_id === owner), 'diagnostic delivery must stay with its authenticated account');
        diagnosticDeliveries.push({ owner, count: rows.length }); diagnostics.push(...rows); data = { event_ids: rows.map(row => row.event_id) };
      } else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null,
        feedback: sessions.filter(s => s.user_id === activeUser && s.companion_id === body.p_companion_id).map(s => ({ session_id: s.id, current: false, job_state: 'not_requested',
          has_user_speech: [...saved.values()].some(e => e.session_id === s.id && e.speaker === 'user') })) };
      else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
      else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
      else if (url.pathname.endsWith('/rpc/append_events')) {
        for (const event of body.p_events) saved.set(event.id, { ...event, session_id: body.p_session_id });
        data = { inserted: body.p_events.length, event_ids: body.p_events.map(event => event.id) };
      } else if (url.pathname.endsWith('/rpc/finish_session')) {
        data = sessions.find(s => s.id === body.p_session_id); data.status = 'ended'; data.ended_at = new Date().toISOString();
      } else if (url.pathname === '/rest/v1/sessions') {
        if (request.method() === 'POST') { const row = { ...body, status: 'active', created_at: new Date().toISOString() }; sessions.unshift(row); data = [row]; }
        else data = sessions.filter(s => s.user_id === activeUser && (!url.searchParams.get('id') || s.id === url.searchParams.get('id').slice(3)) &&
          (!url.searchParams.get('companion_id') || s.companion_id === url.searchParams.get('companion_id').slice(3)));
      } else if (url.pathname === '/rest/v1/transcript_events') data = [...saved.values()].filter(e =>
        !url.searchParams.get('session_id') || e.session_id === url.searchParams.get('session_id').slice(3)).map(e => ({ ...e, timestamp: e.occurred_at }));
      await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
    } catch (error) { routeErrors.push(error.message); await route.fulfill({ status: 500, json: { message: 'Fixture route failure.' } }); }
  });
  const loginAs = async uid => {
    activeUser = uid;
    await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture-jwt-' + uid, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#workspace').waitFor({ state: 'visible' });
  };
  const emit = event => page.evaluate(event => window.testPeer.emit(event), event);
  const openSettings = async () => {
    if (await page.locator('#session-review-exit').isVisible()) await page.locator('#session-review-exit').click();
    await page.locator('[data-view="contacts"]').click();
    await page.locator('#account-open').click(); await page.locator('#account-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#microphone-settings,[name="microphone-mode"]').count(), 0, 'browser calls must not expose a nonexistent speakerphone/headset mode selector');
  };
  const closeSettings = () => page.locator('[data-close="account-dialog"]').click();
  const start = async () => {
    if (await page.locator('#session-review-exit').isVisible()) await page.locator('#session-review-exit').click();
    await page.locator('[data-view="contacts"]').click(); await page.locator('#start-call').click();
    await eventually(() => page.evaluate(() => document.body.dataset.callPhase === 'connected'), 'fixture call should connect');
  };
  const finish = async () => {
    await emit({ type: 'response.done', response: { id: 'cleanup-response', status: 'completed' } });
    await emit({ type: 'output_audio_buffer.stopped' });
    await page.locator('#end-call').click();
    await eventually(() => page.evaluate(() => window.testPeer.connectionState === 'closed'), 'fixture call should end');
    assert.equal(sessions[0].status, 'ended');
  };

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ project, userA, userB }) => {
    localStorage.setItem('loop.microphone-mode:' + project + '|' + userA, 'headset');
    localStorage.setItem('loop.microphone-mode:' + project + '|' + userB, 'speakerphone');
  }, { project, userA, userB });
  await loginAs(userA);
  await openSettings();
  assert.doesNotMatch(await page.locator('#account-dialog').innerText(), /스피커폰|이어폰·헤드셋|마이크 사용 환경/);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/call-audio-browser-390.png', fullPage: true });
  await closeSettings(); await start();
  assert.equal(Object.hasOwn(voiceRequests.at(-1), 'microphoneMode'), false, 'old saved preferences must not add a microphoneMode field to voice requests');
  assert.deepEqual(await page.evaluate(() => window.legacyMicrophoneReads), [], 'the app must not read removed microphone preferences');
  await emit({ type: 'session.created', session: { audio: { input: { noise_reduction: { type: 'far_field' }, turn_detection: policy } } } });
  await emit({ type: 'session.updated', session: { audio: { output: { speed: .85 } } } });
  await eventually(() => Promise.resolve(diagnostics.some(row => row.kind === 'audio_configuration' && row.audio_context?.requested_mode === 'unknown' && row.audio_context?.effective_noise === 'far_field' &&
    row.audio_context?.vad_type === 'semantic_vad' && row.audio_context?.interrupt_response === 'on')), 'effective provider configuration should reach diagnostics');
  await eventually(() => Promise.resolve(diagnostics.some(row => row.audio_context?.capture_echo === 'on' && row.audio_context?.capture_noise === 'on' &&
    row.audio_context?.capture_gain === 'off')), 'capture processing flags should reach diagnostics');

  await emit({ type: 'response.created', response: { id: 'fixture-private-provider-response' } });
  await emit({ type: 'output_audio_buffer.started', response_id: 'fixture-private-provider-response' });
  const localCancels = await page.evaluate(() => window.testMessages.filter(event => event.type === 'response.cancel').length);
  await emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(await page.evaluate(() => window.testMessages.filter(event => event.type === 'response.cancel').length), localCancels,
    'a speech-start observation must never independently send a local cancel');
  assert.match(await page.locator('#call-status').textContent(), /말하고 있어요/, 'speech detection alone is not proof that AI playback stopped');
  await eventually(() => Promise.resolve(diagnostics.some(row => row.code === 'SPEECH_DURING_OUTPUT' && row.audio_context?.output_state === 'playing')), 'speech/output overlap should be observable');
  await emit({ type: 'response.done', response: { id: 'fixture-private-provider-response', status: 'cancelled', status_details: { reason: 'turn_detected' } } });
  await emit({ type: 'output_audio_buffer.cleared', response_id: 'fixture-private-provider-response' });
  await eventually(() => Promise.resolve(diagnostics.some(row => row.code === 'AUDIO_RESPONSE_CANCELLED' && row.audio_context?.cancel_origin === 'provider_turn_detected')), 'a provider cancellation receipt should identify turn-detected provenance');
  assert.equal(await page.evaluate(() => window.testMessages.filter(event => event.type === 'response.cancel').length), localCancels);
  await emit({ type: 'input_audio_buffer.speech_stopped' }); await emit({ type: 'input_audio_buffer.committed', item_id: 'fixture-user-turn' });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fixture-user-turn', transcript: 'Please keep our conversation natural.' });
  const previousNotice = await page.locator('#notice').textContent();
  await emit({ type: 'response.created', response: { id: 'fixture-private-truncated-response' } });
  await emit({ type: 'response.done', response: { id: 'fixture-private-truncated-response', status: 'incomplete', status_details: { type: 'incomplete', reason: 'max_output_tokens' } } });
  await eventually(() => Promise.resolve(diagnostics.some(row => row.code === 'RESPONSE_MAX_OUTPUT_TOKENS' && row.request_type === 'response.create')), 'a confirmed generation cap must be observable separately from voice cancellation');
  assert.equal(await page.locator('#notice').textContent(), previousNotice, 'a token cap receipt must not invent a connection warning');
  assert.equal(await page.locator('#end-call').isEnabled(), true);
  await emit({ type: 'response.done', response: { id: 'fixture-private-completed-response', status: 'completed', status_details: { reason: 'max_output_tokens' } } });
  assert.equal(diagnostics.filter(row => row.code === 'RESPONSE_MAX_OUTPUT_TOKENS').length, 1, 'only an actual incomplete receipt confirms truncation');
  await finish();

  await openSettings(); await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('#account-dialog').evaluate(root => {
    for (const node of root.querySelectorAll('h2,h3,p,label,button')) node.style.fontSize = parseFloat(getComputedStyle(node).fontSize) * 1.25 + 'px';
  });
  await page.locator('#usage-guide-replay').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'account-memory', 'remaining account controls must stay usable from the keyboard');
  await page.locator('#account-memory').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert(await page.locator('#account-dialog').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }));
  await page.screenshot({ path: 'test-results/call-audio-browser-320.png', fullPage: true });
  await page.locator('#logout').scrollIntoViewIfNeeded();
  assert(await page.locator('#logout').evaluate(node => {
    const box = node.getBoundingClientRect(), dialog = document.querySelector('#account-dialog').getBoundingClientRect();
    return box.top >= dialog.top && box.bottom <= dialog.bottom && box.bottom <= innerHeight;
  }), 'account controls below the initial compact viewport must remain reachable by scrolling');
  await closeSettings(); await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(userA); await openSettings();
  await closeSettings(); await start();
  assert.equal(Object.hasOwn(voiceRequests.at(-1), 'microphoneMode'), false);
  assert.deepEqual(await page.evaluate(() => window.legacyMicrophoneReads), [], 'revisiting with an old headset preference must not reintroduce mode selection');
  await emit({ type: 'session.created', session: { audio: { input: { noise_reduction: { type: 'far_field' }, turn_detection: policy } } } });
  await eventually(() => Promise.resolve(diagnostics.some(row => row.session_id === sessions[0].id && row.audio_context?.requested_mode === 'unknown' &&
    row.audio_context?.expected_noise === 'far_field' && row.audio_context?.effective_noise === 'far_field')), 'browser input filtering must not imply a known device/output route');
  await finish();
  await loginAs(userB); await openSettings();
  await closeSettings(); await start();
  assert.equal(Object.hasOwn(voiceRequests.at(-1), 'microphoneMode'), false);
  assert.deepEqual(await page.evaluate(() => window.legacyMicrophoneReads), []);
  await emit({ type: 'session.created', session: { audio: { input: { noise_reduction: { type: 'far_field' }, turn_detection: policy } } } });
  await eventually(() => Promise.resolve(diagnosticDeliveries.some(delivery => delivery.owner === userB && delivery.count > 0)), 'a second account should receive only its own diagnostic delivery');
  await finish();
  await loginAs(userA); await openSettings();
  assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-private|Please keep our conversation natural|deviceId|groupId|label/);
  assert(voiceRequests.every(request => !Object.hasOwn(request, 'microphoneMode')));
  assert.deepEqual(await page.evaluate(() => window.legacyMicrophoneReads), []);
  assert.deepEqual(errors, []); assert.deepEqual(routeErrors, []);
  await writeFile('test-results/call-audio-result.json', JSON.stringify({ fixture: true, microphoneModeFieldSent: false, legacyPreferenceRead: false,
    diagnosticCount: diagnostics.length, kinds: [...new Set(diagnostics.map(row => row.kind))], acousticEffectivenessVerified: false }, null, 2));
  console.log('PASS: browser microphone has no artificial mode selector, old preferences are never read or transmitted, account controls remain usable at 390/320px, unknown-route audio diagnostics stay private and account-scoped, and speech detection alone neither cancels playback nor changes the speaking display. Actual noise suppression quality is not measured.');
  await context.close();
} finally { await browser.close(); server.kill('SIGTERM'); }
