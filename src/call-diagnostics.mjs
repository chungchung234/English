const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD = /^(?:git:[0-9a-f]{7,64}|source:[0-9a-f]{12,64}|dev:unversioned)$/;
const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const KINDS = new Set(['provider_error', 'request_timeout', 'connection_state', 'context_error', 'transcription_error', 'media_error', 'audio_configuration', 'audio_interruption', 'turn_latency']);
const REQUESTS = new Set(['unknown', 'checkpoint', 'session.update', 'conversation.item.delete', 'response.create', 'response.cancel', 'input_audio_buffer.commit', 'output_audio_buffer.clear']);
const CONNECTIONS = new Set(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']);
const DATA_STATES = new Set(['connecting', 'open', 'closing', 'closed']);
const PHASES = new Set(['connecting', 'connected', 'ending', 'ended']);
const AUDIO_ENUMS = {
  requested_mode: new Set(['speakerphone', 'headset', 'unknown']),
  expected_noise: new Set(['far_field', 'near_field', 'provider_default', 'unreported']),
  effective_noise: new Set(['far_field', 'near_field', 'off', 'unreported']),
  capture_echo: new Set(['on', 'off', 'unreported']),
  capture_noise: new Set(['on', 'off', 'unreported']),
  capture_gain: new Set(['on', 'off', 'unreported']),
  vad_type: new Set(['semantic_vad', 'server_vad', 'off', 'unreported']),
  interrupt_response: new Set(['on', 'off', 'unreported']),
  output_state: new Set(['playing', 'generating', 'idle', 'unknown']),
  cancel_origin: new Set(['provider_turn_detected', 'client_hold', 'client_end', 'client_other', 'unattributed']),
};
const LIMIT = 100, BATCH = 20, DEDUP_MS = 10_000;
const RETRY_BASE_MS = 30_000, RETRY_MAX_MS = 300_000, RETRY_LIMIT = 8;
const LATENCY_ENUMS = {
  purpose: new Set(['startup', 'reply', 'hint']),
  start_basis: new Set(['speech_stop_received', 'request_sent']),
  measurement: new Set(['provider_output_started', 'remote_stream_samples', 'native_render', 'source_saved']),
};
const LATENCY_TIMES = new Set(['request_ms', 'transcription_ms', 'save_ack_ms', 'provider_output_ms', 'first_audio_ms']);
function cleanLatencyContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !UUID.test(value.turn_key)) return null;
  const result = { turn_key: value.turn_key };
  for (const [key, allowed] of Object.entries(LATENCY_ENUMS)) {
    if (!allowed.has(value[key])) return null;
    result[key] = value[key];
  }
  for (const key of LATENCY_TIMES) if (Object.hasOwn(value, key)) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 120_000) return null;
    result[key] = value[key];
  }
  if (value.measurement === 'provider_output_started' && result.provider_output_ms === undefined ||
      ['remote_stream_samples', 'native_render'].includes(value.measurement) && result.first_audio_ms === undefined ||
      value.measurement === 'source_saved' && result.save_ack_ms === undefined) return null;
  return result;
}

function cleanAudioContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Fixed key order makes equivalent settings deduplicate even after reload.
  const result = {};
  for (const [key, allowed] of Object.entries(AUDIO_ENUMS)) {
    if (typeof value[key] === 'string' && allowed.has(value[key])) result[key] = value[key];
  }
  // This is an app-generated opaque UUID, never a provider response identifier.
  if (typeof value.response_key === 'string' && UUID.test(value.response_key)) result.response_key = value.response_key;
  return Object.keys(result).length ? result : null;
}
const audioKey = value => JSON.stringify([value.audio_context || null, value.latency_context || null]);
const copyReceipt = value => ({ ...value, ...(value.audio_context ? { audio_context: { ...value.audio_context } } : {}), ...(value.latency_context ? { latency_context: { ...value.latency_context } } : {}) });

