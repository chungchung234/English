export const CALL_CONNECT_TIMEOUT_MS = 45000;

const cancelled = signal => signal.reason || Object.assign(new Error('Connection cancelled.'), { name: 'AbortError' });

// Only the initial attempt owns this deadline. Actual RTC + data-channel
// readiness permanently completes it; it never watches an established call.
export function createConnectionAttempt({ controller, timeoutMs = CALL_CONNECT_TIMEOUT_MS,
  setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  if (!controller?.signal || typeof controller.abort !== 'function') throw new TypeError('An attempt controller is required.');
  let timer = null, finished = false, connected = false, rejectStopped, resolveConnected;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // There may be a gap between stages with no caller awaiting this promise.
  stopped.catch(() => {});
  const connectionReady = new Promise(resolve => { resolveConnected = resolve; });
  function release() {
    if (timer !== null) cancel(timer);
    timer = null;
    controller.signal.removeEventListener('abort', aborted);
  }
  function aborted() {
    if (finished) return;
    finished = true; release(); rejectStopped(cancelled(controller.signal));
  }
  if (controller.signal.aborted) aborted();
  else {
    controller.signal.addEventListener('abort', aborted, { once: true });
    timer = later(() => {
      if (finished) return;
      const error = Object.assign(new Error('Call connection timed out.'), { code: 'CALL_CONNECT_TIMEOUT' });
      controller.abort(error);
    }, timeoutMs);
  }
  return {
    wait(promise) { return Promise.race([Promise.resolve(promise), stopped]); },
    waitUntilConnected() { return Promise.race([connectionReady, stopped]); },
    connected() {
      if (finished) return connected;
      finished = true; connected = true; release(); resolveConnected(); return true;
    },
    dispose() {
      release();
      if (!finished) {
        finished = true;
        rejectStopped(Object.assign(new Error('Connection attempt disposed.'), { name: 'AbortError' }));
      }
    },
  };
}
