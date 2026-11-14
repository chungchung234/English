// IndexedDB is a crash-recovery queue. Supabase remains the source of truth.
export function createOutbox(dbName = 'loop-outbox-v1', { indexedDBImpl } = {}) {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const req = (indexedDBImpl || globalThis.indexedDB).open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  });
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', mode);
      let result;
      action(tx.objectStore('pending'), value => { result = value; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Local save aborted'));
    });
  }
  return {
    put: record => transaction('readwrite', store => store.put(record)),
    list: async scope => {
      const all = await transaction('readonly', (store, done) => {
        const request = store.getAll(); request.onsuccess = () => done(request.result);
      });
      return all.filter(item => item.scope === scope).sort((a,b) => a.event.occurred_at.localeCompare(b.event.occurred_at));
    },
    remove: ids => transaction('readwrite', store => ids.forEach(id => store.delete(id))),
    // A background flush and a current-call flush may send the same immutable
    // UUID concurrently. Retire only the exact acknowledged snapshot, never a
    // replacement queued under that ID while the request was in flight.
    removeAcknowledged(records) {
      const expected = snapshot(records);
      return transaction('readwrite', (store, done) => {
        let removed = 0; done(removed);
        for (const record of expected) {
          const request = store.get(record.id);
          request.onsuccess = () => {
            if (request.result && sameRecord(request.result, record)) {
              store.delete(record.id); done(++removed);
            }
          };
        }
      });
    }
  };
}

const snapshot = records => JSON.parse(JSON.stringify(records));
function immutable(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sameRecord(a, b) { try { return canonical(a) === canonical(b); } catch { return false; } }
function validateFlush(outbox, scope, send) {
  if (typeof scope !== 'string' || !scope || typeof send !== 'function' || typeof outbox?.list !== 'function' || typeof outbox?.removeAcknowledged !== 'function') throw new TypeError('Invalid outbox flush.');
}
async function sendBatches(outbox, sessionId, records, send) {
  for (let offset = 0; offset < records.length; offset += 50) {
    const batch = immutable(snapshot(records.slice(offset, offset + 50)));
    await send(sessionId, Object.freeze(batch.map(item => item.event)));
    await outbox.removeAcknowledged(batch);
  }
}

// Delete only after server acknowledgement; retries keep the same event UUID/key.
export async function flushOutbox(outbox, scope, send) {
  validateFlush(outbox, scope, send);
  const pending = (await outbox.list(scope)).filter(item => item.scope === scope);
  const sessions = new Map();
  for (const item of pending) {
    if (!sessions.has(item.sessionId)) sessions.set(item.sessionId, []);
    sessions.get(item.sessionId).push(item);
  }
  for (const [sessionId, records] of sessions) {
    await sendBatches(outbox, sessionId, records, send);
  }
  return (await outbox.list(scope)).length;
}

// Current speech must not wait behind another session's retry queue. This has
// no account-wide flight lock; an exact duplicate is safe for append_events.
export async function flushOutboxSession(outbox, scope, sessionId, send, { eventIds } = {}) {
  validateFlush(outbox, scope, send);
  if (typeof sessionId !== 'string' || !sessionId || eventIds !== undefined && (!Array.isArray(eventIds) || eventIds.some(id => typeof id !== 'string' || !id))) throw new TypeError('Invalid outbox session flush.');
  const selected = eventIds === undefined ? null : new Set(eventIds);
  const matches = item => item.scope === scope && item.sessionId === sessionId && (!selected || selected.has(item.id));
  const pending = (await outbox.list(scope)).filter(matches);
  await sendBatches(outbox, sessionId, pending, send);
  return (await outbox.list(scope)).filter(matches).length;
}
