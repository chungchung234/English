// Independent controller/delivery contracts. Edge responses, player callbacks
// and persistence are local fixtures; no provider or production data is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AUTHORED_DIALOGUE_PROTOCOL as protocol, authoredTextSha256, createAuthoredDialogue, createAuthoredPlaybackDelivery } from '../web/authored-dialogue.js';
import { createVerifiedPcmPlayback, pcmSha256 } from '../web/verified-pcm-playback.js';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = `https://service.example|${uid(1)}`, sessionId = uid(2), companionId = 'alex', callEpoch = 11;
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const until = async (check, label = 'local asynchronous contract must settle') => {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert(check(), label);
};
const initialAuthority = { protocol, callEpoch, companionId, authorityGeneration: 7, generation: 0, memoryRevision: 4, memoryMode: 'included' };
const inputIds = { currentUserEventIds: [uid(10)], acceptedHistoryEventIds: [], qualifiedUserEventIds: [uid(10)] };
const turnRequest = n => ({ purpose: 'reply', turnNonce: uid(30 + n) });
const cancelAck = body => ({ protocol, sessionId: body.sessionId, callEpoch: body.callEpoch, authorityGeneration: body.authorityGeneration,
  turnNonce: body.turnNonce, generation: body.generation ?? 0, cancelled: true, status: 'cancelled' });
function playerFixture() {
  const calls = { prepare: [], play: [], pause: [], resolve: [], resume: [], cancel: [], invalidate: [], dispose: [] };
  return { calls, state: { status: 'idle', completed: false }, prepareGate: null, resumeResult: true,
    async prepare(...args) { calls.prepare.push(args); return this.prepareGate ? this.prepareGate.promise : true; },
    play(owner) { calls.play.push(clone(owner)); return true; },
    pauseCandidate(owner, candidateId, decisionEpoch) { calls.pause.push({ owner: clone(owner), candidateId, decisionEpoch }); return calls.pause.length; },
    resolveCandidate(owner, decision) { calls.resolve.push({ owner: clone(owner), ...clone(decision) }); return true; },
    async resumeFromGesture(owner, decision) {
      calls.resume.push({ owner: clone(owner), ...clone(decision || {}) });
      const outcome = this.manualOutcomes?.shift() || { applied: this.resumeResult, playing: this.resumeResult };
      if (outcome.applied && decision?.candidateId) this.eventHook?.({ kind: 'candidate_dismissed_by_user', owner: clone(owner), ...clone(decision) });
      return outcome.playing;
    },
    cancel(owner, reason) { calls.cancel.push({ owner: clone(owner), reason }); return true; },
    invalidate(reason) { calls.invalidate.push(reason); return true; },
    dispose() { calls.dispose.push(true); }
  };
}
async function audioFor(reply) {
  const bytes = new ArrayBuffer(96), view = new DataView(bytes);
  for (let i = 0; i < 48; i++) view.setInt16(i * 2, (i % 7 - 3) * 3000, true);
  return { pcmBase64: Buffer.from(bytes).toString('base64'), manifest: {
    version: 'verified-pcm-candidate-v1', owner: clone(reply.owner), textSha256: reply.textSha256,
    pcmSha256: await pcmSha256(bytes, webcrypto.subtle), format: 'pcm_s16le', sampleRate: 24000, channels: 1,
    sourceFrames: 48, byteLength: bytes.byteLength, synthesisId: uid(999), synthesisSpeed: reply.speed,
    transcriptVerification: { status: 'matched', policyVersion: 'word-match-fixture-v1', approvedTextSha256: reply.textSha256 }
  } };
}
function fixture(t, options = {}) {
  const player = options.player || playerFixture(), requests = [], replies = [], transcripts = [], lifecycle = [], states = [], failures = [], queued = [], speed = [];
  let current = true, textCounter = 0;
  const delivery = options.delivery || { pending: async () => [], queue: value => { queued.push(clone(value)); return Promise.resolve(); }, flush: async () => ({ delivered: 0 }) };
  const edge = async (route, body, settings = {}) => {
    requests.push({ route, body: clone(body), signal: settings.signal });
    if (options.edge) return options.edge(route, body, settings, baseEdge);
    return baseEdge(route, body);
  };
  async function baseEdge(route, body) {
    if (route === 'dialogue-context') return clone(body.omitLearningContext ? { ...initialAuthority, authorityGeneration: 8, memoryRevision: null, memoryMode: 'omitted' } : initialAuthority);
    if (route === 'dialogue-turn') {
      const count = ++textCounter, text = `A specific synthetic character perspective for turn ${count}.`;
      const owner = { scope, sessionId, companionId, callEpoch, turnNonce: body.turnNonce, turnId: uid(100 + count), assistantEventId: uid(200 + count),
        authorityGeneration: body.authorityGeneration, expectedMemoryRevision: body.expectedMemoryRevision, playbackEpoch: body.playbackEpoch };
      const value = { protocol, owner, generation: body.expectedGeneration + 1, text, textSha256: await authoredTextSha256(text, webcrypto.subtle), speed: body.speechSpeed,
        assistantEvent: { id: owner.assistantEventId, session_id: sessionId, speaker: 'assistant', text, event_key: `assistant:authored-${owner.turnId}:0`, occurred_at: '2026-11-14T10:00:01.000Z', storage: 'server' } };
      replies.push(clone(value)); return value;
    }
    if (route === 'dialogue-synthesis') return audioFor(replies.find(reply => reply.owner.turnId === body.owner.turnId));
    if (route === 'dialogue-cancel') return cancelAck(body);
    throw Error('Unknown local fixture route');
  }
  const dialogue = createAuthoredDialogue({ scope, sessionId, companionId, callEpoch, player, playbackDelivery: delivery, edge,
    savedInputs: options.savedInputs || (async () => clone(inputIds)), isCurrent: () => current, subtle: options.subtle || webcrypto.subtle,
    onTranscript: (row, owner) => transcripts.push({ row: clone(row), owner: clone(owner) }), onLifecycle: event => lifecycle.push(clone(event)),
    onState: state => states.push(clone(state)), onFailure: error => failures.push(clone(error)), onSpeed: value => speed.push(clone(value)) });
  player.eventHook = event => dialogue.playerEvent(event);
  t.after(() => dialogue.dispose());
  return { dialogue, player, requests, replies, transcripts, lifecycle, states, failures, queued, speed, delivery,
    setCurrent: value => { current = value; }, count: route => requests.filter(request => request.route === route).length,
    prepare: async (n = 1) => { await dialogue.initialize(); dialogue.create(turnRequest(n)); await until(() => player.calls.play.length === 1); return replies.at(-1); },
    event: (kind, owner = replies.at(-1)?.owner, extra = {}) => dialogue.playerEvent({ kind, owner: clone(owner), ...extra }) };
}
const strong = { evidence: 'client_reported_playback_completed' };

