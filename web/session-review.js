import { renderSessionFeedback } from './session-feedback.js';

// Navigation and async readiness are independent: arriving feedback never
// changes the page or the reader's position.
export function createSessionReview({ context, getRows, showSource, onExit, onViewed }) {
  const $ = id => document.getElementById(id);
  const panel = $('review-panel'), footer = $('session-review-footer');
  let key = '', state = null, rendered = '', transcriptY = 0, feedbackY = 0, revision = 0;
  let footerHeight = 0, sourceReturn = false, retryingKey = null;
  const owned = () => `${context().scope || ''}|${context().sessionId || ''}`;
  function reset() {
    key = owned(); state = null; rendered = ''; transcriptY = feedbackY = 0; sourceReturn = false;
    revision++; footerHeight = 0; panel.dataset.sessionView = 'transcript';
    $('session-feedback-content').replaceChildren();
    retryingKey = null;
    $('session-feedback-retry').disabled = false;
    $('session-feedback-page-retry').disabled = false;
    footer.style.removeProperty('min-height'); panel.style.removeProperty('--session-footer-height');
  }
  function active() { return context().active && panel.dataset.mode === 'session'; }
  function sync() {
    if (key !== owned()) reset();
    document.body.dataset.sessionReview = active() ? panel.dataset.sessionView : '';
    $('session-review-header').hidden = panel.dataset.mode !== 'session';
    footer.hidden = !active() || panel.dataset.sessionView !== 'transcript';
    $('session-transcript-back').hidden = panel.dataset.sessionView !== 'feedback';
    $('session-record-title').hidden = panel.dataset.sessionView === 'feedback';
  }
  function restore(y, focus) {
    const request = ++revision;
    requestAnimationFrame(() => {
      if (request !== revision || !active()) return;
      window.scrollTo({ top: y, behavior: 'instant' });
      focus?.focus({ preventScroll: true });
    });
  }
  function transcript({ source } = {}) {
    if (!active()) return;
    feedbackY = window.scrollY;
    panel.dataset.sessionView = 'transcript'; sync();
    if (source) {
      sourceReturn = true; paintFooter();
      const request = ++revision;
      requestAnimationFrame(() => { if (request === revision && active()) showSource(source, { isActive: () => request === revision && active() && panel.dataset.sessionView === 'transcript' }); });
    } else { sourceReturn = false; paintFooter(); restore(transcriptY, $('session-record-title')); }
  }
  function openFeedback() {
    if (!active() || !['ready', 'partial', 'failed', 'empty'].includes(state?.status)) return;
    if (!sourceReturn) transcriptY = window.scrollY;
    panel.dataset.sessionView = 'feedback'; sync();
    restore(feedbackY, $('session-feedback-title'));
    onViewed?.($('session-feedback-content'));
  }
  function paintFooter() {
    const status = state?.status || 'loading';
    const ready = status === 'ready';
    const failed = ['partial', 'failed', 'empty'].includes(status);
    $('session-feedback-open').hidden = !ready;
    $('session-feedback-open').textContent = sourceReturn ? '학습 노트로 돌아가기 →' : '학습 노트 보기 →';
    $('session-feedback-status').hidden = ready;
    $('session-feedback-status').dataset.state = status;
    $('session-feedback-status-title').textContent = status === 'finalizing' ? '마지막 대화를 확인하고 있어요' : status === 'pending' ? '학습 노트 준비 중' : status === 'loading' ? '학습 노트 상태 확인 중' : status === 'partial' ? '대화 저장 확인이 필요해요' : status === 'empty' ? '학습 노트에 담을 내용이 없어요' : '학습 노트를 준비하지 못했어요';
    $('session-feedback-status-note').textContent = failed ? (state?.message || '대화 기록은 계속 볼 수 있어요.') : '대화는 먼저 읽을 수 있어요.';
    const retry = $('session-feedback-retry');
    retry.hidden = !state?.retry || state.blocked === true || status === 'pending';
    retry.textContent = state?.retryLabel || (status === 'partial' ? '저장 상태 확인' : '학습 노트 다시 준비');
    $('session-feedback-unavailable').hidden = ready;
    $('session-feedback-content').hidden = !ready;
    $('session-feedback-page-status').textContent = failed ? state.message : $('session-feedback-status-title').textContent;
    const pageRetry = $('session-feedback-page-retry');
    pageRetry.hidden = retry.hidden; pageRetry.textContent = retry.textContent;
  }
  async function runRetry() {
    const action = state?.retry, actionKey = key;
    if (!action || retryingKey === key) return;
    retryingKey = key;
    $('session-feedback-retry').disabled = $('session-feedback-page-retry').disabled = true;
    try { await action(); }
    catch { if (key === actionKey) update({ ...state, status: 'failed', message: '다시 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' }); }
    finally {
      if (key === actionKey) {
        retryingKey = null;
        $('session-feedback-retry').disabled = $('session-feedback-page-retry').disabled = false;
      }
    }
  }
  function update(next) {
    if (next.sessionId !== context().sessionId) return;
    if (key !== owned()) reset();
    state = next; paintFooter(); sync();
    if (next.status !== 'ready' || !next.analysis) return;
    const signature = JSON.stringify([next.analysis, next.excludedExpressions]);
    if (signature === rendered) {
      if (active() && panel.dataset.sessionView === 'feedback') onViewed?.($('session-feedback-content'));
      return;
    }
    rendered = signature;
    const y = window.scrollY;
    renderSessionFeedback($('session-feedback-content'), next.analysis, {
      getRows, excludedExpressions: next.excludedExpressions || [],
      onSource: ids => transcript({ source: ids })
    });
    if (active() && panel.dataset.sessionView === 'feedback') {
      window.scrollTo({ top: y, behavior: 'instant' }); onViewed?.($('session-feedback-content'));
    }
  }
  $('session-feedback-open').onclick = openFeedback;
  $('session-feedback-retry').onclick = $('session-feedback-page-retry').onclick = runRetry;
  $('session-transcript-back').onclick = () => transcript();
  $('session-review-exit').onclick = () => { revision++; onExit(); sync(); };
  const observer = new ResizeObserver(entries => {
    if (footer.hidden) return;
    const height = Math.ceil(entries[0].borderBoxSize?.[0]?.blockSize || footer.getBoundingClientRect().height);
    if (height <= footerHeight) return;
    footerHeight = height;
    footer.style.minHeight = `${height}px`;
    panel.style.setProperty('--session-footer-height', `${height}px`);
  });
  observer.observe(footer);
  return { update, sync, reset, openFeedback };
}
