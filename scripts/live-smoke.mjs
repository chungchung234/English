// Actual deployed-release acceptance using temporary confirmed accounts and
// synthetic microphone speech. Runtime credentials and transcripts stay private.
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

class SmokeError extends Error {}
const companions = [
  { id: 'alex', name: 'Alex', voice: 'cedar' },
  { id: 'mia', name: 'Mia', voice: 'marin' },
  { id: 'juno', name: 'Juno', voice: 'verse' },
];
const ensure = (condition, message) => { if (!condition) throw new SmokeError(message); };
const pass = message => console.log(`::notice title=Live release check::${message}`);

export function sanitizeStatus(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, '[credential]')
    .replace(/\b(?:sk-|sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/g, '[credential]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[credential]')
    .replace(/https?:\/\/[^\s]+/g, '[URL]')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, '[email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[identifier]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[private value]').slice(0, 280);
}

export function verifyEvidence(content, events) {
  const users = new Map(events.filter(event => event.speaker === 'user').map(event => [event.id, event]));
  for (const key of ['strengths', 'corrections', 'practice', 'patterns', 'memory_facts']) {
    for (const item of content[key] || []) {
      ensure(Array.isArray(item.evidence_ids) && item.evidence_ids.length > 0 && item.evidence_ids.every(id => users.has(id)), 'Feedback contains an unsupported evidence reference.');
      if (key === 'memory_facts') ensure(typeof item.quote === 'string' && item.quote.length > 0 && item.evidence_ids.some(id => users.get(id).text.includes(item.quote)), 'Memory fact quotation does not match saved user speech.');
      if (key === 'corrections') ensure(typeof item.original === 'string' && item.original.length > 0 && item.evidence_ids.some(id => users.get(id).text.includes(item.original)), 'Correction quotation does not match saved user speech.');
    }
  }
}

export function verifyMemory(memory, profile, sessions, events) {
  ensure(memory.companionId === profile.id && Array.isArray(memory.memories) && memory.memories.length > 0, 'Companion learning memory was not retrieved.');
  const ownedSessions = new Set(sessions.filter(session => session.companion_id === profile.id).map(session => session.id));
  for (const item of memory.memories) {
    ensure(ownedSessions.has(item.session_id), 'Memory crossed a companion boundary.');
    const ownEvents = events.filter(event => event.session_id === item.session_id);
    const ids = new Set(ownEvents.map(event => event.id));
    ensure(Array.isArray(item.source_event_ids) && item.source_event_ids.every(id => ids.has(id)), 'Memory evidence crossed a companion boundary.');
    verifyEvidence(item, ownEvents);
  }
}

