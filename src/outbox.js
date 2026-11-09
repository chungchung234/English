// IndexedDB is a crash-recovery queue. Supabase remains the source of truth.
export function createOutbox(dbName = 'loop-outbox-v1') {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
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
    remove: ids => transaction('readwrite', store => ids.forEach(id => store.delete(id)))
  };
}

// Delete only after server acknowledgement; retries keep the same event UUID/key.
export async function flushOutbox(outbox, scope, send) {
  const pending = await outbox.list(scope);
  const sessions = Map.groupBy(pending, item => item.sessionId);
  for (const [sessionId, records] of sessions) {
    for (let offset = 0; offset < records.length; offset += 50) {
      const batch = records.slice(offset, offset + 50);
      await send(sessionId, batch.map(item => item.event));
      await outbox.remove(batch.map(item => item.id));
    }
  }
  return (await outbox.list(scope)).length;
}