// Diagnostics retain codes and connection state only. Provider messages, audio,
// transcripts and credentials never enter either the local queue or the RPC.
function clean(value) {
  if (!value || !UUID.test(value.session_id) || !KINDS.has(value.kind) ||
      !CONNECTIONS.has(value.connection_state) || !DATA_STATES.has(value.data_state) || !PHASES.has(value.phase) ||
      !Number.isInteger(value.elapsed_ms) || value.elapsed_ms < 0 || value.elapsed_ms > 7_200_000) return null;
  const audio_context = cleanAudioContext(value.audio_context);
  const latency_context = cleanLatencyContext(value.latency_context);
  if (['audio_configuration', 'audio_interruption'].includes(value.kind) && !audio_context || value.kind === 'turn_latency' && !latency_context) return null;
  return {
    session_id: value.session_id,
    client_build: typeof value.client_build === 'string' && BUILD.test(value.client_build) ? value.client_build : 'dev:unversioned',
    kind: value.kind,
    code: typeof value.code === 'string' && CODE.test(value.code) ? value.code : 'unknown',
    request_type: REQUESTS.has(value.request_type) ? value.request_type : 'unknown',
    elapsed_ms: value.elapsed_ms,
    connection_state: value.connection_state,
    data_state: value.data_state,
    phase: value.phase,
    ...(audio_context ? { audio_context } : {}),
    ...(latency_context ? { latency_context } : {}),
  };
}
function receipt(value) {
  const data = clean(value);
  if (!data || !UUID.test(value.event_id) || typeof value.occurred_at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT/.test(value.occurred_at) || !Number.isFinite(Date.parse(value.occurred_at))) return null;
  return { event_id: value.event_id, occurred_at: new Date(value.occurred_at).toISOString(), ...data };
}

