// Real browser UI, microphone tracks and local persistence. Authentication,
// WebRTC/provider events and the diagnostic API are fixtures; this does not
// claim to validate production audio quality or identify the original VOC code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 49444, base = `http://127.0.0.1:${port}`;
const project = 'https://voice-reliability-test.supabase.co', uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessions = [], saved = new Map(), diagnostics = [], errors = [], routeErrors = [];
let checkpoints = 0;
const policy = { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true };
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe'
});
await new Promise((resolve, reject) => {
  server.stdout.once('data', resolve); server.once('error', reject);
  server.once('exit', code => reject(Error('Fixture server exited: ' + code)));
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const eventually = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(label);
};
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.testMessages = []; window.testPeers = []; window.testTracks = [];
    window.fixture = { settings: 'hold', deletions: 'hold' };
    window.RTCPeerConnection = class {
      constructor() { window.testPeer = this; window.testPeers.push(this); this.connectionState = 'new'; this.tracks = []; }
      addTrack(track) { this.tracks.push(track); window.testTracks.push(track); }
      emit(event) { this.dc.onmessage?.({ data: JSON.stringify(event) }); }
      createDataChannel() {
        return this.dc = { readyState: 'open', send: raw => {
          const event = JSON.parse(raw); window.testMessages.push({ ...event, peer: window.testPeers.indexOf(this) });
          if (event.type === 'session.update' && event.session?.instructions && window.fixture.settings === 'auto') {
            queueMicrotask(() => this.emit({ type: 'session.updated', session: { instructions: event.session.instructions } }));
          }
          if (event.type === 'conversation.item.delete' && window.fixture.deletions === 'auto') {
            queueMicrotask(() => this.emit({ type: 'conversation.item.deleted', item_id: event.item_id }));
          }
          if (event.type === 'input_audio_buffer.commit') {
            queueMicrotask(() => {
              this.emit({ type: 'input_audio_buffer.committed', item_id: 'final-fixture-turn' });
              this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'final-fixture-turn', transcript: 'One last fixture thought.' });
            });
          }
        } };
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.dc.onopen?.(); }
      close() { this.connectionState = 'closed'; this.dc.readyState = 'closed'; }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/public-config.js', route => route.fulfill({ contentType: 'text/javascript',
    body: `globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({ url: project, key: 'sb_publishable_fixture' })};` }));
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : {};
    try {
      let data = [];
      if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
      else if (url.pathname === '/auth/v1/user') data = { id: uid };
      else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
      else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
      else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
      else if (url.pathname.endsWith('/coach/memory-prepare')) data = { status: 'unavailable' };
      else if (url.pathname.endsWith('/coach/voice')) data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
      else if (url.pathname.endsWith('/coach/checkpoint')) { checkpoints++; data = { instructions: 'Trusted fixture checkpoint ' + checkpoints }; }
      else if (url.pathname.endsWith('/coach/review')) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'No model output in fixture.' } } });
      else if (url.pathname.endsWith('/rpc/record_call_diagnostics')) {
        const rows = body.p_events || body.events || []; diagnostics.push(...rows);
        data = { event_ids: rows.map(row => row.id || row.event_id) };
      } else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null,
        feedback: sessions.filter(s => s.companion_id === body.p_companion_id).map(s => ({ session_id: s.id, current: false, job_state: 'not_requested',
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
        else data = sessions.filter(s => (!url.searchParams.get('id') || s.id === url.searchParams.get('id').slice(3)) &&
          (!url.searchParams.get('companion_id') || s.companion_id === url.searchParams.get('companion_id').slice(3)) &&
          (!url.searchParams.get('status') || s.status === url.searchParams.get('status').slice(3)));
      } else if (url.pathname === '/rest/v1/transcript_events') data = [...saved.values()].filter(e =>
        !url.searchParams.get('session_id') || e.session_id === url.searchParams.get('session_id').slice(3)).map(e => ({ ...e, timestamp: e.occurred_at }));
      await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
    } catch (error) { routeErrors.push(error.message); await route.fulfill({ status: 500, json: { message: 'Fixture route failure.' } }); }
  });
  const emit = event => page.evaluate(event => window.testPeer.emit(event), event);
  const microphoneLive = () => page.evaluate(() => window.testPeer.tracks.every(track => track.enabled && track.readyState === 'live'));
  const deletes = () => page.evaluate(() => window.testMessages.filter(e => e.type === 'conversation.item.delete'));
  const updates = () => page.evaluate(() => window.testMessages.filter(e => e.type === 'session.update' && e.session?.instructions));
  const start = async () => {
    if (await page.locator('#session-review-exit').isVisible()) await page.locator('#session-review-exit').click();
    await page.locator('[data-view="contacts"]').click(); await page.locator('#start-call').click();
    await eventually(() => page.evaluate(() => document.body.dataset.callPhase === 'connected'), 'fixture call should connect');
    await emit({ type: 'session.created', session: { instructions: 'Speak English. Fixture persona.', audio: { input: { turn_detection: policy } } } });
    await emit({ type: 'response.done', response: { status: 'completed', usage: { input_tokens: 100 } } });
  };
  const addItems = async prefix => { for (let i = 0; i < 10; i++) await emit({ type: 'conversation.item.created', item: { id: prefix + i } }); };
  const settingsAck = event => emit({ type: 'session.updated', session: { instructions: event.session.instructions } });
  const deleteAck = event => emit({ type: 'conversation.item.deleted', item_id: event.item_id });
  const highUsage = () => emit({ type: 'response.done', response: { status: 'completed', usage: { input_tokens: 19000 } } });
  const utterance = async id => {
    await emit({ type: 'input_audio_buffer.speech_started' }); await emit({ type: 'input_audio_buffer.speech_stopped' });
    await emit({ type: 'input_audio_buffer.committed', item_id: id });
    await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'Our conversation continues normally.' });
    await emit({ type: 'response.created', response: { id: 'response-' + id } }); await emit({ type: 'output_audio_buffer.started' });
  };
  const finish = async () => {
    const id = sessions[0].id;
    await emit({ type: 'response.done', response: { status: 'completed', usage: { input_tokens: 100 } } });
    await emit({ type: 'output_audio_buffer.stopped' }); await page.locator('#end-call').click(); await page.clock.runFor(2500);
    await eventually(() => page.evaluate(() => window.testPeer.connectionState === 'closed'), 'hangup should close the peer');
    return sessions.find(s => s.id === id);
  };
  await page.goto(base);
  await page.evaluate(({ project, uid }) => localStorage.setItem('loop.auth:' + project, JSON.stringify({ access_token: 'fixture-jwt', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid } })), { project, uid });
  await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await page.clock.install();
  await start(); await addItems('context-');
  await page.clock.fastForward(10 * 60 * 1000 + 1);
  await emit({ type: 'response.done', response: { status: 'completed', usage: { input_tokens: 200 } } }); await page.clock.runFor(1000);
  assert.equal(checkpoints, 0, 'ten minutes alone must never interrupt a low-token conversation for compaction');
  assert.equal(await microphoneLive(), true); assert.equal(await page.locator('#notice').textContent(), '');

  await highUsage(); await page.clock.runFor(1000);
  await eventually(async () => (await updates()).length === 1, 'token pressure should request checkpoint settings');
  const firstUpdate = (await updates())[0]; assert(firstUpdate.event_id, 'checkpoint settings must be traceable');
  assert.equal(checkpoints, 1); assert.equal((await deletes()).length, 0, 'deletion must wait for the matching settings ACK');
  await emit({ type: 'session.updated', session: { instructions: 'Unrelated settings ACK' } });
  assert.equal((await deletes()).length, 0, 'an unrelated settings ACK cannot permit deletion');
  await settingsAck(firstUpdate);
  await eventually(async () => (await deletes()).length === 4, 'only items older than the retained six should be requested for deletion');
  const firstDeletes = await deletes(); assert(firstDeletes.every(event => event.event_id));
  assert.equal(new Set(firstDeletes.map(event => event.event_id)).size, 4);
  await deleteAck(firstDeletes[0]);
  await emit({ type: 'error', error: { event_id: firstDeletes[1].event_id, code: 'invalid_request_error', message: 'Fixture deletion rejected.' } });
  assert.equal(await microphoneLive(), false, 'compaction must keep waiting while other deletion receipts remain unconfirmed');
  await deleteAck(firstDeletes[2]); assert.equal(await microphoneLive(), false);
  await deleteAck(firstDeletes[3]);
  await eventually(microphoneLive, 'a rejected item deletion must restore input after the remaining requests settle');
  assert.equal(await page.locator('#notice').textContent(), '', 'a command rejection must not become a connection warning');
  assert.equal(await page.locator('#live-call').isVisible(), true);
  await page.clock.fastForward(61000); await page.evaluate(() => { window.fixture.settings = 'auto'; window.fixture.deletions = 'auto'; });
  await highUsage(); await page.clock.runFor(1500);
  await eventually(async () => (await deletes()).length === 5 && await microphoneLive(), 'retry must confirm the previously rejected item');
  const retriedDeletes = await deletes();
  assert.deepEqual(retriedDeletes.slice(4).map(event => event.item_id), ['context-1'], 'only an unconfirmed item may be retried');
  for (const index of [0, 2, 3]) assert.equal(retriedDeletes.filter(event => event.item_id === 'context-' + index).length, 1, 'confirmed deletions must not be repeated');

  // The one-minute maintenance throttle cannot postpone recovery after a real
  // provider context limit, including immediately after a successful checkpoint.
  await addItems('urgent-context-');
  const recoveryCheckpoints = checkpoints, recoveryDeletes = (await deletes()).length;
  const recoveryStarted = await page.evaluate(() => Date.now());
  await emit({ type: 'response.done', response: { status: 'failed', status_details: { type: 'failed', error: { code: 'context_length_exceeded' } }, usage: { input_tokens: 200 } } });
  await page.clock.runFor(1500);
  await eventually(async () => checkpoints === recoveryCheckpoints + 1 && (await deletes()).length > recoveryDeletes && await microphoneLive(),
    'a real context limit must bypass the maintenance cooldown and recover immediately');
  assert(await page.evaluate(started => Date.now() - started < 60000, recoveryStarted), 'recovery must finish before the normal sixty-second cooldown');
  assert.equal(await page.locator('#notice').textContent(), '', 'acknowledged context recovery should keep the call unobstructed');

  await emit({ type: 'error', error: { event_id: 'unknown-command-fixture', code: 'invalid_request_error', message: 'Fixture nonfatal provider command error.' } });
  await utterance('after-rejection'); await eventually(() => Promise.resolve(saved.size === 1), 'normal transcription should still reach the server');
  assert.equal(await microphoneLive(), true); assert.equal(await page.locator('#notice').textContent(), '');
  assert.match(await page.locator('#call-status').textContent(), /말하고 있어요/);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/voice-reliability-continued.png', fullPage: true });
  const firstEnded = await finish(); assert.equal(firstEnded.status, 'ended', 'nonfatal command errors must not poison the transcription completion flag');
  await eventually(() => Promise.resolve(diagnostics.some(row => row.kind === 'provider_error' && row.code === 'invalid_request_error' && row.request_type === 'conversation.item.delete') &&
    diagnostics.some(row => row.kind === 'provider_error' && row.code === 'invalid_request_error' && row.request_type === 'unknown')), 'both tracked and unknown provider errors should reach diagnostics');
  assert.doesNotMatch(JSON.stringify(diagnostics), /Fixture deletion rejected|Fixture nonfatal provider command error|Our conversation continues normally/,
    'diagnostics must not contain provider message text or conversation content');

  await start(); await addItems('timeout-'); await page.evaluate(() => { window.fixture.settings = 'hold'; });
  const beforeUpdates = (await updates()).length, beforeDeletes = (await deletes()).length;
  await highUsage(); await page.clock.runFor(1000);
  await eventually(async () => (await updates()).length === beforeUpdates + 1, 'a new high-token call should request its own checkpoint settings');
  assert.equal(await microphoneLive(), false);
  await page.clock.runFor(8500); await eventually(microphoneLive, 'a missing settings ACK must restore microphone input after timeout');
  assert.equal((await deletes()).length, beforeDeletes, 'unacknowledged instructions must never delete live context');
  assert.equal(await page.locator('#notice').textContent(), '', 'background compaction timeout must not tell a connected caller to restart');
  await utterance('after-timeout');
  assert.equal((await finish()).status, 'ended', 'settings ACK timeout must not mark received speech as lost');
  await eventually(() => Promise.resolve(diagnostics.some(row => row.kind === 'request_timeout' && row.request_type === 'session.update')), 'the settings timeout must also reach diagnostics');

  await start();
  await page.evaluate(() => { window.testPeer.connectionState = 'disconnected'; window.testPeer.onconnectionstatechange(); });
  assert.equal(await microphoneLive(), false); assert.match(await page.locator('#notice').textContent(), /연결/);
  await page.screenshot({ path: 'test-results/voice-reliability-disconnected.png', fullPage: true });
  await page.evaluate(() => { window.testPeer.connectionState = 'connected'; window.testPeer.onconnectionstatechange(); });
  assert.equal(await microphoneLive(), true); assert.equal(await page.locator('#notice').textContent(), '');
  await emit({ type: 'input_audio_buffer.committed', item_id: 'real-asr-failure' });
  await emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'real-asr-failure', error: { code: 'audio_unintelligible', message: 'Fixture ASR failure.' } });
  assert.match(await page.locator('#notice').textContent(), /전사|기록/);
  assert.equal((await finish()).status, 'active', 'a genuine ASR failure must still retain partial status');
  await eventually(() => page.locator('#post-call-transcript').textContent().then(text => /일부|확인 필요/.test(text)), 'the partial call should offer truthful recovery guidance');
  await page.setViewportSize({ width: 320, height: 568 }); await page.screenshot({ path: 'test-results/voice-reliability-partial-320.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []); assert.deepEqual(routeErrors, []);
  await writeFile('test-results/voice-reliability-result.json', JSON.stringify({ fixture: true, checkpoints, contextLimitCooldownBypassed: true,
    sessions: sessions.map(s => ({ id: s.id, status: s.status })), diagnosticCount: diagnostics.length,
    deletionRequests: retriedDeletes.map(event => ({ item: event.item_id, eventId: event.event_id })) }, null, 2));
  console.log('PASS: ten-minute low-token calls stay uninterrupted; compaction waits for matching settings/deletion receipts, retries only unconfirmed items, bypasses the cooldown for a real context limit, recovers from timeout, records command errors without false warnings/partial completion, and preserves real disconnection/ASR failure guidance. Provider and diagnostic transports are fixtures.');
  await context.close();
} finally { await browser.close(); server.kill('SIGTERM'); }
