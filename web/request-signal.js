// Compose request cancellation and a deadline without newer AbortSignal static
// methods. Media-capable browsers can lack any()/timeout(). Release resources
// after the response body settles as well as after cancellation.
export function createRequestSignal({ signal: parent, timeoutMs = 90000,
  AbortController: Controller = globalThis.AbortController,
  setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  if (typeof Controller !== 'function') throw new TypeError('AbortController is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('A finite request timeout is required.');
  const controller = new Controller();
  let timer = null, released = false;
  function dispose() {
    if (released) return;
    released = true;
    if (timer !== null) cancel(timer);
    timer = null;
    parent?.removeEventListener?.('abort', parentAborted);
  }
  function abort(reason) {
    if (released) return;
    controller.abort(reason); dispose();
  }
  function parentAborted() { abort(parent.reason); }
  if (parent?.aborted) parentAborted();
  else parent?.addEventListener?.('abort', parentAborted, { once: true });
  if (!released) timer = later(() => {
    const error = new Error('The request timed out.'); error.name = 'TimeoutError';
    abort(error);
  }, timeoutMs);
  return { signal: controller.signal, dispose };
}
