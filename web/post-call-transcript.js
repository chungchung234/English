import { recordTimeLabel, sessionTimeLabel, sessionTimeZone } from './conversation-time.js';

const text = (tag, value, className) => {
  const node = document.createElement(tag); node.textContent = value || '';
  if (className) node.className = className;
  return node;
};
const keyOf = row => row.event_key || row.id;
const ordered = rows => [...rows].sort((a, b) => String(a.occurred_at || a.timestamp || '').localeCompare(String(b.occurred_at || b.timestamp || '')) || String(a.id).localeCompare(String(b.id)));

// This view is independent of feedback generation. Received text, durable device
// storage and acknowledged server storage are deliberately distinct states.
export function createPostCallTranscript({ context, allRows, pendingRows }) {
  let state = null, version = 0, pendingSource = null;
  const valid = value => {
    const current = context();
    return value && state === value && value.scope === current.scope && value.companionId === current.companionId && value.sessionId === current.sessionId;
  };
  function clear() { version++; state = null; pendingSource = null; document.getElementById('post-call-transcript')?.remove(); }
  // Keep the reading surface mounted as storage and feedback settle. Rebuilding
  // the transcript would discard selection/focus and move a reader mid-sentence.
  function mount() {
    let host = document.getElementById('post-call-transcript');
    if (host?.dataset.sessionId === state.sessionId) return host;
    host?.remove();
    host = text('section', '', 'session-transcript');
    host.id = 'post-call-transcript'; host.dataset.postCallTranscript = ''; host.dataset.sessionId = state.sessionId;
    host.setAttribute('aria-label', '대화 원문');
    const meta = text('p', '', 'transcript-meta'); meta.dataset.transcriptMeta = '';
    meta.append(text('span', '', 'transcript-companion'), document.createTextNode(' · '));
    const status = text('span', '', 'transcript-save-state'); status.dataset.transcriptStatus = '';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); meta.append(status);
    const recovery = text('div', '', 'transcript-recovery'); recovery.hidden = true;
    const retry = text('button', '대화문 저장 상태 다시 확인', 'text-button'); retry.type = 'button'; retry.dataset.action = 'retry-post-call-transcript';
    retry.onclick = () => { if (valid(state)) void load(state); }; recovery.append(retry);
    const events = text('div', '', 'transcript-events'); events.dataset.transcriptEvents = '';
    const empty = text('p', '', 'help transcript-empty'); empty.dataset.transcriptEmpty = ''; events.append(empty);
    const info = document.createElement('details'); info.className = 'transcript-record-info';
    const summary = text('summary', '기록 정보'); summary.dataset.action = 'toggle-transcript-record-info';
    const timing = text('p', '', 'help'); timing.dataset.sessionTime = '';
    const measurement = text('p', '', 'help'); measurement.dataset.callSaveDuration = ''; measurement.hidden = true;
    const detailStatus = text('p', '', 'help'); detailStatus.dataset.transcriptStorageDetail = '';
    const note = text('p', '자동 전사된 기록이에요. 중간에 멈춘 답변은 실제로 들은 내용과 다를 수 있어요.', 'help');
    const timeNote = text('p', '기록 시각은 발화를 수신한 때이며 실제 말하기 시작 시각과 다를 수 있어요.', 'help');
    const stamps = text('div', '', 'transcript-record-times'); stamps.dataset.transcriptRecordTimes = '';
    info.append(summary, timing, measurement, detailStatus, note, timeNote, stamps);
    host.append(meta, recovery, events, info);
    document.getElementById('review-content').after(host);
    return host;
  }
  const updateText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function render() {
    if (!valid(state)) return;
    const host = mount(), current = state.current;
    // Preserve the visible utterance when a late earlier event is inserted or
    // status text wraps. At the top of the page, keep the normal top position.
    const anchor = window.scrollY > 0 && host.getClientRects().length
      ? [...host.querySelectorAll('[data-transcript-event-id]')].find(node => node.getBoundingClientRect().bottom > 0)
      : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const session = { ...state.session, ...(current?.created_at ? { created_at: current.created_at } : {}), ...(current?.ended_at ? { ended_at: current.ended_at } : {}), ...(current?.time_zone ? { time_zone: current.time_zone } : {}) };
    const zone = sessionTimeZone(session).zone;
    const hasSessionTime = session.created_at && Object.hasOwn(session, 'time_zone');
    updateText(host.querySelector('[data-session-time]'), hasSessionTime ? sessionTimeLabel(session) : state.metadataFailed ? '통화 시각과 시간대를 확인하지 못했어요.' : '통화 시각과 시간대를 확인하고 있어요.');
    const phase = current?.transcriptPhase || state.phase;
    const rows = ordered((current?.transcript || state.rows).values());
    const pending = rows.filter(row => row.storage !== 'server').length;
    const incomplete = current?.recordIncomplete || state.recordIncomplete;
    const duration = Number.isFinite(current?.durationMs) && current.durationMs >= 0 ? Math.floor(current.durationMs / 1000) : null;
    updateText(host.querySelector('.transcript-companion'), state.name + (duration === null ? '' : ` · ${Math.floor(duration / 60)}분 ${duration % 60}초`));
    const compactStatus = phase === 'finalizing' ? '마지막 대화 확인 중'
      : phase === 'partial' || state.error ? '저장 확인 필요'
      : state.loading && !rows.length ? '기록 확인 중'
      : pending ? '서버 저장 대기'
      : incomplete ? '수신된 대화 저장됨'
      : rows.length ? '대화 저장됨' : '저장된 발화 없음';
    updateText(host.querySelector('[data-transcript-status]'), compactStatus);
    host.dataset.transcriptPhase = phase;
    let message = phase === 'finalizing' ? '마지막 발화의 전사와 서버 저장을 확인하고 있어요. 지금까지 수신한 대화는 먼저 읽을 수 있어요.'
      : phase === 'partial' ? '전사 또는 통화 저장이 미완료예요. 지금까지 수신한 발화만 표시하며, 누락된 음성은 복구를 보장할 수 없어요.'
      : state.loading ? '서버 대화문과 이 기기의 전송 대기 기록을 확인하고 있어요.'
      : state.error ? '대화문 전체의 저장 상태를 확인하지 못했어요. 확인된 발화만 표시하며, 기기·서버 기록은 다시 확인해 주세요.'
      : pending ? `${pending}개 발화의 서버 반영 대기 · 기기 보관 여부는 아래 기록에 표시돼요.`
      : rows.length ? '대화문 서버 저장 확인 · 피드백은 별도로 준비돼요.'
      : '서버에서 확인된 발화가 없어요. 수신되지 않은 음성은 기록에 포함되지 않아요.';
    if (phase === 'saved' && incomplete) message = '수신된 기록으로 마무리한 통화예요. 누락된 음성은 포함되지 않아요.';
    updateText(host.querySelector('[data-transcript-storage-detail]'), message);
    const measurement = host.querySelector('[data-call-save-duration]');
    measurement.hidden = !(phase === 'saved' && Number.isFinite(current?.saveDurationMs) && current.saveDurationMs >= 0);
    if (!measurement.hidden) updateText(measurement, `통화 종료부터 저장 확인까지 ${(current.saveDurationMs / 1000).toFixed(1)}초 · 피드백 준비 시간은 별도예요.`);
    host.querySelector('.transcript-recovery').hidden = !(state.error || phase === 'partial');
    const events = host.querySelector('[data-transcript-events]'), stamps = host.querySelector('[data-transcript-record-times]');
    const blocks = new Map([...events.querySelectorAll('[data-transcript-key]')].map(node => [node.dataset.transcriptKey, node]));
    const stampNodes = new Map([...stamps.children].map(node => [node.dataset.transcriptKey, node]));
    const keys = new Set();
    let previous = null, previousStamp = null;
    for (const row of rows) {
      const key = String(keyOf(row)); keys.add(key);
      let block = blocks.get(key), stamp = stampNodes.get(key);
      if (!block) {
        block = text('div', '', 'transcript-turn'); block.dataset.transcriptKey = key; block.tabIndex = -1;
        block.append(text('p', '', 'transcript-speaker'), text('p', '', 'transcript-text'));
      }
      block.dataset.transcriptEventId = row.id; block.dataset.storage = row.storage || 'received'; block.dataset.speaker = row.speaker;
      updateText(block.querySelector('.transcript-speaker'), row.speaker === 'user' ? '나' : state.name);
      updateText(block.querySelector('.transcript-text'), row.text || '');
      // insertBefore only when order actually changes, preserving selection and focus.
      const next = previous ? previous.nextElementSibling : events.firstElementChild;
      if (next !== block) events.insertBefore(block, next);
      previous = block;
      if (!stamp) { stamp = text('p', '', 'transcript-record-time'); stamp.dataset.transcriptKey = key; }
      const storage = row.storage === 'server' ? '서버 저장 확인' : row.storage === 'device' ? '이 기기 보관 확인 · 서버 전송 대기' : row.storage === 'failed' ? '기기 보관과 서버 저장을 확인하지 못했어요.' : '수신한 발화 · 기기 보관 확인 중';
      updateText(stamp, `${row.speaker === 'user' ? '나' : state.name} · ${recordTimeLabel(row.occurred_at || row.timestamp, zone)} · ${storage}`);
      const nextStamp = previousStamp ? previousStamp.nextElementSibling : stamps.firstElementChild;
      if (nextStamp !== stamp) stamps.insertBefore(stamp, nextStamp);
      previousStamp = stamp;
    }
    for (const [key, block] of blocks) if (!keys.has(key)) block.remove();
    for (const [key, stamp] of stampNodes) if (!keys.has(key)) stamp.remove();
    const empty = events.querySelector('[data-transcript-empty]'); empty.hidden = rows.length > 0;
    updateText(empty, phase === 'finalizing' ? '아직 수신된 대화문이 없어요. 마지막 발화를 확인하고 있어요.' : state.loading || state.error ? '기록을 확인하고 있어요.' : '저장된 발화가 없어요.');
    if (anchor?.isConnected && host.getClientRects().length) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > .5) window.scrollBy({ top: delta, behavior: 'instant' });
    }
    fulfillSource();
  }
  function cancelSource() { pendingSource = null; }
  function fulfillSource() {
    const request = pendingSource;
    if (!request) return false;
    let active = false;
    try { active = request.isActive(); } catch { /* A vanished view cancels navigation. */ }
    if (!valid(request.state) || !active) { pendingSource = null; return false; }
    const wanted = new Set(request.ids), host = document.getElementById('post-call-transcript');
    if (!host) return false;
    let first;
    for (const block of host.querySelectorAll('[data-transcript-event-id]')) {
      const matches = wanted.has(block.dataset.transcriptEventId) || wanted.has(block.dataset.transcriptKey);
      block.toggleAttribute('data-source-highlight', matches);
      if (matches && !first) first = block;
    }
    if (!first) return false;
    pendingSource = null;
    first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  }
  function showSource(ids, { isActive = () => true } = {}) {
    pendingSource = null;
    if (!valid(state) || !Array.isArray(ids) || !ids.length) return false;
    pendingSource = { state, ids: [...ids], isActive };
    return fulfillSource();
  }
  async function loadSessionMetadata(value, request) {
    let session;
    try {
      const sessions = await allRows('sessions', `id=eq.${value.sessionId}`);
      session = sessions.find(row => row.id === value.sessionId && row.companion_id === value.companionId);
    } catch { /* Optional time metadata does not determine transcript readiness. */ }
    if (!valid(value) || request !== version) return;
    if (session) value.session = { ...value.session, ...session };
    value.metadataFailed = !(value.session.created_at && Object.hasOwn(value.session, 'time_zone'));
    render();
  }
  async function load(value) {
    if (!valid(value)) return;
    const request = ++version; value.loading = true; value.error = false; value.metadataFailed = false; render();
    if (!value.session.created_at || !Object.hasOwn(value.session, 'time_zone')) void loadSessionMetadata(value, request);
    const results = await Promise.allSettled([
      allRows('transcript_events', `session_id=eq.${value.sessionId}&order=timestamp.asc,id.asc`), pendingRows(value.scope)
    ]);
    if (!valid(value) || request !== version) return;
    const rows = value.current?.transcript || value.rows;
    if (results[1].status === 'fulfilled') for (const record of results[1].value.filter(record => record.sessionId === value.sessionId)) {
      const row = record.event, existing = rows.get(keyOf(row));
      if (existing?.storage !== 'server') rows.set(keyOf(row), { ...row, storage: 'device' });
    }
    if (results[0].status === 'fulfilled') {
      for (const row of results[0].value.filter(row => row.session_id === value.sessionId)) rows.set(keyOf(row), { ...row, occurred_at: row.timestamp || row.occurred_at, storage: 'server' });
    }
    value.error = results.some(result => result.status === 'rejected');
    value.loading = false; render();
  }
  function select(session, { name, current = null } = {}) {
    const owner = context();
    if (!session || !owner.scope || session.companion_id !== owner.companionId) { clear(); return; }
    if (state?.scope === owner.scope && state.sessionId === session.id && state.companionId === session.companion_id) {
      if (current) state.current = current;
      state.session = { ...state.session, ...Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined)) };
      if (session.record_incomplete !== undefined) state.recordIncomplete = session.record_incomplete;
      if (state.current?.transcriptPhase !== 'finalizing') {
        state.phase = session.status === 'ended' ? 'saved' : 'partial';
        if (state.current) { state.current.transcriptPhase = state.phase; state.current.recordIncomplete = state.recordIncomplete; }
        if (!state.loading) void load(state);
      }
      render(); return;
    }
    version++; pendingSource = null;
    state = { scope: owner.scope, sessionId: session.id, companionId: session.companion_id, session: { ...session }, name: name || session.companion_id, current, rows: new Map(), phase: session.status === 'ended' ? 'saved' : 'partial', recordIncomplete:session.record_incomplete, loading: !current, error: false };
    document.getElementById('post-call-transcript')?.remove(); render();
    if (!current) void load(state);
  }
  return {
    clear, select, showSource, cancelSource,
    getRows() { return valid(state) ? ordered((state.current?.transcript || state.rows).values()).map(row => ({ ...row })) : []; },
    prioritizeFeedback() { if (valid(state)) render(); },
    changed(current) { if (state?.current === current) render(); },
    confirm(scope, sessionId, events) {
      if (!valid(state) || state.scope !== scope || state.sessionId !== sessionId) return;
      const rows = state.current?.transcript || state.rows;
      for (const event of events) { const existing = rows.get(keyOf(event)); if (existing) existing.storage = 'server'; }
      render();
    }
  };
}
