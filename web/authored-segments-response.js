// Strict framing and source-tuple binding for incrementally delivered, fully
// verified PCM parts. The controller/queue perform cryptographic admission in
// the awaited callbacks. No whole-turn completion is returned before clean EOF.
export const AUTHORED_SEGMENTS_RESPONSE_LIMITS = Object.freeze({
  textFrameBytes: 262144,
  segmentFrameBytes: 5800000,
  metadataFrameBytes: 8192,
  totalBytes: 6160000,
  readChunks: 100000,
  parts: 16,
  pcmBytes: 4320000,
  // Each independently padded part can add base64 padding over a whole clip.
  // Decoded byte counts below remain the authoritative cumulative audio limit.
  base64Characters: 5760064,
});
const PROTOCOL = 'authored_dialogue_v1';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_FIELDS = ['scope', 'sessionId', 'companionId', 'callEpoch', 'turnNonce', 'turnId', 'assistantEventId', 'authorityGeneration', 'expectedMemoryRevision', 'playbackEpoch'];
const PART_FIELDS = ['version', 'owner', 'synthesisId', 'index', 'count', 'startByte', 'endByte', 'parentTextSha256', 'textSha256', 'pcmSha256', 'format', 'sampleRate', 'channels', 'sourceFrames', 'byteLength', 'transcriptVerification', 'synthesisSpeed'];
const FINAL_FIELDS = ['version', 'owner', 'synthesisId', 'textSha256', 'pcmSha256', 'format', 'sampleRate', 'channels', 'sourceFrames', 'byteLength', 'transcriptVerification', 'synthesisSpeed'];
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ownedError = Symbol('authored-segments-response-error');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && SHA.test(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
function invalid(code = 'DIALOGUE_STREAM_INVALID', status) {
  const error = Object.assign(new Error('The conversation reply could not be read.'), { code, [ownedError]: true });
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}
function aborted(signal) {
  const error = invalid('DIALOGUE_STREAM_ABORTED'); let timedOut = false;
  try { timedOut = signal?.reason?.name === 'TimeoutError'; } catch { /* caller-owned reason */ }
  error.name = timedOut ? 'TimeoutError' : 'AbortError'; return error;
}
function checkedLimits(value = {}) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(AUTHORED_SEGMENTS_RESPONSE_LIMITS, key))) throw invalid();
  const limits = { ...AUTHORED_SEGMENTS_RESPONSE_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTHORED_SEGMENTS_RESPONSE_LIMITS[key]) throw invalid();
  return limits;
}
function ownerKey(value) {
  if (!exactKeys(value, OWNER_FIELDS) || typeof value.scope !== 'string' || !value.scope || value.scope.length > 4096 ||
    !['sessionId', 'turnNonce', 'turnId', 'assistantEventId'].every(key => uuid(value[key])) ||
    !['alex', 'mia', 'juno'].includes(value.companionId) ||
    !['callEpoch', 'authorityGeneration', 'playbackEpoch'].every(key => integer(value[key])) ||
    !(value.expectedMemoryRevision === null || integer(value.expectedMemoryRevision))) throw invalid();
  return JSON.stringify(OWNER_FIELDS.map(key => value[key]));
}
function checkedPlan(value, text, textSha256, limits) {
  if (!exactKeys(value, ['version', 'count', 'textByteLength', 'textSha256', 'parts']) || value.version !== 'verified-speech-segments-v1' ||
    !integer(value.count) || value.count < 1 || value.count > limits.parts || !hash(value.textSha256) || value.textSha256 !== textSha256 ||
    !integer(value.textByteLength) || !Array.isArray(value.parts) || value.parts.length !== value.count ||
    typeof text !== 'string' || !text.trim() || text.length > 20000) throw invalid();
  const bytes = new TextEncoder().encode(text), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  if (bytes.byteLength !== value.textByteLength || decoder.decode(bytes) !== text) throw invalid();
  let end = 0;
  const parts = value.parts.map((part, index) => {
    if (!exactKeys(part, ['index', 'startByte', 'endByte', 'textSha256']) || part.index !== index || !integer(part.startByte) || !integer(part.endByte) ||
      part.startByte !== end || part.endByte <= part.startByte || part.endByte > bytes.byteLength || !hash(part.textSha256)) throw invalid();
    // A range cannot split a UTF8 codepoint. Exact hash membership is checked
    // by the queue before its onText callback admits any subsequent part.
    decoder.decode(bytes.subarray(part.startByte, part.endByte)); end = part.endByte;
    return Object.freeze({ ...part });
  });
  if (end !== bytes.byteLength) throw invalid();
  return Object.freeze({ version: value.version, count: value.count, textByteLength: value.textByteLength,
    textSha256: value.textSha256, parts: Object.freeze(parts) });
}
function verifiedTranscript(value, textSha256) {
  return exactKeys(value, ['status', 'policyVersion', 'approvedTextSha256']) && value.status === 'matched' &&
    value.policyVersion === 'lexical-fidelity-v1' && value.approvedTextSha256 === textSha256;
}
function pcmShape(value, expectedOwner, textSha256) {
  if (ownerKey(value.owner) !== expectedOwner || !uuid(value.synthesisId) || !hash(value.pcmSha256) || value.format !== 'pcm_s16le' ||
    value.sampleRate !== 24000 || value.channels !== 1 || !integer(value.sourceFrames) || value.sourceFrames < 1 ||
    !integer(value.byteLength) || value.byteLength !== value.sourceFrames * 2 ||
    !Number.isFinite(value.synthesisSpeed) || value.synthesisSpeed < .25 || value.synthesisSpeed > 4 ||
    !verifiedTranscript(value.transcriptVerification, textSha256)) throw invalid();
}
function decodedBase64Bytes(value, limit) {
  if (typeof value !== 'string' || !value || value.length > limit || value.length % 4) throw invalid();
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (!/^[A-Za-z0-9+/]+$/.test(value.slice(0, value.length - padding))) throw invalid();
  if (padding && (BASE64.indexOf(value[value.length - padding - 1]) & (padding === 2 ? 15 : 3))) throw invalid();
  return value.length / 4 * 3 - padding;
}