test('saved caller ACK gates content requests; exact canonical text is retained before synthesis and generation readiness is not completion', async t => {
  const saved = deferred(), synthesis = deferred();
  const f = fixture(t, { savedInputs: () => saved.promise, edge: async (route, body, _settings, base) => route === 'dialogue-synthesis' ? synthesis.promise : base(route, body) });
  await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await settle();
  assert.equal(f.count('dialogue-turn'), 0); assert.equal(f.player.calls.prepare.length, 0);
  saved.resolve(clone(inputIds)); await until(() => f.transcripts.length === 1);
  const reply = f.replies[0], request = f.requests.find(request => request.route === 'dialogue-turn').body;
  assert.deepEqual(request.currentUserEventIds, inputIds.currentUserEventIds); assert.deepEqual(request.acceptedHistoryEventIds, []);
  assert.equal(f.transcripts[0].row.text, reply.text); assert.equal(f.transcripts[0].row.id, reply.owner.assistantEventId);
  assert.equal(f.dialogue.state.pending, true); assert.equal(f.queued.length, 0);
  synthesis.resolve(await audioFor(reply)); await until(() => f.player.calls.play.length === 1);
  assert.equal(f.player.calls.prepare[0][1], reply.textSha256); assert.equal(f.queued.length, 0);
});

test('failed or missing saved caller input never issues a reply request or fabricates speech', async t => {
  for (const savedInputs of [async () => { throw Error('raw ACK failed'); }, async () => ({ ...clone(inputIds), currentUserEventIds: [] })]) {
    const f = fixture(t, { savedInputs }); await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await until(() => f.failures.length === 1);
    assert.equal(f.count('dialogue-turn'), 0); assert.equal(f.player.calls.play.length, 0); assert.equal(f.transcripts.length, 0); assert.equal(f.queued.length, 0);
  }
});

test('writer and reader budget failures preserve the safe code without automatic retry or playback evidence', async t => {
  for (const code of ['BUDGET_EXCEEDED', 'COST_BUDGET_EXCEEDED']) for (const rejectedRoute of ['dialogue-turn', 'dialogue-synthesis']) {
    const privateMessage = 'PRIVATE_PROVIDER_TOKEN_CANARY', request = turnRequest(1);
    const f = fixture(t, { edge: async (route, body, _settings, base) => {
      if (route === rejectedRoute) throw Object.assign(Error(privateMessage), { code, body: { authorization: privateMessage } });
      return base(route, body);
    } });
    await f.dialogue.initialize(); f.dialogue.create(request); await until(() => f.failures.length === 1); await settle();
    assert.deepEqual(f.failures, [{ code, recoveryNeeded: true }]);
    assert.deepEqual(f.lifecycle.filter(event => event.kind === 'failed'), [{ kind: 'failed', turnNonce: request.turnNonce, code }]);
    assert.equal(f.dialogue.state.pending, false); assert.equal(f.player.calls.prepare.length, 0); assert.equal(f.player.calls.play.length, 0);
    assert.equal(await f.dialogue.resume({ turnNonce: request.turnNonce, decisions: [] }), false);
    if (f.replies.length) f.event('played_through', f.replies[0].owner, strong);
    await settle();
    assert.equal(f.count('dialogue-context'), 1); assert.equal(f.count('dialogue-turn'), 1);
    assert.equal(f.count('dialogue-synthesis'), rejectedRoute === 'dialogue-synthesis' ? 1 : 0);
    assert.equal(f.count('dialogue-cancel'), 0); assert.equal(f.queued.length, 0);
    assert.equal(JSON.stringify([f.lifecycle, f.failures, f.states, f.transcripts]).includes(privateMessage), false);
  }
});

