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
  let state = null, version = 0;
  const valid = value => {
    const current = context();
    return value && state === value && value.scope === current.scope && value.companionId === current.companionId && value.sessionId === current.sessionId;
  };
  function clear() { version++; state = null; document.getElementById('post-call-transcript')?.remove(); }
  function render() {
    if (!valid(state)) return;
    const focused = document.activeElement?.closest('#post-call-transcript') ? document.activeElement.dataset.action : null;
    let host = document.getElementById('post-call-transcript');
    if (!host) {
      host = text('section', '', 'analysis'); host.id = 'post-call-transcript'; host.dataset.postCallTranscript = '';
    }
    const review = document.getElementById('review-content');
    if (state.feedbackFirst) { if (review.nextElementSibling !== host) review.after(host); }
    else if (host.nextElementSibling !== review) review.before(host);
    const wasOpen = host.querySelector('details')?.open ?? true;
    host.replaceChildren(); host.dataset.sessionId = state.sessionId;
    host.append(text('h3', `${state.name}와 나눈 대화문`));
    const current = state.current;
    const phase = current?.transcriptPhase || state.phase;
    const rows = ordered((current?.transcript || state.rows).values());
    const pending = rows.filter(row => row.storage !== 'server').length;
    let message = phase === 'finalizing' ? '통화 음성을 종료했어요. 마지막 발화의 전사와 서버 저장을 확인하고 있어요.'
      : phase === 'partial' ? '전사 또는 통화 저장이 미완료예요. 지금까지 수신한 발화만 표시하며, 누락된 음성은 복구를 보장할 수 없어요.'
      : state.loading ? '서버 대화문과 이 기기의 전송 대기 기록을 확인하고 있어요.'
      : state.error ? '대화문 전체의 저장 상태를 확인하지 못했어요. 확인된 발화만 표시하며, 기기·서버 기록은 다시 확인해 주세요.'
      : pending ? `${pending}개 발화의 서버 반영 대기 · 기기 보관 여부는 각 발화에 표시돼요.`
      : rows.length ? '대화문 서버 저장 확인 · 피드백은 별도로 준비돼요.'
      : '서버에서 확인된 발화가 없어요. 수신되지 않은 음성은 기록에 포함되지 않아요.';
    if (phase === 'saved' && (current?.recordIncomplete || state.recordIncomplete)) message = '수신된 기록으로 마무리한 통화예요. 누락된 음성은 포함되지 않아요.';
    const status = text('p', message, 'help'); status.dataset.transcriptStatus = ''; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); host.append(status);
    if (current?.assistantInterrupted && rows.some(row=>row.speaker==='assistant')) host.append(text('p', '종료 직전 상대가 생성한 문장은 실제 재생된 범위와 다를 수 있어요.', 'help'));
    if (current?.wrapupCanLeave && phase === 'finalizing') {
      const home = text('button', '홈에서 기다리기', 'text-button'); home.id = 'wrapup-home'; home.type = 'button'; home.dataset.action = 'wrapup-home'; home.onclick = current.onWrapupHome; host.append(home);
    }
    const details = document.createElement('details'); details.className = 'call-transcript'; details.open = wasOpen;
    const summary = text('summary', `대화문 보기 · ${rows.length}개 발화`); summary.dataset.action = 'toggle-post-call-transcript'; details.append(summary);
    const events = document.createElement('div'); events.dataset.transcriptEvents = '';
    for (const row of rows) {
      const block = document.createElement('div'); block.dataset.transcriptEventId = row.id; block.dataset.storage = row.storage || 'received';
      block.append(text('pre', `${row.speaker === 'user' ? '나' : state.name}: ${row.text}`));
      if (row.storage !== 'server') block.append(text('p', row.storage === 'device' ? '이 기기 보관 확인 · 서버 전송 대기' : row.storage === 'failed' ? '기기 보관과 서버 저장을 확인하지 못했어요.' : '수신한 발화 · 기기 보관 확인 중', 'help'));
      events.append(block);
    }
    if (!rows.length) events.append(text('p', phase === 'finalizing' ? '아직 수신된 대화문이 없어요. 마지막 발화의 전사를 확인하고 있어요.' : state.loading || state.error ? '기록 확인이 끝나기 전에는 발화 유무를 판단하지 않아요.' : '저장된 발화가 없어요.', 'help'));
    details.append(events); host.append(details);
    if (state.error || phase === 'partial') {
      const retry = text('button', '대화문 저장 상태 다시 확인', 'text-button'); retry.type = 'button'; retry.dataset.action = 'retry-post-call-transcript';
      retry.onclick = () => load(state); host.append(retry);
    }
    if (focused) host.querySelector(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
  }
  async function load(value) {
    if (!valid(value)) return;
    const request = ++version; value.loading = true; value.error = false; render();
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
      if (session.record_incomplete !== undefined) state.recordIncomplete = session.record_incomplete;
      if (state.current?.transcriptPhase !== 'finalizing') {
        state.phase = session.status === 'ended' ? 'saved' : 'partial';
        if (state.current) { state.current.transcriptPhase = state.phase; state.current.recordIncomplete = state.recordIncomplete; }
        if (!state.loading) void load(state);
      }
      render(); return;
    }
    version++;
    state = { scope: owner.scope, sessionId: session.id, companionId: session.companion_id, name: name || session.companion_id, current, rows: new Map(), phase: session.status === 'ended' ? 'saved' : 'partial', recordIncomplete:session.record_incomplete, loading: !current, error: false };
    document.getElementById('post-call-transcript')?.remove(); render();
    if (!current) void load(state);
  }
  return {
    clear, select,
    prioritizeFeedback() { if (valid(state)) { state.feedbackFirst = true; const details = document.querySelector('#post-call-transcript details'); if (details) details.open = false; render(); } },
    changed(current) { if (state?.current === current) render(); },
    confirm(scope, sessionId, events) {
      if (!valid(state) || state.scope !== scope || state.sessionId !== sessionId) return;
      const rows = state.current?.transcript || state.rows;
      for (const event of events) { const existing = rows.get(keyOf(event)); if (existing) existing.storage = 'server'; }
      render();
    }
  };
}
