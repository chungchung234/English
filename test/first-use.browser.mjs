// Real UI, WebAudio nodes, microphone tracks and IndexedDB. Auth, WebRTC and
// provider/backend transports are fixtures; these are lifecycle assertions,
// not a judgment of real conversation or subjective sound quality.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = Number(process.env.FIRST_USE_TEST_PORT||49209), project = 'https://call-transition-test.supabase.co', uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base=`http://127.0.0.1:${port}`;
const sessions = [], saved = new Map(), finishes = [], errors = [], routeErrors = [];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let historyGate=null,historyFailure=false,activeUser=uid,auditAnalysis=null;
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
      if(url.pathname==='/auth/v1/user')data={id:activeUser};
      else if (url.pathname === '/auth/v1/settings') data = { external: { google: false, kakao: false } };
      else if (url.pathname.endsWith('/coach/config')) data = { models: { voice: 'fixture' } };
      else if (url.pathname.endsWith('/coach/memory-manage')) data = { revision: 0, facts: [], excluded_sessions: [], history_suppressed: false };
      else if (url.pathname.endsWith('/coach/memory')) data = { memories: [] };
      else if (url.pathname.endsWith('/coach/voice')) {
        const gate = voiceGate; if (gate) { gate.started.resolve(); await gate.release.promise; }
        if (failVoice) return route.fulfill({ status: 503, json: { error: { code: 'VOICE_UNAVAILABLE', message: 'Fixture connection unavailable.' } } });
        data = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
      } else if (url.pathname.endsWith('/coach/review')) {
        const row=[...saved.values()].find(e=>e.session_id===body.sessionId&&e.speaker==='user');
        auditAnalysis={id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',session_id:body.sessionId,kind:'session',content:{corrections:[{original:row.text,improved:'I went for a walk.',reason:'지난 일에는 과거형을 써요.',category:'error',evidence_ids:[row.id]}]}};
        data={analysis:auditAnalysis};
      } else if(url.pathname==='/rest/v1/analyses')data=auditAnalysis?[auditAnalysis]:[];
      else if (url.pathname.endsWith('/rpc/learning_snapshot')) data = { items: [], recommended_item_ids: [], next_plan: null, feedback: sessions.map(s => ({ session_id: s.id, current: Boolean(auditAnalysis), job_state: auditAnalysis?'succeeded':'not_requested', has_user_speech: [...saved.values()].some(e => e.session_id === s.id && e.speaker === 'user') })) };
      else if (url.pathname.endsWith('/rpc/learning_enhancement_snapshot')) data = { reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} };
      else if (url.pathname.endsWith('/rpc/learning_record_event')) data = { saved: true };
      else if (url.pathname.endsWith('/rpc/append_events')) {
        const gate = appendGate; if (gate) { gate.started.resolve(); await gate.release.promise; }
        for (const event of body.p_events) saved.set(event.id, { ...event, session_id: body.p_session_id, timestamp: event.occurred_at });
        data = { inserted: body.p_events.length, event_ids: body.p_events.map(e => e.id) };
      } else if (url.pathname.endsWith('/rpc/finish_session')) {
        finishes.push(body.p_session_id); data = sessions.find(s => s.id === body.p_session_id); data.status = 'ended'; data.ended_at = new Date().toISOString();
      } else if (url.pathname === '/rest/v1/sessions') {
        if(request.method()==='GET'&&historyGate)await historyGate.release.promise;
        if(request.method()==='GET'&&historyFailure)return route.fulfill({status:503,json:{message:'fixture history unavailable'}});
        if (request.method() === 'POST') { const row = { ...body, status: 'active', created_at: new Date().toISOString() }; sessions.unshift(row); data = [row]; }
        else data = sessions.filter(s => (!url.searchParams.get('id') || s.id === url.searchParams.get('id').slice(3)) && (!url.searchParams.get('companion_id') || s.companion_id === url.searchParams.get('companion_id').slice(3)) && (!url.searchParams.get('status') || s.status === url.searchParams.get('status').slice(3)));
      } else if (url.pathname === '/rest/v1/transcript_events') data = [...saved.values()].filter(e => !url.searchParams.get('session_id') || e.session_id === url.searchParams.get('session_id').slice(3));
      await route.fulfill({ json: data, headers: Array.isArray(data) ? { 'Content-Range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'Access-Control-Expose-Headers': 'Content-Range' } : {} });
    } catch (error) { routeErrors.push(error.message); await route.fulfill({ status: 500, json: { message: 'Fixture transport failed.' } }); }
  });

  await context.addInitScript(()=>{
    const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.micMode='normal';window.micRequests=0;window.auditStreams=[];
    navigator.mediaDevices.getUserMedia=async options=>{
      window.micRequests++;
      if(window.micMode==='denied')throw new DOMException('Permission denied','NotAllowedError');
      const stream=await gum(options);window.auditStreams.push(stream);
      if(window.micMode==='delayed')await new Promise(resolve=>window.releaseMic=resolve);
      return stream;
    };
  });
  const out=process.env.FIRST_USE_SCREENSHOT_DIR||'test-results/first-use';await mkdir(out,{recursive:true});
  const shot=name=>page.screenshot({path:`${out}/${name}.png`,animations:'disabled'});
  await page.goto(base);
  await page.evaluate(({project,uid})=>localStorage.setItem('loop.auth:'+project,JSON.stringify({access_token:'fixture',refresh_token:'fixture',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}})),{project,uid});
  historyGate={release:defer()};await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
  await page.locator('[data-view="history"]').click();await page.locator('#history-loading').waitFor({state:'visible'});
  assert.equal(await page.locator('#history').getAttribute('aria-busy'),'true');assert.equal(await page.locator('#history-first-call').isVisible(),false);await shot('01-history-loading');
  historyGate.release.resolve();historyGate=null;await page.locator('#history .empty-state').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#history').getAttribute('aria-busy')==='false');assert.equal(await page.locator('#history-loading').isVisible(),false);
  await page.locator('#history-first-call').click();await page.locator('#first-use-intro').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>micRequests),0);await shot('02-first-home');
  await page.setViewportSize({width:320,height:568});assert(await page.locator('#start-call').evaluate(n=>n.getBoundingClientRect().bottom<=document.querySelector('.glass-dock').getBoundingClientRect().top));await shot('10-first-home-compact');await page.setViewportSize({width:390,height:844});
  await page.locator('#usage-guide-open').click();assert(await page.locator('#usage-guide').isVisible());assert.match(await page.locator('#guide-title').innerText(),/친구/);await shot('03-friend-guide');
  await page.locator('#guide-next').click();assert.match(await page.locator('#guide-title').innerText(),/통화/);assert.equal(await page.evaluate(()=>micRequests),0);await shot('04-call-guide');
  await page.setViewportSize({width:320,height:568});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert(await page.locator('#guide-next').evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}));await shot('05-guide-compact');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#usage-guide').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'usage-guide-open');
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await page.locator('#first-use-intro').isVisible(),false,'skip persists for this account');
  activeUser='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';await page.evaluate(({project,id})=>localStorage.setItem('loop.auth:'+project,JSON.stringify({access_token:'fixture',refresh_token:'fixture',expires_at:Math.floor(Date.now()/1000)+3600,user:{id}})),{project,id:activeUser});
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert(await page.locator('#first-use-intro').isVisible(),'another account has independent guidance');
  await page.locator('#account-open').click();await page.locator('#usage-guide-replay').click();assert(await page.locator('#usage-guide').isVisible());await page.locator('#guide-skip').click();assert.equal(await page.locator('#account-dialog').isVisible(),false);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>micMode='denied');await page.locator('#start-call').click();await page.locator('#call-help').waitFor({state:'visible'});
  assert.match(await page.locator('#call-help-copy').innerText(),/사이트 설정/);assert.doesNotMatch(await page.locator('#call-help').innerText(),/Permission denied/);assert.equal(sessions.length,0);assert(await page.locator('#call-help-retry').evaluate(n=>n.getBoundingClientRect().bottom<document.querySelector('.glass-dock').getBoundingClientRect().top));await shot('06-microphone-recovery');
  await page.evaluate(()=>micMode='delayed');await page.locator('#call-help-retry').click();await page.waitForFunction(()=>typeof releaseMic==='function');await page.locator('#cancel-connection').click();
  await page.evaluate(()=>releaseMic());await page.waitForFunction(()=>auditStreams.at(-1).getTracks().every(t=>t.readyState==='ended'));
  assert.equal(sessions.length,0,'late microphone grant cannot create a session after cancel');assert(await page.locator('#start-call').isEnabled());
  await page.evaluate(()=>micMode='denied');await page.locator('#start-call').click();await page.locator('#call-help').waitFor({state:'visible'});
  const requestsBeforeGuide=await page.evaluate(()=>micRequests);await page.locator('#usage-guide-open').click();await page.locator('#guide-next').click();
  assert(await page.locator('#start-call').isVisible(),'guide from an error restores its actual call target');assert.equal(await page.evaluate(()=>micRequests),requestsBeforeGuide);await page.locator('#guide-skip').click();
  await page.evaluate(()=>micMode='normal');
  voiceGate={started:defer(),release:defer()};const cancelledGate=voiceGate;
  await page.locator('#start-call').click();await milestone(cancelledGate.started.promise,'voice request is held');await shot('07-cancellable-connection');
  const oldPeer=await page.evaluate(()=>{window.oldPeer=testPeer;return testPeer.connectionState});assert.equal(oldPeer,'new');
  await page.locator('#cancel-connection').click();assert(await page.locator('#start-call').isEnabled());
  assert(await page.evaluate(()=>oldPeer.input.readyState==='ended'));
  voiceGate={started:defer(),release:defer()};const currentGate=voiceGate;await page.evaluate(()=>autoReady=true);
  await page.locator('#start-call').click();await milestone(currentGate.started.promise,'new request after cancel');currentGate.release.resolve();voiceGate=null;
  await page.waitForFunction(()=>document.body.dataset.callPhase==='connected');cancelledGate.release.resolve();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('body').getAttribute('data-call-phase'),'connected');assert.equal(await page.locator('#cancel-connection').isVisible(),false);
  assert(await page.evaluate(()=>oldPeer!==testPeer&&oldPeer.connectionState==='closed'&&testPeer.connectionState==='connected'));
  assert.equal(await page.locator('#first-use-intro').isVisible(),false,'successful connection dismisses first-call copy');
  await page.evaluate(()=>testPeer.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'first-use-utterance',transcript:'I go for a walk.'})}));
  await page.waitForFunction(()=>document.querySelector('#turn-count').textContent==='1개 발화');
  await page.locator('#end-call').click();await page.locator('#post-call-transcript').waitFor({state:'visible'});
  await page.locator('#session-feedback-open').waitFor({state:'visible'});await page.locator('#session-feedback-open').click();
  assert(await page.locator('#first-note-guide').isVisible());await shot('09-first-learning-note');
  await page.locator('#first-note-dismiss').click();assert.equal(await page.locator('#first-note-guide').isVisible(),false);assert(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('loop.first-use:v1:')).some(k=>JSON.parse(localStorage.getItem(k)).noteRead===true)));
  await page.locator('#session-review-exit').click();
  await page.locator('[data-view="history"]').click();await page.waitForFunction(()=>document.querySelector('#history').getAttribute('aria-busy')==='false');
  const existing=await page.locator('#history').innerText();historyFailure=true;await page.locator('#refresh-history').click();await page.locator('#history-load-retry').waitFor({state:'visible'});
  assert.equal(await page.locator('#history').innerText(),existing,'refresh failure preserves existing history');assert.equal(await page.locator('#history-loading').isVisible(),false);await shot('08-refresh-recovery');
  historyFailure=false;await page.locator('#history-load-retry').click();await page.waitForFunction(()=>document.querySelector('#history').getAttribute('aria-busy')==='false');assert.equal(await page.locator('#history-load-retry').isVisible(),false);
  assert.deepEqual(errors,[]);assert.deepEqual(routeErrors,[]);
  console.log('PASS: delayed loading/empty/retry states; optional guide has no mic side effects, ESC/focus, compact layout and account-scoped persistence; permission recovery; late microphone and voice responses after cancel cannot revive a call; immediate retry remains isolated.');
}finally{await browser.close();server.kill('SIGTERM');}
