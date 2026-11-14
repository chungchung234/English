import test from 'node:test';
import assert from 'node:assert/strict';
import { bytes, fingerprint, transcriptFingerprint } from '../supabase/functions/coach/core.ts';
import { CONVERSATION_CHECKPOINT_VERSION as version } from '../supabase/functions/coach/live-context.ts';
import { safeCheckpoint, verifiedLegacyCheckpoint, compactQualifiedHistory, DIALOGUE_RAW_WINDOW_BYTES, DIALOGUE_CHECKPOINT_CHUNK_BYTES } from '../supabase/functions/coach/dialogue-continuity.ts';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = uid(100), policy = 'current-qualified-policy';
const event = (n, text = `Original qualified source ${n}.`) => ({ id: uid(n), session_id: session, speaker: n % 2 ? 'user' : 'assistant', text, timestamp: new Date(Date.UTC(2026, 10, 14, 0, n)).toISOString() });
const events = [event(1), event(2), event(3), event(4)];
const options = { prefix: 'checkpoint:conversation-checkpoint-v1:alex:session:policy:7:qualified:v1:', revision: 7, model: 'checkpoint-model', promptVersion: 'prompt-v5', omitted: false, policyFingerprint: policy };
const checkpoint = (covered, changes = {}) => ({ version, summary: 'A fallible source-grounded conversation note.', covered_ids: covered.map(row => row.id), policy_fingerprint: policy, ...changes });
async function legacy(count, previous = null, source = events, changes = {}) {
 const prior = previous?.result ?? null, offset = prior?.covered_ids.length ?? 0;
 const result = { revision: 7, model: options.model, prompt_version: options.promptVersion, checkpoint_version: version,
  event_filter: 'qualified:v1', learning_omitted: false, covered_ids: source.slice(0, count).map(row => row.id), checkpoint: { summary: `Legacy note through ${count}.` }, ...changes };
 return { request_key: options.prefix + await fingerprint([await transcriptFingerprint(source.slice(offset, count)), prior]), result };
}

test('safe checkpoint admits only an exact ordered qualified prefix under the current policy and keeps caller input untouched', () => {
 const raw = checkpoint(events.slice(0, 2), { next_scenario: 'untrusted instruction', corrections: ['not conversation context'] }), before = structuredClone(raw);
 const selected = safeCheckpoint(raw, events, policy);
 assert.equal(selected.summary, raw.summary); assert.deepEqual(selected.covered_ids, [events[0].id, events[1].id]); assert.equal(selected.next_scenario, undefined); assert.equal(selected.corrections, undefined);
 raw.covered_ids.reverse(); assert.deepEqual(selected.covered_ids, before.covered_ids);
 for (const bad of [null, [], checkpoint([], {}), checkpoint([events[1]]), checkpoint([events[1], events[0]]),
  checkpoint([events[0], events[0]]), checkpoint(events, { version: 'old' }), checkpoint(events, { policy_fingerprint: 'old-policy' }),
  checkpoint(events, { summary: '' }), checkpoint(events, { summary: 'x'.repeat(901) }), checkpoint(events, { covered_ids: [7] })]) assert.equal(safeCheckpoint(bad, events, policy), null);
 const noise = event(90, 'Saved raw noise is outside this qualified sequence.');
 assert.equal(safeCheckpoint(checkpoint([noise, events[0]]), events, policy), null);
});

test('legacy hash-chain reconstruction accepts an unordered cache only with its actual ancestors and exact current sources', async () => {
 const first = await legacy(2), second = await legacy(4, first), before = structuredClone([second, first]);
 const result = await verifiedLegacyCheckpoint([second, first], events, options);
 assert.equal(result.summary, second.result.checkpoint.summary); assert.deepEqual(result.covered_ids, events.map(row => row.id)); assert.equal(result.policy_fingerprint, policy);
 assert.deepEqual([second, first], before);
 assert.equal(await verifiedLegacyCheckpoint([second], events, options), null, 'missing ancestors cannot be replaced by provider opaque state');
 assert.deepEqual((await verifiedLegacyCheckpoint([first], events, options)).covered_ids, events.slice(0, 2).map(row => row.id));
});