test('unsafe provider error codes and private bodies never enter failure callbacks or lifecycle events', async t => {
  for (const unsafeCode of ['token=PRIVATE_CODE_TOKEN_CANARY', 'PRIVATE_' + 'A'.repeat(65), 'private_code', { token: 'PRIVATE_CODE_TOKEN_CANARY' }, undefined]) {
    const privateMessage = 'PRIVATE_ERROR_MESSAGE_CANARY', f = fixture(t, { edge: async (route, body, _settings, base) => {
      if (route === 'dialogue-turn') throw Object.assign(Error(privateMessage), { code: unsafeCode, body: { token: 'PRIVATE_BODY_TOKEN_CANARY' } });
      return base(route, body);
    } });
    const request = turnRequest(1); await f.dialogue.initialize(); f.dialogue.create(request); await until(() => f.failures.length === 1);
    assert.deepEqual(f.failures, [{ code: 'AUTHORED_DIALOGUE_FAILED', recoveryNeeded: true }]);
    assert.deepEqual(f.lifecycle.filter(event => event.kind === 'failed'), [{ kind: 'failed', turnNonce: request.turnNonce, code: 'AUTHORED_DIALOGUE_FAILED' }]);
    assert.equal(JSON.stringify([f.lifecycle, f.failures, f.states]).includes('PRIVATE_'), false);
    assert.equal(f.count('dialogue-turn'), 1); assert.equal(f.count('dialogue-synthesis'), 0);
  }
});

test('unconfirmed cancellation sanitizes private error codes while retaining its specific fallback', async t => {
  const privateValue = 'PRIVATE_CANCEL_TOKEN_CANARY', f = fixture(t, { edge: async (route, body, _settings, base) => {
    if (route === 'dialogue-cancel') throw Object.assign(Error(privateValue), { code: 'token=' + privateValue, body: { token: privateValue } });
    return base(route, body);
  } });
  const reply = await f.prepare(); assert.equal(await f.dialogue.cancel({ turnNonce: reply.owner.turnNonce }), false);
  assert.deepEqual(f.failures, [{ code: 'DIALOGUE_CANCEL_UNCONFIRMED', recoveryNeeded: true }]);
  assert.deepEqual(f.lifecycle.filter(event => event.kind === 'failed'), [{ kind: 'failed', turnNonce: reply.owner.turnNonce, code: 'DIALOGUE_CANCEL_UNCONFIRMED' }]);
  assert.equal(JSON.stringify([f.lifecycle, f.failures, f.states]).includes(privateValue), false);
  f.event('played_through', reply.owner, strong); await settle();
  assert.equal(f.queued.length, 0); assert.equal(f.count('dialogue-cancel'), 1); assert.equal(f.count('dialogue-turn'), 1); assert.equal(f.count('dialogue-synthesis'), 1);
});

test('empty startup source remains explicit rather than manufacturing a current caller', async t => {
  const f = fixture(t, { savedInputs: async () => ({ currentUserEventIds: [], acceptedHistoryEventIds: [], qualifiedUserEventIds: [] }) });
  await f.dialogue.initialize(); f.dialogue.create({ purpose: 'startup', turnNonce: uid(31) }); await until(() => f.player.calls.play.length === 1);
  const body = f.requests.find(value => value.route === 'dialogue-turn').body;
  assert.equal(body.purpose, 'startup'); assert.deepEqual(body.currentUserEventIds, []); assert.deepEqual(body.acceptedHistoryEventIds, []);
});

test('estimated drain releases lifecycle without a report; genuine late strong evidence is once-only and stays bound to the old turn', async t => {
  const f = fixture(t), old = await f.prepare(); f.event('estimated_drain', old.owner);
  assert.equal(f.dialogue.state.pending, false); assert.equal(f.queued.length, 0); assert(f.lifecycle.some(value => value.kind === 'estimated_drain'));
  f.dialogue.create(turnRequest(2)); await until(() => f.player.calls.play.length === 2); const next = f.replies[1];
  f.event('played_through', old.owner, strong); f.event('played_through', old.owner, strong); f.event('estimated_drain', old.owner);
  assert.equal(f.queued.length, 1); assert.deepEqual(f.queued[0].owner, old.owner); assert.equal(f.queued[0].generation, old.generation);
  assert.notEqual(f.queued[0].owner.turnNonce, next.owner.turnNonce); assert.equal(f.dialogue.state.pending, true);
  f.event('played_through', next.owner, strong); assert.equal(f.queued.length, 2); assert.equal(f.dialogue.state.pending, false);
  assert.equal(f.transcripts.length, 2, 'evidence promotion never rewrites or duplicates canonical text');
});

