const BUILD = /^(?:git:[0-9a-f]{7,64}|source:[0-9a-f]{12,64}|dev:unversioned)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = ['created', 'device_persisted', 'server_ack'];
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));

// Only release provenance crosses the analytics boundary. Never spread caller
// objects here: voice content, auth tokens, and account details are not metadata.
export function telemetryMetadata(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return { telemetry_schema: 1, ...(typeof source.client_build === 'string' && BUILD.test(source.client_build) ? { client_build: source.client_build } : {}) };
}

export function clientBuild(value = globalThis.LOOP_CLIENT_BUILD) {
  return typeof value === 'string' && BUILD.test(value) ? value : 'dev:unversioned';
}

export function createTelemetryReceipt(metadata, { randomUUID = () => crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  return Object.freeze({ eventId: randomUUID(), occurredAt: now(), metadata: Object.freeze(telemetryMetadata(metadata)) });
}

// The receipt is created once, at a real RTC connected observation. Storage can
// fail independently of RTC, so retries need their own bounded schedule rather
// than waiting for another connectionstatechange event.
export function createConnectedTelemetry({ metadata, enqueue, isCurrent, onPersisted = () => {}, onStage = () => {},
  sessionId, retryDelays = [250, 1000, 3000, 8000], setTimer = setTimeout, clearTimer = clearTimeout,
  receiptOptions } = {}) {
  let receipt, attempts = 0, persisted = false, stopped = false, timer = null, inFlight = null;
  const report = (stage, reason) => {
    try { onStage({ ...receipt, sessionId, stage, attempts, ...(reason ? { reason } : {}) }); } catch { /* Diagnostics must not interrupt a call. */ }
  };
  const active = () => !stopped && isCurrent();
  async function attempt() {
    if (!active() || persisted) return persisted;
    if (inFlight) return inFlight;
    const work = (async () => {
      attempts++;
      let stored = false;
      try { stored = await enqueue(receipt) === true; } catch { /* Retain this receipt for the next storage attempt. */ }
      if (!active()) return false;
      if (stored) {
        persisted = true;
        report('device_persisted');
        try { onPersisted(); } catch { /* Consumer UI cannot undo durable storage. */ }
        return true;
      }
      report('created', 'storage');
      if (attempts <= retryDelays.length) timer = setTimer(() => {
        timer = null;
        void attempt();
      }, retryDelays[attempts - 1]);
      return false;
    })();
    inFlight = work;
    try { return await work; } finally { if (inFlight === work) inFlight = null; }
  }
  return {
    observe(connectionState) {
      if (connectionState !== 'connected' || !active()) return Promise.resolve(false);
      if (!receipt) {
        receipt = createTelemetryReceipt(metadata, receiptOptions);
        report('created');
        return attempt();
      }
      // Duplicate connected notifications cannot create another event, overlap a
      // write, or reset an exhausted retry budget.
      return inFlight || Promise.resolve(persisted);
    },
    stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; },
    get state() { return { stage: persisted ? 'device_persisted' : receipt ? 'created' : 'unobserved', attempts, eventId: receipt?.eventId || null }; }
  };
}

// A small, account-scoped support journal. It records delivery evidence, not
// event bodies. Its failure never changes the durable queue's success result.
export function createTelemetryDiagnostics({ getScope, storage = globalThis.localStorage, limit = 20,
  now = () => new Date().toISOString() } = {}) {
  const clean = value => {
    if (!value || !UUID.test(value.eventId) || !UUID.test(value.sessionId) || !STAGES.includes(value.stage)) return null;
    const metadata = telemetryMetadata(value.metadata);
    return { eventId: value.eventId, sessionId: value.sessionId, stage: value.stage, metadata,
      ...(iso(value.occurredAt) ? { occurredAt: value.occurredAt } : {}),
      ...(iso(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
      ...(Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 5 ? { attempts: value.attempts } : {}),
      ...(value.stage === 'created' && value.reason === 'storage' ? { reason: 'storage' } : {}) };
  };
  const read = scope => {
    if (!scope) return [];
    try {
      const rows = JSON.parse(storage?.getItem('loop.telemetry:' + scope) || '[]');
      return Array.isArray(rows) ? rows.map(clean).filter(Boolean).slice(-limit) : [];
    } catch { return []; }
  };
  return {
    record(value) {
      const scope = getScope();
      const row = clean({ ...value, updatedAt: now() });
      if (!scope || !row) return;
      try {
        const rows = read(scope), old = rows.find(item => item.eventId === row.eventId);
        if (old && STAGES.indexOf(old.stage) > STAGES.indexOf(row.stage)) return;
        storage?.setItem('loop.telemetry:' + scope, JSON.stringify([...rows.filter(item => item.eventId !== row.eventId), clean({ ...old, ...row })].slice(-limit)));
      } catch { /* Support diagnostics are best effort; IndexedDB owns delivery. */ }
    },
    list() { return read(getScope()); }
  };
}