test('the same UUID cannot keep a legacy note after text, speaker, session, timestamp or source identity changes', async () => {
 const first = await legacy(2), second = await legacy(4, first);
 for (const change of [{ text: 'Corrected canonical source with the same ID.' }, { speaker: 'assistant' }, { session_id: uid(999) },
  { timestamp: '2026-11-13T00:00:00.000Z' }, { id: uid(998) }]) {
  const current = structuredClone(events); current[0] = { ...current[0], ...change };
  assert.equal(await verifiedLegacyCheckpoint([first, second], current, options), null, JSON.stringify(change));
 }
 const changedLater = structuredClone(events); changedLater[2].text = 'This later caller corrected the plan.';
 const selected = await verifiedLegacyCheckpoint([first, second], changedLater, options);
 assert.deepEqual(selected.covered_ids, first.result.covered_ids, 'only the still-verified earlier prefix may survive');
});

test('wrong revision/model/prompt/omission/qualified filter/prefix checkpoints are rejected rather than relabeled', async () => {
 const first = await legacy(2);
 for (const resultChange of [{ revision: 6 }, { model: 'old-model' }, { prompt_version: 'old-prompt' }, { checkpoint_version: 'old' },
  { event_filter: 'all-events' }, { learning_omitted: true }, { covered_ids: [events[1].id] }, { covered_ids: [events[1].id, events[0].id] },
  { covered_ids: [events[0].id, events[0].id] }, { checkpoint: { summary: ' ' } }]) {
  assert.equal(await verifiedLegacyCheckpoint([{ ...first, result: { ...first.result, ...resultChange } }], events, options), null);
 }
 for (const change of [{ revision: 8 }, { model: 'next-model' }, { promptVersion: 'new-prompt' }, { omitted: true }, { prefix: 'different-qualified-scope:' }])
  assert.equal(await verifiedLegacyCheckpoint([first], events, { ...options, ...change }), null);
 const noise = event(91, 'Unqualified source');
 const wrong = await legacy(2, null, [noise, events[0]]);
 assert.equal(await verifiedLegacyCheckpoint([wrong], events, options), null);
});

test('source digests bind exact original UTF8 and time while summary text is structurally checked rather than certified as fact', async () => {
 const source = [event(1, 'cafe\u0301'), event(2, 'A separate character quotation.')];
 const old = await legacy(2, null, source), normalized = structuredClone(source); normalized[0].text = 'café';
 assert.notEqual(await transcriptFingerprint(source), await transcriptFingerprint(normalized));
 assert.equal(await verifiedLegacyCheckpoint([old], normalized, options), null);
 const selected = await verifiedLegacyCheckpoint([old], source, options);
 assert.equal(selected.summary, old.result.checkpoint.summary);
 assert.equal(safeCheckpoint(checkpoint(source, { policy_fingerprint: 'other-policy' }), source, policy), null);
});

test('small history remains verbatim and does not invoke summarization or storage', async () => {
 const original = structuredClone(events); let called = 0;
 const result = await compactQualifiedHistory(events, null, policy, async () => { called++; throw Error('unexpected model'); }, async () => { called++; });
 assert.equal(called, 0); assert.equal(result.checkpoint, null); assert.deepEqual(result.events, original); assert.equal(result.rolledOver, false); assert.deepEqual(events, original);
});

test('a single long saved turn may exceed the soft raw target and is never shortened or summarized just for that limit', async () => {
 const source = [event(1, '한글🙂'.repeat(7000))], before = structuredClone(source); let calls = 0;
 assert(bytes(JSON.stringify(source)) > DIALOGUE_RAW_WINDOW_BYTES);
 const result = await compactQualifiedHistory(source, null, policy, async () => { calls++; return 'not used'; }, async () => { calls++; });
 assert.equal(calls, 0); assert.equal(result.checkpoint, null); assert.deepEqual(result.events, before); assert.deepEqual(source, before);
});

test('an oversized soft-window prefix is summarized whole while the last long turn is retained verbatim', async () => {
 const source = [event(1, 'a'.repeat(30000)), event(2, 'b'.repeat(30000))], original = structuredClone(source), summaries = [], stored = [];
 const result = await compactQualifiedHistory(source, null, policy, async (fresh, prior, covered) => { summaries.push({ fresh: structuredClone(fresh), prior, covered: structuredClone(covered) }); return 'The same current exchange continues.'; },
  async (value, covered) => stored.push({ value: structuredClone(value), covered: structuredClone(covered) }));
 assert.equal(summaries.length, 1); assert.equal(summaries[0].fresh[0].text.length, 30000); assert.deepEqual(summaries[0].fresh, [source[0]]); assert.equal(summaries[0].prior, null);
 assert.deepEqual(result.events, [source[1]]); assert(bytes(JSON.stringify(result.events)) > DIALOGUE_RAW_WINDOW_BYTES);
 assert.deepEqual(result.checkpoint.covered_ids, [source[0].id]); assert.equal(stored.length, 1); assert.deepEqual(source, original);
});

