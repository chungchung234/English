import { createLearningOutbox, validateScope } from '../src/learning-outbox.js';

const VERSION = 'conversation-playback-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const companions = new Set(['mia', 'alex', 'juno']);
const validId = value => typeof value === 'string' && UUID.test(value);
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const validTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const ids = (value, maximum) => Array.isArray(value) && value.length > 0 && value.length <= maximum &&
  value.every(validId) && new Set(value).size === value.length;

function receipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id) || !validId(value.session_id) ||
    !companions.has(value.companion_id) || !validTime(value.created_at) || !ids(value.event_ids, 50) ||
    !ids(value.qualified_user_ids, 3000) || !validRevision(value.expected_memory_revision)) {
    throw new TypeError('Invalid conversation playback receipt');
  }
  // This store never receives transcript text or provider identifiers.
  return { id: value.id, session_id: value.session_id, companion_id: value.companion_id, created_at: value.created_at,
    event_ids: [...value.event_ids], qualified_user_ids: [...value.qualified_user_ids], expected_memory_revision: value.expected_memory_revision };
}

/** A separate database reuses the existing scoped, immutable event-store API. */
export function createConversationPlaybackOutbox(dbName = 'loop-conversation-playback-v1',
  { indexedDBImpl = globalThis.indexedDB, storage } = {}) {
  let durable = storage;
  const store = () => durable ??= createLearningOutbox(dbName, { indexedDBImpl });
  return {
    async put(scope, value) {
      validateScope(scope); const normalized = receipt(value);
      const { id, created_at, ...body } = normalized;
      await store().put(scope, { id, kind: 'event', created_at, body: { version: VERSION, ...body } });
      return id;
    },
    async list(scope) {
      validateScope(scope);
      return (await store().list(scope)).map(row => {
        if (row.kind !== 'event' || row.body?.version !== VERSION) throw new TypeError('Unknown conversation playback record');
        return receipt({ ...row.body, id: row.id, created_at: row.created_at });
      });
    },
    async remove(scope, id) { validateScope(scope); await store().remove(scope, id); },
  };
}

/**
 * Call-local playback evidence. observe() runs synchronously on floor updates,
 * before any saving await, so a future revision cannot relabel old playback.
 * capture() only queues quotations whose raw transcript writes were ACKed.
 */
export function createConversationPlaybackCollector({ scope, sessionId, companionId, outbox } = {}) {
  validateScope(scope);
  if (!validId(sessionId) || !companions.has(companionId) || !outbox?.put) throw new TypeError('Invalid playback collector');
  const revisions = new Map(), queued = new Set();
  let accepted = [], latest, flight, requested = false;

  async function collect({ transcript, providerItems }) {
    const rows = transcript instanceof Map ? [...transcript.values()] : [];
    const byProvider = new Map();
    for (const row of rows) {
      if (!row || !validId(row.id) || !['user', 'assistant'].includes(row.speaker) || !validTime(row.occurred_at)) continue;
      const providerId = providerItems?.get(row.id);
      if (typeof providerId !== 'string' || !revisions.has(providerId)) continue;
      const list = byProvider.get(providerId) || []; list.push(row); byProvider.set(providerId, list);
    }
    let nearestUser = null, queuedCount = 0, failedCount = 0;
    for (const providerId of accepted) {
      const matches = byProvider.get(providerId);
      // An unresolved earlier item could be the nearest caller turn. Defer
      // instead of attaching an assistant quote to an older, unrelated turn.
      if (!matches || matches.length !== 1) { nearestUser = null; continue; }
      const row = matches[0];
      if (row.speaker === 'user') { nearestUser = row; continue; }
      const revision = revisions.get(providerId);
      if (queued.has(row.id) || !validRevision(revision) || row.storage !== 'server' || nearestUser?.storage !== 'server' ||
        revisions.get(providerItems?.get(nearestUser.id)) !== revision ||
        Date.parse(nearestUser.occurred_at) > Date.parse(row.occurred_at)) continue;
      const entry = { id: row.id, session_id: sessionId, companion_id: companionId, created_at: row.occurred_at,
        event_ids: [row.id], qualified_user_ids: [nearestUser.id], expected_memory_revision: revision };
      try { await outbox.put(scope, entry); queued.add(row.id); queuedCount++; }
      catch { failedCount++; } // Optional continuity evidence cannot fail a call's raw save.
    }
    return { queued: queuedCount, failed: failedCount };
  }
  return {
    observe(acceptedItemIds, memoryRevision) {
      if (!Array.isArray(acceptedItemIds)) return false;
      const next = [...new Set(acceptedItemIds.filter(id => typeof id === 'string' && id.trim() && id.length <= 256))];
      const changed = next.length !== accepted.length || next.some((id, index) => id !== accepted[index]);
      accepted = next;
      for (const id of accepted) if (!revisions.has(id)) revisions.set(id, validRevision(memoryRevision) ? memoryRevision : null);
      return changed;
    },
    capture(transcript, providerItems) {
      latest = { transcript, providerItems }; requested = true;
      if (flight) return flight;
      flight = (async () => {
        const result = { queued: 0, failed: 0 };
        while (requested) {
          requested = false; const outcome = await collect(latest);
          result.queued += outcome.queued; result.failed += outcome.failed;
        }
        return result;
      })().finally(() => { flight = null; });
      return flight;
    },
  };
}

function payload(value) {
  return { p_session_id: value.session_id, p_event_ids: [...value.event_ids], p_receipt_id: value.id,
    p_qualified_user_ids: [...value.qualified_user_ids], p_expected_memory_revision: value.expected_memory_revision };
}
function completeAcknowledgement(result, value) {
  if (!result || result.session_id !== value.session_id || !Array.isArray(result.acknowledged_ids) || !Array.isArray(result.discarded_ids)) return false;
  const acknowledged = result.acknowledged_ids, discarded = result.discarded_ids;
  if (![...acknowledged, ...discarded].every(validId) || new Set([...acknowledged, ...discarded]).size !== acknowledged.length + discarded.length) return false;
  if (acknowledged.some(id => !value.event_ids.includes(id)) || discarded.some(id => !value.event_ids.includes(id))) return false;
  if (discarded.length && result.reason !== 'stale_revision') return false;
  if (!discarded.length && result.reason !== null) return false;
  return acknowledged.length + discarded.length === value.event_ids.length;
}

/** Best-effort delivery is independent of raw transcript/finish-session ACKs. */
export function createConversationPlaybackDelivery({ outbox, getScope, send, maxRequests = 50 } = {}) {
  if (!outbox?.list || !outbox?.remove || typeof getScope !== 'function' || typeof send !== 'function' ||
    !Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new TypeError('Invalid playback delivery');
  const flights = new Map();
  return {
    flush() {
      const scope = getScope(); if (!scope) return Promise.resolve({ delivered: 0 });
      if (flights.has(scope)) return flights.get(scope);
      const work = (async () => {
        let delivered = 0;
        try {
          const pending = (await outbox.list(scope)).slice(0, maxRequests);
          for (const value of pending) {
            if (getScope() !== scope) break;
            const normalized = receipt(value), result = await send(payload(normalized), scope);
            if (getScope() !== scope || !completeAcknowledgement(result, normalized)) break;
            await outbox.remove(scope, normalized.id); delivered++;
          }
        } catch { /* Offline, malformed ACK and local-storage failure retain exact receipts. */ }
        return { delivered };
      })().finally(() => { flights.delete(scope); });
      flights.set(scope, work); return work;
    },
  };
}
