// A parent turn owns one bounded PCM collection and two native playback slots.
// Each part is independently admitted; only a sealed, entirely strong parent
// can produce a full-turn playback receipt. This is software output evidence.
import { createVerifiedPcmPlayback, pcmSha256 } from './verified-pcm-playback.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const FIELDS = ['scope', 'sessionId', 'companionId', 'callEpoch', 'turnNonce', 'turnId', 'assistantEventId', 'authorityGeneration', 'expectedMemoryRevision', 'playbackEpoch'];
const MAX_BYTES = 4320000, MAX_PARTS = 16, MAX_TEXT_BYTES = 262144;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const key = value => JSON.stringify(FIELDS.map(field => value?.[field]));
// Child playbackEpoch is the bounded part index. The immutable parent turn
// identity distinguishes jobs; this mapping is never sent to the server.
const turnKey = value => JSON.stringify(FIELDS.filter(field => field !== 'playbackEpoch').map(field => value?.[field]));
const same = (a, b) => key(a) === key(b);
function owner(value) {
  if (!value || !['sessionId', 'turnNonce', 'turnId', 'assistantEventId'].every(field => typeof value[field] === 'string' && UUID.test(value[field])) ||
    !['alex', 'mia', 'juno'].includes(value.companionId) || !['callEpoch', 'authorityGeneration', 'playbackEpoch'].every(field => integer(value[field])) ||
    !(value.expectedMemoryRevision === null || integer(value.expectedMemoryRevision)) || typeof value.scope !== 'string') throw Error('Invalid segment owner');
  const parts = value.scope.split('|'), url = new URL(parts[0]);
  if (parts.length !== 2 || !UUID.test(parts[1]) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid segment scope');
  return Object.freeze(Object.fromEntries(FIELDS.map(field => [field, value[field]])));
}
function audioManifest(value, expectedOwner, textHash, bytes, version) {
  if (!value || value.version !== version || !same(owner(value.owner), expectedOwner) || value.textSha256 !== textHash || !SHA.test(value.pcmSha256) ||
    value.format !== 'pcm_s16le' || value.sampleRate !== 24000 || value.channels !== 1 || !integer(value.sourceFrames) || value.sourceFrames < 1 ||
    value.sourceFrames * 2 !== bytes || value.byteLength !== bytes || !integer(bytes) || bytes < 2 || bytes > MAX_BYTES || !UUID.test(value.synthesisId) ||
    !Number.isFinite(value.synthesisSpeed) || value.synthesisSpeed < .25 || value.synthesisSpeed > 4 || value.transcriptVerification?.status !== 'matched' ||
    value.transcriptVerification.policyVersion !== 'lexical-fidelity-v1' || value.transcriptVerification.approvedTextSha256 !== textHash) throw Error('Invalid segment manifest');
  return Object.freeze({ ...value, owner: expectedOwner, transcriptVerification: Object.freeze({ ...value.transcriptVerification }) });
}

export function createSegmentedPcmPlayback({ isCurrent = () => true, canUnlockContext = value => value === null || isCurrent(value), onEvent = () => {},
  AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext, AudioWorkletNodeConstructor = globalThis.AudioWorkletNode,
  subtle = globalThis.crypto?.subtle, ...options } = {}) {
  if (typeof isCurrent !== 'function' || typeof canUnlockContext !== 'function' || typeof onEvent !== 'function' || !subtle?.digest) throw new TypeError('Invalid segmented playback options');
  let context = null, combined = null, moduleFlight = null, disposed = false, current = null, closed = false;
  const leases = [], slots = [{ part: null }, { part: null }], terminalTurns = new Set(), links = new Map();
  const emit = (record, kind, extra = {}) => { try { onEvent(Object.freeze({ ...extra, kind, owner: record?.owner ?? null })); } catch { /* Observers cannot grant authority. */ } };
  const live = record => { try { return Boolean(record && current === record && !disposed && !record.terminal && !record.signal?.aborted && isCurrent(record.owner)); } catch { return false; } };
  const mayUnlock = record => { try { return !disposed && Boolean(canUnlockContext(record?.owner ?? null)); } catch { return false; } };
  const matches = (record, value) => { try { return live(record) && same(owner(value), record.owner); } catch { return false; } };
  function stop(record, reason = 'clear') {
    if (!record || record.terminal) return false;
    record.terminal = true; record.reason = typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'clear';
    terminalTurns.add(turnKey(record.owner)); record.signal?.removeEventListener?.('abort', record.aborted);
    for (const slot of slots) if (slot.part?.record === record) { slot.player.cancel(slot.part.owner, record.reason); slot.part = null; }
    record.parts.forEach(part => { if (part) part.bytes = null; });
    if (!record.completed) emit(record, 'terminal', { reason: record.reason });
    return true;
  }
  function check(record) { if (live(record)) return true; if (current === record && !record?.terminal) stop(record, 'scope_changed'); return false; }
  function fail(record) {
    if (record && current === record && !record.terminal) {
      if (live(record)) emit(record, 'rejected', { code: 'INVALID_SEGMENT_ADMISSION' });
      stop(record, 'invalid_audio');
    }
    return false;
  }
  function ensureContext() {
    if (disposed) throw Error('Segmented player disposed');
    if (context) return context;
    if (typeof AudioContextConstructor !== 'function' || typeof AudioWorkletNodeConstructor !== 'function') throw Error('PCM audio unavailable');
    context = new AudioContextConstructor({ latencyHint: 'interactive' });
    combined = context.createMediaStreamDestination();
    context.onstatechange = () => {
      const record = current;
      if (live(record) && !record.completed && record.head < record.plan.count && context.state !== 'running') {
        record.contextBlocked = true; if (record.started) record.weak = true;
      }
      for (const lease of leases) { try { lease.onstatechange?.(); } catch { /* Each child has an independent subscription. */ } }
    };
    return context;
  }
  function leaseContext() {
    const audio = ensureContext();
    const lease = {
      onstatechange: null,
      get sampleRate() { return audio.sampleRate; }, get currentTime() { return audio.currentTime; }, get state() { return audio.state; },
      get destination() { return audio.destination; }, get baseLatency() { return audio.baseLatency; }, get outputLatency() { return audio.outputLatency; },
      get getOutputTimestamp() { return typeof audio.getOutputTimestamp === 'function' ? audio.getOutputTimestamp.bind(audio) : undefined; },
      createGain: () => audio.createGain(), createMediaStreamDestination: () => audio.createMediaStreamDestination(),
      resume: () => audio.resume(), close: () => Promise.resolve(),
      audioWorklet: { addModule: url => moduleFlight ||= Promise.resolve().then(() => audio.audioWorklet.addModule(url)).catch(error => { moduleFlight = null; throw error; }) },
    };
    leases.push(lease); return lease;
  }
  function connectReferences() {
    if (!context || !combined) return;
    for (const slot of slots) {
      const stream = slot.player.referenceStream;
      if (stream && !links.has(stream)) {
        const source = context.createMediaStreamSource(stream); source.connect(combined); links.set(stream, source);
      }
    }
  }
  function cursor(record, part = record?.parts[record.head]) {
    if (!record) return null;
    const local = part && slots[part.index % 2].part === part ? slots[part.index % 2].player.state.cursor : part?.lastCursor;
    const offset = record.parts.slice(0, part?.index ?? record.head).reduce((sum, value) => sum + (value?.manifest.sourceFrames ?? 0), 0);
    return local ? Object.freeze({ ...local, sourceFrame: offset + local.sourceFrame, partIndex: part.index, partSourceFrame: local.sourceFrame }) : null;
  }
  function finish(record) {
    if (!check(record) || record.completed || !record.sealed || record.head !== record.plan.count) return;
    record.completed = true; terminalTurns.add(turnKey(record.owner)); record.signal?.removeEventListener?.('abort', record.aborted);
    record.completionKind = record.weak ? 'estimated_drain' : 'played_through';
    const last = record.parts.at(-1), extra = { sourceFrames: record.totalBytes / 2, segmentCount: record.plan.count,
      finalContextFrameExclusive: last?.completion?.finalContextFrameExclusive ?? null, cursor: cursor(record, last) };
    record.parts.forEach(part => { part.bytes = null; });
    emit(record, record.completionKind, record.weak ? extra : { ...extra, evidence: 'client_reported_playback_completed' });
  }
  function childEvent(slot, event) {
    const part = slot.part, record = part?.record;
    if (!part || !same(event.owner, part.owner) || !check(record) || record.completed) return;
    if (event.cursor) part.lastCursor = event.cursor;
    if (event.kind === 'terminal' || event.kind === 'rejected') { fail(record); return; }
    if (['played_through', 'estimated_drain'].includes(event.kind)) {
      if (part.index !== record.head || part.ended) { fail(record); return; }
      part.ended = event.kind; part.completion = event; part.lastCursor = slot.player.state.cursor;
      if (event.kind !== 'played_through') record.weak = true;
      slot.part = null; record.head++; pump(record); finish(record); return;
    }
    if (event.kind === 'started') {
      if (!record.started) { record.started = true; emit(record, 'started', { cursor: cursor(record, part) }); }
      else emit(record, 'segment_started', { segmentIndex: part.index, cursor: cursor(record, part) });
      return;
    }
    if (event.kind === 'candidate_dismissed_by_user') {
      if (record.holds.get(event.candidateId) !== event.decisionEpoch) return;
      record.holds.delete(event.candidateId);
    }
    if (event.kind === 'continuity_uncertain') record.weak = true;
    if (event.kind === 'context_interrupted') {
      record.contextBlocked = true;
      if (record.contextNotified) return;
      record.contextNotified = true;
    }
    // Prefetch observations never change the parent floor/cursor or resume it.
    if (part.index !== record.head && !['context_interrupted', 'continuity_uncertain'].includes(event.kind)) return;
    if (event.kind === 'ready') { emit(record, 'segment_ready', { segmentIndex: part.index }); return; }
    if (event.kind === 'render_drained') { emit(record, 'segment_render_drained', { segmentIndex: part.index, cursor: cursor(record, part) }); return; }
    const { owner: _owner, kind: _kind, cursor: _cursor, ...extra } = event;
    emit(record, event.kind, { ...extra, segmentIndex: part.index, ...(event.cursor ? { cursor: cursor(record, part) } : {}) });
  }
  for (const slot of slots) {
    slot.player = createVerifiedPcmPlayback({ ...options, subtle, maxPcmBytes: MAX_BYTES,
      AudioContextConstructor: function () { return leaseContext(); },
      AudioWorkletNodeConstructor: function (_lease, ...args) { return new AudioWorkletNodeConstructor(ensureContext(), ...args); },
      isCurrent: value => Boolean(slot.part && same(value, slot.part.owner) && live(slot.part.record)),
      canStart: value => Boolean(slot.part && same(value, slot.part.owner) && live(slot.part.record) && slot.part.record.head === slot.part.index &&
        !slot.part.record.holds.size && !slot.part.record.contextBlocked),
      canUnlockContext: () => mayUnlock(current), onEvent: event => childEvent(slot, event) });
  }
  function load(record, part) {
    const slot = slots[part.index % 2];
    if (part.loading || part.ready || part.ended || slot.part || !check(record)) return;
    slot.part = part; part.loading = true;
    // prepare registers the child's record synchronously. Pause reasons can
    // therefore be attached even while its own digest or load ACK is pending.
    const preparing = slot.player.prepare(part.owner, part.manifest.textSha256, part.childManifest, part.bytes, record.signal);
    if (part.index === record.head) for (const [id, epoch] of record.holds) slot.player.pauseCandidate(part.owner, id, epoch);
    part.preparation = (async () => {
      const ready = await preparing;
      if (!check(record) || slot.part !== part) return false;
      if (!ready) return fail(record);
      part.loading = false; part.ready = true;
      try { connectReferences(); } catch { return fail(record); }
      pump(record); return true;
    })().catch(() => fail(record));
  }
  function pump(record) {
    if (!check(record) || record.completed) return;
    for (const index of [record.head, record.head + 1]) if (record.parts[index]) load(record, record.parts[index]);
    const part = record.parts[record.head];
    // The next slot was prepared silently. If the head changed while a global
    // candidate was pending, attach that hold before it can consume a sample.
    if (part && slots[part.index % 2].part === part) for (const [id, epoch] of record.holds) slots[part.index % 2].player.pauseCandidate(part.owner, id, epoch);
    if (part?.ready && record.playRequested && !record.holds.size && !record.contextBlocked) slots[part.index % 2].player.play(part.owner);
  }
  async function unlockFromGesture() {
    const record = current;
    if (!mayUnlock(record)) return false;
    try {
      // Both calls enter native resume synchronously within the gesture. Their
      // leases share module loading, while retaining separate gain gates.
      const flights = slots.map(slot => slot.player.unlockFromGesture());
      connectReferences();
      const results = await Promise.all(flights);
      if (disposed || current !== record || !mayUnlock(record) || context?.state !== 'running' || !results.every(Boolean)) return false;
      if (live(record)) {
        record.contextBlocked = false; record.contextNotified = false; pump(record);
        const part = record.parts[record.head], slot = part && slots[part.index % 2];
        if (part?.ready && slot.part === part && record.playRequested && !record.holds.size && slot.player.state.status !== 'playing') {
          const resumed = await slot.player.resumeFromGesture(part.owner);
          if (!check(record) || slot.part !== part || !resumed) return false;
        }
      }
      return true;
    } catch { if (!disposed) emit(record, 'blocked'); return false; }
  }
  return {
    unlockFromGesture, unlock: unlockFromGesture,
    async begin(ownerValue, textHash, text, planValue, signal) {
      let approved, plan, textBytes;
      try {
        approved = owner(ownerValue);
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_BYTES) throw Error('Invalid canonical text');
        textBytes = new TextEncoder().encode(text);
        if (!SHA.test(textHash) || !planValue || planValue.version !== 'verified-speech-segments-v1' ||
          !integer(planValue.count) || planValue.count < 1 || planValue.count > MAX_PARTS || planValue.count !== planValue.parts?.length ||
          textBytes.byteLength > MAX_TEXT_BYTES || planValue.textByteLength !== textBytes.byteLength || planValue.textSha256 !== textHash) throw Error('Invalid segment plan');
        let offset = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        if (decoder.decode(textBytes) !== text) throw Error('Invalid canonical Unicode');
        const parts = planValue.parts.map((value, index) => {
          if (!value || value.index !== index || value.startByte !== offset || !integer(value.endByte) || value.endByte <= offset || value.endByte > textBytes.byteLength || !SHA.test(value.textSha256)) throw Error('Invalid text range');
          decoder.decode(textBytes.subarray(offset, value.endByte)); offset = value.endByte;
          return Object.freeze({ index, startByte: value.startByte, endByte: value.endByte, textSha256: value.textSha256 });
        });
        if (offset !== textBytes.byteLength || disposed || signal?.aborted || terminalTurns.has(turnKey(approved)) ||
          current && !current.terminal && turnKey(current.owner) === turnKey(approved) || !isCurrent(approved)) return false;
        plan = Object.freeze({ version: planValue.version, count: parts.length, textByteLength: textBytes.byteLength, textSha256: textHash, parts: Object.freeze(parts) });
      } catch { return false; }
      if (current && !current.terminal && !current.completed) stop(current, 'accepted_new_turn');
      const record = { owner: approved, textHash, plan, signal, parts: [], head: 0, totalBytes: 0, nextIndex: 0, holds: new Map(), candidateEpochs: new Map(),
        admitted: false, terminal: false, completed: false, sealed: false, weak: false, started: false, playRequested: false, contextBlocked: false, contextNotified: false };
      current = record; record.aborted = () => stop(record, 'clear'); signal?.addEventListener?.('abort', record.aborted, { once: true });
      try {
        if (await pcmSha256(textBytes.buffer, subtle) !== textHash || !check(record)) return fail(record);
        for (const part of plan.parts) {
          const bytes = textBytes.slice(part.startByte, part.endByte);
          if (await pcmSha256(bytes.buffer, subtle) !== part.textSha256 || !check(record)) return fail(record);
        }
        record.admitted = true; emit(record, 'plan_ready', { segmentCount: plan.count }); return true;
      } catch { return fail(record); }
    },
    async enqueue(ownerValue, value, bytes, signal) {
      const record = current;
      if (!matches(record, ownerValue) || !record.admitted || record.sealed || record.admitting || signal?.aborted) return false;
      record.admitting = true;
      try {
        const index = record.nextIndex, range = record.plan.parts[index];
        if (!(bytes instanceof ArrayBuffer) || !range || value?.index !== index || value.count !== record.plan.count || value.startByte !== range.startByte ||
          value.endByte !== range.endByte || value.parentTextSha256 !== record.textHash || value.textSha256 !== range.textSha256 || record.totalBytes + bytes.byteLength > MAX_BYTES) throw Error('Invalid segment');
        const approved = audioManifest(value, record.owner, range.textSha256, bytes.byteLength, 'verified-pcm-segment-v1');
        if (record.job && (approved.synthesisId !== record.job || approved.synthesisSpeed !== record.speed)) throw Error('Changed synthesis identity');
        const copy = bytes.slice(0);
        if (await pcmSha256(copy, subtle) !== approved.pcmSha256 || !check(record) || signal?.aborted) return fail(record);
        const childOwner = Object.freeze({ ...record.owner, playbackEpoch: index });
        const childManifest = Object.freeze({ ...approved, version: 'verified-pcm-candidate-v1', owner: childOwner });
        const part = { index, record, owner: childOwner, manifest: approved, childManifest, bytes: copy, loading: false, ready: false, ended: null };
        record.parts.push(part); record.nextIndex++; record.totalBytes += copy.byteLength; record.job = approved.synthesisId; record.speed = approved.synthesisSpeed;
        // Native preparation is deliberately detached from transport admission:
        // only two slots load; later bounded buffers never hold up body/EOF.
        pump(record); return true;
      } catch { return fail(record); }
      finally { record.admitting = false; }
    },
    async seal(ownerValue, value) {
      const record = current;
      if (!matches(record, ownerValue) || !record.admitted || record.sealed || record.admitting || record.nextIndex !== record.plan.count) return false;
      try {
        const approved = audioManifest(value, record.owner, record.textHash, record.totalBytes, 'verified-pcm-candidate-v1');
        if (approved.synthesisId !== record.job || approved.synthesisSpeed !== record.speed) throw Error('Changed final synthesis');
        const all = new Uint8Array(record.totalBytes); let offset = 0;
        for (const part of record.parts) { all.set(new Uint8Array(part.bytes), offset); offset += part.bytes.byteLength; }
        if (await pcmSha256(all.buffer, subtle) !== approved.pcmSha256 || !check(record)) return fail(record);
        record.sealed = true; record.finalManifest = approved; finish(record); return true;
      } catch { return fail(record); }
    },
    play(ownerValue) {
      const record = current; if (!matches(record, ownerValue) || !record.admitted || record.completed) return false;
      record.playRequested = true; pump(record); return !record.holds.size && !record.contextBlocked;
    },
    pauseCandidate(ownerValue, candidateId, decisionEpoch) {
      const record = current;
      if (!matches(record, ownerValue) || record.completed || typeof candidateId !== 'string' || !candidateId || candidateId.length > 256 || !integer(decisionEpoch) ||
        (record.candidateEpochs.get(candidateId) ?? -1) >= decisionEpoch) return 0;
      record.candidateEpochs.set(candidateId, decisionEpoch); record.holds.set(candidateId, decisionEpoch);
      const part = record.parts[record.head], slot = part && slots[part.index % 2];
      return part && slot?.part === part ? slot.player.pauseCandidate(part.owner, candidateId, decisionEpoch) : 0;
    },
    resolveCandidate(ownerValue, decision) {
      const record = current;
      if (!matches(record, ownerValue) || !decision || !integer(decision.decisionEpoch) || record.holds.get(decision.candidateId) !== decision.decisionEpoch) return false;
      if (decision.kind === 'accepted_turn') return stop(record, 'accepted_new_turn');
      if (!['rejected_noise', 'rejected_echo'].includes(decision.kind)) return false;
      const part = record.parts[record.head], slot = part && slots[part.index % 2];
      record.holds.delete(decision.candidateId);
      if (part && slot?.part === part && !slot.player.resolveCandidate(part.owner, decision)) {
        if (live(record) && record.candidateEpochs.get(decision.candidateId) === decision.decisionEpoch) record.holds.set(decision.candidateId, decision.decisionEpoch);
        return false;
      }
      pump(record); return true;
    },
    async resumeFromGesture(ownerValue, decision = {}) {
      const record = current, hasCandidate = decision.candidateId !== undefined;
      const valid = () => matches(record, ownerValue) && !record.completed && (hasCandidate ? integer(decision.decisionEpoch) && record.holds.get(decision.candidateId) === decision.decisionEpoch : !record.holds.size);
      if (!valid() || !mayUnlock(record)) return false;
      let resuming;
      try { resuming = Promise.resolve(ensureContext().resume()); } catch { emit(record, 'blocked'); return false; }
      try {
        await resuming;
        if (!valid() || context.state !== 'running' || !mayUnlock(record)) return false;
        const part = record.parts[record.head], slot = part && slots[part.index % 2];
        if (part && slot?.part === part) {
          if (part.preparation) await part.preparation;
          if (!valid() || record.parts[record.head] !== part || slot.part !== part || !part.ready) return false;
          record.contextBlocked = false; record.contextNotified = false;
          const result = await slot.player.resumeFromGesture(part.owner, decision);
          if (!check(record) || record.parts[record.head] !== part || slot.part !== part) return false;
          pump(record); return result;
        }
        // There is no child hold while waiting for the first/next source part.
        // Remove only this exact user-dismissed reason; do not classify noise.
        if (hasCandidate) { record.holds.delete(decision.candidateId); emit(record, 'candidate_dismissed_by_user', decision); }
        record.contextBlocked = false; record.contextNotified = false; record.playRequested = true;
        if (!record.holds.size) emit(record, 'resume_applied'); pump(record); return !record.holds.size;
      } catch { if (live(record)) emit(record, 'blocked'); return false; }
    },
    cancel(ownerValue, reason = 'explicit_stop') { return matches(current, ownerValue) ? stop(current, reason) : false; },
    invalidate(reason = 'scope_changed') { return stop(current, reason); },
    get referenceStream() { return combined?.stream ?? null; },
    get state() {
      const record = current, part = record?.parts[record.head], child = part && slots[part.index % 2].part === part ? slots[part.index % 2].player.state : null;
      const status = disposed ? 'disposed' : record?.terminal ? 'terminal' : record?.completed ? record.completionKind : record ?
        record.holds.size ? 'paused' : record.contextBlocked ? 'blocked' : child?.status ?? (record.admitted ? 'buffering' : 'preparing') : 'idle';
      return Object.freeze({ status, owner: record?.owner ?? null, cursor: cursor(record, part ?? record?.parts.at(-1)), terminal: Boolean(disposed || record?.terminal),
        paused: Boolean(record?.holds.size || record?.contextBlocked || child?.paused), completed: Boolean(record?.completed), completionKind: record?.completionKind ?? null,
        playedThrough: record?.completionKind === 'played_through', contextState: context?.state ?? null, sampleRate: context?.sampleRate ?? null,
        finalContextFrameExclusive: record?.parts.at(-1)?.completion?.finalContextFrameExclusive ?? null, continuityUncertain: Boolean(record?.weak || child?.continuityUncertain),
        segmentIndex: record?.head ?? null, segmentCount: record?.plan.count ?? null, receivedSegments: record?.nextIndex ?? 0, sealed: Boolean(record?.sealed) });
    },
    dispose() {
      if (disposed) return;
      stop(current, 'call_end'); disposed = true;
      slots.forEach(slot => { slot.player.dispose(); slot.part = null; });
      links.forEach(source => { try { source.disconnect(); } catch { /* Already detached. */ } }); links.clear();
      try { combined?.disconnect(); combined?.stream.getTracks?.().forEach(track => track.stop()); } catch { /* Only owned references. */ }
      leases.forEach(lease => { lease.onstatechange = null; });
      if (context && !closed) { closed = true; context.onstatechange = null; try { Promise.resolve(context.close()).catch(() => {}); } catch { /* Closed already. */ } }
    },
  };
}