test('foreign source/session/nonce/revision callbacks and missing strong label cannot release or report current output', async t => {
  const f = fixture(t), reply = await f.prepare();
  for (const change of [{ scope: `https://other.example|${uid(1)}` }, { sessionId: uid(900) }, { companionId: 'juno' }, { callEpoch: 12 },
    { turnNonce: uid(901) }, { turnId: uid(902) }, { assistantEventId: uid(903) }, { authorityGeneration: 8 }, { expectedMemoryRevision: 5 }, { playbackEpoch: 50 }]) {
    f.event('played_through', { ...reply.owner, ...change }, strong);
  }
  f.event('played_through', reply.owner); f.event('render_drained', reply.owner);
  assert.equal(f.queued.length, 0); assert.equal(f.dialogue.state.pending, true);
  f.event('played_through', reply.owner, strong); assert.equal(f.queued.length, 1); assert.equal(f.dialogue.state.pending, false);
});

test('cancel is local and terminal before its server ACK; late synthesis cannot prepare or play the cancelled turn', async t => {
  const synthesis = deferred(), cancelled = deferred();
  const f = fixture(t, { edge: async (route, body, _settings, base) => route === 'dialogue-synthesis' ? synthesis.promise : route === 'dialogue-cancel' ? cancelled.promise : base(route, body) });
  await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await until(() => f.count('dialogue-synthesis') === 1);
  const reply = f.replies[0]; assert.equal(await f.dialogue.cancel({ turnNonce: uid(99) }), false);
  const stop = f.dialogue.cancel({ turnNonce: reply.owner.turnNonce, reason: 'explicit_stop' });
  assert.equal(f.player.calls.cancel.length, 1); synthesis.resolve(await audioFor(reply)); await settle();
  assert.equal(f.player.calls.prepare.length, 0, 'a cancelled source must not be prepared while its cancellation ACK is pending');
  f.event('played_through', reply.owner, strong); assert.equal(f.queued.length, 0);
  cancelled.resolve(cancelAck(f.requests.find(value => value.route === 'dialogue-cancel').body)); assert.equal(await stop, true);
  assert.equal(f.player.calls.play.length, 0);
});

test('cancel during player preparation prevents a late prepare success from playing', async t => {
  const cancelled = deferred(), player = playerFixture(); player.prepareGate = deferred();
  const f = fixture(t, { player, edge: async (route, body, _settings, base) => route === 'dialogue-cancel' ? cancelled.promise : base(route, body) });
  await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await until(() => player.calls.prepare.length === 1);
  const reply = f.replies[0], stop = f.dialogue.cancel({ turnNonce: reply.owner.turnNonce });
  player.prepareGate.resolve(true); await settle(); assert.equal(player.calls.play.length, 0);
  cancelled.resolve(cancelAck(f.requests.find(value => value.route === 'dialogue-cancel').body)); assert(await stop);
});

test('foreign or ambiguous cancel acknowledgements cannot settle another source while local output remains stopped', async t => {
  for (const change of [{ protocol: 'other' }, { sessionId: uid(899) }, { callEpoch: 99 }, { authorityGeneration: 99 },
    { turnNonce: uid(898) }, { status: 'unknown' }, { cancelled: false }]) {
    const f = fixture(t, { edge: async (route, body, _settings, base) => {
      const value = await base(route, body); return route === 'dialogue-cancel' ? { ...value, ...change } : value;
    } });
    const reply = await f.prepare(); assert.equal(await f.dialogue.cancel({ turnNonce: reply.owner.turnNonce }), false);
    assert.equal(f.player.calls.cancel.length, 1); assert.equal(f.failures.length, 1);
    f.event('played_through', reply.owner, strong); assert.equal(f.queued.length, 0);
  }
});

test('scope invalidation and disposal discard late text before it can synthesize or mutate canonical history', async t => {
  for (const ending of ['invalidate', 'dispose']) {
    const turn = deferred(), returned = deferred(); let sourceHashCalls = 0;
    const f = fixture(t, { subtle: { digest: (...args) => { sourceHashCalls++; return webcrypto.subtle.digest(...args); } },
      edge: async (route, body, _settings, base) => {
        if (route !== 'dialogue-turn') return base(route, body);
        await turn.promise; const value = await base(route, body); returned.resolve(); return value;
      } });
    await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await until(() => f.count('dialogue-turn') === 1);
    if (ending === 'invalidate') { f.setCurrent(false); f.dialogue.invalidate('scope_changed'); } else f.dialogue.dispose();
    turn.resolve(); await returned.promise; await settle();
    assert.equal(sourceHashCalls, 0, 'late revoked text is rejected before another asynchronous digest/admission stage');
    assert.equal(f.transcripts.length, 0); assert.equal(f.count('dialogue-synthesis'), 0); assert.equal(f.player.calls.prepare.length, 0);
    assert.equal(f.queued.length, 0); assert(f.player.calls.invalidate.length > 0);
  }
});

