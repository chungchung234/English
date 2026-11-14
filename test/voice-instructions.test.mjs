import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createVoiceInstructions, voiceInstructionsDigest } from '../web/voice-instructions.js';

const echo = (instructions, type = 'session.updated') => ({ type, session: { instructions } });
const base = { instructions: 'Approved caller memory and companion voice.', openingInstructions: 'Approved dated opening.', policyVersion: 'companion-v5', memoryRevision: 3 };
function fixture() {
  const issues = [], store = createVoiceInstructions({ onMismatch: issue => issues.push(issue) });
  store.initialize(base); return { store, issues };
}

test('initial default echoes and later speed/session echoes never become response authority', () => {
  const store = createVoiceInstructions();
  assert.equal(store.observe(echo('Provider default helper.', 'session.created')).status, 'unapproved');
  assert.equal(store.instructions, null);
  assert.equal(store.initialize(base), true);
  assert.equal(store.initialize({ instructions: 'An accidental second initialization.' }), false);
  store.observe(echo('Provider default helper.', 'session.created'));
  store.observe({ type: 'session.updated', session: { audio: { output: { speed: 1 } } } });
  store.observe(echo('A late older session configuration.'));
  assert.equal(store.instructions, base.instructions);
  assert.equal(store.openingInstructions, base.openingInstructions);
  assert.equal(store.state.authoritative.memoryRevision, 3);
  assert.equal(store.state.generation, 1);
});

test('checkpoint waits for its exact current receipt before changing normal reply context', () => {
  const { store } = fixture(), token = store.stage({ instructions: 'New compact conversation.', memoryRevision: 4 });
  assert.equal(store.instructions, base.instructions);
  assert.equal(store.matches(token, echo(base.instructions)), false);
  assert.equal(store.matches(token, echo('New compact conversation.', 'session.created')), false);
  assert.equal(store.commit(token, echo('New compact conversation. ')), false, 'partial or normalized text is not the same approved state');
  assert.equal(store.observe(echo('New compact conversation.')).status, 'matched_pending');
  assert.equal(store.instructions, base.instructions, 'observing an echo alone cannot authorize it');
  assert.equal(store.commit(token, echo('New compact conversation.')), true);
  assert.equal(store.instructions, 'New compact conversation.');
  assert.equal(store.state.authoritative.memoryRevision, 4);
  assert.equal(store.state.authoritative.policyVersion, base.policyVersion);
  assert.equal(store.state.generation, 2);
  assert.equal(store.openingInstructions, null, 'a continued call cannot reuse its old opening context');
});

test('an older connection without an initial instruction receipt can adopt its first approved checkpoint only after acknowledgement', () => {
  const store = createVoiceInstructions(), token = store.stage({ instructions: 'Backend-approved first checkpoint.' });
  store.observe(echo('An unapproved legacy session default.'));
  assert.equal(store.instructions, null);
  assert.equal(store.initialize(base), false, 'a late initialization cannot supersede an in-flight checkpoint');
  assert.equal(store.commit(token, echo('Backend-approved first checkpoint.')), true);
  assert.equal(store.state.initialized, true);
  assert.equal(store.instructions, 'Backend-approved first checkpoint.');
});

test('superseded checkpoint receipts cannot overwrite a later requested or approved context', () => {
  const { store } = fixture();
  const old = store.stage({ instructions: 'Old candidate.' });
  const next = store.stage({ instructions: 'Latest candidate.', memoryRevision: 5 });
  assert.equal(store.matches(old, echo('Old candidate.')), false);
  assert.equal(store.commit(old, echo('Old candidate.')), false);
  assert.equal(store.cancel(old), false);
  assert.equal(store.commit(next, echo('Latest candidate.')), true);
  store.observe(echo('Old candidate.')); store.observe(echo(base.instructions));
  assert.equal(store.instructions, 'Latest candidate.');
  assert.equal(store.commit(next, echo('Latest candidate.')), false, 'one lease cannot be committed twice');
});

