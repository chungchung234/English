import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, selectStudy, emptyInputs, evaluateVoiceExperience, errorRate, readBoundedJson, NORMALIZATION } from '../scripts/evaluate-voice-experience.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/voice-experience-benchmark.json', import.meta.url), 'utf8'));
function setup(study = 'reply', edit = () => {}) {
  const suite = structuredClone(fixture); edit(suite.studies[study]);
  const manifest = selectStudy(suite, study), [predictions, labels] = emptyInputs(manifest);
  const add = (variant_id = 'baseline', output = { status: 'completed', reason: null, reply_text: 'That sounds nice.' }, options = {}) => {
    const c = manifest.cases.find(c => c.id === options.case_id) || manifest.cases[0];
    const v = manifest.variants.find(v => v.id === variant_id), model_config = { ...manifest.base_config, ...v.treatment_patch };
    const r = { case_id: c.id, source_version: manifest.source_version, variant_id, repeat: 1, origin: 'synthetic_fixture', input_sha256: c.input_sha256, model_config, config_sha256: digest(model_config), output, output_sha256: digest(output), ...options };
    predictions.records.push(r); return r;
  };
  const review = (r, judgments, reviewer_code = 'rater-a') => labels.reviews.push({ case_id: r.case_id, source_version: manifest.source_version, variant_id: r.variant_id, repeat: r.repeat, input_sha256: r.input_sha256, output_sha256: r.output_sha256, reviewer_code, origin: 'human_review', judgments });
  const reference = (text, uncertainty = 'none') => labels.references.push({ case_id: manifest.cases[0].id, source_version: manifest.source_version, input_sha256: manifest.cases[0].input_sha256, text, reference_sha256: digest(text), reviewer_code: 'transcriber-a', verbatim_attested: true, adjudicated: true, uncertainty });
  return { manifest, predictions, labels, add, review, reference, run: () => evaluateVoiceExperience(manifest, predictions, labels) };
}
const group = (r, origin = 'synthetic_fixture', variant = 'baseline') => r.groups.find(g => g.origin === origin && g.variant_id === variant);

