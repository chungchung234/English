// This tests characterization authority and isolation, not model naturalness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { characterViewpoints, renderCharacterViewpoints, CHARACTER_VIEWPOINTS_VERSION } from './character-viewpoints.ts';

test('each companion has immutable authored viewpoints with reasons and contextual flexibility', () => {
  for (const id of ['mia', 'alex', 'juno']) {
    const profile = characterViewpoints(id);
    assert.equal(profile.version, CHARACTER_VIEWPOINTS_VERSION);
    assert.equal(profile.companion_id, id);
    assert.equal(profile.subject, 'companion');
    assert.equal(profile.origin, 'authored');
    assert(Object.isFrozen(profile)); assert(Object.isFrozen(profile.viewpoints));
    assert(profile.viewpoints.length > 0);
    for (const view of profile.viewpoints) {
      assert(Object.isFrozen(view));
      for (const key of ['topic', 'preference', 'reason', 'flexibility']) assert(view[key].trim());
    }
    assert.throws(() => { profile.viewpoints[0].preference = 'The caller likes this, so I do too.'; }, TypeError);
  }
  assert.throws(() => characterViewpoints('__proto__'), RangeError);
  assert.throws(() => characterViewpoints('other'), RangeError);
});

test('caller preference changes cannot overwrite the companion authored profile', () => {
  const before = JSON.stringify(characterViewpoints('alex'));
  const callerPreferences = { places: 'I only enjoy loud places.' };
  callerPreferences.places = 'I only enjoy silent places.';
  assert.equal(JSON.stringify(characterViewpoints('alex')), before);
  assert.notEqual(JSON.stringify(characterViewpoints('mia')), before);
  assert.notEqual(JSON.stringify(characterViewpoints('juno')), before);
  const rendered = renderCharacterViewpoints('alex');
  const data = JSON.parse(rendered.split('\n').at(-1));
  assert.deepEqual(data, characterViewpoints('alex'));
  assert(!rendered.includes(callerPreferences.places));
  assert.equal(data.viewpoints.find(view => view.topic === 'places').preference,
    'For a conversation, I usually choose somewhere I can hear the person across from me.');
});
