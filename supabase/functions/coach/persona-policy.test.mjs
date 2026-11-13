// These tests inspect authored instructions and examples. They do not call a
// speech model or measure conversation quality, comprehension, or learning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIONS, CONVERSATION_GUIDELINES } from './core.ts';

const examples = profile => [...profile.description.matchAll(/Caller: "([^"]+)" Companion: "([^"]+)"/g)]
  .map(([, caller, companion]) => ({ caller, companion }));

test('authored everyday exchanges give each companion a voice without turning sharing into a task or evaluation', () => {
  for (const situation of [/coffee.*cafe.*noisy/i, /cooked without a recipe/i, /anything special tonight/i]) {
    const reactions = COMPANIONS.map(profile => {
      const sample = examples(profile).find(value => situation.test(value.caller));
      assert(sample, `${profile.id} needs an authored exchange for this situation`);
      assert.match(profile.description, /not facts to remember or lines to memorize and repeat/);
      assert.match(CONVERSATION_GUIDELINES, /Character tastes are fictional characterization, not claims of lived experiences/);
      assert.doesNotMatch(sample.companion, /you should|you must|repeat after me|try saying|I can help|we can practice|if you want|great job|well done/i);
      assert.doesNotMatch(sample.companion, /\b(?:I|we)\s+(?:went|visited|had|saw|was)\b/i, 'fictional tastes must not turn into invented offline experiences');
      return sample;
    });
    assert.equal(new Set(reactions.map(sample => sample.caller)).size, 1, 'compare character voices against the same supplied meaning');
    assert.equal(new Set(reactions.map(sample => sample.companion)).size, COMPANIONS.length);
  }
  assert(COMPANIONS.every(profile => examples(profile).some(sample => !/[?？]/u.test(sample.companion))), 'a companion can complete a turn without interviewing the caller');
});

test('the primary call role is friendly company while explicit language help remains an ordinary direct request', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /purpose of this call is a friendly, natural English conversation with this character/);
  assert.match(policy, /Ordinary conversation is already the point of the call/);
  assert.match(policy, /Explicit requests for an expression, meaning, grammar, pronunciation, or clarification are ordinary requests/);
  assert.match(policy, /Give the useful answer directly and then make room for the conversation to continue/);
  assert.match(policy, /Corrections or practice belong in the live call only when the caller explicitly requests them/);
  assert.match(policy, /Small language issues in understandable speech do not change the subject/);
  assert.doesNotMatch(policy, /purpose.*help the learner express their own meaning/i);
});

test('shared phone-conversation policy preserves caller initiative, direct help and language boundaries', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /room to initiate questions, suggest a topic, disagree, or ask for clarification/);
  assert.match(policy, /A question is optional/);
  assert.match(policy, /answer their question directly rather than immediately asking the same question back/);
  assert.match(policy, /choose one concrete topic and actually begin it/);
  assert.match(policy, /caller asks you to repeat, repeat the relevant message/);
  assert.match(policy, /Speak only in English throughout the call/);
  assert.match(policy, /Korean or mixed-language input is valid communication/);
  assert.match(policy, /Only recall details supported by this companion's supplied history/);
  assert.doesNotMatch(policy, /\b\d+[–-]\d+\s+(?:English\s+)?words|at most two sentences/i);
});

test('conversation requests change behavior instead of becoming correction material or repeated repair explanations', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /Share your tastes and point of view/);
  assert.match(policy, /Your character comes through in what you say, rather than an explanation of your personality or your job/);
  assert.match(policy, /do not automatically agree, praise, or reassure/);
  assert.match(policy, /Maintain the caller's stated conversation preferences during this call/);
  assert.match(policy, /Treat these as requests about the conversation, not as sentences to correct/);
  assert.match(policy, /one specific uncertain part/);
  assert.match(policy, /not a confirmed personal fact or language mistake/);
  assert.match(policy, /Accept a correction and update your interpretation/);
  assert.match(policy, /After resolving it, return to the original topic/);
  assert.match(policy, /address that concern first instead of turning it into a correction or example sentence/);
  assert.match(policy, /Do not invent technical causes you cannot verify/);
  assert.match(policy, /do not claim an app action has completed without a supplied confirmation/);
});

test('opening, memory and persona boundaries permit familiarity without resets, false history or human identity claims', () => {
  const policy = CONVERSATION_GUIDELINES;
  assert.match(policy, /opening context as a grounded conversational starting point/);
  assert.match(policy, /When the caller speaks first, answer their current content/);
  assert.match(policy, /brief reply to the caller's greeting is fine and must not reset the topic/);
  assert.match(policy, /caller's current corrections priority/);
  assert.match(policy, /A plan is not a completed event/);
  assert.match(policy, /Respect explicit forget markers/);
  assert.match(policy, /Do not invent a human biography, a real day of offline activities, shared experiences, or exclusive relationships/);
  assert.match(policy, /answer honestly and briefly without listing your functions/);
  assert.match(COMPANIONS.find(profile => profile.id === 'alex').description, /own take on things.*gentle disagreement/);
  assert.match(COMPANIONS.find(profile => profile.id === 'juno').description, /without teasing their English, difficulty, or sensitive experiences/);
});