test('three isolated authored studies default to no observations and null performance', () => {
  for (const [study, count] of [['reply', 12], ['asr', 4], ['turntaking', 4]]) {
    const r = setup(study).run();
    assert.equal(r.authored_scenario_count, count); assert.equal(r.observation_count, 0);
    assert.equal(r.missing_cells, count * 6); assert.equal(r.pairing.missing_or_incompatible_pairs, count * 3);
    assert.equal(r.model_performance_measured, null); assert.equal(r.participant_count, null);
    assert.equal(r.deployment_decision, null); assert.equal(r.automatic_pass_gate, false);
    assert.equal(group(r).diagnostics.english_word_count, null); assert.equal(group(r).asr.word_error_rate, null);
    assert.equal(r.normalization, NORMALIZATION); assert.match(r.condition_scope, /not_deployed_replay/);
  }
});
test('a candidate can change only the declared study variable', () => {
  const h = setup(); h.manifest.variants[1].treatment_patch.speech_speed = .8;
  assert.throws(h.run);
  const a = setup('asr'); a.manifest.variants[1].declared_treatments = ['instructions']; assert.throws(a.run);
  const b = setup(); b.manifest.base_config.voice_model = 'different-model'; assert.throws(b.run);
});
test('duplicate, foreign, stale source, input, output and undeclared config are rejected', () => {
  for (const mutate of [
    h => h.predictions.records.push(structuredClone(h.predictions.records[0])),
    h => { h.predictions.records[0].case_id = 'foreign'; },
    h => { h.predictions.records[0].source_version = 'older-source'; },
    h => { h.predictions.records[0].input_sha256 = '0'.repeat(64); },
    h => { h.predictions.records[0].output.reply_text = 'Stale output'; },
    h => { h.predictions.records[0].model_config.speech_speed = 1.2; },
    h => { h.predictions.records[0].variant_id = 'foreign'; },
  ]) { const h = setup(); h.add(); mutate(h); assert.throws(h.run); }
});
test('full manifest hash prevents replay after requirements or population change', () => {
  for (const mutate of [m => m.cases[0].requirements.push('Changed criterion'), m => m.cases.pop(), m => { m.condition_scope = 'supplied_effective_session_capture'; m.effective_config_capture_attested = true; }]) {
    const h = setup(); h.add(); mutate(h.manifest); assert.throws(h.run);
  }
  const h = setup(); h.add(); h.labels.manifest_sha256 = '0'.repeat(64); assert.throws(h.run);
  const a = setup(); a.add(); a.predictions.study_id = 'asr'; assert.throws(a.run);
});
test('human labels bind output, input, source and pseudocode without discarding uncertainty', () => {
  for (const mutate of [
    h => { h.labels.reviews[0].output_sha256 = '0'.repeat(64); },
    h => { h.labels.reviews[0].input_sha256 = '0'.repeat(64); },
    h => { h.labels.reviews[0].source_version = 'old'; },
    h => { h.labels.reviews[0].reviewer_code = 'person@example.com'; },
    h => h.labels.reviews.push(structuredClone(h.labels.reviews[0])),
  ]) { const h = setup(); const r = h.add(); h.review(r, { adequacy: 2 }); mutate(h); assert.throws(h.run); }
  const h = setup(), r = h.add();
  h.review(r, { adequacy: 2, language_policy: 'compliant' });
  h.review(r, { adequacy: 0, language_policy: 'uncertain' }, 'rater-b');
  const g = group(h.run()); assert.equal(g.human_review.review_count, 2);
  assert.equal(g.human_review.disagreements_not_adjudicated, 1); assert.equal(g.human_review.judgments.language_policy.uncertain, 1);
});
test('word counts and Hangul are diagnostics, not automatic language or adequacy decisions', () => {
  const h = setup(); h.add('baseline', { status: 'completed', reason: null, reply_text: "I can't miss this well-known café. 서울" });
  const r = h.run(), g = group(r); assert.equal(g.diagnostics.english_word_count.median, 6);
  assert.equal(g.diagnostics.hangul_present_count, 1); assert.equal(g.diagnostics.language_judgment_from_scripts, false);
  assert.equal(g.human_review.review_count, 0); assert.equal(r.model_performance_measured, null);
  assert.equal(r.learning_effect_claim_supported, false); assert.equal(r.learner_outcomes_measured, false);
});
test('cancellation, token exhaustion, transport errors and missing cells remain separate', () => {
  const h = setup(); h.add(); h.add('candidate', { status: 'incomplete', reason: 'max_output_tokens', reply_text: 'An unfinished' });
  h.add('baseline', { status: 'cancelled', reason: 'client_cancel' }, { repeat: 2 });
  h.add('baseline', { status: 'error', reason: 'transport' }, { repeat: 3 });
  const r = h.run(); assert.deepEqual(group(r).outcomes, { completed: 1, cancelled: 1, incomplete: 0, error: 1, missing: 0 });
  assert.equal(group(r, 'synthetic_fixture', 'candidate').token_exhaustion_count, 1);
  assert.equal(r.missing_cells, 68); assert.equal(r.pairing.comparable_record_pairs, 1);
  assert.equal(r.pairing.by_origin[0].reply_word_difference_candidate_minus_baseline, null);
});
test('frozen WER/CER preserve grammar, case, punctuation and empty-reference undefined rates', () => {
  assert.deepEqual(errorRate('I go home', 'I went home'), { edits: 1, reference_units: 3, rate: 1 / 3 });
  assert.deepEqual(errorRate('가나', '가다', 'character'), { edits: 1, reference_units: 2, rate: .5 });
  assert.equal(errorRate('café', 'cafe\u0301', 'character').rate, 0);
  assert.equal(errorRate('Yes.', 'yes').rate, 1); assert.equal(errorRate('', 'noise').rate, null);
  assert.throws(() => errorRate('a'.repeat(2100), 'b'.repeat(2100), 'character'));
});
test('ASR metrics require a provided adjudicated verbatim reference, not an authored script', () => {
  const h = setup('asr'); h.add('baseline', { status: 'completed', reason: null, asr_text: 'Yesterday I went' });
  assert.equal(group(h.run()).asr.word_error_rate, null); assert.equal(group(h.run()).asr.missing_reference_count, 1);
  h.reference('Yesterday I go'); const g = group(h.run()); assert.equal(g.asr.word_error_rate, 1 / 3); assert.equal(g.asr.word_edits, 1);
  h.labels.references[0].uncertainty = 'uncertain'; assert.equal(group(h.run()).asr.word_error_rate, null);
  h.labels.references[0].reference_sha256 = '0'.repeat(64); assert.throws(h.run);
});
test('provider acoustic speech-stop is never ground truth for turn taking', () => {
  const h = setup('turntaking'); const r = h.add('baseline', { status: 'completed', reason: null, assistant_audio_start_ms: 2000, provider_speech_stopped_ms: 1000 });
  assert.equal(group(h.run()).turntaking.response_minus_human_true_end_ms, null);
  h.review(r, { true_end_ms: 2500, intended_continuation: true });
  h.review(r, { true_end_ms: 'uncertain', intended_continuation: 'uncertain' }, 'rater-b');
  const g = group(h.run()).turntaking; assert.equal(g.response_minus_human_true_end_ms.median, -500);
  assert.equal(g.starts_before_human_true_end_count, 1); assert.equal(g.intended_continuation_takeover_count, 1);
  assert.equal(g.unmeasured_label_count, 1); assert.equal(g.provider_speech_stop_is_gold, false);
});
test('paired ASR rates and human timing require shared references or agreed end labels', () => {
  const a = setup('asr'); a.add('baseline', { status: 'completed', reason: null, asr_text: 'I went home' }); a.add('candidate', { status: 'completed', reason: null, asr_text: 'I go home' }); a.reference('I go home');
  assert.equal(a.run().pairing.by_origin[0].word_error_rate_difference.median, -1 / 3);
  const t = setup('turntaking'), x = t.add('baseline', { status: 'completed', reason: null, assistant_audio_start_ms: 2000 }), y = t.add('candidate', { status: 'completed', reason: null, assistant_audio_start_ms: 3000 });
  t.review(x, { true_end_ms: 2500, intended_continuation: true }); t.review(y, { true_end_ms: 2500, intended_continuation: true });
  assert.equal(t.run().pairing.by_origin[0].true_end_latency_difference_ms.median, 1000);
  t.review(y, { true_end_ms: 2700, intended_continuation: true }, 'rater-b');
  assert.equal(t.run().pairing.by_origin[0].true_end_latency_difference_ms, null);
  assert.equal(group(t.run(), 'synthetic_fixture', 'candidate').human_review.disagreements_not_adjudicated, 1);
});
test('explicit missing outputs and non-speech insertions do not become successful pairs', () => {
  const h = setup(); h.add(); h.add('candidate', { status: 'missing', reason: null });
  assert.equal(h.run().pairing.explicit_missing_output_pairs, 1); assert.equal(h.run().pairing.comparable_record_pairs, 0);
  const a = setup('asr'); a.add('baseline', { status: 'completed', reason: null, asr_text: 'invented' }); a.reference('');
  assert.equal(group(a.run()).asr.word_error_rate, null); assert.equal(group(a.run()).asr.non_speech_output_count, 1);
});
test('provider observations cannot masquerade as script-only recordings', () => {
  for (const origin of ['provider_on_tts', 'provider_on_human']) { const h = setup(); h.add('baseline', undefined, { origin }); assert.throws(h.run); }
});
test('spoken provider judgments bind the reviewed assistant audio and attestation', () => {
  const h = setup('reply', m => { const c = m.cases[0]; c.input.audio_sha256 = 'a'.repeat(64); c.input.audio_origin = 'tts'; c.input.fixture_audio_provenance = 'fake_hash_for_software_test'; c.input_sha256 = digest(c.input); });
  const r = h.add('baseline', { status: 'completed', reason: null, reply_text: 'A complete reply.' }, { origin: 'provider_on_tts' }); h.review(r, { language_policy: 'compliant', unfinished: 'no' });
  assert.throws(h.run); r.output.assistant_audio_sha256 = 'b'.repeat(64); r.output_sha256 = digest(r.output); h.labels.reviews[0].output_sha256 = r.output_sha256; assert.throws(h.run);
  h.labels.reviews[0].audio_reviewed = true; assert.equal(group(h.run(), 'provider_on_tts').human_review.audio_review_attested_count, 1);
  r.output.assistant_audio_sha256 = 'c'.repeat(64); assert.throws(h.run);
});
test('paired differences stay separated by supplied origins and unmatched pairs stay explicit', () => {
  // Deliberately fake hashes/attestations test validation, not model observations.
  const h = setup('reply', m => { for (const c of m.cases) { c.input.audio_sha256 = 'a'.repeat(64); c.input.audio_origin = 'tts'; c.input.fixture_audio_provenance = 'fake_hash_for_software_test'; c.input_sha256 = digest(c.input); } });
  h.add('baseline', { status: 'completed', reason: null, reply_text: 'One two three.' }); h.add('candidate', { status: 'completed', reason: null, reply_text: 'One.' });
  h.add('baseline', { status: 'completed', reason: null, reply_text: 'One.' }, { repeat: 2, origin: 'provider_on_tts' });
  h.add('candidate', { status: 'completed', reason: null, reply_text: 'One two three four.' }, { repeat: 2, origin: 'provider_on_tts' });
  h.add('baseline', undefined, { repeat: 3 }); h.add('candidate', undefined, { repeat: 3, origin: 'provider_on_tts' });
  const r = h.run(); assert.equal(r.pairing.by_origin[0].reply_mean_word_difference, -2); assert.equal(r.pairing.by_origin[1].reply_mean_word_difference, 3);
  assert.equal(r.pairing.incompatible_origin_pairs, 1); assert.equal(r.pairing.missing_or_incompatible_pairs, 34);
  assert.equal(r.provenance, 'supplied_attestation_not_independently_verified'); assert.notEqual(r.model_performance_measured, true);
  assert.equal(r.learning_effect_claim_supported, false); assert.equal(r.deployment_decision, null);
});
test('input files have finite byte bounds and CLI failures do not disclose source text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-eval-'));
  try {
    const large = join(dir, 'large.json'); await writeFile(large, ' '.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(readBoundedJson(large));
    const h = setup(); h.add(); h.predictions.source_version = 'private-user-probe';
    const p = join(dir, 'p.json'), l = join(dir, 'l.json'); await writeFile(p, JSON.stringify(h.predictions)); await writeFile(l, JSON.stringify(h.labels));
    const result = spawnSync(process.execPath, ['scripts/evaluate-voice-experience.mjs', '--predictions', p, '--labels', l], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /private-user-probe|That sounds nice/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
