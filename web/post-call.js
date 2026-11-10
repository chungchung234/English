import { createLearningOutbox } from '../src/learning-outbox.js';
import { createLearningEnhancements, practiceCue } from './learning-enhancements.js';
import { telemetryMetadata } from '../src/learning-telemetry.mjs';

const $ = id => document.getElementById(id);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value || '';
  if (className) node.className = className;
  return node;
};
const validId = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const exclusion = action => ['exclude', 'known', 'hold_wrong_transcript', 'hold_intent'].includes(action);
const date = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' KST' : '';
const unwrap = value => Array.isArray(value) && value.length === 1 ? value[0] : value;
function quotaReset() {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return date(next.toISOString());
}
function recovery(error) {
  const code = String(error?.code || '');
  if (code === 'BUDGET_EXCEEDED' || error?.status === 429) return { message: `오늘 피드백 생성 한도를 사용했어요. ${quotaReset()}부터 다시 만들 수 있어요. 기존 기록과 복습은 계속 볼 수 있어요.`, blocked: true, until: new Date().setUTCHours(24, 0, 0, 0), code: 'quota' };
  if (['ANALYSIS_TOO_LARGE', 'BODY_TOO_LARGE'].includes(code)) return { message: '이번 기록은 자동 분석 크기 한도를 넘었어요. 원문은 유지됩니다. 다음에는 통화를 짧게 나누어 주세요.', blocked: true, code: 'input_too_large' };
  if (['UNAUTHENTICATED', 'ACCOUNT_NOT_ALLOWED'].includes(code) || [401, 403].includes(error?.status)) return { message: '같은 계정으로 다시 로그인한 뒤 저장과 피드백 상태를 확인해 주세요.', blocked: true, code: 'auth' };
  if (code === 'NO_TRANSCRIPT') return { message: '확인된 사용자 발화가 없어 피드백을 만들 수 없어요. 저장된 기록을 확인하거나 다음 대화를 시작해 주세요.', blocked: true, code: 'no_speech' };
  if (code === 'JOB_IN_PROGRESS') return { message: '서버에서 피드백을 준비하고 있어요. 상태를 확인하거나 홈으로 이동할 수 있어요.', code: 'processing' };
  if (['CONFIGURATION_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'DATABASE_UNAVAILABLE'].includes(code)) return { message: '현재 피드백 서비스를 확인할 수 없어요. 기존 기록을 볼 수 있으며, 연결이 복구된 뒤 상태를 확인해 주세요.', code: 'service' };
  return { message: navigator.onLine === false ? '연결이 끊겼어요. 같은 기기·계정으로 다시 연결한 뒤 상태를 확인해 주세요.' : '요청의 완료 여부를 확인하지 못했어요. 상태를 확인한 뒤 다시 선택해 주세요.', code: 'unconfirmed' };
}

// The server owns revisions and recommendation eligibility. The durable queue owns
// unacknowledged user intent; an optimistic label must never imply server success.
export function createPostCallFlow(deps) {
  let outbox;
  try{outbox=createLearningOutbox();}catch{const unavailable=async()=>{throw Error('기기 저장을 사용할 수 없어요.');};outbox={put:unavailable,list:unavailable,remove:unavailable};}
  let generation = 0, loadVersion = 0, snapshotVersion = 0;
  let identity = '', accountScope = '', companion = '', selected = null;
  let sessions = [], analyses = [], weekly = null, snapshot = null;
  let snapshotError = false, localQueueError = false, queueReady = false;
  let pending = [], volatile = new Map(), actionStates = new Map(), actionResults = new Map(), errors = new Map();
  let attempts = new Map(), activePractice = null, flushing = null, flushAgain = false, pollTimer = null;
  let exposureObserver = null, exposureTimer = null, exposed = new Set();
  let practiceObserver = null;
  const practiceHidden = new Map();
  let previousFocus = null, previousFocusKey = null, pendingFocusRestore = null, planApplied = '', requests = new Set(), panelOpen = false;
  const ctx = () => deps.context();
  const token = () => ({ generation, identity, scope: accountScope, companion });
  const same = t => t.generation === generation && t.identity === identity && identity === currentIdentity();
  const currentIdentity = () => { const c = ctx(); return c?.userId ? `${c.service}|${c.userId}|${c.companionId}` : ''; };
  const busy = () => Boolean(ctx()?.busy?.());
  const notify = message => deps.notice(message);
  const button = (label, fn, primary = false) => {
    const node = text('button', label, primary ? 'glass-button' : 'text-button');
    node.type = 'button';
    node.onclick = async () => {
      if (node.disabled) return;
      node.disabled = true;
      try { await fn(); } catch (error) { notify(recovery(error).message); }
      finally { if (node.isConnected && node.dataset.keepDisabled !== 'true') node.disabled = false; }
    };
    return node;
  };
  const status = message => {
    const node = text('p', message, 'help');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    return node;
  };
  const callStatus = message => { if (!busy() && $('call-status')) $('call-status').textContent = message; };
  const own = record => record.body?.p_companion_id === companion || record.body?.companion_id === companion;
  const itemOf = id => snapshot?.items?.find(item => item.id === id);
  const recordItem = record => record.body?.p_item_id;
  const itemPending = id => [...pending, ...volatile.values()].filter(record => record.kind === 'action' && recordItem(record) === id);
  const suppressed = item => !item || item.has_valid_source === false || item.status === 'excluded' || item.status === 'held' || item.quality_hold || itemPending(item.id).some(record => exclusion(record.body.p_action));
  const canRecommend = item => !suppressed(item) && item.status !== 'candidate' && (item.status !== 'practiced' || enhancements.isDue(item.id));
  const feedback = id => snapshot?.feedback?.find(item => item.session_id === id);
  const analysisFor = id => analyses.find(item => item.kind === 'session' && item.session_id === id && (!feedback(id)?.analysis_id || feedback(id).analysis_id === item.id));
  const sessionFor = id => sessions.find(item => item.id === id);
  const running = job => ['running', 'processing', 'reserved', 'pending'].includes(job?.job_state) && (!job.job_expires_at || Date.parse(job.job_expires_at) > Date.now());
  const enhancements = createLearningEnhancements({
    text, button, status, pending: itemPending, suppressed, itemOf, token, same,
    submit: submitEnhancement, edge: deps.edge, refresh: refreshSnapshot, render,
    notify, appendEvidence, prepare: prepareNext, startRecall
  });

  function stopExposure() {
    exposureObserver?.disconnect(); exposureObserver = null;
    clearTimeout(exposureTimer); exposureTimer = null;
  }
  function syncPracticeVisibility() {
    for (const [node, hidden] of practiceHidden) node.hidden = hidden;
    practiceHidden.clear();
    if (!activePractice || activePractice.saved) {
      practiceObserver?.disconnect(); practiceObserver = null; return;
    }
    // Keep answer copies in the transcript, feedback, library and weekly goals
    // out of the visible practice surface. Closing restores their original state.
    const conceal = node => {
      if (!node || node === activePractice.box) return;
      if (node.contains(activePractice.box)) { for (const child of node.children) conceal(child); return; }
      if (!practiceHidden.has(node)) practiceHidden.set(node, node.hidden);
      node.hidden = true;
    };
    for (const node of document.querySelectorAll('#review-content, #post-call-transcript, [data-practice-surrounding], [data-weekly-analysis-id], #learning-queue [data-session-id]')) conceal(node);
    for (const node of $('learning-session')?.children || []) conceal(node);
    if (!practiceObserver && typeof MutationObserver !== 'undefined') {
      practiceObserver = new MutationObserver(syncPracticeVisibility);
      practiceObserver.observe(document.body, { childList: true, subtree: true });
    }
  }
  function closePractice() {
    activePractice = null;syncPracticeVisibility();render();
    const original=previousFocus,key=previousFocusKey,t=token();previousFocus=null;previousFocusKey=null;let provisionalFocus=null;
    const restoreFocus=(remaining=4)=>{
      if(!same(t)||activePractice||document.querySelector('[data-panel="review"]')?.hidden){pendingFocusRestore=null;return;}
      const active=document.activeElement;
      if(active&&active!==document.body&&active.isConnected&&active!==provisionalFocus&&!active.closest('.learning-practice')&&active.dataset.action!==key?.action){pendingFocusRestore=null;return;}
      const container=key?.container?$(key.container):null;
      const focusEntry=(node,provisional=false)=>{
        if(!node||node.disabled||node.closest('[hidden]'))return false;
        for(let ancestor=node.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS')ancestor.open=true;
        node.focus({preventScroll:true});const focused=document.activeElement===node;if(focused){provisionalFocus=provisional?node:null;pendingFocusRestore=provisional?restoreFocus:null;}return focused;
      };
      const replacement=original?.isConnected&&container?.contains(original)?original:[...container?.querySelectorAll('button[data-action]')||[]].find(node=>node.dataset.action===key?.action&&(!key.itemId||node.closest('[data-item-id]')?.dataset.itemId===key.itemId));
      if(focusEntry(replacement))return;
      // A library disclosure builds its cards on the queued toggle event.
      if(remaining){setTimeout(()=>restoreFocus(remaining-1),0);return;}
      // A concurrent exclusion may remove the original practice entry. Return
      // keyboard users to this item's explicit recovery instead of the body.
      const conflict=pending.find(record=>record.state==='conflict'&&recordItem(record)===key?.itemId);
      const queue=$('learning-queue');
      const recovery=conflict?[...queue?.querySelectorAll('[data-conflict-id]')||[]].find(node=>node.dataset.conflictId===conflict.id)?.querySelector('[data-action="retry-conflict"], [data-action="discard-conflict"]'):null;
      if(focusEntry(recovery))return;
      for(const root of [container,queue]){
        const restore=[...root?.querySelectorAll('[data-item-id]')||[]].find(node=>node.dataset.itemId===key?.itemId)?.querySelector('[data-action="restore"]');
        if(focusEntry(restore))return;
      }
      if(container&&!container.closest('[hidden]')){
        if(focusEntry(container.querySelector('summary'),true))return;
        container.tabIndex=-1;focusEntry(container,true);
      }
    };
    pendingFocusRestore=restoreFocus;setTimeout(restoreFocus,0);
  }
  function clear() {
    generation++; loadVersion++; snapshotVersion++;
    clearTimeout(pollTimer); pollTimer = null; stopExposure(); closePractice();
    identity = ''; accountScope = ''; companion = ''; selected = null;
    sessions = []; analyses = []; weekly = null; snapshot = null;
    pending = []; volatile = new Map(); actionStates = new Map(); actionResults = new Map(); errors = new Map(); attempts = new Map(); exposed = new Set();
    snapshotError = false; localQueueError = false; queueReady = false;
    planApplied = ''; panelOpen = false; requests = new Set();pendingFocusRestore=null;
    enhancements.clear();
    for (const id of ['learning-queue', 'learning-session']) $(id)?.replaceChildren();
    if ($('practice-preview')) $('practice-preview').disabled = true;
    if ($('practice-preview-text')) $('practice-preview-text').textContent = '첫 통화 후에 만나요';
  }
  function ensureIdentity() {
    const next = currentIdentity();
    if (next === identity) return Boolean(next);
    clear();
    const c = ctx();
    if (!c?.userId) return false;
    identity = next; accountScope = `${c.service}|${c.userId}`; companion = c.companionId;
    restoreBlockers();
    return true;
  }
  function restoreBlockers() {
    try {
      const stored = JSON.parse(localStorage.getItem('loop.learning-blockers:' + identity) || '[]');
      for (const value of stored) {
        if (!validId(value.id) || !['quota', 'input_too_large'].includes(value.code) || value.code === 'quota' && Number(value.until) <= Date.now()) continue;
        const state = recovery({ code: value.code === 'quota' ? 'BUDGET_EXCEEDED' : 'ANALYSIS_TOO_LARGE' });
        if (value.until) state.until = value.until;
        state.sourceVersion = value.sourceVersion || null;
        errors.set(value.id, state);
      }
    } catch { /* Only durable learning actions rely on IndexedDB. */ }
  }
  function persistBlockers() {
    try { localStorage.setItem('loop.learning-blockers:' + identity, JSON.stringify([...errors].filter(([, state]) => ['quota', 'input_too_large'].includes(state.code)).map(([id, state]) => ({ id, code: state.code, until: state.until || null, sourceVersion: state.sourceVersion || null })))); } catch { /* UI still reports this response honestly. */ }
  }
  async function readQueue(t) {
    try {
      const rows = await outbox.list(t.scope);
      if (!same(t)) return false;
      pending = rows.filter(own); queueReady = true; localQueueError = false;
      return true;
    } catch {
      if (same(t)) { localQueueError = true; queueReady = false; }
      return false;
    }
  }
  async function refreshSnapshot(t = token()) {
    const version = ++snapshotVersion;
    try {
      const result = unwrap(await deps.rpc('learning_snapshot', { p_companion_id: t.companion }));
      if (!same(t) || version !== snapshotVersion) return false;
      if (!result || !Array.isArray(result.items) || !Array.isArray(result.feedback)) throw Error('snapshot unavailable');
      const previous = new Map((snapshot?.items || []).map(item => [item.id, item]));
      result.items = result.items.map(item => Number(previous.get(item.id)?.revision) > Number(item.revision) ? previous.get(item.id) : item);
      snapshot = result; snapshotError = false;
      try {
        const extended = unwrap(await deps.rpc('learning_enhancement_snapshot', { p_companion_id: t.companion }));
        if (!same(t) || version !== snapshotVersion) return false;
        if (!extended || !['reviews', 'schedules', 'recalls', 'usage', 'weekly_goals'].every(key => Array.isArray(extended[key]))) throw Error('enhancement snapshot unavailable');
        enhancements.setSnapshot(extended);
      } catch {
        if (!same(t) || version !== snapshotVersion) return false;
        enhancements.setSnapshot(null, true);
      }
      for (const job of result.feedback) {
        const previousError = errors.get(job.session_id);
        if (previousError?.code === 'quota' && previousError.until && previousError.until <= Date.now()) errors.delete(job.session_id);
        if (previousError?.code === 'input_too_large' && job.source_version && previousError.sourceVersion !== job.source_version) errors.delete(job.session_id);
        if (job.current) errors.delete(job.session_id);
        else if (['input_too_large', 'quota'].includes(job.blocked_reason)) {
          const blocked = recovery({ code: job.blocked_reason === 'quota' ? 'BUDGET_EXCEEDED' : 'ANALYSIS_TOO_LARGE' });
          blocked.sourceVersion = job.source_version || null;
          if (job.blocked_until) { blocked.until = Date.parse(job.blocked_until); blocked.message = `오늘 피드백 생성 한도를 사용했어요. ${date(job.blocked_until)}부터 다시 만들 수 있어요. 기존 기록과 복습은 계속 볼 수 있어요.`; }
          errors.set(job.session_id, blocked);
        }
      }
      persistBlockers();
      await readQueue(t);
      if (!same(t)) return false;
      applyPlan(); render(); schedulePoll();
      return true;
    } catch {
      if (same(t) && version === snapshotVersion) { snapshotError = true; render(); }
      return false;
    }
  }
  function applyPlan() {
    const plan = snapshot?.next_plan;
    if (!plan || busy() || !queueReady || hasPendingExclusions()) return;
    const item = itemOf(plan.item_id || plan.target_item_id);
    if (!item || suppressed(item) || !plan.scenario) return;
    const key = `${plan.id || plan.prepared_at || ''}|${item.id}|${plan.scenario}`;
    if (planApplied === key) return;
    planApplied = key;
    deps.chooseScenario(plan.scenario, plan.source_session_id || item.source_session_id, { restore: true, itemId: item.id });
  }
  async function load(data = {}) {
    if (!ensureIdentity()) return;
    const t = token(), version = ++loadVersion;
    const belongs = session => session.companion_id === companion;
    if (data.sessions) sessions = data.sessions.filter(belongs);
    const ids = new Set(sessions.map(session => session.id));
    if (data.analyses) analyses = data.analyses.filter(analysis => analysis.kind === 'session' && ids.has(analysis.session_id));
    weekly = data.weekly || (data.analyses || []).find(analysis => analysis.kind === 'weekly' && analysis.content?.scope?.companionId === companion) || null;
    if (weekly?.content?.scope?.companionId !== companion) weekly = null;
    await readQueue(t);
    if (!same(t) || version !== loadVersion) return;
    render();
    await refreshSnapshot(t);
    if (same(t)) void flush();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!snapshot?.feedback?.some(running)) return;
    const t = token();
    pollTimer = setTimeout(async () => {
      if (!same(t)) return;
      const before = snapshot.feedback.filter(running).map(job => job.session_id);
      await refreshSnapshot(t);
      if (!same(t)) return;
      if (before.some(id => feedback(id)?.current && !analysisFor(id))) await deps.refresh();
    }, 5000);
  }
  async function queue(record, t, { quiet = false } = {}) {
    if (!same(t)) return false;
    if (record.kind === 'action' && exclusion(record.body.p_action)) {
      volatile.set(record.id, record); render();
    }
    try {
      await outbox.put(t.scope, record);
      if (!same(t)) return false;
      volatile.delete(record.id);
      pending = [...pending.filter(item => item.id !== record.id), record];
      actionStates.set(record.id, '기기 보관 확인 · 서버 반영 대기');
      render();
      return true;
    } catch {
      if (same(t)) {
        actionStates.set(record.id, '저장하지 못했어요 · 기기 보관도 확인되지 않았어요');
        localQueueError = true;
        if (!quiet) notify('저장하지 못했어요. 기기 보관도 확인되지 않았으므로 이 화면에서 다시 선택해 주세요.');
        render();
      }
      return false;
    }
  }
  function telemetryStage(record, stage) {
    if (record.body?.p_name !== 'call_connected') return;
    try { deps.onTelemetryStage?.({ eventId: record.id, sessionId: record.body.p_session_id,
      occurredAt: record.created_at, metadata: telemetryMetadata(record.body.p_payload), stage }); } catch { /* Diagnostics are best effort. */ }
  }
  async function event(name, fields = {}, payload = {}, t = token(), receipt = null) {
    if (receipt && (!validId(receipt.eventId) || typeof receipt.occurredAt !== 'string' || !Number.isFinite(Date.parse(receipt.occurredAt)))) return false;
    const id = receipt?.eventId || uuid(), occurredAt = receipt?.occurredAt || now();
    const metadata = telemetryMetadata(receipt?.metadata || deps.getEventMetadata?.());
    const record = { id, kind: 'event', created_at: occurredAt, body: {
      p_event_id: id, p_name: name, p_companion_id: t.companion,
      p_session_id: fields.sessionId || null, p_analysis_id: fields.analysisId || null,
      p_item_id: fields.itemId || null, p_attempt_id: fields.attemptId || null,
      p_payload: { occurred_at: occurredAt, ...payload, ...metadata }
    } };
    telemetryStage(record, 'created');
    const stored = await queue(record, t, { quiet: name === 'call_connected' });
    if (stored) { telemetryStage(record, 'device_persisted'); void flush(); }
    return stored;
  }
  async function act(item, action, payload = {}, oldRecord = null) {
    if (!ensureIdentity() || !item || item.companion_id !== companion) return false;
    const t = token(), current = itemOf(item.id);
    if (!current) return false;
    if (current.status === 'excluded' && !['restore', 'exclude', 'known', 'hold_wrong_transcript', 'hold_intent'].includes(action)) { notify('최신 상태는 추천 제외예요. 제외 상태를 유지하거나 이전 선택을 취소한 뒤 먼저 제외를 해제해 주세요.'); return false; }
    if (action === 'prepare_next' && current.has_valid_source === false) { notify('유효한 출처를 확인하지 못해 다음 통화 목표를 준비할 수 없어요. 이전 선택을 취소하거나 새 피드백을 확인해 주세요.'); return false; }
    if (!oldRecord && itemPending(item.id).length) { notify('이 표현의 이전 선택을 먼저 서버에서 확인해 주세요.'); return false; }
    const id = uuid();
    const record = { id, kind: 'action', created_at: now(), body: {
      p_item_id: current.id, p_expected_revision: current.revision, p_action_id: id,
      p_action: action, p_payload: { ...payload, occurred_at: now() }, companion_id: t.companion
    } };
    if (!await queue(record, t)) return false;
    if (oldRecord) {
      try { await outbox.remove(t.scope, oldRecord.id); } catch { notify('이전 선택 정리를 확인하지 못했어요. 새 선택은 서버 확인 대기 중이에요.'); }
      if (!same(t)) return false;
      pending = pending.filter(item => item.id !== oldRecord.id);
    }
    await flush();
    return same(t) && actionStates.get(id) === '서버 저장 확인';
  }
  async function submitEnhancement(rpc, item, args, metadata = {}, oldRecord = null) {
    if (!ensureIdentity() || !item || item.companion_id !== companion) return null;
    if (!oldRecord && itemPending(item.id).length) { notify('이 표현의 이전 선택을 먼저 서버에서 확인해 주세요.'); return null; }
    const t = token(), id = uuid();
    const record = { id, kind: 'action', created_at: now(), body: {
      companion_id: t.companion, p_item_id: item.id, p_action: 'enhancement', p_payload: {},
      _enhancement: { rpc, args: { ...args, p_action_id: id }, item_id: item.id, attemptId: metadata.attemptId || null }
    } };
    if (!await queue(record, t)) return null;
    if (oldRecord) {
      await outbox.remove(t.scope, oldRecord.id);
      if (!same(t)) return null;
      pending = pending.filter(row => row.id !== oldRecord.id);
    }
    await flush();
    if (!same(t)) return null;
    const result = actionResults.get(id) || null;
    if (result?.outcome === 'applied') notify('선택을 서버에 저장했어요.');
    return result;
  }
  async function flush() {
    if (!ensureIdentity() || !accountScope) return;
    if (flushing) { flushAgain = true; return flushing; }
    const t = token();
    const job = (async () => {
      let rows;
      try { rows = await outbox.list(t.scope); } catch { if (same(t)) { queueReady = false; localQueueError = true; render(); } return; }
      let enhancementChanged = false;
      for (const record of rows) {
        if (!same(t)) return;
        // Keep actions for a different companion durable until that scope is opened.
        if (!own(record) || record.state === 'conflict') continue;
        try {
          let result;
          if (record.kind === 'action') {
            const extension = record.body._enhancement;
            if (extension) {
              if (!['learning_review_submit', 'learning_review_decide', 'learning_schedule_config', 'learning_recall', 'learning_usage_review', 'learning_weekly_goal_select'].includes(extension.rpc)) throw Object.assign(Error('Unknown learning action'), { code: '22023' });
              result = unwrap(await deps.rpc(extension.rpc, extension.args));
              enhancementChanged = true;
            } else {
              const { companion_id: ignored, ...body } = record.body;
              result = unwrap(await deps.rpc('learning_action', body));
            }
            if (!same(t)) return;
            if (snapshot && result?.item && (!itemOf(result.item.id) || Number(result.item.revision) >= Number(itemOf(result.item.id).revision))) {
              snapshot.items = [...snapshot.items.filter(item => item.id !== result.item.id), result.item];
            }
            if (result?.outcome === 'conflict') {
              const conflicted = { ...record, state: 'conflict' };
              await outbox.put(t.scope, conflicted);
              if (!same(t)) return;
              pending = pending.map(item => item.id === record.id ? conflicted : item);
              actionStates.set(record.id, '다른 기기에서 상태가 바뀌었어요 · 최신 상태를 보고 다시 선택해 주세요');
              render(); continue;
            }
            if (result?.outcome !== 'applied') throw Error('acknowledgement unavailable');
            actionResults.set(record.id, result);
            if (snapshot && result.next_plan !== undefined) snapshot.next_plan = result.next_plan;
            if (record.body.p_action === 'practice') confirmPractice(record);
            if (extension?.rpc === 'learning_recall') confirmRecall(record);
            actionStates.set(record.id, '서버 저장 확인');
          } else if (record.kind === 'event') {
            const acknowledgement = unwrap(await deps.rpc('learning_record_event', record.body));
            if (!same(t)) return;
            if (acknowledgement?.saved !== true) throw Error('event acknowledgement unavailable');
            telemetryStage(record, 'server_ack');
          } else continue;
          await outbox.remove(t.scope, record.id);
          if (!same(t)) return;
          pending = pending.filter(item => item.id !== record.id);
          volatile.delete(record.id);
          render();
        } catch (error) {
          if (!same(t)) return;
          if (record.kind === 'action' && ['P0001', '22023', '22P02', '23514'].includes(String(error?.code || ''))) {
            const held = { ...record, state: 'conflict' };
            try { await outbox.put(t.scope, held); } catch { localQueueError = true; }
            if (!same(t)) return;
            pending = pending.map(item => item.id === record.id ? held : item);
            actionStates.set(record.id, '현재 조건에서는 저장할 수 없어요 · 다시 선택하거나 이전 선택을 취소해 주세요');
            await refreshSnapshot(t);
            if (!same(t)) return;
            notify('현재 상태에서 이 선택을 저장할 수 없어요. 최신 상태를 보고 다시 선택하거나 이전 선택을 취소해 주세요.');
            render(); continue;
          }
          actionStates.set(record.id, '기기 보관 확인 · 서버 반영을 확인하지 못했어요');
          notify(recovery(error).message);
          render(); break;
        }
      }
      if (same(t)) {
        await readQueue(t);
        if (enhancementChanged) await refreshSnapshot(t);
        if (same(t)) { applyPlan(); render(); }
      }
    })();
    flushing = job;
    try { await job; } finally {
      if (flushing === job) flushing = null;
      if (flushAgain && same(t)) { flushAgain = false; void flush(); }
    }
  }
  function hasPendingExclusions() {
    if (!identity || identity !== currentIdentity()) return true;
    return !queueReady || localQueueError || [...pending, ...volatile.values()].some(record => record.kind === 'action' && exclusion(record.body.p_action));
  }

  function actionButton(label, item, action, payload = {}, primary = false) {
    const node = button(label, async () => {
      const confirmed = await act(item, action, payload);
      if (confirmed) notify(action === 'defer' ? '나중에 하기로 서버에 저장했어요.' : action === 'prepare_next' ? '다음 통화 준비를 서버에 저장했어요. 통화 시작은 직접 선택해 주세요.' : '선택을 서버에 저장했어요.');
      render();
    }, primary);
    node.dataset.action = action;
    node.disabled = itemPending(item.id).length > 0;
    return node;
  }
  function appendEvidence(target, ids, sessionId) {
    if (!ids?.length) return;
    const allowed = ids.filter(validId);
    if (!allowed.length) return;
    const details = document.createElement('details');
    details.append(text('summary', '근거 발화'));
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      const t = token();
      const node = text('blockquote', '근거 발화를 확인하고 있어요.'); details.append(node);
      try {
        const rows = await deps.allRows('transcript_events', `id=in.(${allowed.join(',')})&order=timestamp.asc,id.asc`);
        if (!same(t) || !node.isConnected) return;
        node.textContent = rows.filter(row => row.speaker === 'user' && (!sessionId || row.session_id === sessionId)).map(row => row.text).join(' / ') || '연결된 사용자 발화를 확인할 수 없어요.';
      } catch { if (same(t) && node.isConnected) { node.textContent = '근거 발화를 확인하지 못했어요. 다시 열어 주세요.'; loaded = false; node.remove(); } }
    });
    target.append(details);
  }
  function itemCard(item, attribution = null, candidate = false, controlsOnly = false) {
    const article = document.createElement('article'); article.className = 'feedback-item'; article.dataset.itemId = item.id;
    const delayed = ((!attribution && !candidate) || activePractice?.mode === 'delayed' && activePractice.itemId === item.id) && enhancements.isDue(item.id) && !suppressed(item);
    if (delayed) article.append(text('h4', '예약한 표현 · 가리고 회상'));
    else if (!controlsOnly) {
    article.append(text('small', item.category === 'error' ? '의미·문법 오류' : '선택 가능한 대안'));
    if (item.original) article.append(text('p', item.original, 'original'));
    article.append(text('p', item.expression, 'improved'));
    if (item.reason) article.append(text('p', item.reason));
    appendEvidence(article, item.evidence_ids, attribution?.sessionId);
    } else article.append(text('h4', '이 표현 연습'));
    if (item.practice_count) article.append(text('small', `직접 연습한 날 ${item.practice_count}일 · 자동 숙달 평가가 아니에요`));
    const actions = document.createElement('div'); actions.className = 'learning-actions';
    const advanced=document.createElement('details');advanced.className='feedback-context';advanced.append(text('summary','표현 관리'));const management=document.createElement('div');management.className='learning-actions';advanced.append(management);
    if (!suppressed(item)) {
      if (candidate || item.status === 'candidate' || !item.enrolled) actions.append(actionButton('이 표현도 등록', item, 'enroll'));
      const start = button(delayed ? '가리고 회상하기' : '표현 하나 연습', () => delayed ? startRecall(item.id, start) : startPractice(item.id, attribution, start)); start.dataset.action = delayed ? 'start-delayed-recall' : 'practice';
      start.disabled = itemPending(item.id).length > 0 || snapshotError || candidate || item.status === 'candidate' || !item.enrolled;
      actions.append(start, actionButton('나중에 하기', item, 'defer'));management.append(actionButton('이미 아는 표현이에요', item, 'known'), actionButton('그만 보기', item, 'exclude'));
      if (item.status === 'practiced' || item.status === 'deferred') management.append(actionButton('다시 보고 싶어요', item, 'review_again'));
      if (attribution?.sessionId && attribution?.analysisId) {
        const payload = { source_session_id: attribution.sessionId, source_analysis_id: attribution.analysisId };
        management.append(actionButton('내가 한 말이 아니에요', item, 'hold_wrong_transcript', payload), actionButton('의도와 달라요', item, 'hold_intent', payload));
      }
    } else if (item.status === 'excluded' && !itemPending(item.id).length) {
      actions.append(actionButton('추천 제외 되돌리기', item, 'restore'));
      if (item.has_valid_source === false) article.append(text('p', '유효한 새 피드백이 확인되기 전에는 자동 추천하지 않아요.', 'help'));
    } else article.append(text('p', '품질 보류 또는 제외 반영 대기 중이에요. 현재 기기의 추천과 다음 통화 목표에서 제외됩니다.', 'help'));
    const records = itemPending(item.id);
    if (records.length) article.append(status(records.some(record => record.state === 'conflict') ? '최신 상태가 달라 선택을 보류했어요. 위의 동기화 안내에서 다시 선택해 주세요.' : records.some(record => volatile.has(record.id)) ? '기기 저장을 확인하지 못했어요 · 서버에 반영되지 않았어요' : '기기 보관 확인 · 서버 반영 대기'));
    if (item.defer_count >= 2) article.append(text('p', '계속 미루고 싶다면 그만 보기를 선택해도 괜찮아요. 연습 이력은 남습니다.', 'help'));
    article.append(actions);if(management.childElementCount)article.append(advanced);
    enhancements.renderItem(article, item, attribution);
    return article;
  }
  function renderQueue(target) {
    const actions = pending.filter(record => record.kind === 'action');
    if (!actions.length && !volatile.size && !localQueueError) return;
    const area = document.createElement('section'); area.className = 'analysis';
    area.append(text('h3', '저장과 동기화'));
    if (localQueueError) area.append(status('기기 저장 상태를 확인하지 못했어요. 복원과 서버 반영을 약속할 수 없어요.'));
    for (const record of actions) {
      const row = document.createElement('div'); row.className = 'feedback-item';
      if (record.state === 'conflict') {
        row.dataset.conflictId = record.id;
        row.append(status('최신 상태나 저장 조건이 달라 이전 선택을 보류했어요. 서버 상태를 자동으로 덮어쓰지 않았어요.'));
        const item = itemOf(recordItem(record));
        row.append(text('p', `최신 상태: ${stateLabel(item)}. ${exclusion(record.body.p_action) ? '현재 기기에서는 계속 추천을 막고 있어요.' : '원하는 행동을 다시 선택할 수 있어요.'}`));
        const retry = button('최신 상태에 다시 적용', async () => {
          const t = token();
          if (!await refreshSnapshot(t) || !same(t)) return;
          const current = itemOf(recordItem(record));
          if (current) {
            const extension = record.body._enhancement;
            if (extension) await submitEnhancement(extension.rpc, current, enhancements.rebase(extension.rpc, extension.args, current), extension, record);
            else await act(current, record.body.p_action, record.body.p_payload, record);
          }
        }); retry.dataset.action = 'retry-conflict';
        const discard = button('이전 선택 취소', async () => {
          const t = token(); await outbox.remove(t.scope, record.id);
          if (!same(t)) return; pending = pending.filter(item => item.id !== record.id); render();
        }); discard.dataset.action = 'discard-conflict';
        row.append(retry, discard);
      } else row.append(status(`${exclusion(record.body.p_action) ? '제외 반영 대기 · ' : ''}${actionStates.get(record.id) || '기기 보관 확인 · 서버 반영 대기'}`));
      area.append(row);
    }
    for (const record of volatile.values()) {
      const row = document.createElement('div'); row.className = 'feedback-item';
      row.append(status('저장하지 못했어요. 현재 화면에서만 추천을 막고 있으며 재접속 후 복원은 보장되지 않아요.'));
      row.append(button('같은 선택 다시 저장', async () => { if (await queue(record, token())) await flush(); })); area.append(row);
    }
    area.append(button('같은 요청 다시 전송', flush)); target.append(area);
  }
  function stateLabel(item) {
    if (!item) return '항목을 확인할 수 없음';
    return ({ candidate: '선택 등록 전', active: '미연습', deferred: '나중에 하기', practiced: '직접 연습함', excluded: '추천 제외', held: '품질 보류' })[item.status] || '확인 필요';
  }
  function renderBacklog() {
    const target = $('learning-queue'); if (!target) return;
    target.replaceChildren(); renderQueue(target);
    if (snapshotError) {
      target.append(status('학습 상태를 서버에서 확인하지 못했어요. 저장된 피드백 원문은 볼 수 있으나 최신 추천·저장 상태는 확인이 필요해요.'));
      target.append(button('학습 상태 다시 확인', () => refreshSnapshot()));
    }
    const unseen = snapshot?.feedback?.filter(job => job.current && !job.exposed_at && sessionFor(job.session_id)) || [];
    if (unseen.length) {
      const heading = text('h3', `${ctx().name}의 미확인 피드백`); target.append(heading);
      for (const job of unseen.slice(0, 3)) {
        const open = button(`${date(sessionFor(job.session_id)?.ended_at)} 피드백 보기`, () => openSession(job.session_id));
        open.dataset.sessionId = job.session_id; target.append(open);
      }
    }
    if (!snapshot) return;
    if(Number.isInteger(snapshot.daily_practice_count))target.append(text('p',`오늘 직접 연습한 표현 ${snapshot.daily_practice_count}개 · 서버 확인 기준`,'help'));
    const recommended = enhancements.recommendedIds(snapshot.recommended_item_ids || []).slice(0, (snapshot.recommended_item_ids || []).length).map(itemOf).filter(canRecommend);
    const collection=document.createElement('details');collection.className='feedback-context';collection.dataset.practiceSurrounding='';collection.append(text('summary','남겨둔 복습 · '+recommended.length+'개'));target.append(collection);
    const content=document.createElement('div');collection.append(content);
    const heading = text('h4', '오늘 추천 표현'); content.append(heading);
    if (!recommended.length) content.append(text('p', '지금 권할 표현이 없어요. 원하면 보관함에서 직접 연습하거나 다음에 대화해요.', 'help'));
    for (const item of recommended.slice(0, 3)) {
      const reason = enhancements.reason(item);
      if (reason) content.append(text('p', `추천 이유: ${reason}`, 'help'));
      content.append(itemCard(item));
    }
    const more = button('오늘 더 연습하기 · 최대 3개', async () => {
      const t = token();
      await deps.rpc('learning_recommend_more', { p_companion_id: t.companion });
      if (same(t)) await refreshSnapshot(t);
    }); more.dataset.action = 'recommend-more'; more.disabled = snapshotError || !queueReady;
    content.append(more);
    const library = document.createElement('details'); library.append(text('summary', '지난 피드백·표현 보관함'));
    let built = false;
    library.addEventListener('toggle', () => {
      if (!library.open || built) return; built = true;
      for (const session of sessions) {
        if (!analysisFor(session.id)) continue;
        library.append(button(`${date(session.ended_at)} 피드백`, () => openSession(session.id)));
      }
      for (const item of snapshot.items) library.append(itemCard(item));
      if (!snapshot.items.length) library.append(text('p', '보관된 표현이 아직 없어요.', 'help'));
    });
    content.append(library);
    if(activePractice && !activePractice.source) {
      target.append(activePractice.box);
      if (activePractice.mode === 'delayed' && suppressed(itemOf(activePractice.itemId))) {
        for (const node of activePractice.gradeButtons) node.disabled = true;
        activePractice.state.textContent = '이 표현은 현재 추천 제외 또는 품질 보류 상태예요. 회상 기록을 새로 저장하지 않았어요.';
      }
    }
  }
  function renderTranscript(target, id) {
    const details = document.createElement('details'); details.append(text('summary', '저장된 대화 기록 보기'));
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return; loaded = true;
      const t = token();
      const node = text('div', '저장된 기록을 확인하고 있어요.'); details.append(node);
      try {
        const rows = await deps.allRows('transcript_events', `session_id=eq.${id}&order=timestamp.asc,id.asc`);
        if (!same(t) || !node.isConnected) return;
        node.replaceChildren();
        for (const row of rows) node.append(text('p', `${row.speaker === 'user' ? '나' : ctx().name}: ${row.text}`));
        if (!rows.length) node.append(text('p', '서버에서 확인된 발화가 없어요. 수신되지 않은 음성은 원본 녹음으로 복구할 수 없어요.'));
      } catch { if (same(t) && node.isConnected) { node.textContent = '저장된 기록을 확인하지 못했어요. 다시 열어 주세요.'; loaded = false; } }
    }); target.append(details);
  }
  function renderFullFeedback(target, analysis) {
    const details = document.createElement('details'); details.append(text('summary', '전체 피드백 보기'));
    let built = false;
    details.addEventListener('toggle', () => {
      if (!details.open || built) return; built = true;
      const content = analysis.content || {};
      for (const [key, title] of [['strengths', '잘한 점'], ['corrections', '교정과 대안'], ['practice', '연습 표현'], ['patterns', '이 기록에서 확인된 패턴']]) {
        if (!content[key]?.length) continue;
        details.append(text('h4', title));
        for (const item of content[key]) {
          const article = document.createElement('div'); article.className = 'feedback-item';
          if (key === 'corrections') article.append(text('small', item.category === 'error' ? '의미·문법 오류' : '선택 가능한 대안'), text('p', item.original, 'original'), text('p', item.improved, 'improved'), text('p', item.reason));
          else article.append(text('p', item.text || item.expression));
          appendEvidence(article, item.evidence_ids, analysis.session_id); details.append(article);
        }
      }
    }); target.append(details);
  }
  const expressionKey = value => String(value || '').toLowerCase().replace(/[\p{P}]/gu, ' ').replace(/\s+/g, ' ').trim();
  function belongsToAnalysis(item, sessionId, analysisId) {
    return item.sources?.some(source => source.session_id === sessionId && source.analysis_id === analysisId) || item.source_session_id === sessionId && item.source_analysis_id === analysisId;
  }
  function sourceProjection(item, analysis) {
    const source = item.sources?.find(source => source.session_id === analysis.session_id && source.analysis_id === analysis.id);
    const correction = analysis.content?.corrections?.find(candidate => expressionKey(candidate.improved) === expressionKey(item.expression));
    const practice = analysis.content?.practice?.find(candidate => expressionKey(candidate.expression || candidate.text) === expressionKey(item.expression));
    const reconsidered = enhancements.acceptedProjection(item, analysis);
    const ownProjection = item.source_session_id === analysis.session_id && item.source_analysis_id === analysis.id;
    return { ...item, source_session_id: analysis.session_id, source_analysis_id: analysis.id,
      original: correction?.original || (ownProjection ? item.original : '') || '',
      next_scenario: analysis.content?.next_scenario || (ownProjection ? item.next_scenario : '') || '',
      reason: reconsidered?.reason || correction?.reason || (ownProjection ? item.reason : '') || '',
      category: reconsidered?.category || correction?.category || (ownProjection ? item.category : '') || 'alternative',
      evidence_ids: reconsidered?.evidence_ids || correction?.evidence_ids || practice?.evidence_ids || (ownProjection ? item.evidence_ids : []) || [],
      has_valid_source: source ? source.valid : item.has_valid_source };
  }
  function renderSession() {
    stopExposure();
    const target = $('learning-session'); if (!target) return;
    target.replaceChildren();
    if (!selected) return;
    const session=sessionFor(selected), job=feedback(selected), analysis=analysisFor(selected), error=errors.get(selected);
    target.dataset.feedbackSession=selected;
    if(session?.record_incomplete || job?.record_incomplete) target.append(status('수신된 기록으로 마무리한 통화예요. 누락된 음성은 포함되지 않아요.'));
    if(snapshotError) {target.append(status('최신 학습 상태를 확인하지 못했어요. 서버 상태를 확인한 뒤 연습을 선택해 주세요.'));target.append(button('학습 상태 다시 확인',()=>refreshSnapshot()));return;}
    if(session && session.status!=='ended') {
      target.append(status('통화 종료와 서버 저장이 아직 확인되지 않았어요. 수신되지 않은 음성은 복구를 보장할 수 없어요.'));
      const finish=button('수신된 기록으로 마무리',async()=>{if(busy())return;const t=token();await ctx().sync();if(!same(t))return;await deps.rpc('learning_finish_partial',{p_session_id:session.id});if(!same(t))return;await deps.refresh();if(same(t))await requestReview(session.id);});finish.dataset.action='finish-partial';target.append(finish);return;
    }
    if(analysis && job?.current===true) {
      const sourceItems=(snapshot?.items||[]).filter(item=>belongsToAnalysis(item,selected,analysis.id)).map(item=>sourceProjection(item,analysis));
      // The historical source, rather than another merged source, determines the
      // controls available on this feedback screen.
      for(const row of document.querySelectorAll('#review-content [data-correction-expression]')) {
        const item=sourceItems.find(item=>expressionKey(item.expression)===expressionKey(row.dataset.correctionExpression));
        const held=item && suppressed(item);
        const hiddenRecall=activePractice?.mode==='delayed'&&!activePractice.saved&&expressionKey(itemOf(activePractice.itemId)?.expression)===expressionKey(row.dataset.correctionExpression);
        row.hidden=Boolean(held||hiddenRecall);
      }
      const primary=sourceItems.find(item=>item.enrolled && item.status!=='candidate' && !suppressed(item));
      if(primary) {
        const details=document.createElement('details');details.className='feedback-context';details.open=Boolean(activePractice?.source && activePractice.itemId===primary.id);
        details.append(text('summary',primary.status==='practiced'?'연습 기록 보기':'표현 하나 연습'));
        if(activePractice?.source && activePractice.itemId===primary.id) details.append(activePractice.box);
        else details.append(itemCard(primary,{sessionId:selected,analysisId:analysis.id}));
        target.append(details);
      }
      if(activePractice?.source?.sessionId===selected&&activePractice.itemId!==primary?.id){
        // Keep an already-open attempt readable when another device excludes its
        // item. Saving stays blocked until the user resolves the queued action.
        const attempt=activePractice,details=document.createElement('details');details.className='feedback-context';details.open=true;details.append(text('summary','연습 저장 상태 확인'),attempt.box);target.append(details);
        attempt.save.disabled=true;attempt.save.dataset.keepDisabled='true';
        attempt.state.textContent=itemPending(attempt.itemId).some(record=>record.state==='conflict')?'최신 상태가 달라 저장하지 않았어요. 연습을 닫고 동기화 안내에서 다시 선택해 주세요.':'이 표현은 현재 추천 제외 또는 품질 보류 상태예요. 새 연습 기록을 저장하지 않았어요.';
      }
      const candidates=sourceItems.filter(item=>(item.status==='candidate'||!item.enrolled)&&!suppressed(item));
      if(candidates.length){const choices=document.createElement('details');choices.className='feedback-context';choices.append(text('summary','원하면 추가 표현 선택 · 후보 최대 3개'));for(const item of candidates.slice(0,3))choices.append(itemCard(item,{sessionId:selected,analysisId:analysis.id},true));target.append(choices);}
      const withheld=sourceItems.filter(suppressed);if(withheld.length){const details=document.createElement('details');details.className='feedback-context';details.append(text('summary','제외·보류한 표현'));for(const item of withheld)details.append(itemCard(item,{sessionId:selected,analysisId:analysis.id}));target.append(details);}
      const core=$('review-content')?.querySelector('.analysis');if(core)core.dataset.feedbackCore='';if(core&&!job.exposed_at)observeExposure(core,selected,analysis.id);
      enhancements.renderUsage(target, selected);
      return;
    }
    if(analysis) target.append(status('원문이 바뀌었거나 최신 여부를 확인하지 못한 피드백이에요. 새 피드백을 확인하기 전에는 연습을 권하지 않아요.'));
    if(job?.has_user_speech===false)target.append(status('확인된 사용자 발화가 없어 피드백을 만들지 않아요.'));
    else if(running(job)||requests.has(selected))target.append(status('피드백을 준비하고 있어요. 홈으로 이동해도 이 회차에서 상태를 확인할 수 있어요. 앱을 닫은 뒤 완료 여부는 다시 확인이 필요해요.'));
    else if(error)target.append(status(error.message));
    else target.append(status('통화 저장과 피드백 상태를 확인해 주세요.'));
    const check=button('피드백 상태 확인',async()=>{const t=token();await refreshSnapshot(t);if(same(t))await deps.refresh();});check.dataset.action='check-feedback';target.append(check);
    if(job?.has_user_speech!==false&&!running(job)&&!requests.has(selected)){const request=button('피드백 만들기 · 재시도는 생성 한도를 사용할 수 있어요',()=>requestReview(selected));request.dataset.action='request-feedback';request.disabled=Boolean(error?.blocked&&(!error.until||Date.now()<error.until));target.append(request);}
    const home=button('홈으로',()=>deps.setView('contacts'));home.dataset.action='home';target.append(home);
  }
  function renderWeekly() {
    const target = $('learning-queue');
    if (target && snapshot && !snapshotError) enhancements.renderWeekly(target, weekly);
  }
  function renderPreview() {
    const home=$('learning-home');if(!home)return;
    const unseen=snapshot?.feedback?.find(job=>job.current&&!job.exposed_at&&sessionFor(job.session_id));
    const recommended=enhancements.recommendedIds(snapshot?.recommended_item_ids||[]).slice(0,(snapshot?.recommended_item_ids||[]).length).map(itemOf).find(canRecommend);
    home.hidden=!unseen&&!recommended;home.disabled=snapshotError;
    home.textContent=unseen?ctx().name+'의 새 피드백 · 지난 통화 피드백이 준비됐어요':recommended?'남겨둔 복습 · '+(enhancements.isDue(recommended.id)?'예약한 표현 가리고 회상':recommended.expression):'';
    home.onclick=openPreview;
  }
  function render() {
    if (!identity || identity !== currentIdentity()) return;
    // Preserve the user's logical focus across status refreshes. No background
    // response chooses a new session, opens a dialog, or enters the review tab.
    const focused = document.activeElement;
    const focusAction = focused?.dataset?.action;
    const focusSelection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    const focusItem = focused?.closest?.('[data-item-id]')?.dataset.itemId;
    const focusConflict = focused?.closest?.('[data-conflict-id]')?.dataset.conflictId;
    const focusSession = focused?.closest?.('[data-feedback-session]')?.dataset.feedbackSession;
    const inReview = focused?.closest?.('#learning-queue, #review-content, #learning-session');
    const expanded = [...document.querySelectorAll('#learning-queue details[open], #review-content details[open], #learning-session details[open]')].map(node => `${node.closest('[id]')?.id}|${node.querySelector('summary')?.textContent}`);
    renderBacklog(); renderSession(); renderWeekly(); renderPreview(); syncPracticeVisibility();
    for (const detail of document.querySelectorAll('#learning-queue details, #review-content details, #learning-session details')) {
      if (expanded.includes(`${detail.closest('[id]')?.id}|${detail.querySelector('summary')?.textContent}`)) detail.open = true;
    }
    if (inReview && focusAction && (!document.activeElement || document.activeElement === document.body)) {
      const candidates = [...document.querySelectorAll('#learning-queue [data-action], #review-content [data-action], #learning-session [data-action]')];
      const replacement = candidates.find(node => node.dataset.action === focusAction && (!focusItem || node.closest('[data-item-id]')?.dataset.itemId === focusItem) && (!focusConflict || node.closest('[data-conflict-id]')?.dataset.conflictId === focusConflict) && (!focusSession || node.closest('[data-feedback-session]')?.dataset.feedbackSession === focusSession));
      if (replacement && !replacement.disabled) {
        replacement.focus({ preventScroll: true });
        if (focusSelection && typeof replacement.setSelectionRange === 'function') replacement.setSelectionRange(...focusSelection);
      }
    }
    if(pendingFocusRestore)setTimeout(pendingFocusRestore,0);
  }
  function observeExposure(node, sessionId, analysisId) {
    const key = `${sessionId}|${analysisId}`;
    if (exposed.has(key) || typeof IntersectionObserver === 'undefined') return;
    const t = token(); let ratio = 0;
    const visible = () => document.visibilityState === 'visible' && ratio >= 0.5 && node.isConnected && !node.closest('[hidden]') && !document.querySelector('dialog[open]');
    const schedule = () => {
      clearTimeout(exposureTimer); exposureTimer = null;
      if (!visible()) return;
      exposureTimer = setTimeout(async () => {
        if (!same(t) || !visible() || exposed.has(key)) return;
        exposed.add(key);
        const stored = await event('feedback_exposed', { sessionId, analysisId }, { foreground: true, visible_ratio: ratio, visible_ms: 1000, status: 'success' }, t);
        if (!stored) { exposed.delete(key); return; }
        if (same(t)) {
          const job = feedback(sessionId); if (job) job.exposed_at = now();
          renderPreview();
        }
      }, 1000);
    };
    exposureObserver = new IntersectionObserver(entries => { ratio = entries[0]?.intersectionRatio || 0; schedule(); }, { threshold: [0, 0.5, 1] });
    exposureObserver.observe(node);
    node._exposureVisibility = schedule;
  }
  function viewed() {
    if (!ensureIdentity()) return;
    panelOpen = !document.querySelector('[data-panel="review"]')?.hidden;
    if (!panelOpen) stopExposure(); else renderSession();
    applyPlan();
  }
  async function openSession(id) {
    if (!ensureIdentity() || !sessionFor(id)) return;
    if (busy()) { notify('현재 통화를 마친 뒤 피드백을 확인해 주세요.'); return; }
    if (activePractice) closePractice();
    selected=id;panelOpen=true;await deps.openSession(id,analysisFor(id));renderSession();
  }
  async function openPreview() {
    if (!ensureIdentity() || busy()) return;
    const unseen = snapshot?.feedback?.find(job => job.current && !job.exposed_at && sessionFor(job.session_id));
    if (unseen) { await openSession(unseen.session_id); return; }
    const item = enhancements.recommendedIds(snapshot?.recommended_item_ids || []).slice(0,(snapshot?.recommended_item_ids || []).length).map(itemOf).find(canRecommend);
    if (item) { deps.setView('review');if(enhancements.isDue(item.id))startRecall(item.id);else await startPractice(item.id, null); }
    else { deps.setView('review'); viewed(); }
  }
  async function requestReview(id) {
    if (!ensureIdentity() || requests.has(id)) return;
    const t = token(), session = sessionFor(id);
    if (!session || session.status !== 'ended') return;
    // Snapshot is the lease and source-version query. A timeout alone never
    // authorizes a second job, and a changed input can clear a size blocker.
    if (!await refreshSnapshot(t) || !same(t)) return;
    const existingError = errors.get(id);
    if (existingError?.blocked && (!existingError.until || Date.now() < existingError.until)) { notify(existingError.message); return; }
    const job = feedback(id);
    if (job?.current) { errors.delete(id); persistBlockers(); if (!analysisFor(id)) await deps.refresh(); return; }
    if (job?.has_user_speech === false || running(job)) return;
    requests.add(id); errors.delete(id); render(); callStatus('통화는 서버에 저장됐어요 · 피드백 준비 중');
    try {
      const result=await deps.edge('review', { sessionId: id });
      if (!same(t)) return;
      const analysis=result?.analysis;
      if(!analysis?.id||analysis.session_id!==id||!analysis.content||analysis.content.scope?.companionId&&analysis.content.scope.companionId!==t.companion)throw Error('이번 통화의 피드백 저장 결과를 확인하지 못했어요.');
      // The committed review response is independent of a later history fetch.
      // Keep it available even when the history endpoint is temporarily down.
      const accepted={...analysis,companion_id:t.companion};
      analyses=[accepted,...analyses.filter(row=>row.id!==accepted.id)];errors.delete(id);persistBlockers();
      try{deps.onAnalysis?.(accepted);}catch{notify('피드백은 서버에 저장됐어요. 화면을 새로고침해 주세요.');}
      await refreshSnapshot(t);
      if (!same(t)) return;
      callStatus('통화와 피드백 서버 저장 확인');
      try{await deps.refresh();}catch{if(same(t))notify('통화와 피드백은 서버에 저장됐어요. 최근 통화 목록을 새로고침해 주세요.');}
      if(same(t))callStatus('통화와 피드백 서버 저장 확인');
    } catch (error) {
      if (!same(t)) return;
      const state = recovery(error); state.sourceVersion = feedback(id)?.source_version || null; errors.set(id, state); persistBlockers();
      // This event describes the failed request, not a failed server generation.
      await event('flow_failure', { sessionId: id }, { stage: 'analysis', reason: ({ quota: 'quota', input_too_large: 'input_too_large', auth: 'auth', no_speech: 'unknown', processing: 'unknown', service: 'network', unconfirmed: 'network' })[state.code] || 'unknown', status: 'failure' }, t);
      if (!same(t)) return;
      await refreshSnapshot(t);
      if (same(t)) { notify(state.message); callStatus('통화 저장 확인 · 피드백 완료 여부 확인 필요'); }
    } finally {
      if (same(t)) { requests.delete(id); render(); schedulePoll(); }
    }
  }
  async function saved(session) {
    if (!ensureIdentity() || session?.companion_id !== companion) return;
    if (!sessionFor(session.id)) sessions.unshift(session);
    else sessions = sessions.map(row => row.id === session.id ? session : row);
    render();
    await requestReview(session.id);
  }
  function interrupted(session, warning) {
    if (!ensureIdentity() || session?.companion_id !== companion) return;
    if (!sessionFor(session.id)) sessions.unshift(session);
    else sessions = sessions.map(row => row.id === session.id ? { ...row, ...session } : row);
    errors.set(session.id, { message: warning || '서버 저장이 끝나지 않았어요. 수신된 발화만 기기 대기열에 있을 수 있으며, 수신되지 않은 음성은 복구를 보장할 수 없어요.', code: 'record_unconfirmed' });
    render();
  }

  function startRecall(id, trigger = null) {
    if (!ensureIdentity() || busy() || snapshotError) return;
    const item = itemOf(id);
    if (!item || suppressed(item) || itemPending(id).length || !enhancements.isDue(id)) return;
    const t = token(), attemptId = uuid();
    const attempt = { id: attemptId, itemId: id, source: null, t, saved: false, mode: 'delayed' };
    attempts.set(attemptId, attempt); activePractice = attempt; pendingFocusRestore = null;
    previousFocus = trigger || document.activeElement;
    previousFocusKey = { action: 'start-delayed-recall', itemId: id, container: 'learning-queue' };
    Object.assign(attempt, enhancements.buildRecall(item, {
      attemptId, close: closePractice,
      current: () => same(t) && activePractice === attempt,
      saved: () => attempt.saved,
      confirm: () => confirmRecall({ body: { _enhancement: { attemptId } } })
    }));
    deps.setView('review'); render(); attempt.toggle.focus();
  }
  function confirmRecall(record) {
    const attempt = activePractice;
    if (!attempt || attempt.mode !== 'delayed' || attempt.saved || record.body?._enhancement?.attemptId !== attempt.id || !same(attempt.t)) return;
    attempt.saved = true; syncPracticeVisibility();
    attempt.state.textContent = '시간을 둔 회상 자기보고를 서버에 저장했어요. 즉시 따라 말하기와 별도 기록이에요.';
    for (const node of attempt.gradeButtons) node.hidden = true;
    attempt.toggle.hidden = true; attempt.finish.replaceChildren();
    const prepare = button('다음 통화 준비', () => prepareNext(attempt.itemId)); prepare.dataset.action = 'prepare-next';
    attempt.finish.append(prepare);
  }
  async function startPractice(id, attribution, trigger=null) {
    if (!ensureIdentity() || busy() || snapshotError) return;
    const canonical = itemOf(id);
    const analysis=attribution?.sessionId?analyses.find(row=>row.id===attribution.analysisId):null;
    const item=canonical&&analysis?sourceProjection(canonical,analysis):canonical;
    if (!item || suppressed(item) || itemPending(id).length || !item.enrolled || item.status==='candidate') return;
    if (attribution?.analysisId && item.sources && !item.sources.some(source => source.analysis_id === attribution.analysisId && source.session_id === attribution.sessionId && source.valid)) { notify('이 출처는 현재 연습 추천에서 보류됐어요. 유효한 새 피드백을 확인해 주세요.'); return; }
    pendingFocusRestore=null;
    const t = token(), attemptId = uuid();
    // Attribution is fixed at the explicit click. A merged item is never counted
    // toward every source; home and library clicks intentionally have no source.
    const source = attribution?.sessionId && attribution?.analysisId ? attribution : null;
    const attempt = { id: attemptId, itemId: id, source, t, saveId: null, saved: false, mode: 'rephrase' };
    attempts.set(attemptId, attempt); activePractice = attempt;
    previousFocus = trigger||document.activeElement;
    previousFocusKey = {action:'practice',itemId:id,container:trigger?.closest?.('#learning-session, #learning-queue')?.id||(source?'learning-session':'learning-queue')};
    const box=document.createElement('section');box.className='learning-practice';box.dataset.itemId=id;attempt.box=box;const target=box;
    if (!target) { notify('연습 창을 열지 못했어요. 다시 선택해 주세요.'); return; }
    target.replaceChildren();
    const intro = text('p', '단서를 보고 같은 뜻을 영어로 말해 보세요. 똑같이 외울 필요는 없고, 표현을 다시 봐도 괜찮아요.', 'help');
    const cue = practiceCue(item, enhancements.scheduleFor(id)?.goal);
    const original = text('p', cue.value, cue.kind === 'source' ? 'original' : 'help'); original.dataset.practiceCue = cue.kind;
    const expression = text('p', item.expression, 'improved'); expression.dataset.practiceExpression = ''; expression.hidden = true;
    const reason = text('p', item.reason); reason.hidden = true;
    const assistance = text('p', '교정 뒤 다시 말해본 연습으로 기록해요. 녹음·자동 채점은 하지 않아요.', 'help');
    const toggle = button('표현 다시 보기 · 도움 받기', () => {
      if (!same(t) || activePractice !== attempt || attempt.saved) return;
      expression.hidden = !expression.hidden;
      reason.hidden = expression.hidden;
      toggle.textContent = expression.hidden ? '표현 다시 보기 · 도움 받기' : '표현 가리고 내 말로';
      assistance.textContent = '표현을 참고했어요. 가리고 다시 말해봐도 좋아요. 녹음·자동 채점은 하지 않아요.';
      toggle.setAttribute('aria-expanded', String(!expression.hidden));
    }); toggle.dataset.action = 'toggle-expression'; toggle.setAttribute('aria-expanded', 'false');
    const state = status('아직 연습 기록을 저장하지 않았어요.'); state.dataset.practiceStatus = '';
    const finish = document.createElement('div');
    const save = button('직접 연습했어요', async () => {
      if (!same(t) || activePractice !== attempt || attempt.saved) return;
      save.disabled = true;
      const payload = { attempt_id: attemptId, attribution: source ? 'session' : 'library', source_session_id: source?.sessionId || null, source_analysis_id: source?.analysisId || null };
      const operation = act(itemOf(id), 'practice', payload);
      state.textContent = '기기 보관과 서버 저장을 확인하고 있어요.';
      const confirmed = await operation;
      if (!same(t) || activePractice !== attempt || !state.isConnected) return;
      attempt.saveId = [...pending].find(record => record.body?.p_action === 'practice' && record.body?.p_payload?.attempt_id === attemptId)?.id || null;
      if (confirmed) {
        attempt.saved = true; syncPracticeVisibility(); state.textContent = '교정 뒤 다시 말해본 기록을 서버에 저장했어요.';
        save.hidden = true; toggle.hidden = true; finish.replaceChildren();
        const home = button('홈으로', () => { closePractice(); panelOpen = false; deps.setView('contacts'); }, true); home.dataset.action = 'home';
        const prepare = button('다음 통화 준비', () => prepareNext(id)); prepare.dataset.action = 'prepare-next';
        finish.append(home, prepare);
      } else {
        const records = itemPending(id);
        state.textContent = records.some(record => record.state === 'conflict') ? '최신 상태가 달라 저장하지 않았어요. 연습 창을 닫고 동기화 안내에서 다시 선택해 주세요.' : records.length ? '기기 보관 확인 · 서버 반영 대기. 서버 확인 전에는 연습 완료로 표시하지 않아요.' : '저장하지 못했어요. 다시 선택해 주세요.';
        save.disabled = records.length > 0; save.dataset.keepDisabled = String(records.length > 0);
      }
    }, true); save.dataset.action = 'save-practice'; save.disabled = true;
    const later = button('나중에 하기', async () => {
      if (!same(t)) return;
      const confirmed = await act(itemOf(id), 'defer');
      if (!same(t) || !state.isConnected) return;
      state.textContent = confirmed ? '나중에 하기를 서버에 저장했어요. 연습 수행으로 기록하지 않았어요.' : itemPending(id).length ? '기기 보관 확인 · 나중에 하기 서버 반영 대기' : '저장하지 못했어요. 다시 선택해 주세요.';
      if (confirmed) { later.disabled = true; later.dataset.keepDisabled = 'true'; save.hidden = true; }
    }); later.dataset.action = 'defer';
    Object.assign(attempt, { state, save, toggle, finish });
    const actions=document.createElement('div');actions.className='learning-actions';actions.append(toggle,save,later);
    const close=button('연습 닫기',closePractice);close.dataset.action='close-practice';actions.append(close);
    target.append(text('h4', '같은 뜻을 내 말로'), intro, text('small', cue.label), original, expression, reason, assistance, actions, state, finish);
    const home = button('홈으로', () => { closePractice(); panelOpen = false; deps.setView('contacts'); }); home.dataset.action = 'home'; target.append(home);
    render();toggle.focus();
    const started = await event('practice_started', { sessionId: source?.sessionId, analysisId: source?.analysisId, itemId: id, attemptId }, { attribution: source ? 'session' : 'library', status: 'success' }, t);
    if (same(t) && activePractice === attempt) {
      save.disabled = !started;
      if (!started) state.textContent = '연습 시작을 기기에 보관하지 못했어요. 닫은 뒤 다시 선택해 주세요. 완료로 기록하지 않았어요.';
    }
  }
  function confirmPractice(record) {
    const attempt = activePractice;
    if (!attempt || record.body?.p_payload?.attempt_id !== attempt.id || !same(attempt.t) || !attempt.state?.isConnected) return;
    attempt.saved = true; syncPracticeVisibility();
    attempt.state.textContent = '교정 뒤 다시 말해본 기록을 서버에 저장했어요.';
    attempt.save.hidden = true; attempt.toggle.hidden = true; attempt.finish.replaceChildren();
    const home = button('홈으로', () => { closePractice(); panelOpen = false; deps.setView('contacts'); }, true); home.dataset.action = 'home';
    const prepare = button('다음 통화 준비', () => prepareNext(attempt.itemId)); prepare.dataset.action = 'prepare-next';
    attempt.finish.append(home, prepare);
  }
  async function recordConnected(sessionId, receipt = null) {
    if (!ensureIdentity() || !validId(sessionId)) return false;
    return await event('call_connected', { sessionId }, { attribution: 'session', new_session_id: sessionId, status: 'success' }, token(), receipt);
  }
  async function prepareNext(id) {
    const item = itemOf(id);
    if (!item || suppressed(item) || busy()) return;
    if (!queueReady || hasPendingExclusions()) { notify('제외·보류 선택을 먼저 확인해 주세요. 확인 전에는 학습 목표 없이 일반 대화를 시작할 수 있어요.'); return; }
    const t = token();
    const confirmed = await act(item, 'prepare_next');
    if (!same(t) || !confirmed) return;
    applyPlan(); closePractice(); deps.setView('contacts');
    notify(snapshot?.next_plan ? '다음 통화 준비를 저장했어요. 상황을 바꾸거나 원할 때 통화를 시작하세요.' : '연결할 목표 상황을 확인할 수 없어 일반 주제로 안내해요.');
  }
  async function getBackup() {
    if (!ensureIdentity()) return [];
    const t = token();
    const rows = await outbox.list(t.scope);
    if (!same(t)) throw Error('백업 중 계정이나 상대가 바뀌었어요. 다시 선택해 주세요.');
    if (rows.some(record => record.kind === 'action') || volatile.size) throw Error('서버 확인 전인 복습 선택이 있어요. 저장·충돌 상태를 먼저 확인한 뒤 백업해 주세요.');
    const items = await deps.allRows('learning_state_items', 'order=created_at.asc,id.asc');
    if (!same(t)) throw Error('백업 중 계정이나 상대가 바뀌었어요. 다시 선택해 주세요.');
    const sources = await deps.allRows('learning_sources', 'order=item_id.asc,analysis_id.asc');
    if (!same(t)) throw Error('백업 중 계정이나 상대가 바뀌었어요. 다시 선택해 주세요.');
    const holds = await deps.allRows('learning_source_holds', 'order=created_at.asc,id.asc');
    if (!same(t)) throw Error('백업 중 계정이나 상대가 바뀌었어요. 다시 선택해 주세요.');
    const extended = await Promise.all([...new Set(items.map(item => item.companion_id))].map(async companionId => {
      const value = unwrap(await deps.rpc('learning_enhancement_snapshot', { p_companion_id: companionId }));
      if (!value || !['reviews', 'schedules', 'recalls', 'usage', 'weekly_goals'].every(key => Array.isArray(value[key]))) throw Error('회상·재검토 이력을 확인하지 못해 불완전한 백업을 만들지 않았어요.');
      return value;
    }));
    if (!same(t)) throw Error('백업 중 계정이나 상대가 바뀌었어요. 다시 선택해 주세요.');
    return items.map(item => {
      const { user_id: ignored, ...safe } = item;
      const ownedSources = sources.filter(source => source.item_id === item.id);
      const sessionId = ownedSources[0]?.session_id || item.restored_session_id;
      if (!sessionId) throw Error('표현과 원본 회차의 연결을 확인하지 못했어요. 불완전한 복습 백업은 만들지 않았어요.');
      const held = holds.filter(hold => ownedSources.some(source => source.session_id === hold.session_id && (hold.reason === 'intent' ? hold.item_id === item.id : !hold.evidence_ids?.length || hold.evidence_ids.some(id => source.evidence_ids?.includes(id)))) || hold.session_id === item.restored_session_id && (hold.reason === 'wrong_transcript' || hold.item_id === item.id));
      const held_sources = [...new Map(held.map(hold => [`${hold.session_id}|${hold.reason}`, { session_id: hold.session_id, reason: hold.reason }])).values()];
      const enhancements = Object.fromEntries(['reviews', 'schedules', 'recalls', 'usage', 'weekly_goals', 'imports'].map(key => [key, extended.flatMap(value => value[key] || []).filter(row => row.item_id === item.id).map(row => {
        const { user_id: ignored, ...portable } = row;
        return { ...portable, item_expression: item.expression, source_session_id: row.source_session_id || sessionId };
      })]));
      return { ...safe, source_session_id: sessionId, held_sources, enhancements };
    });
  }
  async function restoreBackup(items = []) {
    if (!ensureIdentity()) return { restored: 0 };
    if (!Array.isArray(items)) throw Error('복습 백업 형식을 확인해 주세요.');
    const t = token(); let restored = 0;
    for (let offset = 0; offset < items.length; offset += 50) {
      if (!same(t)) throw Error(`계정이나 상대가 바뀌었어요. 앞선 ${restored}개 요청만 전송했어요.`);
      try { await deps.rpc('learning_restore', { p_items: items.slice(offset, offset + 50) }); restored += Math.min(50, items.length - offset); }
      catch { throw Error(`복습 이력 ${restored}개 항목의 복원 요청을 전송했어요. ${offset + 1}번째 이후 배치를 확인하지 못했어요. 같은 백업으로 다시 시도할 수 있어요.`); }
    }
    for (let offset = 0; offset < items.length; offset += 50) {
      if (!same(t)) throw Error('복습 이력 요청은 전송했어요. 회상·재검토 이력 복원 중 계정이나 상대가 바뀌어 중단했어요. 같은 백업으로 다시 시도할 수 있어요.');
      const batch = items.slice(offset, offset + 50);
      const p_data = Object.fromEntries(['reviews', 'schedules', 'recalls', 'usage', 'weekly_goals', 'imports'].map(key => [key, batch.flatMap(item => {
        const values = item.enhancements?.[key] || [];
        if (!Array.isArray(values)) throw Error('회상·재검토 백업 형식을 확인해 주세요.');
        return values;
      })]));
      if (!Object.values(p_data).some(rows => rows.length)) continue;
      try { await deps.rpc('learning_enhancement_restore', { p_data }); }
      catch { throw Error('기본 복습 이력 요청은 전송했어요. 회상·재검토·활용 이력의 일부 복원은 확인하지 못했어요. 기존 서버 기록은 유지되며 같은 백업으로 다시 시도할 수 있어요.'); }
    }
    if (same(t)) await refreshSnapshot(t);
    return { restored };
  }
  function show(analysis) {
    if(!ensureIdentity()||!analysis?.session_id)return;
    selected=analysis.session_id;panelOpen=true;
    analyses=[analysis,...analyses.filter(row=>row.id!==analysis.id)];
    if(!sessionFor(selected))sessions.unshift({id:selected,companion_id:companion,status:'ended'});
    renderSession();void refreshSnapshot();
  }
  function selectSession(session) {
    if(!ensureIdentity()||!session?.id)return;
    selected=session.id;sessions=[session,...sessions.filter(row=>row.id!==session.id)];renderSession();void refreshSnapshot();
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(exposureTimer); exposureTimer = null;
    if (document.visibilityState === 'visible') {
      const node = $('review-content')?.querySelector('[data-feedback-core]'); node?._exposureVisibility?.();
    }
  });
  window.addEventListener('online', () => { if (identity && identity === currentIdentity()) { void flush(); void refreshSnapshot(); } });
  function getPlan(){if(!identity||identity!==currentIdentity()||snapshotError||hasPendingExclusions())return null;const plan=snapshot?.next_plan;const item=itemOf(plan?.item_id||plan?.target_item_id);return plan&&item&&!suppressed(item)?plan:null;}
  return { getPlan, show, selectSession, load, openSession, saved, interrupted, openPreview, clear, viewed, hasPendingExclusions, flush, getBackup, restoreBackup, requestReview, prepareNext, recordConnected };
}