test('recovery retires weak/strong source records; failed memory-free context cannot reuse old authority', async t => {
  let failRecovery = false;
  const f = fixture(t, { edge: async (route, body, _settings, base) => {
    if (route === 'dialogue-context' && body.omitLearningContext && failRecovery) throw Error('context unavailable');
    return base(route, body);
  } });
  const old = await f.prepare(); f.event('estimated_drain', old.owner); failRecovery = true;
  await assert.rejects(f.dialogue.recover(), /context unavailable/);
  f.event('played_through', old.owner, strong); assert.equal(f.queued.length, 0); assert.equal(f.dialogue.authority, null);
  assert.throws(() => f.dialogue.create(turnRequest(2)), /unavailable/);
  failRecovery = false; assert.equal(await f.dialogue.recover(), true); assert.equal(f.dialogue.authority.memoryMode, 'omitted'); assert.equal(f.dialogue.authority.memoryRevision, null);
});

test('a stale initialization response cannot replace a newer memory-free recovery authority', async t => {
  const oldContext = deferred(); let first = true;
  const f = fixture(t, { edge: async (route, body, _settings, base) => route === 'dialogue-context' && first ? (first = false, oldContext.promise) : base(route, body) });
  const old = f.dialogue.initialize(); assert.equal(await f.dialogue.recover(), true);
  oldContext.resolve(clone(initialAuthority)); assert.equal(await old, false); assert.equal(f.dialogue.authority.authorityGeneration, 8); assert.equal(f.dialogue.authority.memoryRevision, null);
});

test('initial omitted context has no reset while every recovery explicitly resets authority, including already-omitted recovery', async t => {
  let authorityGeneration = 8;
  const f = fixture(t, { edge: async (route, body, _settings, base) => {
    const value = await base(route, body);
    if (route === 'dialogue-context' && body.reset === true) value.authorityGeneration = ++authorityGeneration;
    return value;
  } });
  assert.equal(await f.dialogue.initialize(true), true);
  assert.deepEqual(f.requests[0].body, { protocol, sessionId, callEpoch, omitLearningContext: true });
  const controller = new AbortController();
  assert.equal(await f.dialogue.recover({ signal: controller.signal }), true);
  assert.deepEqual(f.requests[1].body, { protocol, sessionId, callEpoch, omitLearningContext: true, reset: true });
  assert.equal(f.requests[1].signal, controller.signal); assert.equal(f.dialogue.authority.authorityGeneration, 9);
  assert.equal(await f.dialogue.recover(), true);
  assert.deepEqual(f.requests[2].body, { protocol, sessionId, callEpoch, omitLearningContext: true, reset: true });
  assert.equal(f.dialogue.authority.authorityGeneration, 10); assert.equal(f.count('dialogue-turn'), 0); assert.equal(f.player.calls.play.length, 0);
});

test('mismatched turn ownership, canonical source, and text digest never reach synthesis', async t => {
  const changes = [value => { value.owner.sessionId = uid(999); }, value => { value.owner.turnNonce = uid(998); },
    value => { value.owner.scope = `https://service.example|${uid(997)}`; }, value => { value.owner.expectedMemoryRevision++; },
    value => { value.assistantEvent.id = uid(996); }, value => { value.assistantEvent.storage = 'device'; },
    value => { value.assistantEvent.text += ' changed'; }, value => { value.textSha256 = '0'.repeat(64); }];
  for (const change of changes) {
    const f = fixture(t, { edge: async (route, body, _settings, base) => { const value = await base(route, body); if (route === 'dialogue-turn') change(value); return value; } });
    await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await until(() => f.failures.length === 1);
    assert.equal(f.transcripts.length, 0); assert.equal(f.count('dialogue-synthesis'), 0); assert.equal(f.player.calls.prepare.length, 0);
  }
});

test('synthesis owner mismatch and a real PCM digest refusal retain canonical text without playing or reporting it', async t => {
  const mismatch = fixture(t, { edge: async (route, body, _settings, base) => { const value = await base(route, body); if (route === 'dialogue-synthesis') value.manifest.owner.turnId = uid(888); return value; } });
  await mismatch.dialogue.initialize(); mismatch.dialogue.create(turnRequest(1)); await until(() => mismatch.failures.length === 1);
  assert.equal(mismatch.transcripts.length, 1); assert.equal(mismatch.player.calls.prepare.length, 0); assert.equal(mismatch.queued.length, 0);
  let contexts = 0;
  const player = createVerifiedPcmPlayback({ workletUrl: 'https://app.example/assets/verified-pcm-worklet.aaaaaaaaaaaa.js', baseUrl: 'https://app.example/', subtle: webcrypto.subtle,
    AudioContextConstructor: class { constructor() { contexts++; throw Error('bad PCM must not create a graph'); } }, AudioWorkletNodeConstructor: class {} });
  t.after(() => player.dispose());
  const corrupt = fixture(t, { player, edge: async (route, body, _settings, base) => { const value = await base(route, body); if (route === 'dialogue-synthesis') value.manifest.pcmSha256 = '0'.repeat(64); return value; } });
  await corrupt.dialogue.initialize(); corrupt.dialogue.create(turnRequest(1)); await until(() => corrupt.failures.length === 1);
  assert.equal(corrupt.transcripts.length, 1); assert.equal(corrupt.queued.length, 0); assert.equal(contexts, 0);
});

