// Realtime error events echo the client event_id; success events need an
// operation-specific matcher. Never retain provider messages or request bodies
// in an error: they may contain conversation content or connection details.
const safeCode = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : 'PROVIDER_ERROR';
const safeType = value => typeof value === 'string' && /^[a-z][a-z0-9_.]{0,79}$/.test(value) ? value : 'unknown';
const requestError = (code, requestType) => Object.assign(new Error(code), { code, requestType });

export function createRealtimeRequests({ send, onIssue = () => {}, timeoutMs = 8000,
  randomUUID = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof send !== 'function') throw new TypeError('A send function is required.');
  const pending = new Map(), recent = new Map();
  let disposed = false, sequence = 0;
  const result = requestType => ({ handled: true, requestType });
  const unknown = () => ({ handled: false, requestType: 'unknown' });
  function issue(kind, code, record) {
    try { onIssue({ kind, code, request_type: record.requestType }); } catch { /* Diagnostics cannot change request settlement. */ }
  }
  function settle(record, status, value) {
    if (!pending.has(record.id)) return false;
    pending.delete(record.id); clearTimer(record.timer); record.status = status;
    if (status === 'resolved') record.resolve(value); else record.reject(value);
    return true;
  }
  function failSend(record) {
    if (settle(record, 'rejected', requestError('SEND_FAILED', record.requestType))) issue('context_error', 'SEND_FAILED', record);
  }
  return {
    request(message, { match = () => false, stateAck = false, timeoutMs: requestTimeout = timeoutMs } = {}) {
      const requestType = safeType(message?.type);
      if (disposed) return Promise.reject(requestError('REQUEST_CANCELLED', requestType));
      return new Promise((resolve, reject) => {
        const record = { id: 'rtc-' + randomUUID(), requestType, match, stateAck, resolve, reject,
          sequence: sequence++, status: 'pending', ackConsumed: false, timer: null };
        pending.set(record.id, record); recent.set(record.id, record);
        while (recent.size > 256) recent.delete(recent.keys().next().value);
        record.timer = setTimer(() => {
          if (settle(record, 'rejected', requestError('REQUEST_TIMEOUT', requestType))) issue('request_timeout', 'REQUEST_TIMEOUT', record);
        }, requestTimeout);
        try {
          const sent = send({ ...message, event_id: record.id });
          if (sent && typeof sent.then === 'function') Promise.resolve(sent).catch(() => failSend(record));
        } catch { failSend(record); }
      });
    },
    event(event) {
      if (event?.type === 'error') {
        const record = pending.get(event.error?.event_id) || recent.get(event.error?.event_id);
        if (!record) return unknown();
        // An explicit rejection is conclusive: no success receipt is still
        // owed by that operation. Unlike a timeout, it must not consume the
        // next retry's matching acknowledgement.
        record.ackConsumed = true;
        settle(record, 'rejected', requestError(safeCode(event.error?.code), record.requestType));
        return result(record.requestType);
      }
      // Keep timeout/cancellation tombstones until their first matching receipt.
      // Without echoed request IDs, an identical retry's ack is ambiguous; the
      // oldest unmatched operation consumes it rather than confirming a retry
      // using a receipt which might belong to the timed-out operation.
      // A caller may instead mark an exact desired-state predicate as stateAck:
      // one receipt then proves that same state for every matching state request,
      // including a retry whose earlier receipt was permanently lost.
      const candidates = [...new Set([...recent.values(), ...pending.values()])].sort((a, b) => a.sequence - b.sequence);
      let acknowledgedType;
      for (const record of candidates) {
        if (acknowledgedType && !record.stateAck) continue;
        if (record.ackConsumed || typeof record.match !== 'function') continue;
        let matches = false;
        try { matches = record.match(event) === true; } catch { /* An unrelated malformed event cannot settle a request. */ }
        if (!matches) continue;
        record.ackConsumed = true;
        settle(record, 'resolved', event);
        acknowledgedType ||= record.requestType;
        if (!record.stateAck) return result(record.requestType);
      }
      return acknowledgedType ? result(acknowledgedType) : unknown();
    },
    dispose() {
      disposed = true;
      for (const record of pending.values()) settle(record, 'rejected', requestError('REQUEST_CANCELLED', record.requestType));
    },
  };
}
