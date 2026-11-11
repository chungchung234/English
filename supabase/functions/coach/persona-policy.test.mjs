// These tests inspect authored instructions and examples. They do not call a
// speech model or measure persona quality, comprehension, or learning outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIONS, CONVERSATION_GUIDELINES } from './core.ts';

const examples = profile => [...profile.description.matchAll(/Learner: "([^"]+)" Assistant: "([^"]+)"/g)]
  .map(([, learner, assistant]) => ({ learner, assistant }));

test('authored persona examples demonstrate distinct reactions that can end without a question', () => {
  const reactions = COMPANIONS.map(profile => {
    const sample = examples(profile)[0];
    assert(sample, `${profile.id} needs an authored reaction example`);
    assert.match(profile.description, /not facts to remember/);
    assert.match(profile.description, /End that turn there; no question is needed/);
    assert.doesNotMatch(sample.assistant, /[?？]/u, `${profile.id} should demonstrate a complete non-question turn`);
    assert.doesNotMatch(sample.assistant, /you should|you must|repeat after me|try saying/i);
    return sample;
  });
  assert.equal(new Set(reactions.map(sample => sample.learner)).size, 1, 'compare styles against the same supplied meaning');
  assert.equal(new Set(reactions.map(sample => sample.assistant)).size, COMPANIONS.length, 'the authored styles should have distinct reactions');
});

test('authored bilingual help examples preserve the requested expression across companion styles', () => {
  const help = COMPANIONS.map(profile => {
    const sample = examples(profile).find(value => /[가-힣]/u.test(value.learner));
    assert(sample, `${profile.id} needs an input-language-independent help example`);
    assert.doesNotMatch(sample.assistant, /[가-힣?？]/u);
    assert.match(profile.description, /without an extra lesson or a demand to repeat/);
    return sample;
  });
  assert.equal(new Set(help.map(sample => sample.learner)).size, 1);
  assert.equal(new Set(help.map(sample => sample.assistant)).size, 1, 'a direct expression request should not become a persona performance');
  assert.equal(help[0].assistant, 'I went for a walk after work.');
});

test('shared phone-conversation policy preserves learner initiative, requested help and language boundaries', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /express their own meaning, understand and respond to another speaker, and repair misunderstandings/);
  assert.match(policy, /room to initiate questions, suggest a topic, disagree, or ask for clarification/);
  assert.match(policy, /A question is optional/);
  assert.match(policy, /reduce support when they can proceed independently/);
  assert.match(policy, /not a compulsory guessing exercise/);
  assert.match(policy, /If the learner asks you to repeat, repeat the relevant message/);
  assert.match(policy, /Speak only in English throughout the call/);
  assert.match(policy, /Korean or mixed-language input is valid communication/);
  assert.match(policy, /Only recall details supported by this companion's supplied history/);
  assert.doesNotMatch(policy, /\b\d+[–-]\d+\s+(?:English\s+)?words|at most two sentences/i);
});