test('candidates before prepare are retained; empty rejection resumes while uncertainty requires explicit user continuation', async t => {
  const synthesis = deferred(), f = fixture(t, { edge: async (route, body, _settings, base) => route === 'dialogue-synthesis' ? synthesis.promise : base(route, body) });
  await f.dialogue.initialize(); f.dialogue.create(turnRequest(1)); await until(() => f.count('dialogue-synthesis') === 1);
  const reply = f.replies[0], candidate = { turnNonce: reply.owner.turnNonce, candidateId: 'short-candidate', decisionEpoch: 2 };
  assert(f.dialogue.pauseCandidate(candidate));
  synthesis.resolve(await audioFor(reply)); await until(() => f.player.calls.play.length === 1);
  assert(f.player.calls.pause.some(value => value.candidateId === candidate.candidateId));
  assert(f.dialogue.resolveCandidate({ ...candidate, kind: 'rejected_noise' })); assert.equal(f.player.calls.resolve.at(-1).kind, 'rejected_noise');
  const uncertain = { ...candidate, candidateId: 'uncertain', decisionEpoch: 3 };
  f.dialogue.pauseCandidate(uncertain); f.dialogue.resolveCandidate({ ...uncertain, kind: 'asr_failed' });
  assert.equal(f.player.calls.resume.length, 0);
  assert.equal(await f.dialogue.resume({ turnNonce: uid(77), decisions: [uncertain] }), false);
  assert.equal(await f.dialogue.resume({ turnNonce: reply.owner.turnNonce, decisions: [uncertain] }), true);
  assert.equal(f.player.calls.resume.length, 1); assert.equal(f.player.calls.resume[0].candidateId, uncertain.candidateId);
  f.event('resume_applied', reply.owner);
  const resumed = f.lifecycle.find(value => value.kind === 'resumed'); assert.equal(resumed.decisions[0].candidateId, uncertain.candidateId);
});

test('stale candidate epochs cannot replace a newer hold or authorize its rejection', async t => {
  const f = fixture(t), reply = await f.prepare(); const candidate = { turnNonce: reply.owner.turnNonce, candidateId: 'candidate', decisionEpoch: 4 };
  assert(f.dialogue.pauseCandidate(candidate)); assert.equal(f.dialogue.pauseCandidate({ ...candidate, decisionEpoch: 3 }), false);
  assert.equal(f.dialogue.resolveCandidate({ ...candidate, decisionEpoch: 3, kind: 'rejected_noise' }), false);
  assert(f.dialogue.resolveCandidate({ ...candidate, kind: 'rejected_noise' }));
  assert.equal(f.dialogue.pauseCandidate(candidate), false, 'resolved candidate duplicates cannot reopen an old hold');
});

test('failed explicit gesture resume preserves its unresolved candidate for a later real gesture', async t => {
  const f = fixture(t), reply = await f.prepare(), candidate = { candidateId: 'uncertain', decisionEpoch: 4, turnNonce: reply.owner.turnNonce };
  f.dialogue.pauseCandidate(candidate); f.dialogue.resolveCandidate({ ...candidate, kind: 'asr_failed' });
  f.player.resumeResult = false;
  assert.equal(await f.dialogue.resume({ turnNonce: reply.owner.turnNonce, decisions: [candidate] }), false);
  f.player.resumeResult = true;
  assert.equal(await f.dialogue.resume({ turnNonce: reply.owner.turnNonce, decisions: [candidate] }), true, 'a failed gesture did not consume the decision');
  assert.equal(f.player.calls.resume.length, 2);
});

test('explicitly applied partial release can continue through multiple candidates without claiming they were noise', async t => {
  const f = fixture(t), reply = await f.prepare();
  const candidates = [1, 2].map(value => ({ candidateId: 'uncertain-' + value, decisionEpoch: value, turnNonce: reply.owner.turnNonce }));
  for (const candidate of candidates) { f.dialogue.pauseCandidate(candidate); f.dialogue.resolveCandidate({ ...candidate, kind: 'uncertain' }); }
  f.player.manualOutcomes = [{ applied: true, playing: false }, { applied: true, playing: true }];
  assert.equal(await f.dialogue.resume({ turnNonce: reply.owner.turnNonce, decisions: candidates }), true);
  assert.equal(f.player.calls.resume.length, 2); assert.equal(f.player.calls.resolve.filter(value => ['rejected_noise', 'rejected_echo'].includes(value.kind)).length, 0);
  assert.equal(await f.dialogue.resume({ turnNonce: reply.owner.turnNonce, decisions: candidates }), false);
});

test('speed changes apply to the next authored synthesis and never reinterpret the current PCM rate', async t => {
  const f = fixture(t), old = await f.prepare(); assert(f.dialogue.requestSpeed(1.1));
  assert.equal(f.dialogue.speed.applied, .85); assert.equal(f.dialogue.speed.pending, true); assert.equal(f.count('dialogue-synthesis'), 1);
  f.event('played_through', old.owner, strong); f.dialogue.create(turnRequest(2)); await until(() => f.player.calls.play.length === 2);
  const turns = f.requests.filter(value => value.route === 'dialogue-turn'); assert.equal(turns[1].body.speechSpeed, 1.1);
  assert.equal(f.dialogue.speed.applied, 1.1); assert.equal(f.dialogue.speed.pending, false);
});

