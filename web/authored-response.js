// Transport framing only. Canonical text/owner and PCM admission remain with
// the authored controller/player; no audio is released before done and EOF.
export const AUTHORED_RESPONSE_LIMITS = Object.freeze({
  textFrameBytes: 262144,
  audioFrameBytes: 5800000,
  metadataFrameBytes: 4096,
  totalBytes: 6070336,
  readChunks: 100000,
});
const MAX_BASE64_CHARACTERS = 5760000;
const ownedError = Symbol('authored-response-error');
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function invalid(code = 'DIALOGUE_STREAM_INVALID', status) {
  const error = Object.assign(new Error('The conversation reply could not be read.'), { code, [ownedError]: true });
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}
function aborted(signal) {
  const error = invalid('DIALOGUE_STREAM_ABORTED');
  let timedOut = false;
  try { timedOut = signal?.reason?.name === 'TimeoutError'; } catch { /* reasons are caller-owned */ }
  error.name = timedOut ? 'TimeoutError' : 'AbortError';
  return error;
}
function checkedLimits(value = {}) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(AUTHORED_RESPONSE_LIMITS, key))) throw invalid();
  const limits = { ...AUTHORED_RESPONSE_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTHORED_RESPONSE_LIMITS[key]) throw invalid();
  return limits;
}

export async function readAuthoredResponse(response, { onText, signal, limits: requestedLimits } = {}) {
  let reader, completed = false, cancelling = false, rejectAbort;
  const abortWait = new Promise((_, reject) => { rejectAbort = reject; });
  // An abort can happen synchronously inside onText, before its race is made.
  // Keep this rejection handled even when validation itself rejects first.
  void abortWait.catch(() => {});
  const cancelReader = () => {
    if (!reader || cancelling) return;
    cancelling = true;
    try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* cancellation was attempted */ }
  };
  const onAbort = () => { rejectAbort(aborted(signal)); cancelReader(); };
  const wait = async work => {
    if (signal?.aborted) throw aborted(signal);
    const result = await Promise.race([work, abortWait]);
    if (signal?.aborted) throw aborted(signal);
    return result;
  };
  try {
    reader = response?.body?.getReader?.();
    if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function' || typeof onText !== 'function') throw invalid();
    if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalid();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) throw aborted(signal);
    if (response.ok !== true) throw invalid('DIALOGUE_STREAM_HTTP_ERROR', response.status);
    if (!/^application\/x-ndjson(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(response.headers?.get?.('content-type') || '')) throw invalid();
    const limits = checkedLimits(requestedLimits);
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > limits.totalBytes) throw invalid();
    let stage = 0, audio, timings, received = 0, chunks = 0, lineBytes = 0, lineParts = [];
    const frameLimit = () => stage === 0 ? limits.textFrameBytes : stage === 1 ? limits.audioFrameBytes : limits.metadataFrameBytes;
    const append = part => {
      lineBytes += part.byteLength;
      if (lineBytes > frameLimit()) throw invalid();
      if (part.byteLength) lineParts.push(part);
    };
    const frame = async () => {
      if (stage === 3 || !lineBytes) throw invalid();
      const bytes = new Uint8Array(lineBytes); let offset = 0;
      for (const part of lineParts) { bytes.set(part, offset); offset += part.byteLength; }
      lineParts = []; lineBytes = 0;
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value?.type === 'error') {
        if (!exactKeys(value, ['type', 'error']) || !exactKeys(value.error, ['code', 'message']) || typeof value.error.message !== 'string' || value.error.message.length > 256) throw invalid();
        throw invalid(safeCode(value.error.code) ? value.error.code : 'DIALOGUE_STREAM_UNAVAILABLE');
      }
      if (stage === 0) {
        if (!exactKeys(value, ['type', 'result']) || value.type !== 'text' || !object(value.result)) throw invalid();
        await wait(Promise.resolve().then(() => onText(value.result)));
        stage = 1;
      } else if (stage === 1) {
        if (!exactKeys(value, ['type', 'result']) || value.type !== 'audio' || !object(value.result) || !object(value.result.manifest) || typeof value.result.pcmBase64 !== 'string' || value.result.pcmBase64.length > MAX_BASE64_CHARACTERS) throw invalid();
        audio = value.result; stage = 2;
      } else {
        if (!exactKeys(value, ['type', 'timings']) || value.type !== 'done' || !exactKeys(value.timings, ['totalMs', 'authorMs', 'synthesisMs']) || Object.values(value.timings).some(number => !Number.isFinite(number) || number < 0 || number > 180000)) throw invalid();
        timings = Object.freeze({ ...value.timings }); stage = 3;
      }
    };
    for (;;) {
      const part = await wait(reader.read());
      if (!part || typeof part.done !== 'boolean') throw invalid();
      if (part.done) {
        if (part.value !== undefined || lineBytes || stage !== 3) throw invalid();
        completed = true;
        return { audio, timings };
      }
      if (!(part.value instanceof Uint8Array) || ++chunks > limits.readChunks) throw invalid();
      received += part.value.byteLength;
      if (received > limits.totalBytes) throw invalid();
      let start = 0;
      while (start < part.value.length) {
        if (stage === 3) throw invalid();
        const newline = part.value.indexOf(10, start);
        if (newline === -1) { append(part.value.subarray(start)); break; }
        append(part.value.subarray(start, newline));
        await frame(); start = newline + 1;
      }
    }
  } catch (error) {
    if (error?.[ownedError]) throw error;
    if (signal?.aborted) throw aborted(signal);
    // Only validated server error frames carry a backend code. Native decoder,
    // stream and caller-validation exceptions must not expose their payloads.
    throw invalid();
  } finally {
    try { signal?.removeEventListener?.('abort', onAbort); } catch { /* cleanup cannot expose caller data */ }
    if (!completed) cancelReader();
    try { reader?.releaseLock?.(); } catch { /* cancellation can still be settling */ }
  }
}
