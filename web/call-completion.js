// Product timing choices, not measured storage latency. Storage completion is
// supplied by the caller after transcript sync and the server finish response.
export const CALL_COMPLETION_TIMING = Object.freeze({ minEndMs: 600, offerReviewMs: 3000, updateMs: 250 });

export function createCallCompletion({ onUpdate = () => {}, onReview = () => {},
  now = () => performance.now(), startedAt, setTimeout: later = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  // Callers can include synchronous microphone/UI shutdown in the measurement.
  const started = Number.isFinite(startedAt) ? startedAt : now();
  let stage = 'transcribing', status = 'pending', reviewOpened = false, disposed = false;
  let timer = null, revision = 0, greatestElapsed = 0, measuredElapsed = null, resolveReviewed;
  const reviewed = new Promise(resolve => { resolveReviewed = resolve; });
  function liveElapsed() {
    const elapsed = now() - started;
    if (Number.isFinite(elapsed)) greatestElapsed = Math.max(greatestElapsed, elapsed, 0);
    return greatestElapsed;
  }
  function snapshot() {
    const elapsedMs = measuredElapsed ?? liveElapsed();
    return { elapsedMs, stage, status, reviewOpened,
      canReview: !disposed && !reviewOpened && status === 'pending' && elapsedMs >= CALL_COMPLETION_TIMING.offerReviewMs };
  }
  function notify() {
    if (disposed) return;
    try { onUpdate(snapshot()); } catch { /* Rendering must not change completion evidence. */ }
  }
  function clearTimer() {
    revision++;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function schedule(delay, work) {
    clearTimer();
    const request = revision;
    timer = later(() => {
      if (disposed || request !== revision) return;
      timer = null; work();
    }, delay);
  }
  function reveal() {
    if (disposed || reviewOpened) return false;
    reviewOpened = true;
    notify();
    if (disposed) return false;
    try { onReview(snapshot()); } catch { /* The caller owns navigation recovery. */ }
    finally { resolveReviewed(); }
    return true;
  }
  function tick() {
    if (disposed || status !== 'pending') return;
    notify();
    if (!disposed && status === 'pending') schedule(CALL_COMPLETION_TIMING.updateMs, tick);
  }
  function setStage(value) {
    if (disposed || status !== 'pending' || !['transcribing', 'saving'].includes(value)) return false;
    if (stage === value) return true;
    stage = value; notify(); return true;
  }
  function settle(value) {
    if (disposed || status !== 'pending' || !['saved', 'partial'].includes(value)) return false;
    // Freeze at the acknowledgement/failure, never at the end of an animation.
    measuredElapsed = liveElapsed(); status = value; clearTimer(); notify();
    if (disposed || reviewOpened) return true;
    const remaining = CALL_COMPLETION_TIMING.minEndMs - liveElapsed();
    if (remaining <= 0) reveal();
    else schedule(remaining, reveal);
    return true;
  }
  function openReview() {
    if (!snapshot().canReview) return false;
    return reveal();
  }
  function dispose() {
    if (disposed) return;
    measuredElapsed ??= liveElapsed(); disposed = true; clearTimer(); resolveReviewed();
  }
  notify();
  if (!disposed) schedule(CALL_COMPLETION_TIMING.updateMs, tick);
  return { setStage, settle, openReview, dispose, reviewed, get state() { return snapshot(); } };
}