function storageFixture() {
  const rows = new Map();
  return { rows, async put(account, row) { const key = account + '|' + row.id, old = rows.get(key); if (old && JSON.stringify(old) !== JSON.stringify(row)) throw Error('immutable durable report'); rows.set(key, clone(row)); },
    async list(account) { return [...rows].filter(([key]) => key.startsWith(account + '|')).map(([, row]) => clone(row)); }, async remove(account, id) { rows.delete(account + '|' + id); } };
}
function playbackReport(n = 1, account = scope) {
  return { protocol, owner: { scope: account, sessionId, companionId, callEpoch, turnNonce: uid(300 + n), turnId: uid(400 + n), assistantEventId: uid(500 + n),
    authorityGeneration: 7, expectedMemoryRevision: 4, playbackEpoch: n }, generation: n, receiptId: uid(500 + n), qualifiedUserEventIds: [uid(10)] };
}
const pendingAuthority = { sessionId, callEpoch, authorityGeneration: 7, memoryRevision: 4 };
const ack = value => ({ protocol, owner: clone(value.owner), generation: value.generation, receiptId: value.receiptId, status: 'recorded', reason: null });

test('playback delivery retries exact payload and removes only exact known recorded/discarded ACKs', async () => {
  const storage = storageFixture(), value = playbackReport(), sent = []; let attempt = 0;
  const mutations = [result => ({ ...result, owner: { ...result.owner, scope: `https://service.example|${uid(99)}` } }),
    result => ({ ...result, owner: { ...result.owner, sessionId: uid(98) } }), result => ({ ...result, receiptId: uid(97) }),
    result => ({ ...result, generation: 99 }), result => ({ ...result, status: 'discarded', reason: 'unknown' }),
    result => ({ ...result, status: 'recorded', reason: 'stale_revision' })];
  const delivery = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => {
    sent.push(clone(body)); const index = attempt++; if (index === 0) throw Error('offline');
    if (index <= mutations.length) return mutations[index - 1](ack(body));
    return { ...ack(body), status: 'discarded', reason: 'stale_revision' };
  } });
  await delivery.queue(value);
  for (let i = 0; i <= mutations.length; i++) { assert.equal((await delivery.flush()).delivered, 0); assert.equal((await delivery.pending(scope, pendingAuthority)).length, 1); }
  assert.equal((await delivery.flush()).delivered, 1); assert.equal((await delivery.pending(scope, pendingAuthority)).length, 0);
  assert(sent.every(item => JSON.stringify(item) === JSON.stringify(value)));
});

test('durable report identity survives reload, duplicate queue timestamps, and caller mutation without shadowing old evidence', async () => {
  const storage = storageFixture(), value = playbackReport(), first = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => ack(body) });
  await first.queue(value); const originalRow = clone([...storage.rows.values()][0]); await first.queue(value);
  assert.deepEqual([...storage.rows.values()][0], originalRow, 'an exact retry preserves immutable created_at');
  value.owner.expectedMemoryRevision = 99; value.qualifiedUserEventIds.push(uid(11));
  const [retained] = await first.pending(scope, pendingAuthority); assert.equal(retained.owner.expectedMemoryRevision, 4); assert.deepEqual(retained.qualifiedUserEventIds, [uid(10)]);
  try { retained.owner.scope = `https://bad.example|${uid(90)}`; retained.qualifiedUserEventIds.push(uid(12)); } catch { /* Frozen snapshots may reject mutation. */ }
  const reloaded = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => ack(body) });
  await assert.rejects(Promise.resolve().then(() => reloaded.queue({ ...playbackReport(), generation: 77 })), /identity|immutable/i);
  const pending = await reloaded.pending(scope, pendingAuthority); assert.equal(pending.length, 1); assert.equal(pending[0].generation, 1); assert.equal(pending[0].owner.scope, scope);
  assert.equal((await reloaded.flush()).delivered, 1);
});

test('a verified quota-only new write failure preserves immutable current-call evidence without claiming durability', async () => {
  const storage = storageFixture(), value = playbackReport(), sent = [];
  storage.put = async () => { throw Error('quota unavailable'); };
  const delivery = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => { sent.push(clone(body)); return ack(body); } });
  await delivery.queue(value).catch(() => {});
  assert.equal(storage.rows.size, 0, 'a failed disk write is not represented as durable');
  const [pending] = await delivery.pending(scope, pendingAuthority); assert.deepEqual(pending, value); assert(Object.isFrozen(pending));
  value.generation = 99; value.owner.expectedMemoryRevision = 99;
  assert.equal((await delivery.flush()).delivered, 1); assert.equal(sent[0].generation, 1); assert.equal(sent[0].owner.expectedMemoryRevision, 4);
  assert.equal((await delivery.pending(scope, pendingAuthority)).length, 0);
  let ambiguous = false;
  const uncertainStorage = { async list() { if (ambiguous) throw Error('cannot verify disk'); return []; }, async put() { ambiguous = true; throw Error('write result unknown'); }, async remove() {} };
  const uncertain = createAuthoredPlaybackDelivery({ storage: uncertainStorage, getScope: () => scope, send: async body => ack(body) });
  await uncertain.queue(playbackReport()).catch(() => {});
  assert.equal((await uncertain.pending(scope, pendingAuthority)).length, 0, 'an ambiguous persisted identity cannot be silently replaced by memory');
});

