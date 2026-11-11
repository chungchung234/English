// Holding the floor changes response generation, never the microphone. We use
// the provider's complete effective VAD policy so speed/checkpoint updates do
// not silently reset it. A failed acknowledgement keeps playback blocked.
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const valid = value => value && ['semantic_vad', 'server_vad'].includes(value.type);
const equal = (left, right) => valid(left) && valid(right) && Object.keys(right).every(key => left[key] === right[key]);

export function createVoiceTurnControls({ send, changed = () => {}, blockOutput = () => {}, failed = () => {}, timeoutMs = 8000 }) {
  let policy = null, available = false, disposed = false, blocked = false, desiredHold = false;
  let phase = 'idle', flight = null, speaking = false, awaitingCommit = false, heldInput = false, pendingReply = false;
  let lastResponse = null, effectivePolicy = null, clearVerified = false;
  const sent = new Set(), clearRequests = new Set(), activeResponses = new Set(), cancelledResponses = new Set(), itemResponses = new Map();
  const state = () => ({ ready: Boolean(policy), held: blocked, desiredHold, phase, pending: Boolean(flight), inputBusy: speaking || awaitingCommit });
  const publish = () => changed(state());
  const output = value => { blocked = value; blockOutput(value); };
  function transmit(event) {
    const eventId = event.event_id || 'voice-floor-' + crypto.randomUUID(); sent.add(eventId);
    send({ ...event, event_id: eventId }); return eventId;
  }
  function silence(responseId = lastResponse) {
    if (responseId) cancelledResponses.add(responseId);
    transmit({ type: 'response.cancel', ...(responseId ? { response_id: responseId } : {}) });
    clearOutput();
  }
  function clearOutput() {
    const eventId = 'voice-floor-' + crypto.randomUUID(); clearVerified = false; clearRequests.add(eventId);
    try { transmit({ event_id: eventId, type: 'output_audio_buffer.clear' }); }
    catch (error) { clearRequests.delete(eventId); throw error; }
  }
  function settle() {
    const target = flight?.target || (phase === 'error' && policy ? { ...clone(policy), create_response: !desiredHold, interrupt_response: desiredHold ? false : policy.interrupt_response !== false } : null);
    if (!target || !equal(effectivePolicy, target) || (!desiredHold && (!clearVerified || clearRequests.size || activeResponses.size))) return;
    clearTimeout(flight?.timer); flight = null; phase = desiredHold ? 'holding' : 'idle'; output(desiredHold);
    if (!desiredHold) {
      pendingReply = heldInput && !speaking && !awaitingCommit;
      if (speaking || awaitingCommit) heldInput = false; // the restored VAD owns this ongoing turn
    }
  }
  function reject(message) {
    if (disposed) return;
    clearTimeout(flight?.timer); flight = null; phase = 'error';
    // Retain the requested state for an explicit retry; do not guess that the
    // server rejected a request whose acknowledgement merely arrived late.
    output(true); pendingReply = false; publish(); failed(message);
  }
  function reply() {
    if (!pendingReply || disposed || !available || blocked || flight || speaking || awaitingCommit || activeResponses.size) return;
    pendingReply = false; heldInput = false;
    try { transmit({ type: 'response.create' }); }
    catch { failed('답변을 요청하지 못했어요. 연결을 확인하고 다시 말씀해 주세요.'); }
  }
  function request(hold) {
    if (disposed || !available || !policy || flight || (!hold && (speaking || awaitingCommit))) return false;
    desiredHold = Boolean(hold); phase = hold ? 'holding-pending' : 'resuming';
    // Playback remains muted through resume acknowledgement, including any
    // response that raced a preceding hold request.
    output(true);
    const target = { ...clone(policy), create_response: !hold, interrupt_response: hold ? false : policy.interrupt_response !== false };
    flight = { target, hold, eventId: null, timer: null };
    flight.timer = setTimeout(() => reject('답변 상태를 확인하지 못했어요. 다시 시도하거나 통화를 마쳐 주세요.'), timeoutMs);
    publish();
    try {
      // On resume the settings acknowledgement is also an ordering barrier:
      // cancellation and clear have already been requested on this channel.
      // This avoids treating an older automatic-interruption clear as enough.
      if (!hold) silence();
      flight.eventId = transmit({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: target } } } });
      if (hold) silence();
    } catch { reject('답변을 잠시 멈추지 못했어요. 연결을 확인하고 다시 시도해 주세요.'); }
    return true;
  }
  return {
    get state() { return state(); },
    get blocksResponse() { return blocked || Boolean(flight); },
    request,
    retry() { return request(desiredHold); },
    availability(value) { available = value; reply(); },
    shutdownPolicy() { return policy ? { ...clone(policy), create_response: false, interrupt_response: false } : null; },
    ignoresTranscript(event) {
      return event.type === 'response.output_audio_transcript.done' &&
        (blocked || cancelledResponses.has(event.response_id) || cancelledResponses.has(itemResponses.get(event.item_id)));
    },
    event(event) {
      if (event.type === 'error' && sent.has(event.error?.event_id)) {
        if (!disposed && event.error.event_id === flight?.eventId) reject('답변 상태를 바꾸지 못했어요. 다시 확인해 주세요.');
        if (clearRequests.delete(event.error?.event_id) && !disposed) reject('답변 중지를 확인하지 못했어요. 다시 확인해 주세요.');
        return true;
      }
      if (disposed) return false;
      if (['session.created', 'session.updated'].includes(event.type)) {
        const effective = event.session?.audio?.input?.turn_detection;
        if (valid(effective)) {
          effectivePolicy = clone(effective);
          if (!policy && effective.create_response !== false) policy = clone(effective);
          else if (!blocked && !flight && effective.create_response !== false) policy = clone(effective);
        }
      }
      if (event.type === 'input_audio_buffer.speech_started') { speaking = true; awaitingCommit = false; pendingReply = false; }
      if (event.type === 'input_audio_buffer.speech_stopped') { speaking = false; awaitingCommit = true; }
      if (event.type === 'input_audio_buffer.committed') { awaitingCommit = false; if (blocked) heldInput = true; }
      if (event.type === 'response.created') {
        const id = event.response?.id; if (id) { lastResponse = id; activeResponses.add(id); }
        if (blocked) { try { silence(id); } catch { reject('답변 중지를 확인하지 못했어요. 연결을 확인해 주세요.'); } }
        else { pendingReply = false; heldInput = false; }
      }
      if (event.type === 'response.output_item.added' && event.item?.id && event.response_id) itemResponses.set(event.item.id, event.response_id);
      if (event.type === 'response.done') {
        activeResponses.delete(event.response?.id);
        if (event.response?.status === 'cancelled' && event.response?.id) cancelledResponses.add(event.response.id);
      }
      if (event.type === 'output_audio_buffer.cleared' && clearRequests.size) {
        clearRequests.delete(clearRequests.values().next().value); clearVerified = !clearRequests.size;
      }
      if (event.type === 'output_audio_buffer.started' && blocked) {
        try { clearOutput(); } catch { /* Local output stays muted. */ }
      }
      // Reopening playback requires both the restored policy and the provider's
      // cleared-output/cancelled-response receipts. A settings ack is not a
      // playback acknowledgement. Unrelated partial session updates cannot win.
      settle(); publish(); reply(); return false;
    },
    dispose() { disposed = true; clearTimeout(flight?.timer); flight = null; pendingReply = false; },
  };
}
