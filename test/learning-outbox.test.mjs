import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLearningOutbox} from '../src/learning-outbox.js';

// Small async IndexedDB stand-in to exercise the queue API without adding a package dependency.
function fakeIndexedDB() {
  const databases = new Map();
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          const stores = new Map();
          db = {
            createObjectStore(storeName, {keyPath}) { stores.set(storeName, {keyPath, rows: new Map()}); },
            transaction(storeName) {
              const storeData = stores.get(storeName);
              const tx = {error: null, abort() { this.aborted = true; this.error ??= new Error('Transaction aborted'); settle(); }};
              let pending = 0;
              let scheduled = false;
              const settle = () => {
                if (pending || scheduled || tx.aborted) return;
                scheduled = true;
                setTimeout(() => {
                  scheduled = false;
                  if (pending || tx.aborted) return;
                  tx.oncomplete?.();
                }, 0);
              };
              const operation = (run, req = {}) => {
                pending++;
                setTimeout(() => {
                  try {
                    if (!tx.aborted) req.result = run();
                    req.onsuccess?.();
                  } catch (error) {
                    tx.error = error;
                    req.error = error;
                    req.onerror?.();
                    tx.onerror?.();
                    tx.onabort?.();
                    tx.aborted = true;
                  } finally {
                    pending--;
                    settle();
                  }
                }, 0);
                return req;
              };
              return {
                get error() { return tx.error; },
                set oncomplete(fn) { tx.oncomplete = fn; settle(); },
                set onerror(fn) { tx.onerror = fn; },
                set onabort(fn) { tx.onabort = fn; },
                abort: tx.abort.bind(tx),
                objectStore() {
                  return {
                    get(key) { return operation(() => structuredClone(storeData.rows.get(key))); },
                    getAll() { return operation(() => [...storeData.rows.values()].map(row => structuredClone(row))); },
                    add(row) { return operation(() => { const key = row[storeData.keyPath]; if (storeData.rows.has(key)) throw new Error('Key exists'); storeData.rows.set(key, structuredClone(row)); }); },
                    put(row) { return operation(() => { storeData.rows.set(row[storeData.keyPath], structuredClone(row)); }); },
                    delete(key) { return operation(() => storeData.rows.delete(key)); }
                  };
                }
              };
            }
          };
          databases.set(name, db);
          request.result = db;
          request.onupgradeneeded?.();
        } else request.result = db;
        request.onsuccess?.();
      });
      return request;
    }
  };
}

const accountA = 'https://service.example|11111111-1111-4111-8111-111111111111';
const accountB = 'https://service.example|22222222-2222-4222-8222-222222222222';
const record = (id, created_at, body = {text: 'hello'}, kind = 'event') => ({id, kind, body, created_at});
const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('persists records by account and returns created_at then id order', async () => {
  const queue = createLearningOutbox('test-order', {indexedDBImpl: fakeIndexedDB()});
  const timestamp = '2026-01-01T12:00:00.000Z';
  await queue.put(accountA, record(idB, timestamp, {step: 2}));
  await queue.put(accountA, record(idA, timestamp, {step: 1}));
  await queue.put(accountA, record('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-01-01T12:00:01.000Z'));
  await queue.put(accountB, record(idA, timestamp, {private: true}));
  assert.deepEqual(await queue.list(accountA), [
    record(idA, timestamp, {step: 1}),
    record(idB, timestamp, {step: 2}),
    record('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-01-01T12:00:01.000Z')
  ]);
  assert.deepEqual(await queue.list(accountB), [record(idA, timestamp, {private: true})]);
});

test('same scoped id is idempotent only for identical record content', async () => {
  const queue = createLearningOutbox('test-idempotent', {indexedDBImpl: fakeIndexedDB()});
  const original = record(idA, '2026-01-01T12:00:00.000Z', {text: 'retry', nested: {a: 1, b: 2}});
  await queue.put(accountA, original);
  await queue.put(accountA, record(idA, original.created_at, {nested: {b: 2, a: 1}, text: 'retry'}));
  await assert.rejects(queue.put(accountA, record(idA, original.created_at, {text: 'changed'})), /different learning record/);
  assert.deepEqual(await queue.list(accountA), [original]);
});

test('conflict state survives idempotent retries and reopening without changing the body', async () => {
  const db = fakeIndexedDB();
  const queue = createLearningOutbox('test-conflict-state', {indexedDBImpl: db});
  const original = record(idA, '2026-01-01T12:00:00.000Z', {text: 'immutable', details: {value: 7}});
  await queue.put(accountA, original);
  await queue.put(accountA, {...original, state: 'conflict'});
  await queue.put(accountA, original); // omitted state must not clear conflict
  const reopened = createLearningOutbox('test-conflict-state', {indexedDBImpl: db});
  assert.deepEqual(await reopened.list(accountA), [{...original, state: 'conflict'}]);
  await assert.rejects(reopened.put(accountA, {...original, body: {text: 'changed'}, state: 'conflict'}), /different learning record/);
  assert.deepEqual(await reopened.list(accountA), [{...original, state: 'conflict'}]);
});

test('records remain until explicit scoped removal', async () => {
  const db = fakeIndexedDB();
  const queue = createLearningOutbox('test-remove', {indexedDBImpl: db});
  const item = record(idA, '2026-01-01T12:00:00.000Z');
  await queue.put(accountA, item);
  await queue.put(accountB, item);
  await queue.remove(accountA, idA);
  assert.deepEqual(await queue.list(accountA), []);
  assert.deepEqual(await queue.list(accountB), [item]);
  const reopened = createLearningOutbox('test-remove', {indexedDBImpl: db});
  assert.deepEqual(await reopened.list(accountB), [item]);
});

test('rejects malformed scopes and records', async () => {
  const queue = createLearningOutbox('test-validation', {indexedDBImpl: fakeIndexedDB()});
  assert.throws(() => queue.list('missing-user'), /Scope/);
  assert.throws(() => queue.remove(accountA, 'not-a-uuid'), /UUID/);
  assert.throws(() => queue.put(accountA, {id: idA, kind: 'other', body: {}, created_at: '2026-01-01T00:00:00Z'}), /kind/);
  assert.throws(() => queue.put(accountA, record(idA, 'bad-time')), /created_at/);
});