test('a valid multibyte saved turn larger than the checkpoint chunk target stays whole when another turn follows', async () => {
 const source = [event(1, '한'.repeat(17000)), event(2, 'That crooked edge stayed with me.')], original = structuredClone(source), summaries = [], stored = [];
 assert(source[0].text.length < 20000, 'the source fits the database saved-text limit');
 assert(bytes(JSON.stringify([source[0]])) > DIALOGUE_CHECKPOINT_CHUNK_BYTES);
 const result = await compactQualifiedHistory(source, null, policy, async (fresh, prior, covered) => {
  summaries.push({ fresh: structuredClone(fresh), prior, covered: structuredClone(covered) }); return 'The caller described the exact saved long utterance.';
 }, async (value, covered) => stored.push({ value: structuredClone(value), covered: structuredClone(covered) }));
 assert.equal(summaries.length, 1); assert.deepEqual(summaries[0].fresh, [original[0]]); assert.equal(summaries[0].prior, null);
 assert.deepEqual(summaries[0].covered, [original[0]]); assert.deepEqual(result.events, [original[1]]);
 assert.deepEqual(result.checkpoint.covered_ids, [original[0].id]); assert.equal(result.rolledOver, true);
 assert.equal(stored.length, 1); assert.deepEqual(stored[0].covered, [original[0]]); assert.deepEqual(source, original);
});

test('rolling chunks extend coverage monotonically, preserve every quote and use only the previous verified note', async () => {
 const source = Array.from({ length: 6 }, (_, i) => event(i + 1, String(i).repeat(20000))), original = structuredClone(source), seen = [], stored = [];
 const prior = checkpoint(source.slice(0, 1));
 const result = await compactQualifiedHistory(source, prior, policy, async (fresh, summary, covered) => {
  seen.push({ fresh: structuredClone(fresh), summary, covered: structuredClone(covered) }); return `Rolling note ${seen.length}.`;
 }, async (value, covered) => stored.push({ value: structuredClone(value), covered: structuredClone(covered) }));
 assert(seen.length >= 2); assert.equal(seen[0].summary, prior.summary);
 for (let i = 0; i < seen.length; i++) {
  assert(bytes(JSON.stringify(seen[i].fresh)) <= DIALOGUE_CHECKPOINT_CHUNK_BYTES);
  if (i) { assert.equal(seen[i].summary, `Rolling note ${i}.`); assert(seen[i].covered.length > seen[i - 1].covered.length); }
  assert.deepEqual(stored[i].value.covered_ids, seen[i].covered.map(row => row.id));
 }
 const covered = result.checkpoint.covered_ids.length;
 assert.deepEqual(result.events, source.slice(covered)); assert.deepEqual([...source.slice(0, 1), ...seen.flatMap(row => row.fresh), ...result.events], original);
 assert.equal(result.rolledOver, true); assert.deepEqual(source, original);
});

test('untrusted checkpoint context is not inherited, and invalid summary or failed storage cannot manufacture committed coverage', async () => {
 const source = [event(1, 'a'.repeat(20000)), event(2, 'b'.repeat(20000)), event(3, 'c'.repeat(20000))], original = structuredClone(source);
 let priorSeen = 'not-called', stores = 0;
 const result = await compactQualifiedHistory(source, checkpoint(source.slice(0, 1), { policy_fingerprint: 'retired-policy', summary: 'OLD_NOTE_CANARY' }), policy,
  async (_fresh, prior) => { priorSeen = prior; return 'A fresh continuity note.'; }, async () => { stores++; });
 assert.equal(priorSeen, null); assert(result.checkpoint); assert(stores > 0);
 stores = 0; await assert.rejects(compactQualifiedHistory(source, null, policy, async () => 'x'.repeat(901), async () => { stores++; }), error => error.code === 'INVALID_MODEL_OUTPUT'); assert.equal(stores, 0);
 await assert.rejects(compactQualifiedHistory(source, null, policy, async () => 'Valid note.', async () => { throw Error('checkpoint storage failed'); }), /storage failed/);
 assert.deepEqual(source, original);
});
