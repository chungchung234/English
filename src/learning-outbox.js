const STORE_NAME = 'learning';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateScope(scope) {
  if (typeof scope !== 'string') throw new TypeError('Scope must be a string');
  const parts = scope.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new TypeError('Scope must contain a service URL and user UUID');
  }
}

function validateRecord(record) {
  if (!isPlainObject(record)) throw new TypeError('Record must be an object');
  if (typeof record.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)) {
    throw new TypeError('Record id must be a UUID');
  }
  if (record.kind !== 'action' && record.kind !== 'event') throw new TypeError('Record kind must be action or event');
  if (record.state !== undefined && record.state !== 'conflict') throw new TypeError('Record state must be conflict when provided');
  if (!isPlainObject(record.body)) throw new TypeError('Record body must be an object');
  if (typeof record.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(record.created_at) || !Number.isFinite(Date.parse(record.created_at))) {
    throw new TypeError('Record created_at must be an ISO date string');
  }
  try {
    if (JSON.stringify(record.body) === undefined) throw new Error();
  } catch {
    throw new TypeError('Record body must be JSON serializable');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameRecord(a, b) {
  return a.id === b.id && a.kind === b.kind && a.created_at === b.created_at && canonical(a.body) === canonical(b.body);
}

// IndexedDB is the durable queue. Records are partitioned by service and account.
export function createLearningOutbox(dbName = 'loop-learning-outbox-v1', { indexedDBImpl = globalThis.indexedDB } = {}) {
  if (!indexedDBImpl?.open) throw new Error('IndexedDB is unavailable');
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'storage_key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });

  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      let settled = false;
      const tx = db.transaction(STORE_NAME, mode);
      const fail = error => {
        if (!settled) {
          settled = true;
          reject(error || new Error('Local save aborted'));
        }
      };
      try {
        action(tx.objectStore(STORE_NAME), value => { result = value; }, fail);
      } catch (error) {
        try { tx.abort(); } catch { /* transaction may already be inactive */ }
        fail(error);
      }
      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  return {
    put(scope, record) {
      validateScope(scope);
      validateRecord(record);
      const entry = { storage_key: `${scope}|${record.id}`, scope, ...record };
      return transaction('readwrite', (store, done, fail) => {
        const request = store.get(entry.storage_key);
        request.onsuccess = () => {
          try {
            const existing = request.result;
            if (existing) {
              if (existing.scope !== scope || !sameRecord(existing, record)) {
                throw new Error('A different learning record already uses this scoped id');
              }
              // Keep local conflict status sticky across retries that omit the metadata.
              if (record.state === 'conflict' && existing.state !== 'conflict') {
                store.put({...existing, state: 'conflict'});
              }
              done(existing.id);
              return;
            }
            store.add(entry);
            done(record.id);
          } catch (error) {
            try { tx.abort(); } catch { /* transaction may already be inactive */ }
            fail(error);
          }
        };
        request.onerror = () => {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          fail(request.error);
        };
      });
    },
    list(scope) {
      validateScope(scope);
      return transaction('readonly', (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result
          .filter(item => item.scope === scope)
          .map(({ storage_key, scope: _scope, ...record }) => record)
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
      });
    },
    remove(scope, id) {
      validateScope(scope);
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new TypeError('Record id must be a UUID');
      }
      return transaction('readwrite', (store, done) => {
        store.delete(`${scope}|${id}`);
        done();
      });
    }
  };
}

export { validateScope, validateRecord };