async function main() {
  const ref = process.env.SUPABASE_PROJECT_REF || 'domkmxmwmihcfadophfg';
  const base = `https://${ref}.supabase.co`, site = process.env.SITE_URL;
  if (!site || !process.env.SUPABASE_ACCESS_TOKEN || !process.env.SMOKE_AUDIO) throw new SmokeError('Live smoke needs site URL, provider authorization and synthetic audio.');
  const origin = new URL(site).origin;
  async function json(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) }); }
    catch { throw new SmokeError('A release-check provider request could not be completed.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new SmokeError(`Release-check ${options.method || 'GET'} request failed with HTTP ${response.status}.`);
    return data;
  }
  let browser, page, stage = 'provider configuration', lastStatus = {};
  const created = [];
  let adminHeaders;
  async function statusSnapshot() {
    if (!page || page.isClosed()) return lastStatus;
    // These are the only UI values allowed in diagnostics. Never inspect browser
    // storage, request/response bodies, console messages, or transcript text.
    const statuses = {};
    for (const selector of ['#notice', '#call-status', '#save-status']) {
      statuses[selector] = sanitizeStatus(await page.locator(selector).textContent({ timeout: 2000 }).catch(() => 'unavailable'));
    }
    lastStatus = statuses;
    return statuses;
  }
  try {
    const keys = await json(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` } });
    const publicKey = keys.find(key => key.name === 'anon')?.api_key || keys.find(key => key.type === 'publishable')?.api_key;
    const serviceKey = keys.find(key => key.name === 'service_role')?.api_key;
    ensure(publicKey && serviceKey, 'Provider public/admin keys are required for isolated release checks.');
    adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    const userRequest = (user, path, body) => json(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: publicKey, Authorization: `Bearer ${user.access_token}`, Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    stage = 'temporary account authentication';
    const users = [];
    for (let i = 0; i < 2; i++) {
      const email = `voice-smoke-${randomUUID()}@example.invalid`, password = randomUUID() + randomUUID();
      const user = await json(base + '/auth/v1/admin/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true }) });
      // Preserve the ID even if the following password grant fails.
      created.push(user.id);
      users.push(await json(base + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }));
    }
    const [learner, other] = users;
    pass('Two temporary email-verified test accounts authenticated against live Supabase.');
    // Private installations must never grant synthetic users access just to test voice.
    const approval = await userRequest(learner, '/rest/v1/rpc/is_approved_user', {});
    if (approval === false) {
      stage = 'private access enforcement';
      for (const user of users) {
        for (const table of [
          'sessions','transcript_events','analyses','memory_state','memory_fact_overrides','memory_session_exclusions',
          'learning_state_items','learning_feedback','learning_sources','learning_source_holds','learning_actions',
          'learning_practice_days','learning_daily','learning_visits','learning_next_plans','learning_events',
          'learning_reviews','learning_schedules','learning_recalls','learning_usage_targets','learning_usage_observations',
          'learning_weekly_goals','learning_weekly_versions','learning_enhancement_actions','learning_enhancement_imports',
        ]) {
          ensure((await userRequest(user, '/rest/v1/' + table + '?select=*')).length === 0, 'Unapproved account can read data.');
        }
        for (const [endpoint, body] of [
          ['/rest/v1/sessions', {scenario:'Must be denied'}],
          ['/rest/v1/rpc/append_events', {p_session_id:randomUUID(),p_events:[]}],
          ['/rest/v1/rpc/finish_session', {p_session_id:randomUUID()}],
          ['/rest/v1/rpc/restore_history', {p_backup:{sessions:[],events:[]}}],
          ['/rest/v1/rpc/learning_snapshot', {p_companion_id:'alex'}],
          ['/rest/v1/rpc/learning_enhancement_snapshot', {p_companion_id:'alex'}],
          ['/rest/v1/rpc/learning_review_submit', {p_item_id:randomUUID(),p_expected_revision:1,p_action_id:randomUUID(),p_source_analysis_id:randomUUID(),p_explanation:'Must be denied'}],
          ['/rest/v1/rpc/learning_review_decide', {p_review_id:randomUUID(),p_expected_revision:1,p_action_id:randomUUID(),p_decision:'dismiss'}],
          ['/rest/v1/rpc/learning_schedule_config', {p_item_id:randomUUID(),p_expected_revision:0,p_action_id:randomUUID(),p_days:1,p_goal:''}],
          ['/rest/v1/rpc/learning_recall', {p_item_id:randomUUID(),p_expected_revision:1,p_action_id:randomUUID(),p_rating:'hard'}],
          ['/rest/v1/rpc/learning_usage_review', {p_usage_id:randomUUID(),p_expected_revision:1,p_action_id:randomUUID(),p_status:'unreviewed'}],
          ['/rest/v1/rpc/learning_weekly_goal_select', {p_analysis_id:randomUUID(),p_kind:'keep',p_expected_revision:0,p_action_id:randomUUID()}],
          ['/rest/v1/rpc/learning_enhancement_restore', {p_data:{}}],
          ['/rest/v1/rpc/learning_review_context', {p_user_id:user.user.id,p_review_id:randomUUID()}],
          ['/rest/v1/rpc/learning_usage_context', {p_user_id:user.user.id,p_session_id:randomUUID()}],
          ['/rest/v1/rpc/learning_recommend_more', {p_companion_id:'alex'}],
          ['/rest/v1/rpc/learning_action', {p_item_id:randomUUID(),p_expected_revision:1,p_action_id:randomUUID(),p_action:'exclude',p_payload:{}}],
          ['/rest/v1/rpc/learning_record_event', {p_event_id:randomUUID(),p_name:'call_connected',p_companion_id:'alex',p_session_id:randomUUID(),p_analysis_id:null,p_item_id:null,p_attempt_id:null,p_payload:{}}],
          ['/rest/v1/rpc/learning_restore', {p_items:[]}],
          ['/rest/v1/rpc/learning_finish_partial', {p_session_id:randomUUID()}],
          // This RPC is service-only even when the caller is authenticated.
          ['/rest/v1/rpc/learning_voice_context', {p_user_id:user.user.id,p_companion_id:'alex'}],
          ['/functions/v1/coach/config', {}],
          ['/functions/v1/coach/reconsider', {requestId:randomUUID()}],
          ['/functions/v1/coach/memory', {companionId:'alex',query:'Previous conversation'}],
          ['/functions/v1/coach/memory-manage', {companionId:'alex',action:'list'}],
          ['/functions/v1/coach/memory-manage', {companionId:'alex',action:'setFact',key:'goal',value:'Must be denied'}],
          ['/functions/v1/coach/memory-index', {companionId:'alex'}],
          ['/functions/v1/coach/checkpoint', {sessionId:randomUUID()}],
          ['/rest/v1/rpc/memory_context', {p_user_id:user.user.id,p_companion_id:'alex'}],
          ['/functions/v1/coach/voice', {sessionId:randomUUID(),sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}],
        ]) {
          const denied = await fetch(base + endpoint, {method:'POST',headers:{apikey:publicKey,Authorization:`Bearer ${user.access_token}`,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
          ensure(denied.status === 403, 'Unapproved account bypassed an access gate.');
        }
      }
      pass('Unapproved verified accounts cannot read records, canonical learning state or memory controls, invoke learning RPCs or service-only learning voice context, create, append, finish, restore, manage/index memories, checkpoint, or access AI. Voice checks require an approved account and were not run.');
      return;
    }
    await mkdir('test-results', { recursive: true });
    for (const profile of companions) {
      stage = `${profile.name}: published mobile home`;
      // A fresh browser process resets the offline WAV microphone capture for
      // each call; this avoids depending on Chromium's shared capture lifetime.
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.env.SMOKE_AUDIO}`] });
      const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
      await context.addInitScript(({ base, session }) => {
        localStorage.setItem('loop.auth:' + base, JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in }));
        // Observe real provider events, retaining only counts and public voice
        // names. No event body, SDP, or transcript is copied into test output.
        globalThis.__liveSmoke = { userTurns: 0, userCommits: 0, assistantTurns: 0, assistantAfterUser: 0, voices: [], connectionState: 'new' };
        const create = RTCPeerConnection.prototype.createDataChannel;
        RTCPeerConnection.prototype.createDataChannel = function (...args) {
          const channel = create.apply(this, args);
          globalThis.__liveSmoke.connectionState = this.connectionState;
          this.addEventListener('connectionstatechange', () => { globalThis.__liveSmoke.connectionState = this.connectionState; });
          channel.addEventListener('message', message => {
            let event; try { event = JSON.parse(message.data); } catch { return; }
            const observed = globalThis.__liveSmoke;
            if (event.type === 'input_audio_buffer.committed') observed.userCommits++;
            if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript?.trim()) observed.userTurns++;
            if (event.type === 'response.output_audio_transcript.done' && event.transcript?.trim()) {
              observed.assistantTurns++;
              if (observed.userCommits > 0) observed.assistantAfterUser++;
            }
            if (event.type === 'session.created' || event.type === 'session.updated') {
              const voice = event.session?.audio?.output?.voice || event.session?.voice;
              if (typeof voice === 'string' && !observed.voices.includes(voice)) observed.voices.push(voice);
            }
          });
          return channel;
        };
      }, { base, session: learner });
      page = await context.newPage(); page.setDefaultTimeout(90_000);
      await page.goto(site, { waitUntil: 'networkidle' });
      await page.locator('#workspace').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#models')?.textContent.includes('gpt-'), {}, { timeout: 60_000 });
      ensure((await page.locator('#companion-name').textContent()) === 'Alex', 'A fresh mobile session did not default to Alex.');
      await page.locator(`[data-companion="${profile.id}"]`).click();
      await page.waitForFunction(name => document.querySelector('#companion-name')?.textContent === name, profile.name);
      await page.locator('#contacts-panel').waitFor({state:'visible'});
      await page.locator('#companion-selector').evaluate(node=>Promise.all(node.getAnimations({subtree:true}).map(animation=>animation.finished)));
      await page.screenshot({ path: `test-results/live-${profile.id}-home.png`, fullPage: true });
      stage = `${profile.name}: actual WebRTC and provider transcription`;
      await page.locator('#start-call').click();
      await page.waitForFunction(() => globalThis.__liveSmoke.connectionState === 'connected', {}, { timeout: 60_000 });
      await page.waitForFunction(expected => globalThis.__liveSmoke.voices.includes(expected), profile.voice, { timeout: 30_000 });
      await page.waitForFunction(() => globalThis.__liveSmoke.userTurns > 0 && Array.from(document.querySelectorAll('#transcript li')).some(li => li.querySelector('b')?.textContent === 'YOU' && /friend|park|caf[eé]|yesterday|today/i.test(li.textContent)), {}, { timeout: 90_000 });
      await page.waitForFunction(name => globalThis.__liveSmoke.assistantAfterUser > 0 && Array.from(document.querySelectorAll('#transcript li')).some(li => li.querySelector('b')?.textContent === name.toUpperCase()), profile.name, { timeout: 90_000 });
      await page.screenshot({ path: `test-results/live-${profile.id}-call.png`, fullPage: true });
      pass(`${profile.name}: actual WebRTC connected, provider confirmed ${profile.voice}, and both speech transcripts reached the app.`);
      stage = `${profile.name}: automatic transcript and feedback save`;
      await page.locator('#end-call').click();
      await page.waitForFunction(() => document.querySelector('#call-status')?.textContent === '통화와 피드백 저장 완료', {}, { timeout: 120_000 });
      await page.locator('[data-view="review"]').click();
      await page.locator('#review-content .analysis').first().waitFor({ state: 'visible' });
      await page.screenshot({ path: `test-results/live-${profile.id}-review.png`, fullPage: true });
      pass(`${profile.name}: call ended and automatic cloud transcript plus feedback save completed.`);
      stage = `${profile.name}: reload restores selected companion, history, and visible feedback`;
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#workspace').waitFor({ state: 'visible' });
      await page.waitForFunction(name => document.querySelector('#companion-name')?.textContent === name, profile.name);
      await page.locator('[data-view="history"]').click();
      await page.locator('#history .history-entry').first().waitFor({ state: 'visible' });
      ensure(await page.locator('#history .history-entry[data-companion-id="'+profile.id+'"]').count() === 1, 'Reloaded history is missing or duplicates this companion conversation.');
      await page.locator('[data-view="review"]').click();
      await page.locator('#review-content .analysis').first().waitFor({ state: 'visible' });
      await statusSnapshot();
      pass(`${profile.name}: reload retained the selected friend and restored visible scoped history and feedback.`);
      await browser.close(); browser = undefined; page = undefined;
    }

    stage = 'exact saved companion sessions and evidence';
    const sessions = await userRequest(learner, '/rest/v1/sessions?select=id,status,companion_id');
    ensure(sessions.length === 3, 'Live calls did not create exactly three sessions.');
    for (const profile of companions) ensure(sessions.filter(session => session.companion_id === profile.id && session.status === 'ended').length === 1, 'Each companion must have exactly one ended session.');
    const events = await userRequest(learner, '/rest/v1/transcript_events?select=id,session_id,speaker,text');
    const analyses = await userRequest(learner, '/rest/v1/analyses?select=id,session_id,kind,content,source_event_ids');
    for (const profile of companions) {
      const session = sessions.find(session => session.companion_id === profile.id);
      const ownEvents = events.filter(event => event.session_id === session.id);
      ensure(ownEvents.some(event => event.speaker === 'user' && event.text.trim()) && ownEvents.some(event => event.speaker === 'assistant' && event.text.trim()), 'A companion call is missing saved speech from one speaker.');
      const reviews = analyses.filter(analysis => analysis.kind === 'session' && analysis.session_id === session.id);
      ensure(reviews.length === 1 && reviews[0].content?.scope?.companionId === profile.id, 'A companion feedback record is missing, duplicated, or misassigned.');
      const ids = new Set(ownEvents.map(event => event.id));
      ensure(reviews[0].source_event_ids?.length > 0 && reviews[0].source_event_ids.every(id => ids.has(id)), 'Saved feedback sources crossed a session boundary.');
      verifyEvidence(reviews[0].content, ownEvents);
      verifyMemory(await userRequest(learner, '/functions/v1/coach/memory', { companionId: profile.id }), profile, sessions, events);
    }
    pass('Exactly one ended session per Alex, Mia, and Juno; saved speech, feedback citations, and retrieved memories stay within each friend.');

    stage = 'Juno weekly analysis scope and evidence';
    const weekly = await userRequest(learner, '/functions/v1/coach/weekly', { companionId: 'juno' });
    const junoSession = sessions.find(session => session.companion_id === 'juno');
    const junoEvents = events.filter(event => event.session_id === junoSession.id), junoIds = new Set(junoEvents.map(event => event.id));
    ensure(weekly.analysis?.kind === 'weekly' && weekly.analysis.content?.scope?.companionId === 'juno' && weekly.analysis.content.scope.session_count === 1, 'Weekly review was not scoped to Juno alone.');
    ensure(weekly.analysis.source_event_ids?.length > 0 && weekly.analysis.source_event_ids.every(id => junoIds.has(id)), 'Weekly evidence crossed a companion boundary.');
    ensure(weekly.analysis.content.based_on?.length > 0 && weekly.analysis.content.based_on.every(source => source.session_id === junoSession.id && junoIds.has(source.event_id)), 'Weekly provenance crossed a companion boundary.');
    verifyEvidence(weekly.analysis.content, junoEvents);
    pass('Upper-tier Juno weekly analysis completed with Juno-only scope, source references, and validated citations.');

    stage = 'cross-account database and memory isolation';
    for (const table of ['sessions', 'transcript_events', 'analyses']) {
      const hidden = await userRequest(other, `/rest/v1/${table}?select=id`);
      ensure(Array.isArray(hidden) && hidden.length === 0, 'Another account could read private learning records.');
    }
    for (const profile of companions) {
      const hidden = await userRequest(other, '/functions/v1/coach/memory', { companionId: profile.id });
      ensure(hidden.companionId === profile.id && Array.isArray(hidden.memories) && hidden.memories.length === 0, 'Another account could retrieve private companion memories.');
    }
    pass('Second account cannot read any private sessions, transcripts, analyses, or memories for any companion.');
    pass('Live three-companion release checks passed. Email delivery and managed backup restore remain separate acceptance checks.');
  } catch (error) {
    const statuses = await statusSnapshot();
    const reason = error instanceof SmokeError ? error.message : 'Browser interaction or application readiness check failed.';
    const message = `${stage}: ${reason}; ${Object.entries(statuses).map(([selector, text]) => `${selector}=${text}`).join('; ')}`;
    // Only fixed diagnostic descriptions and the three sanitized status fields.
    console.error('::error title=Live release check::' + message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); } catch { /* Account cleanup must still run. */ }
    for (const id of created) {
      if (!id) continue;
      try { await json(base + '/auth/v1/admin/users/' + id, { method: 'DELETE', headers: adminHeaders }); }
      catch { console.error('::warning::Temporary test account cleanup failed; inspect the test accounts in Supabase Auth.'); process.exitCode = 1; }
    }
    console.log('Temporary account cleanup attempted.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('::error title=Live release check::Release-check configuration is incomplete or invalid.'); process.exitCode = 1; });
}