test('a failed update retains still-authorized context but cannot adopt a late timeout echo', () => {
  const { store } = fixture(), token = store.stage({ instructions: 'Timed out checkpoint.' });
  assert.equal(store.cancel(token), true);
  store.observe(echo('Timed out checkpoint.'));
  assert.equal(store.commit(token, echo('Timed out checkpoint.')), false);
  assert.equal(store.instructions, base.instructions);
  const retry = store.stage({ instructions: 'Timed out checkpoint.' });
  assert.equal(store.commit(retry, echo('Timed out checkpoint.')), true, 'an exact acknowledged state may confirm an authorized retry');
});

test('forget/source invalidation revokes both contexts and all pending leases until fresh authority arrives', () => {
  const { store } = fixture(), stale = store.stage({ instructions: 'Contains the now-forgotten source.' });
  store.invalidate();
  assert.equal(store.instructions, null); assert.equal(store.openingInstructions, null);
  assert.equal(store.commit(stale, echo('Contains the now-forgotten source.')), false);
  store.observe(echo(base.instructions));
  assert.equal(store.instructions, null, 'provider echo cannot revive revoked memory');
  const safe = store.stage({ instructions: 'Fresh backend-approved memoryless conversation.', memoryRevision: 6 });
  assert.equal(store.commit(safe, echo('Fresh backend-approved memoryless conversation.')), true);
  assert.equal(store.instructions, 'Fresh backend-approved memoryless conversation.');
  assert.equal(store.state.authoritative.memoryRevision, 6);
});

test('leases are scoped to one call even if identical checkpoint text and generations recur', () => {
  const first = fixture().store, second = fixture().store;
  const wrong = first.stage({ instructions: 'Same candidate.' });
  const right = second.stage({ instructions: 'Same candidate.' });
  assert.equal(second.commit(wrong, echo('Same candidate.')), false);
  assert.equal(second.commit(right, echo('Same candidate.')), true);
});

test('diagnostics contain only fixed codes and snapshots contain no conversation text', () => {
  const { store, issues } = fixture();
  const privateText = 'Bearer credential and private conversation that must never be logged.';
  store.observe(echo(privateText)); store.observe(echo(privateText));
  assert.deepEqual(issues, [{ code: 'VOICE_INSTRUCTIONS_MISMATCH', request_type: 'session.update' }]);
  const serialized = JSON.stringify({ issues, state: store.state });
  assert.doesNotMatch(serialized, /Bearer|credential|private conversation|Approved caller|dated opening/);
  assert.equal(store.state.observed.length, privateText.length);
  assert(Object.isFrozen(store.state)); assert(Object.isFrozen(store.state.authoritative));
});

test('disposal and invalid input cannot revive or partially replace approved state', () => {
  const { store } = fixture();
  assert.equal(store.matches(undefined, echo(base.instructions)), false);
  assert.equal(store.cancel(null), false);
  assert.throws(() => store.stage({ instructions: 'new', memoryRevision: -1 }), { code: 'INVALID_VOICE_INSTRUCTIONS' });
  assert.equal(store.instructions, base.instructions);
  const token = store.stage({ instructions: 'Late candidate.' });
  store.dispose();
  assert.equal(store.commit(token, echo('Late candidate.')), false);
  assert.equal(store.observe(echo(base.instructions)), null);
  assert.equal(store.initialize(base), false);
  assert.equal(store.instructions, null);
});

test('synthetic QA digest uses full exact bytes and cannot silently hash a missing configuration', async () => {
  assert.equal(await voiceInstructionsDigest('abc', webcrypto.subtle), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(await voiceInstructionsDigest('abc ', webcrypto.subtle), await voiceInstructionsDigest('abc', webcrypto.subtle));
  await assert.rejects(voiceInstructionsDigest('', webcrypto.subtle), { code: 'INVALID_VOICE_INSTRUCTIONS' });
});
