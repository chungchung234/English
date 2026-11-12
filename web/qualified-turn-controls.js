// The browser owns response creation in manual_turns_v1. Provider VAD still
// commits/transcribes input; neither noise nor a transcript alone proves speech.
// This controller never deletes learner input or changes microphone capture.
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const validPolicy = value => value && ['semantic_vad', 'server_vad'].includes(value.type);
const manualPolicy = value => validPolicy(value) && value.create_response === false && value.interrupt_response === false;
const nonempty = value => typeof value === 'string' && Boolean(value.trim());

export function createQualifiedTurnControls({ send, instructions = () => '', openingInstructions = () => '',
  hasRecentVoice = () => false, now = () => performance.now(), changed = () => {}, blockOutput = () => {},
  failed = () => {}, timeoutMs = 8000, graceMs = 350,
  generationTimeoutMs = Math.max(timeoutMs, 30000), playbackTimeoutMs = Math.max(timeoutMs, 60000) } = {}) {
  if (typeof send !== 'function') throw new TypeError('A send function is required.');
  const born = now(), inputs = new Map(), history = new Map(), responses = new Map(), commands = new Map();
  let available = false, started = false, disposed = false, policy = null, ready = false;
  let desiredHold = false, blocked = true, fault = false, current = null, sequence = 0;
  let startupResolved = false, startupAt = null, startupTimer = null, policyTimer = null, policyRequest = null;
  let lastVoice = -Infinity, pendingHint = null, activeInputId = null, approvalBoundary = -1;

  // Unconfirmed server VAD may stay open on background noise. It cannot claim
  // the floor; only locally qualified speech can delay an opening/reply.
  const inputBusy = () => [...inputs.values()].some(item => !item.deleted && item.qualified &&
    ((item.speaking && item.id === activeInputId) || (!item.timedOut && (item.awaitingCommit || (item.committed && !item.final)))));
  // A manual click approves the latest current candidate, never every noisy
  // transcript accumulated during the call. Server item order, rather than ASR
  // completion order, prevents a delayed old transcript becoming current.
  const manualCandidates = () => [...inputs.values()].filter(item => item.committed && item.final && item.nonempty &&
    (!item.qualified || item.retryRequired) && !item.consumed && !item.deleted &&
    (item.order > approvalBoundary || (item.retryRequired && item.order === approvalBoundary)));
  const uncertain = () => manualCandidates().length > 0;
  const pendingUsers = () => [...inputs.values()].filter(item => item.committed && item.final && item.nonempty && item.qualified && !item.retryRequired && !item.consumed && !item.deleted);
  const phase = () => fault ? 'error' : desiredHold ? (current ? 'holding-pending' : 'holding') :
    current?.cancelled ? 'interrupting' : current ? (current.id ? 'responding' : 'thinking') :
      !startupResolved && started ? 'startup' : 'listening';
  const state = () => ({ ready, held: blocked, desiredHold, phase: phase(),
    pending: Boolean(current || policyRequest || startupTimer), inputBusy: inputBusy(), needsManualReply: uncertain() });
  function publish() { if (!disposed) { try { changed(state()); } catch { /* Rendering cannot alter ownership. */ } } }
  function output(value) {
    if (blocked === value) return;
    blocked = value;
    try { blockOutput(value); } catch { /* Ownership remains blocked even if a removed element cannot render it. */ }
  }
  // Begin muted until the effective manual policy has been acknowledged.
  try { blockOutput(true); } catch { /* The caller may attach playback later. */ }
  function fail(message) {
    if (disposed) return;
    const first = !fault; fault = true; output(true); clearTimeout(startupTimer); startupTimer = null;
    publish(); if (first) { try { failed(message); } catch { /* Reporting is observational. */ } }
  }
  function transmit(event, record = {}) {
    const eventId = 'qualified-turn-' + crypto.randomUUID();
    commands.set(eventId, { ...record, type: event.type });
    while (commands.size > 256) commands.delete(commands.keys().next().value);
    try {
      const result = send({ ...event, event_id: eventId });
      if (result?.then) Promise.resolve(result).catch(() => fail('답변 요청을 확인하지 못했어요. 연결을 확인하거나 통화를 다시 시작해 주세요.'));
    } catch (error) { commands.delete(eventId); throw error; }
    return eventId;
  }
  function input(id) {
    if (typeof id !== 'string' || !id) return null;
    if (!inputs.has(id)) {
      const item = { id, order: sequence++, startedAt: now(), sawSpeech: false, speaking: false,
        awaitingCommit: false, committed: false, final: false, nonempty: false, qualified: false, timedOut: false, retryRequired: false, consumed: false, deleted: false, timer: null };
      inputs.set(id, item); history.set(id, { id, role: 'user', order: item.order });
    }
    return inputs.get(id);
  }
  function armInput(item) {
    clearTimeout(item.timer); item.timedOut = false;
    item.timer = setTimeout(() => {
      if (disposed || item.final) return;
      // A timeout is not a speech stop, commit or final ASR receipt. Keep the
      // candidate open so real speech later in that same server item may still
      // qualify. The app retains all transcription/save failure accounting.
      item.timedOut = true;
      pump();
    }, timeoutMs);
  }
  function qualifies(item, voiceTime = lastVoice) {
    if (!item?.sawSpeech || item.deleted || voiceTime < born || voiceTime < item.startedAt - 500 || voiceTime > now() + 100) return false;
    let recent = false;
    try { recent = hasRecentVoice(Math.max(born, item.startedAt - 500)) === true; } catch { /* Unavailable analysis needs explicit user confirmation. */ }
    return recent;
  }
  function qualify(item, voiceTime = lastVoice) {
    if (!qualifies(item, voiceTime)) return false;
    if (!item.qualified) { item.qualified = true; armInput(item); }
    // Speech takes priority over an opening, including speech whose ASR is late.
    startupResolved = true; clearTimeout(startupTimer); startupTimer = null;
    if (item.speaking && current && !current.cancelled) cancelCurrent();
    return true;
  }
  function acceptedItems(live = true) {
    return [...history.values()].sort((a, b) => a.order - b.order).filter(item => {
      if (item.role === 'user') {
        const source = inputs.get(item.id);
        return source && source.committed && source.final && source.nonempty && source.qualified && (!live || !source.deleted);
      }
      const response = responses.get(item.responseId);
      return (!live || !item.deleted) && response?.generationDone && response.audioStarted && response.audioEnded && response.status === 'completed' && !response.cancelled;
    });
  }
  const references = () => acceptedItems().map(item => ({ type: 'item_reference', id: item.id }));
  function fullInstructions(opening = false) {
    try { const value = opening ? openingInstructions() : instructions(); return nonempty(value) ? value : null; }
    catch { return null; }
  }
  function finishCurrent() {
    if (!current || !current.generationDone || !current.audioEnded) return;
    clearTimeout(current.timer); current.timer = null;
    current = null;
    if (!fault && ready && available && !desiredHold) output(false);
  }
  function armResponse(response, message, delay = timeoutMs) {
    clearTimeout(response.timer);
    response.timer = setTimeout(() => fail(message), delay);
  }
  function clearCurrentOutput(response) {
    if (response.clearRequested) return;
    response.clearRequested = true; response.audioEnded = false;
    transmit({ type: 'output_audio_buffer.clear' }, { response, op: 'clear' });
  }
  function cancelCurrent() {
    if (!current) return false;
    const response = current;
    response.cancelled = true; output(true);
    // response_id is mandatory. Never cancel a different response because a
    // response.created receipt for this request has not arrived yet.
    if (response.id) {
      try {
        if (!response.generationDone && !response.cancelRequested) {
          response.cancelRequested = true;
          transmit({ type: 'response.cancel', response_id: response.id }, { response, op: 'cancel' });
        }
        clearCurrentOutput(response);
      } catch { fail('답변 중지를 확인하지 못했어요. 통화를 다시 시작해 주세요.'); }
    }
    armResponse(response, '답변 중지를 확인하지 못했어요. 통화를 다시 시작해 주세요.');
    finishCurrent(); publish(); return true;
  }
  function create(purpose, userItems = [], hint = null) {
    const base = fullInstructions(purpose === 'startup');
    if (!base || !ready || !available || current || desiredHold || fault || disposed || inputBusy()) return false;
    const response = { nonce: crypto.randomUUID(), purpose, id: null, items: new Set(), users: userItems.map(item => item.id), generationDone: false,
      audioEnded: false, audioStarted: false, cancelled: false, cancelRequested: false, clearRequested: false,
      status: null, timer: null };
    current = response;
    if (purpose === 'startup') startupResolved = true;
    for (const item of userItems) { item.consumed = true; approvalBoundary = Math.max(approvalBoundary, item.order); }
    armResponse(response, '답변 시작을 확인하지 못했어요. 통화를 다시 시작해 주세요.');
    try {
      transmit({ type: 'response.create', response: { conversation: 'auto',
        input: purpose === 'startup' ? [] : references(),
        instructions: hint ? base + '\nFor this response only: ' + hint : base,
        metadata: { turn_nonce: response.nonce, purpose } } }, { response, op: 'create' });
    } catch { fail('답변을 요청하지 못했어요. 연결을 확인하고 통화를 다시 시작해 주세요.'); }
    publish(); return true;
  }
  function pump() {
    if (disposed) return;
    finishCurrent();
    if (ready && available && !fault && !desiredHold && !current?.cancelled) output(false);
    if (fault || !ready || !available || !started || desiredHold || current) { publish(); return; }
    output(false);
    if (inputBusy()) { publish(); return; }
    const users = pendingUsers();
    if (users.length) { startupResolved = true; create('reply', users); return; }
    if (pendingHint) { const hint = pendingHint; pendingHint = null; create('hint', [], hint); return; }
    if (!startupResolved && fullInstructions(true)) {
      startupAt ??= now();
      const remaining = Math.max(0, graceMs - (now() - startupAt));
      if (!remaining) create('startup');
      else if (!startupTimer) startupTimer = setTimeout(() => { startupTimer = null; pump(); }, remaining);
    }
    publish();
  }
  function armPolicy() {
    if (!started || ready || policyTimer || disposed) return;
    policyTimer = setTimeout(() => { policyTimer = null; fail('답변 상태를 확인하지 못했어요. 통화를 다시 시작해 주세요.'); }, timeoutMs);
  }
  function retry() {
    if (disposed || !available) return false;
    // An unacknowledged create/cancel remains ambiguous. Resending could create
    // duplicate speech; a late matching receipt may settle it, or reconnect.
    finishCurrent();
    if (current) return false;
    if (!ready && policy) {
      try {
        policyRequest = transmit({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: { ...clone(policy), create_response: false, interrupt_response: false } } } } }, { op: 'policy' });
        armPolicy(); publish(); return true;
      } catch { fail('답변 상태를 확인하지 못했어요. 통화를 다시 시작해 주세요.'); return false; }
    }
    if (!ready) return false;
    fault = false; pump(); return true;
  }
  return {
    get state() { return state(); },
    get blocksResponse() { return disposed || !ready || fault || desiredHold || Boolean(current); },
    availability(value) { if (disposed) return; available = Boolean(value); if (!available) output(true); else { armPolicy(); pump(); } },
    start() { if (disposed) return false; started = true; armPolicy(); pump(); return true; },
    voice(time = now()) {
      if (disposed || !Number.isFinite(time) || time < born || time > now() + 100) return;
      lastVoice = Math.max(lastVoice, time);
      const item = inputs.get(activeInputId); if (item?.speaking) qualify(item, time);
      pump();
    },
    stop() {
      if (disposed) return false;
      startupResolved = true; clearTimeout(startupTimer); startupTimer = null; pendingHint = null;
      const result = cancelCurrent(); pump(); return result;
    },
    forceReply() {
      if (disposed || fault || desiredHold || !ready || !available || inputBusy()) return false;
      const item = manualCandidates().sort((a, b) => a.order - b.order).at(-1);
      if (!item) return false;
      // Advance before awaiting cancellation receipts so a second click cannot
      // resurrect an older candidate while this approved reply is queued.
      approvalBoundary = Math.max(approvalBoundary, item.order);
      item.qualified = true; item.retryRequired = false;
      startupResolved = true; clearTimeout(startupTimer); startupTimer = null;
      if (current) cancelCurrent();
      pump(); return true;
    },
    request(hold) {
      if (disposed || !available || !ready || fault) return false;
      desiredHold = Boolean(hold);
      if (desiredHold) { clearTimeout(startupTimer); startupTimer = null; output(true); cancelCurrent(); }
      pump(); return true;
    },
    retry,
    requestHint(value) {
      if (disposed || !nonempty(value) || !fullInstructions() || !ready || !available || fault || desiredHold || current || inputBusy()) return false;
      startupResolved = true; clearTimeout(startupTimer); startupTimer = null;
      pendingHint = value; pump(); return true;
    },
    shutdownPolicy() { return policy ? { ...clone(policy), create_response: false, interrupt_response: false } : null; },
    // Realtime deletion only removes live prompt references. Compaction may
    // summarize the same accepted, saved turns after their provider items were
    // deleted, without promoting the app's raw noise transcript into context.
    acceptedItemIds() { return acceptedItems(false).map(item => item.id); },
    ignoresTranscript(event) {
      if (event?.type !== 'response.output_audio_transcript.done') return false;
      const response = responses.get(event.response_id) || responses.get(history.get(event.item_id)?.responseId);
      return Boolean(response?.cancelled) || !response;
    },
    event(event) {
      if (!event || disposed) return false;
      if (event.type === 'error') {
        const command = commands.get(event.error?.event_id);
        if (!command) return false;
        // Generation may have ended before its done receipt reaches us. A
        // scoped "not active" rejection is not proof of a lost response: keep
        // waiting for done and the independent playback receipt/watchdog.
        if (!(command.op === 'cancel' && event.error?.code === 'response_cancel_not_active')) {
          fail('답변 상태를 확인하지 못했어요. 통화를 다시 시작해 주세요.');
        }
        publish(); return true;
      }
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const effective = event.session?.audio?.input?.turn_detection;
        if (validPolicy(effective)) {
          policy = clone(effective); ready = manualPolicy(effective);
          if (ready) { clearTimeout(policyTimer); policyTimer = null; policyRequest = null; }
          else if (started) fail('답변 상태가 변경되었어요. 통화를 다시 시작해 주세요.');
        } else if (event.session?.audio?.input && Object.hasOwn(event.session.audio.input, 'turn_detection')) {
          ready = false; if (started) fail('답변 상태를 확인하지 못했어요. 통화를 다시 시작해 주세요.');
        }
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        const item = input(event.item_id);
        if (item && !item.speaking && !item.consumed && !item.deleted && !item.final) {
          activeInputId = item.id;
          item.startedAt = now(); item.sawSpeech = true; item.speaking = true; item.awaitingCommit = false;
          armInput(item); qualify(item);
        }
      }
      if (event.type === 'input_audio_buffer.speech_stopped') {
        const item = input(event.item_id);
        if (activeInputId === event.item_id) activeInputId = null;
        if (item && !item.final) { item.speaking = false; item.awaitingCommit = !item.committed; armInput(item); }
      }
      if (event.type === 'input_audio_buffer.committed') {
        const item = input(event.item_id);
        if (activeInputId === event.item_id) activeInputId = null;
        if (item) { item.committed = true; item.speaking = false; item.awaitingCommit = false; if (!item.final) armInput(item); }
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const item = input(event.item_id);
        if (activeInputId === event.item_id) activeInputId = null;
        if (item) { item.final = true; item.nonempty = nonempty(event.transcript); item.speaking = false; item.awaitingCommit = false; clearTimeout(item.timer); }
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed') {
        const item = input(event.item_id);
        if (activeInputId === event.item_id) activeInputId = null;
        if (item) { item.final = true; item.speaking = false; item.awaitingCommit = false; clearTimeout(item.timer); }
      }
      if (event.type === 'conversation.item.deleted' && event.item_id) {
        const item = inputs.get(event.item_id); if (item) { item.deleted = true; clearTimeout(item.timer); }
        const entry = history.get(event.item_id); if (entry) entry.deleted = true;
      }
      if (event.type === 'response.created') {
        const response = event.response, expected = current;
        const known = responses.get(response?.id);
        if (known && response.metadata?.turn_nonce === known.nonce && response.metadata?.purpose === known.purpose) {
          // Duplicate receipts cannot reopen completed output or claim a new turn.
        } else if (!response?.id || !expected || response.metadata?.turn_nonce !== expected.nonce || response.metadata?.purpose !== expected.purpose || (expected.id && expected.id !== response.id)) {
          output(true);
          try { if (response?.id) transmit({ type: 'response.cancel', response_id: response.id }, { op: 'unexpected-cancel' }); transmit({ type: 'output_audio_buffer.clear' }, { op: 'unexpected-clear' }); }
          catch { /* Output stays muted on transport failure. */ }
          fail('예상하지 못한 답변이 시작되어 음성을 멈췄어요. 통화를 다시 시작해 주세요.');
        } else {
          expected.id = response.id; responses.set(response.id, expected); clearTimeout(expected.timer); expected.timer = null;
          if (expected.cancelled || fault || desiredHold) cancelCurrent();
          else armResponse(expected, '답변 완료를 확인하지 못했어요. 답변을 멈추거나 통화를 다시 시작해 주세요.', generationTimeoutMs);
        }
      }
      if (event.type === 'response.output_item.added' && event.item?.id) {
        const response = responses.get(event.response_id);
        if (response && !history.has(event.item.id)) { response.items.add(event.item.id); history.set(event.item.id, { id: event.item.id, role: 'assistant', responseId: event.response_id, order: sequence++ }); }
      }
      if (event.type === 'output_audio_buffer.started') {
        const response = responses.get(event.response_id);
        if (!response || response !== current || response.cancelled || fault || desiredHold) {
          output(true);
          if (response === current) cancelCurrent();
          else fail('예상하지 못한 음성이 시작되어 멈췄어요. 통화를 다시 시작해 주세요.');
        } else { response.audioStarted = true; response.audioEnded = false; }
      }
      if (event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared') {
        const response = responses.get(event.response_id);
        if (response) response.audioEnded = true;
      }
      if (event.type === 'response.done') {
        const response = responses.get(event.response?.id);
        if (response) {
          response.generationDone = true; response.status = event.response.status;
          if (event.response.status !== 'completed' && !response.cancelled) {
            response.cancelled = true;
            // A provider failure is not permission for an automatic retry. The
            // user may explicitly retry these inputs once the output has ended.
            for (const id of response.users) {
              const item = inputs.get(id); if (item && !item.deleted) { item.consumed = false; item.retryRequired = true; }
            }
          }
          if (Array.isArray(event.response.output)) {
            let audio = false;
            for (const item of event.response.output) {
              if (item?.id && !history.has(item.id)) { response.items.add(item.id); history.set(item.id, { id: item.id, role: 'assistant', responseId: response.id, order: sequence++ }); }
              if (item?.content?.some(content => ['audio', 'output_audio'].includes(content.type))) audio = true;
            }
            // Text-only and empty responses have no playback receipt to wait for.
            if (!audio && !response.audioStarted && !response.clearRequested) response.audioEnded = true;
          }
          if (!response.audioEnded) armResponse(response, '음성 종료를 확인하지 못했어요. 답변을 멈추거나 통화를 다시 시작해 주세요.', response.cancelled ? timeoutMs : playbackTimeoutMs);
        }
      }
      pump(); return false;
    },
    dispose() {
      disposed = true; clearTimeout(startupTimer); clearTimeout(policyTimer);
      for (const item of inputs.values()) clearTimeout(item.timer);
      for (const response of responses.values()) clearTimeout(response.timer);
      clearTimeout(current?.timer); startupTimer = null; policyTimer = null; pendingHint = null;
    },
  };
}