export function createCallDiagnostics({ getScope, send, storage, now = Date.now, randomUUID = () => crypto.randomUUID() }) {
  // Some browsers throw when merely accessing localStorage. A memory queue can
  // still deliver diagnostics without changing call behavior in that case.
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { /* best effort */ } }
  const accounts = new Map(), recent = new Map();
  let flight = null;
  const owner = () => { try { const value = getScope(); return typeof value === 'string' && value ? value : null; } catch { return null; } };
  const key = scope => 'loop.call-diagnostics:' + scope;
  const retryKey = scope => 'loop.call-diagnostics-retry:' + scope;
  const state = scope => {
    if (!accounts.has(scope)) {
      let retries = [], gate = 0;
      try {
        const saved = JSON.parse(storage?.getItem(retryKey(scope)) || '{}');
        if (Array.isArray(saved.rows)) retries = saved.rows.slice(-LIMIT).filter(row => UUID.test(row?.id) &&
          Number.isInteger(row.attempts) && row.attempts > 0 && row.attempts <= RETRY_LIMIT &&
          Number.isFinite(row.nextAt) && row.nextAt >= 0 && typeof row.quarantined === 'boolean');
        if (Number.isFinite(saved.gate) && saved.gate >= 0) gate = saved.gate;
      } catch { /* Invalid retry metadata never changes the diagnostic receipt. */ }
      accounts.set(scope, { rows: [], acknowledged: new Set(), retry: new Map(retries.map(row => [row.id, row])), gate });
    }
    return accounts.get(scope);
  };
  function read(scope) {
    const current = state(scope);
    // A tab already open before another tab's failure must not overwrite its
    // stronger retry/quarantine decision when it next flushes the same UUIDs.
    try {
      const saved = JSON.parse(storage?.getItem(retryKey(scope)) || '{}');
      if (Number.isFinite(saved.gate) && saved.gate >= 0) current.gate = Math.max(current.gate, saved.gate);
      for (const row of (Array.isArray(saved.rows) ? saved.rows.slice(-LIMIT) : [])) {
        if (!UUID.test(row?.id) || !Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > RETRY_LIMIT ||
          !Number.isFinite(row.nextAt) || row.nextAt < 0 || typeof row.quarantined !== 'boolean') continue;
        const prior = current.retry.get(row.id);
        current.retry.set(row.id, prior ? { id: row.id, attempts: Math.max(prior.attempts, row.attempts),
          nextAt: Math.max(prior.nextAt, row.nextAt), quarantined: prior.quarantined || row.quarantined } : row);
      }
    } catch { /* Storage denial preserves the in-memory decision. */ }
    let stored = [];
    try {
      const value = JSON.parse(storage?.getItem(key(scope)) || '[]');
      if (Array.isArray(value)) stored = value.slice(-LIMIT).map(receipt).filter(Boolean);
      const onDisk = new Set(stored.map(row => row.event_id));
      for (const id of current.acknowledged) if (!onDisk.has(id)) current.acknowledged.delete(id);
    } catch { /* Keep the memory queue when storage is unavailable or corrupt. */ }
    const combined = new Map([...stored, ...current.rows].filter(row => !current.acknowledged.has(row.event_id)).map(row => [row.event_id, row]));
    current.rows = [...combined.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).slice(-LIMIT);
    const present = new Set(current.rows.map(row => row.event_id));
    for (const id of current.retry.keys()) if (!present.has(id)) current.retry.delete(id);
    return current;
  }
  function persistRetry(scope, current) {
    try { storage?.setItem(retryKey(scope), JSON.stringify({ gate: current.gate, rows: [...current.retry.values()] })); }
    catch { /* In-memory backoff still prevents a retry loop when storage is full. */ }
  }
  function defer(scope, batch, error) {
    const current = read(scope), at = Number(now());
    if (!Number.isFinite(at)) return;
    // Immutable malformed diagnostics cannot improve by resending. Keep them
    // locally quarantined, never acknowledge or alter their content. Permission
    // and transport failures get bounded exponential retries, then quarantine.
    const permanent = /^(?:22[0-9A-Z]{3}|42P01|42883)$/.test(String(error?.code || ''));
    let delay = RETRY_BASE_MS;
    for (const row of batch) {
      const previous = current.retry.get(row.event_id), attempts = Math.min(RETRY_LIMIT, (previous?.attempts || 0) + 1);
      delay = Math.max(delay, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)));
      current.retry.set(row.event_id, { id: row.event_id, attempts, nextAt: at + delay, quarantined: permanent || attempts >= RETRY_LIMIT });
    }
    current.gate = at + delay;
    persistRetry(scope, current);
  }
  function persist(scope, current) {
    try {
      if (!storage) return;
      storage.setItem(key(scope), JSON.stringify(current.rows));
      current.acknowledged.clear();
    } catch { /* Retry delivery from memory; diagnostics cannot interrupt a call. */ }
    persistRetry(scope, current);
  }
  function record(value) {
    try {
      const scope = owner(), data = clean(value);
      if (!scope || !data) return false;
      const time = new Date(now()).getTime();
      if (!Number.isFinite(time)) return false;
      const signature = JSON.stringify([scope, data.session_id, data.kind, data.code, data.request_type, data.connection_state, data.phase, audioKey(data)]);
      for (const [id, at] of recent) if (time - at >= DEDUP_MS || time < at) recent.delete(id);
      const current = read(scope), previous = recent.get(signature) ?? current.rows.filter(row =>
        row.session_id === data.session_id && row.kind === data.kind && row.code === data.code &&
        row.request_type === data.request_type && row.connection_state === data.connection_state && row.phase === data.phase && audioKey(row) === audioKey(data)
      ).reduce((latest, row) => Math.max(latest, Date.parse(row.occurred_at)), -Infinity);
      if (time >= previous && time - previous < DEDUP_MS) return false;
      const event_id = randomUUID();
      if (!UUID.test(event_id)) return false;
      current.rows.push({ event_id, occurred_at: new Date(time).toISOString(), ...data });
      current.rows = current.rows.slice(-LIMIT);
      recent.set(signature, time);
      if (recent.size > LIMIT) recent.delete(recent.keys().next().value);
      persist(scope, current);
      return true;
    } catch { return false; }
  }
  function list() {
    try { const scope = owner(); return scope ? read(scope).rows.map(copyReceipt) : []; } catch { return []; }
  }
  function flush() {
    const scope = owner();
    if (!scope) return Promise.resolve();
    if (flight) return flight;
    const work = (async () => {
      // The queue is bounded to five batches. A partial or absent receipt never
      // lets one flush spin indefinitely, and a new account needs its own flush.
      for (let attempt = 0; attempt < LIMIT / BATCH; attempt++) {
        if (owner() !== scope) return;
        const currentState = read(scope), at = Number(now());
        if (!Number.isFinite(at)) return;
        // A wall-clock correction cannot turn a saved cooldown into a wait of
        // days. This only changes retry metadata, never receipt timestamps.
        if (currentState.gate > at + RETRY_MAX_MS) { currentState.gate = at + RETRY_BASE_MS; persistRetry(scope, currentState); }
        if (at < currentState.gate) return;
        const batch = currentState.rows.filter(row => {
          const retry = currentState.retry.get(row.event_id);
          return !retry || !retry.quarantined && (retry.nextAt <= at || retry.nextAt > at + RETRY_MAX_MS);
        }).slice(0, BATCH).map(copyReceipt);
        if (!batch.length) return;
        let response;
        try { response = await send(batch, scope); } catch (error) { defer(scope, batch, error); return; }
        const sent = new Set(batch.map(row => row.event_id));
        const ids = [...(Array.isArray(response?.event_ids) ? response.event_ids : []),
          ...(Array.isArray(response?.dropped_event_ids) ? response.dropped_event_ids : [])];
        const acknowledged = ids.filter(id => sent.has(id));
        if (!acknowledged.length) { defer(scope, batch); return; }
        const current = read(scope);
        for (const id of acknowledged) { current.acknowledged.add(id); current.retry.delete(id); }
        current.rows = current.rows.filter(row => !current.acknowledged.has(row.event_id));
        // At most one disk queue can need tombstones when storage stays full.
        while (current.acknowledged.size > LIMIT) current.acknowledged.delete(current.acknowledged.values().next().value);
        persist(scope, current);
        if (owner() !== scope) return;
      }
    })().catch(() => { /* Diagnostics never change the call's save result. */ });
    flight = work;
    work.finally(() => { if (flight === work) flight = null; });
    return work;
  }
  return { record, flush, list };
}