export async function readAuthoredSegmentsResponse(response, { onText, onSegment, signal, limits: requestedLimits } = {}) {
  let reader, completed = false, cancelling = false, rejectAbort;
  const abortWait = new Promise((_, reject) => { rejectAbort = reject; }); void abortWait.catch(() => {});
  const cancelReader = () => {
    if (!reader || cancelling) return; cancelling = true;
    try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* cancellation was attempted */ }
  };
  const onAbort = () => { rejectAbort(aborted(signal)); cancelReader(); };
  const wait = async work => {
    if (signal?.aborted) throw aborted(signal);
    const result = await Promise.race([work, abortWait]);
    if (signal?.aborted) throw aborted(signal); return result;
  };
  try {
    reader = response?.body?.getReader?.();
    if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function' || typeof onText !== 'function' || typeof onSegment !== 'function') throw invalid();
    if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalid();
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) throw aborted(signal);
    if (response.ok !== true) throw invalid('DIALOGUE_STREAM_HTTP_ERROR', response.status);
    if (!/^application\/x-ndjson(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(response.headers?.get?.('content-type') || '')) throw invalid();
    const limits = checkedLimits(requestedLimits), length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > limits.totalBytes) throw invalid();
    let stage = 0, plan, expectedOwner, synthesisId, speed, next = 0, pcmBytes = 0, pcmFrames = 0, base64Characters = 0;
    let final, timings, received = 0, chunks = 0, lineBytes = 0, lineParts = [];
    const frameLimit = () => stage === 0 ? limits.textFrameBytes : stage === 1 && next < plan.count ? limits.segmentFrameBytes : limits.metadataFrameBytes;
    const append = part => {
      lineBytes += part.byteLength; if (lineBytes > frameLimit()) throw invalid();
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
        if (!exactKeys(value, ['type', 'result', 'plan']) || value.type !== 'text' || !object(value.result) || value.result.protocol !== PROTOCOL || !hash(value.result.textSha256)) throw invalid();
        expectedOwner = ownerKey(value.result.owner);
        plan = checkedPlan(value.plan, value.result.text, value.result.textSha256, limits);
        await wait(Promise.resolve().then(() => onText(value.result, plan))); stage = 1; return;
      }
      if (stage === 1 && next < plan.count) {
        if (!exactKeys(value, ['type', 'result']) || value.type !== 'segment' || !exactKeys(value.result, ['protocol', 'manifest', 'pcmBase64']) || value.result.protocol !== PROTOCOL ||
          !exactKeys(value.result.manifest, PART_FIELDS)) throw invalid();
        const part = plan.parts[next], manifest = value.result.manifest;
        if (manifest.version !== 'verified-pcm-segment-v1' || manifest.index !== next || manifest.count !== plan.count || manifest.startByte !== part.startByte || manifest.endByte !== part.endByte ||
          manifest.parentTextSha256 !== plan.textSha256 || manifest.textSha256 !== part.textSha256) throw invalid();
        pcmShape(manifest, expectedOwner, part.textSha256);
        if (synthesisId !== undefined && (manifest.synthesisId !== synthesisId || manifest.synthesisSpeed !== speed)) throw invalid();
        const decoded = decodedBase64Bytes(value.result.pcmBase64, limits.base64Characters);
        if (decoded !== manifest.byteLength) throw invalid();
        pcmBytes += decoded; pcmFrames += manifest.sourceFrames; base64Characters += value.result.pcmBase64.length;
        if (pcmBytes > limits.pcmBytes || base64Characters > limits.base64Characters) throw invalid();
        synthesisId = manifest.synthesisId; speed = manifest.synthesisSpeed; next++;
        await wait(Promise.resolve().then(() => onSegment(value.result))); return;
      }
      if (stage === 1) {
        if (!exactKeys(value, ['type', 'result']) || value.type !== 'final' || !exactKeys(value.result, ['protocol', 'manifest']) || value.result.protocol !== PROTOCOL ||
          !exactKeys(value.result.manifest, FINAL_FIELDS)) throw invalid();
        const manifest = value.result.manifest;
        if (manifest.version !== 'verified-pcm-candidate-v1' || manifest.textSha256 !== plan.textSha256 || manifest.synthesisId !== synthesisId || manifest.synthesisSpeed !== speed ||
          manifest.byteLength !== pcmBytes || manifest.sourceFrames !== pcmFrames) throw invalid();
        pcmShape(manifest, expectedOwner, plan.textSha256); final = value.result; stage = 2; return;
      }
      if (!exactKeys(value, ['type', 'timings']) || value.type !== 'done' || !exactKeys(value.timings, ['totalMs', 'authorMs', 'synthesisMs']) ||
        Object.values(value.timings).some(number => !Number.isFinite(number) || number < 0 || number > 180000)) throw invalid();
      timings = Object.freeze({ ...value.timings }); stage = 3;
    };
    for (;;) {
      const part = await wait(reader.read());
      if (!part || typeof part.done !== 'boolean') throw invalid();
      if (part.done) {
        if (part.value !== undefined || lineBytes || stage !== 3) throw invalid();
        completed = true; return { final, timings };
      }
      if (!(part.value instanceof Uint8Array) || ++chunks > limits.readChunks) throw invalid();
      received += part.value.byteLength; if (received > limits.totalBytes) throw invalid();
      let start = 0;
      while (start < part.value.length) {
        if (stage === 3) throw invalid();
        const newline = part.value.indexOf(10, start);
        if (newline === -1) { append(part.value.subarray(start)); break; }
        append(part.value.subarray(start, newline)); await frame(); start = newline + 1;
      }
    }
  } catch (error) {
    if (error?.[ownedError]) throw error;
    if (signal?.aborted) throw aborted(signal);
    throw invalid();
  } finally {
    try { signal?.removeEventListener?.('abort', onAbort); } catch { /* no caller data in errors */ }
    if (!completed) cancelReader();
    try { reader?.releaseLock?.(); } catch { /* cancellation can still be pending */ }
  }
}
