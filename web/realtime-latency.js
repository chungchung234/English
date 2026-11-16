// Best-effort timing only. Nothing here owns the response, microphone, playback,
// transcript queue or network. Provider identifiers stay in bounded memory;
// persistent observations contain a newly generated local UUID and numbers.
// A provider output-start receipt is NOT first rendered or physically heard
// audio. A caller may add a separately labelled sample/render observation.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSES = new Set(['startup', 'reply', 'hint']);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const MAX = 64, MAX_MS = 120_000;

export function createRealtimeLatency({ emit = () => {}, now = () => performance.now(),
  randomUUID = () => crypto.randomUUID(), isCurrent = () => true } = {}) {
  const inputs = new Map(), requests = new Map(), responses = new Map();
  let disposed = false, playing = null;
  const live = () => { try { return !disposed && isCurrent() === true; } catch { return false; } };
  const time = () => { try { const value = now(); return Number.isFinite(value) ? value : null; } catch { return null; } };
  function bounded(map, key, value) { map.set(key, value); while (map.size > MAX) map.delete(map.keys().next().value); }
  function duration(at, start) {
    const value = at - start;
    return Number.isFinite(value) && value >= 0 && value <= MAX_MS ? Math.round(value) : undefined;
  }
  function input(itemId) {
    if (!id(itemId)) return null;
    if (!inputs.has(itemId)) bounded(inputs, itemId, { id: itemId, stopped: null, transcribed: null, saved: null, used: false });
    return inputs.get(itemId);
  }
  function observation(turn, measurement) {
    if (!live() || !turn || turn.cancelled) return;
    const context = { turn_key: turn.key, purpose: turn.purpose, start_basis: turn.basis, measurement };
    for (const [field, at] of [['request_ms', turn.requested], ['provider_output_ms', turn.output], ['first_audio_ms', turn.audio]]) {
      if (at !== null && at !== undefined) { const value = duration(at, turn.start); if (value !== undefined) context[field] = value; }
    }
    if (turn.users.length) {
      // A merged response can cover more than one user item. Require every
      // referenced user receipt before calling the stage complete.
      for (const [field, key] of [['transcription_ms', 'transcribed'], ['save_ack_ms', 'saved']]) {
        const sources = turn.users.map(itemId => inputs.get(itemId));
        if (sources.every(source => source && source[key] !== null)) {
          const value = duration(Math.max(...sources.map(source => source[key])), turn.start);
          if (value !== undefined) context[field] = value;
        }
      }
    }
    if (measurement === 'provider_output_started' && context.provider_output_ms === undefined ||
        ['remote_stream_samples', 'native_render'].includes(measurement) && context.first_audio_ms === undefined ||
        measurement === 'source_saved' && context.save_ack_ms === undefined) return;
    const code = measurement === 'provider_output_started' ? 'REALTIME_PROVIDER_OUTPUT' :
      measurement === 'source_saved' ? 'REALTIME_SOURCE_ACK' : 'REALTIME_AUDIO_OBSERVED';
    try { emit({ kind: 'turn_latency', code, request_type: 'response.create', latency_context: context }); }
    catch { /* Metrics cannot disrupt or retry a response. */ }
  }
  function saved(itemIds) {
    if (!live() || !Array.isArray(itemIds)) return;
    const at = time(); if (at === null) return;
    for (const itemId of itemIds) { const source = input(itemId); if (source && source.saved === null) source.saved = at; }
    for (const turn of requests.values()) {
      if (turn.savedReported || !turn.users.length || !turn.users.every(itemId => inputs.get(itemId)?.saved !== null && inputs.has(itemId))) continue;
      turn.savedReported = true; observation(turn, 'source_saved');
    }
  }
  return {
    saved,
    sent(event) {
      if (!live() || !event) return;
      const at = time(); if (at === null) return;
      if (event.type === 'response.cancel') {
        const turn = responses.get(id(event.response_id));
        if (turn) turn.cancelled = true;
        return;
      }
      if (event.type !== 'response.create') return;
      const metadata = event.response?.metadata, nonce = metadata?.turn_nonce, purpose = metadata?.purpose;
      // These are the manual controller's app UUID and finite purpose, not
      // inferred provider IDs or an automatic unsolicited response.
      if (!UUID.test(nonce) || !PURPOSES.has(purpose) || requests.has(nonce)) return;
      const references = Array.isArray(event.response?.input) ? event.response.input : [];
      const users = [...new Set(references.filter(value => value?.type === 'item_reference' && inputs.has(id(value.id)))
        .map(value => value.id))].filter(itemId => !inputs.get(itemId).used);
      const stops = users.map(itemId => inputs.get(itemId).stopped);
      const useStop = purpose === 'reply' && users.length > 0 && stops.every(value => value !== null && duration(at, value) !== undefined);
      let key;
      try { key = randomUUID(); } catch { return; }
      if (!UUID.test(key)) return;
      const turn = { key, purpose, users, start: useStop ? Math.max(...stops) : at,
        basis: useStop ? 'speech_stop_received' : 'request_sent', requested: at,
        output: null, audio: null, audioEnded: false, cancelled: false, savedReported: false, responseId: null };
      for (const itemId of users) inputs.get(itemId).used = true;
      bounded(requests, nonce, turn);
      if (users.length && users.every(itemId => inputs.get(itemId).saved !== null)) {
        turn.savedReported = true; observation(turn, 'source_saved');
      }
    },
    event(event) {
      if (!live() || !event) return;
      const at = time(); if (at === null) return;
      if (event.type === 'input_audio_buffer.speech_stopped') {
        const source = input(event.item_id); if (source && source.stopped === null) source.stopped = at;
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const source = input(event.item_id); if (source && source.transcribed === null) source.transcribed = at;
        return;
      }
      if (event.type === 'response.created') {
        const metadata = event.response?.metadata, responseId = id(event.response?.id), turn = requests.get(metadata?.turn_nonce);
        if (!responseId || !turn || metadata?.purpose !== turn.purpose ||
            turn.responseId && turn.responseId !== responseId || responses.has(responseId) && responses.get(responseId) !== turn || turn.cancelled) return;
        turn.responseId = responseId; bounded(responses, responseId, turn);
        return;
      }
      const responseId = id(event.response_id) || id(event.response?.id), turn = responses.get(responseId);
      if (!turn) return;
      if (event.type === 'output_audio_buffer.started' && !turn.cancelled && !turn.audioEnded && turn.output === null) {
        turn.output = at; playing = responseId; observation(turn, 'provider_output_started');
      }
      if (event.type === 'output_audio_buffer.cleared' || event.type === 'response.done' && event.response?.status !== 'completed') turn.cancelled = true;
      if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type)) {
        turn.audioEnded = true;
        if (responseId === playing) playing = null;
      }
    },
    audioObserved(options = {}) {
      const { responseId = playing, basis } = options || {};
      if (!live() || !['remote_stream_samples', 'native_render'].includes(basis)) return;
      const turn = responses.get(id(responseId)), at = time();
      if (!turn || turn.cancelled || turn.audioEnded || turn.audio !== null || at === null) return;
      turn.audio = at; observation(turn, basis);
    },
    dispose() { disposed = true; inputs.clear(); requests.clear(); responses.clear(); playing = null; },
  };
}
