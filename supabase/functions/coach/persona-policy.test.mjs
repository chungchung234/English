// These tests inspect authored instructions and examples. They do not call a
// speech model or measure persona quality, comprehension, or learning outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIONS, CONVERSATION_GUIDELINES } from './core.ts';

const examples = profile => [...profile.description.matchAll(/Learner: "([^"]+)" Assistant: "([^"]+)"/g)]
  .map(([, learner, assistant]) => ({ learner, assistant }));

test('authored cafe and cooking examples demonstrate distinct contributions without questions, lessons or service menus', () => {
  for (const situation of [/coffee.*cafe.*noisy/i, /cooked without a recipe/i]) {
    const reactions = COMPANIONS.map(profile => {
      const sample = examples(profile).find(value => situation.test(value.learner));
      assert(sample, `${profile.id} needs an authored contribution for this situation`);
      assert.match(profile.description, /not facts to remember/);
      assert.match(profile.description, /lines to memorize and repeat/);
      assert.match(profile.description, /your fictional style cues, never facts about the learner/);
      assert.doesNotMatch(sample.assistant, /[?？]/u, `${profile.id} should demonstrate a complete non-question turn`);
      assert.doesNotMatch(sample.assistant, /you should|you must|repeat after me|try saying|I can help|we can practice|if you want/i);
      assert.doesNotMatch(sample.assistant, /\b(?:I|we)\s+(?:went|visited|had|saw|was)\b/i, 'a style contribution must not invent an offline experience');
      return sample;
    });
    assert.equal(new Set(reactions.map(sample => sample.learner)).size, 1, 'compare styles against the same supplied meaning');
    assert.equal(new Set(reactions.map(sample => sample.assistant)).size, COMPANIONS.length, 'each authored style should contribute its own perspective');
  }
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
  assert.match(policy, /answer it directly rather than immediately asking the same question back/);
  assert.match(policy, /choose one concrete topic and actually begin it/);
  assert.match(policy, /reduce support when they can proceed independently/);
  assert.match(policy, /not a compulsory guessing exercise/);
  assert.match(policy, /If the learner asks you to repeat, repeat the relevant message/);
  assert.match(policy, /Speak only in English throughout the call/);
  assert.match(policy, /Korean or mixed-language input is valid communication/);
  assert.match(policy, /Only recall details supported by this companion's supplied history/);
  assert.doesNotMatch(policy, /\b\d+[–-]\d+\s+(?:English\s+)?words|at most two sentences/i);
});

test('conversation requests change behavior instead of becoming correction material or repeated repair explanations', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /contribute your perspective/);
  assert.match(policy, /not repeatedly use an empathy-then-question or explanation-then-help-offer template/);
  assert.match(policy, /Do not automatically agree, praise, or reassure/);
  assert.match(policy, /Maintain the learner's stated conversation preferences during this call/);
  assert.match(policy, /Treat these as requests about the conversation, not as sentences to correct/);
  assert.match(policy, /one specific uncertain part/);
  assert.match(policy, /not a confirmed personal fact or learner error/);
  assert.match(policy, /Accept a correction and update your interpretation/);
  assert.match(policy, /After resolving it, return to the original topic/);
  assert.match(policy, /address that concern first instead of turning it into a correction or example sentence/);
  assert.match(policy, /Do not invent technical causes you cannot verify/);
  assert.match(policy, /do not claim an app action has completed without a supplied confirmation/);
});

test('opening, memory and persona boundaries permit warmth without resets, false history or identity claims', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /opening plan is supplied, follow it once/);
  assert.match(policy, /When the learner speaks first, answer their current content/);
  assert.match(policy, /brief reply to the learner's greeting is fine and must not reset the topic/);
  assert.match(policy, /learner's current corrections priority/);
  assert.match(policy, /A plan is not a completed event/);
  assert.match(policy, /Respect explicit forget markers/);
  assert.match(policy, /Do not invent a human biography, a real day of offline activities, shared experiences, or exclusive relationships/);
  assert.match(policy, /answer honestly and briefly without listing your functions/);
  assert.match(COMPANIONS.find(profile => profile.id === 'alex').description, /gently disagree or compare tradeoffs without making the decision/);
  assert.match(COMPANIONS.find(profile => profile.id === 'juno').description, /Never tease the learner's English, mistakes, difficulty, or sensitive experiences/);
});