test('recovered durable identity wins over conflicting memory captured while storage was unavailable', async () => {
  const storage = storageFixture(), value = playbackReport();
  const first = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => ack(body) }); await first.queue(value);
  const actualList = storage.list; storage.list = async () => { throw Error('disk temporarily unavailable'); };
  const sent = [], reloaded = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => { sent.push(clone(body)); return ack(body); } });
  await reloaded.queue({ ...playbackReport(), generation: 77 });
  storage.list = actualList;
  const pending = await reloaded.pending(scope, pendingAuthority); assert.equal(pending.length, 1); assert.equal(pending[0].generation, 1);
  assert.equal((await reloaded.flush()).delivered, 1); assert.equal(sent[0].generation, 1);
});

test('concurrent changed payloads cannot overwrite the first immutable report when disk reads are unavailable', async () => {
  const storage = { async list() { throw Error('disk unavailable'); }, async put() { throw Error('must not write without an identity check'); }, async remove() {} };
  const sent = [], delivery = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async body => { sent.push(clone(body)); return ack(body); } });
  const first = delivery.queue(playbackReport()), changed = delivery.queue({ ...playbackReport(), generation: 77 });
  const settled = await Promise.allSettled([first, changed]);
  assert.equal(settled[0].status, 'fulfilled'); assert.equal(settled[1].status, 'rejected');
  const pending = await delivery.pending(scope, pendingAuthority); assert.equal(pending.length, 1); assert.equal(pending[0].generation, 1);
  assert.equal((await delivery.flush()).delivered, 1); assert.equal(sent[0].generation, 1);
});

test('an exact stale head report is retired and allows later recorded reports through the same flush', async () => {
 for (const reason of ['stale_authority', 'source_missing', 'session_missing']) {
  const storage = storageFixture(), first = playbackReport(1), second = playbackReport(2), sent = []; let rejectFirstAck = true;
  const delivery = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: async value => {
    sent.push(clone(value));
    if (rejectFirstAck) { rejectFirstAck = false; return { ...ack(value), owner: { ...value.owner, authorityGeneration: 99 }, status: 'discarded', reason }; }
    return value.receiptId === first.receiptId ? { ...ack(value), status: 'discarded', reason } : ack(value);
  } });
  await delivery.queue(first); await delivery.queue(second);
  assert.equal((await delivery.flush()).delivered, 0); assert.equal((await delivery.pending(scope, pendingAuthority)).length, 2);
  assert.equal((await delivery.flush()).delivered, 2); assert.equal((await delivery.pending(scope, pendingAuthority)).length, 0);
  assert.deepEqual(sent.map(value => value.receiptId), [first.receiptId, first.receiptId, second.receiptId]);
 }
});

test('in-flight account change cannot delete another account or relabel an old receipt; authority filters exclude retired reports', async () => {
  const storage = storageFixture(), scope2 = `https://service.example|${uid(9)}`, old = playbackReport(1), second = playbackReport(2, scope2), gate = deferred();
  let active = scope; const sent = [];
  const delivery = createAuthoredPlaybackDelivery({ storage, getScope: () => active, send: async (value, account) => { sent.push({ account, value: clone(value) }); return sent.length === 1 ? gate.promise : ack(value); } });
  await delivery.queue(old); await delivery.queue(second);
  assert.equal((await delivery.pending(scope, { ...pendingAuthority, memoryRevision: 99 })).length, 0);
  assert.equal((await delivery.pending(scope, { ...pendingAuthority, authorityGeneration: 99 })).length, 0);
  const flight = delivery.flush(); assert.equal(delivery.flush(), flight); await until(() => sent.length === 1);
  active = scope2; gate.resolve(ack(old)); assert.equal((await flight).delivered, 0);
  assert.equal((await delivery.pending(scope, pendingAuthority)).length, 1); assert.equal((await delivery.pending(scope2, pendingAuthority)).length, 1);
  assert.equal((await delivery.flush()).delivered, 1); active = scope; assert.equal((await delivery.flush()).delivered, 1);
  assert.deepEqual(sent.map(value => value.account), [scope, scope2, scope]); assert.deepEqual(sent[0].value, sent[2].value);
});

test('already played report is joined into the next turn while its optional standalone ACK is still pending', async t => {
  const storage = storageFixture(), sendGate = deferred();
  const delivery = createAuthoredPlaybackDelivery({ storage, getScope: () => scope, send: () => sendGate.promise });
  const f = fixture(t, { delivery }), old = await f.prepare(); f.event('played_through', old.owner, strong);
  f.dialogue.create(turnRequest(2)); await until(() => f.count('dialogue-turn') === 2);
  const body = f.requests.filter(value => value.route === 'dialogue-turn')[1].body;
  assert.equal(body.pendingPlaybackReports.length, 1); assert.deepEqual(body.pendingPlaybackReports[0].owner, old.owner);
  sendGate.resolve(ack(body.pendingPlaybackReports[0]));
});
