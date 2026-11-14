// Output transport independent, whole-buffer PCM playback. A matched backend
// manifest is necessary but is not proof of physical listening. No audio/text
// is persisted here and no provider request is made by this module.
// prepare() alone validates the clip before creating its PCM node/loading the
// worklet. A trusted gesture may preload the empty Context/graph/worklet first.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const OWNER_FIELDS = ['scope', 'sessionId', 'companionId', 'callEpoch', 'turnNonce', 'turnId', 'assistantEventId', 'authorityGeneration', 'expectedMemoryRevision', 'playbackEpoch'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && UUID.test(value);
const revision = value => value === null || integer(value);
const safeReason = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'clear';
const snapshotCursor = value => value && Object.freeze({ sourceFrame: value.sourceFrame, phaseNumerator: value.phaseNumerator, phaseDenominator: value.phaseDenominator, renderedContextFrames: value.renderedContextFrames });
function owner(value) {
  if (!value || !id(value.sessionId) || !id(value.turnNonce) || !id(value.turnId) || !id(value.assistantEventId) || !['alex', 'mia', 'juno'].includes(value.companionId) ||
    !['callEpoch', 'authorityGeneration', 'playbackEpoch'].every(key => integer(value[key])) || !revision(value.expectedMemoryRevision) || typeof value.scope !== 'string') throw new TypeError('Invalid playback owner');
  const parts = value.scope.split('|');
  if (parts.length !== 2 || !id(parts[1])) throw new TypeError('Invalid playback scope');
  const service = new URL(parts[0]); if (!['https:', 'http:'].includes(service.protocol) || service.username || service.password) throw new TypeError('Invalid playback scope');
  return Object.freeze(Object.fromEntries(OWNER_FIELDS.map(key => [key, value[key]])));
}
const ownerKey = value => JSON.stringify(OWNER_FIELDS.map(key => value[key]));
const playbackKey = value => JSON.stringify([value.scope, value.sessionId, value.companionId, value.callEpoch, value.turnNonce, value.turnId, value.playbackEpoch]);
function manifest(value, expectedOwner, expectedText, byteLength, maximum) {
  if (!SHA.test(expectedText) || !value || value.version !== 'verified-pcm-candidate-v1' || ownerKey(owner(value.owner)) !== ownerKey(expectedOwner) ||
    value.textSha256 !== expectedText || !SHA.test(value.pcmSha256) || value.format !== 'pcm_s16le' || value.sampleRate !== 24000 || value.channels !== 1 ||
    !integer(value.sourceFrames) || value.sourceFrames < 1 || !integer(value.byteLength) || value.byteLength !== byteLength || byteLength > maximum || value.sourceFrames * 2 !== byteLength ||
    !id(value.synthesisId) || !Number.isFinite(value.synthesisSpeed) || value.synthesisSpeed < .25 || value.synthesisSpeed > 4 ||
    value.transcriptVerification?.status !== 'matched' || value.transcriptVerification.approvedTextSha256 !== expectedText ||
    typeof value.transcriptVerification.policyVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.transcriptVerification.policyVersion)) throw new TypeError('Invalid verified PCM manifest');
  return Object.freeze({ ...value, owner: expectedOwner, transcriptVerification: Object.freeze({ ...value.transcriptVerification }) });
}
function assetUrl(value, base, digest) {
  // Check the injected build descriptor and filename. addModule has no SRI
  // option; deployment must verify the emitted asset under its exact-URL CSP.
  const location = new URL(base), url = new URL(value, location);
  const name = url.pathname.match(/\/verified-pcm-worklet\.([0-9a-f]{12,64})\.js$/);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password || url.search || url.hash || !name ||
    digest !== undefined && (!SHA.test(digest) || !digest.startsWith(name[1]))) throw new TypeError('A same-site content-hashed PCM worklet URL is required');
  return url.href;
}
export async function pcmSha256(bytes, subtle = globalThis.crypto?.subtle) {
  if (!(bytes instanceof ArrayBuffer) || !subtle?.digest) throw new TypeError('PCM digest unavailable');
  return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function createVerifiedPcmPlayback({ workletUrl, workletSha256, baseUrl = globalThis.location?.href,
  isCurrent = () => true, canUnlockContext = value => value === null || isCurrent(value), onEvent = () => {}, AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeConstructor = globalThis.AudioWorkletNode, subtle = globalThis.crypto?.subtle,
  maxPcmBytes = 16 * 1024 * 1024, commandTimeoutMs = 5000, drainTimeoutMs = 5000, pollIntervalMs = 25,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now() } = {}) {
  const url = assetUrl(workletUrl, baseUrl, workletSha256);
  if (typeof isCurrent !== 'function' || typeof canUnlockContext !== 'function' || typeof onEvent !== 'function' || !integer(maxPcmBytes) || maxPcmBytes < 2 ||
    ![commandTimeoutMs, drainTimeoutMs, pollIntervalMs].every(value => Number.isFinite(value) && value > 0)) throw new TypeError('Invalid PCM playback options');
  let context = null, gain = null, reference = null, moduleFlight = null, current = null, sequence = 0, disposed = false;
  const terminalKeys = new Set();
  const emit = (record, kind, extra = {}) => { try { onEvent(Object.freeze({ kind, owner: record?.owner ?? null, ...extra })); } catch { /* Observers cannot change ownership. */ } };
  const owns = record => { try { return Boolean(record && !disposed && current === record && !record.terminal && isCurrent(record.owner)); } catch { return false; } };
  // This authorizes only an EMPTY context preflight, not any clip. Integrators
  // can check current call/scope/authority while isCurrent stays turn-strict.
  const mayUnlock = record => { try { return !disposed && Boolean(canUnlockContext(record?.owner ?? null)); } catch { return false; } };
  const mute = () => { try { if (gain) { gain.gain.cancelScheduledValues?.(context.currentTime); gain.gain.setValueAtTime(0, context.currentTime); } } catch { if (gain) gain.gain.value = 0; } };
  function send(record, kind, extra = {}, transfer = []) {
    const commandId = ++record.commandId;
    record.node.port.postMessage({ kind, token: record.token, commandId, ...extra }, transfer); return commandId;
  }
  function cleanup(record) {
    clearTimer(record.poll); record.poll = null; clearTimer(record.loadTimer);
    record.signal?.removeEventListener?.('abort', record.aborted);
    if (record.node) { record.node.port.onmessage = null; record.node.onprocessorerror = null; try { record.node.disconnect(); record.node.port.close?.(); } catch { /* Released already. */ } record.node = null; }
    record.resolveLoad?.(false); record.resolveLoad = null;
  }
  function stop(record, reason = 'clear') {
    if (!record || record.terminal) return false;
    // The software gate closes synchronously. Already queued hardware audio
    // cannot be recalled, and this operation never claims zero-ms device stop.
    mute(); record.terminal = true; record.status = 'terminal'; record.reason = safeReason(reason); terminalKeys.add(playbackKey(record.owner));
    try { if (record.node) send(record, 'clear'); } catch { /* The gain is already closed. */ }
    cleanup(record);
    // A later call/turn cleanup cannot retroactively cancel completed evidence.
    if (!record.completed) emit(record, 'terminal', { reason: record.reason, cursor: record.cursor });
    return true;
  }
  function check(record) { if (owns(record)) return true; if (current === record && !record.terminal) stop(record, 'scope_changed'); return false; }
  function ensureContext() {
    if (disposed) throw Error('PCM player disposed');
    if (context) return context;
    if (typeof AudioContextConstructor !== 'function' || typeof AudioWorkletNodeConstructor !== 'function') throw Error('PCM audio unavailable');
    context = new AudioContextConstructor({ latencyHint: 'interactive' });
    gain = context.createGain(); gain.gain.value = 0;
    reference = context.createMediaStreamDestination(); gain.connect(context.destination); gain.connect(reference);
    context.onstatechange = () => {
      const record = current; if (!record || record.terminal || record.completed) return;
      if (!check(record)) return;
      if (context.state !== 'running') {
        mute(); record.contextHeld = true;
        if (record.started) { record.continuityUncertain = true; emit(record, 'continuity_uncertain', { cursor: record.cursor }); }
        if (record.loaded) try { send(record, 'pause'); } catch { stop(record, 'context_failed'); }
        record.status = 'blocked'; emit(record, 'context_interrupted');
        if (context.state === 'closed') stop(record, 'context_failed');
      }
    };
    return context;
  }
  function loadModule() {
    const audio = ensureContext();
    return moduleFlight ||= Promise.resolve().then(() => audio.audioWorklet.addModule(url)).catch(error => { moduleFlight = null; throw error; });
  }
  function startOrResume(record, resume = false) {
    if (!check(record) || !record.loaded || record.completed || record.candidates.size) return false;
    if (context.state !== 'running') { record.status = 'blocked'; record.contextHeld = true; emit(record, 'blocked'); return false; }
    record.contextHeld = false;
    // The source may have drained before the context was interrupted. Resume
    // only output-position polling; never restart already consumed samples.
    if (record.drain) { record.status = 'draining'; poll(record); return true; }
    gain.gain.setValueAtTime(1, context.currentTime);
    try { send(record, resume ? 'resume' : 'play'); } catch { stop(record, 'context_failed'); return false; }
    record.status = 'playing'; poll(record); return true;
  }
  function finish(record, kind, extra = {}) {
    if (!check(record) || record.completed) return;
    record.completed = true; record.completionKind = kind; record.status = kind;
    terminalKeys.add(playbackKey(record.owner)); mute();
    try { send(record, 'clear'); } catch { /* Completed source cleanup is not new evidence. */ }
    cleanup(record); emit(record, kind, extra);
  }
  function poll(record) {
    if (record.poll || record.completed || record.terminal) return;
    record.poll = setTimer(() => {
      record.poll = null;
      if (!check(record) || record.completed) return;
      if (record.drain && !record.candidates.size && !record.contextHeld && context.state === 'running') {
        let timestamp;
        try { timestamp = context.getOutputTimestamp?.(); } catch { /* Missing output position cannot establish completion. */ }
        const time = timestamp?.contextTime;
        const plausible = Number.isFinite(time) && time >= 0 && Number.isFinite(timestamp?.performanceTime) && time <= context.currentTime + .1 &&
          (record.lastOutputTime === null || time >= record.lastOutputTime);
        if (plausible) record.lastOutputTime = time;
        if (!record.continuityUncertain && plausible && Math.floor(time * context.sampleRate) >= record.drain.finalContextFrameExclusive) {
          finish(record, 'played_through', { ...record.drain, outputTimestampContextTime: time, evidence: 'client_reported_playback_completed' }); return;
        }
        const latency = [context.baseLatency, context.outputLatency].reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), .1);
        const guarded = context.currentTime >= record.drain.finalContextFrameExclusive / context.sampleRate + latency;
        if ((typeof context.getOutputTimestamp !== 'function' || record.continuityUncertain) && guarded || now() - record.drainAt >= drainTimeoutMs) {
          finish(record, 'estimated_drain', { ...record.drain }); return;
        }
      }
      poll(record);
    }, pollIntervalMs);
  }
  function message(record, event) {
    const value = event.data;
    if (!check(record) || value?.token !== record.token) return;
    if (value.cursor && integer(value.cursor.sourceFrame) && value.cursor.sourceFrame <= record.manifest.sourceFrames && integer(value.cursor.phaseNumerator) &&
      value.cursor.phaseDenominator === context.sampleRate && value.cursor.phaseNumerator < context.sampleRate && integer(value.cursor.renderedContextFrames)) record.cursor = snapshotCursor(value.cursor);
    if (value.kind === 'error') { stop(record, 'invalid_audio'); return; }
    if (value.kind === 'loaded' && value.commandId === record.loadCommand) { clearTimer(record.loadTimer); record.loaded = true; record.resolveLoad?.(true); record.resolveLoad = null; }
    else if (value.kind === 'started' && !record.started) { record.started = true; emit(record, 'started', { cursor: record.cursor }); }
    else if (value.kind === 'pause_applied') { record.status = record.candidates.size || record.contextHeld ? 'paused' : record.status; emit(record, 'pause_applied', { candidateId: value.candidateId, decisionEpoch: value.decisionEpoch, commandId: value.commandId, cursor: record.cursor }); }
    else if (value.kind === 'resume_applied') emit(record, 'resume_applied', { commandId: value.commandId, cursor: record.cursor });
    else if (value.kind === 'render_drained' && record.started && !record.drain && record.cursor?.sourceFrame === record.manifest.sourceFrames && value.sourceFrames === record.manifest.sourceFrames && integer(value.finalContextFrameExclusive) && value.finalContextFrameExclusive > 0) {
      record.drain = { sourceFrames: value.sourceFrames, finalContextFrameExclusive: value.finalContextFrameExclusive }; record.drainAt = now(); record.status = 'draining';
      emit(record, 'render_drained', { ...record.drain, cursor: record.cursor }); poll(record);
    }
  }
  return {
    async unlockFromGesture() {
      const requestedRecord = current;
      if (!mayUnlock(requestedRecord)) return false;
      const contextOnly = Boolean(requestedRecord?.terminal || requestedRecord?.completed);
      if (requestedRecord && !contextOnly && !check(requestedRecord)) return false;
      if (contextOnly) { mute(); cleanup(requestedRecord); }
      let resumption;
      try { const audio = ensureContext(); resumption = Promise.resolve(audio.resume()); }
      catch { emit(current, 'blocked'); return false; }
      try {
        // resume() above runs before any await, while activation is available.
        await resumption; if (disposed) return false;
        await loadModule();
        if (disposed) return false;
        if (requestedRecord && current !== requestedRecord) return false;
        if (!mayUnlock(requestedRecord)) return false;
        if (context.state !== 'running') { emit(current, 'blocked'); return false; }
        // A stopped/completed source remains cleaned, gated and tombstoned.
        // Only the context is unlocked for the next separately admitted turn.
        if (contextOnly) { mute(); return true; }
        const record = current;
        if (record && !check(record)) return false;
        if (record && record.playRequested && !record.completed && !record.candidates.size) startOrResume(record, record.started || record.contextHeld);
        return true;
      } catch { if (!disposed && (!requestedRecord || current === requestedRecord)) emit(current, 'blocked'); return false; }
    },
    async prepare(ownerValue, expectedTextSha256, manifestValue, bytes, signal) {
      let approvedOwner, approvedManifest;
      try {
        approvedOwner = owner(ownerValue);
        if (!(bytes instanceof ArrayBuffer)) throw new TypeError('Invalid PCM bytes');
        approvedManifest = manifest(manifestValue, approvedOwner, expectedTextSha256, bytes.byteLength, maxPcmBytes);
        if (disposed || signal?.aborted || terminalKeys.has(playbackKey(approvedOwner)) || !isCurrent(approvedOwner)) return false;
      } catch { emit(null, 'rejected', { code: 'INVALID_ADMISSION' }); return false; }
      if (current && !current.terminal && ownerKey(current.owner) === ownerKey(approvedOwner)) {
        if (current.manifest.pcmSha256 !== approvedManifest.pcmSha256 || current.manifest.textSha256 !== expectedTextSha256) return false;
        return current.preparation || Boolean(current.loaded && !current.completed);
      }
      if (current && !current.terminal) stop(current, 'accepted_new_turn');
      const copy = bytes.slice(0), record = { owner: approvedOwner, manifest: approvedManifest, token: 'pcm-' + ++sequence,
        terminal: false, completed: false, status: 'preparing', commandId: 0, candidates: new Map(), candidateEpochs: new Map(), cursor: null,
        node: null, loaded: false, started: false, playRequested: false, contextHeld: false, continuityUncertain: false,
        drain: null, lastOutputTime: null, poll: null, signal };
      current = record;
      record.aborted = () => stop(record, 'clear'); signal?.addEventListener?.('abort', record.aborted, { once: true });
      record.preparation = (async () => {
        try {
          if (await pcmSha256(copy, subtle) !== approvedManifest.pcmSha256) throw Error('PCM_DIGEST_MISMATCH');
          if (!check(record) || signal?.aborted) return false;
          await loadModule(); if (!check(record)) return false;
          const samples = new Float32Array(approvedManifest.sourceFrames), view = new DataView(copy);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          record.node = new AudioWorkletNodeConstructor(context, 'loop-verified-pcm-v1', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
          record.node.port.onmessage = event => message(record, event);
          record.node.onprocessorerror = () => stop(record, 'context_failed'); record.node.connect(gain);
          const loaded = new Promise(resolve => { record.resolveLoad = resolve; record.loadTimer = setTimer(() => stop(record, 'context_failed'), commandTimeoutMs); });
          record.loadCommand = send(record, 'load', { samples }, [samples.buffer]);
          if (!await loaded || !check(record)) return false;
          for (const [candidateId, decisionEpoch] of record.candidates) send(record, 'pause', { candidateId, decisionEpoch });
          record.status = 'ready'; emit(record, 'ready', { cursor: record.cursor }); return true;
        } catch { if (!record.terminal) { emit(record, 'rejected', { code: 'PCM_PREPARATION_FAILED' }); stop(record, 'invalid_audio'); } return false; }
      })();
      return record.preparation;
    },
    play(ownerValue) {
      const record = current;
      try { if (!record || ownerKey(owner(ownerValue)) !== ownerKey(record.owner) || !check(record) || !record.loaded || record.completed) return false; } catch { return false; }
      if (record.playRequested) return record.status === 'playing';
      record.playRequested = true; return startOrResume(record);
    },
    pauseCandidate(ownerValue, candidateId, decisionEpoch) {
      const record = current;
      try { if (!record || ownerKey(owner(ownerValue)) !== ownerKey(record.owner) || !check(record) || record.completed || typeof candidateId !== 'string' || !candidateId || candidateId.length > 256 || !integer(decisionEpoch)) return 0; } catch { return 0; }
      const previous = record.candidateEpochs.get(candidateId);
      if (previous !== undefined && previous >= decisionEpoch) return 0;
      record.candidateEpochs.set(candidateId, decisionEpoch);
      record.candidates.set(candidateId, decisionEpoch);
      // Admission/loading may still be pending. Keep the reason so future play
      // cannot race it; 0 here means no worklet command/ACK has been issued yet.
      if (!record.loaded) return 0;
      try { return send(record, 'pause', { candidateId, decisionEpoch }); } catch { stop(record, 'context_failed'); return 0; }
    },
    resolveCandidate(ownerValue, decision) {
      const record = current;
      try { if (!record || ownerKey(owner(ownerValue)) !== ownerKey(record.owner) || !check(record) || record.completed || !decision || !integer(decision.decisionEpoch) || !record.candidates.has(decision.candidateId) || record.candidates.get(decision.candidateId) !== decision.decisionEpoch) return false; } catch { return false; }
      if (decision.kind === 'accepted_turn') return stop(record, 'accepted_new_turn');
      if (!['rejected_noise', 'rejected_echo'].includes(decision.kind)) return false;
      record.candidates.delete(decision.candidateId);
      if (!record.candidates.size && record.playRequested) startOrResume(record, true);
      return true;
    },
    async resumeFromGesture(ownerValue, { candidateId, decisionEpoch } = {}) {
      const record = current;
      try {
        if (!record || ownerKey(owner(ownerValue)) !== ownerKey(record.owner) || !check(record) || !record.loaded || record.completed) return false;
        if (candidateId === undefined ? record.candidates.size > 0 : !integer(decisionEpoch) || !record.candidates.has(candidateId) || record.candidates.get(candidateId) !== decisionEpoch) return false;
        // Explicit user intent is distinct from an ASR noise/echo decision.
        // Resume is invoked before the first await to retain user activation.
        const resumption = Promise.resolve(ensureContext().resume());
        await resumption;
        if (!check(record) || context.state !== 'running') return false;
        if (candidateId !== undefined) {
          if (record.candidates.get(candidateId) !== decisionEpoch) return false;
          record.candidates.delete(candidateId);
          emit(record, 'candidate_dismissed_by_user', { candidateId, decisionEpoch });
        }
        if (record.candidates.size) return false;
        record.playRequested = true;
        return startOrResume(record, true);
      } catch { if (owns(record)) emit(record, 'blocked'); return false; }
    },
    cancel(ownerValue, reason = 'explicit_stop') {
      try { return current && ownerKey(owner(ownerValue)) === ownerKey(current.owner) ? stop(current, reason) : false; } catch { return false; }
    },
    invalidate(reason = 'scope_changed') { return stop(current, reason); },
    get referenceStream() { return reference?.stream ?? null; },
    get state() { const record = current; return Object.freeze({ status: disposed ? 'disposed' : record?.status ?? 'idle', owner: record?.owner ?? null, cursor: record?.cursor ?? null,
      terminal: Boolean(record?.terminal || disposed), paused: Boolean(record?.candidates.size || record?.contextHeld), completed: Boolean(record?.completed), contextState: context?.state ?? null,
      completionKind: record?.completionKind ?? null, playedThrough: record?.completionKind === 'played_through',
      sampleRate: context?.sampleRate ?? null, finalContextFrameExclusive: record?.drain?.finalContextFrameExclusive ?? null, continuityUncertain: Boolean(record?.continuityUncertain) }); },
    dispose() {
      if (disposed) return;
      stop(current, 'call_end'); disposed = true; mute();
      try { gain?.disconnect(); reference?.disconnect(); } catch { /* Detached already. */ }
      try { reference?.stream?.getTracks?.().forEach(track => track.stop()); } catch { /* Only the player-created reference stream is owned here. */ }
      if (context) { context.onstatechange = null; try { Promise.resolve(context.close()).catch(() => {}); } catch { /* Closed already. */ } }
    },
  };
}
