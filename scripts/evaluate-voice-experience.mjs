import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const ORIGINS = ['synthetic_fixture', 'provider_on_tts', 'provider_on_human'];
const STATUSES = ['completed', 'cancelled', 'incomplete', 'error', 'missing'];
export const NORMALIZATION = 'nfc-v1:case-and-punctuation-preserved;wer-whitespace;cer-codepoints-including-space';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = () => { throw Error('Invalid or unbound voice evaluation data.'); };
const text = (x, max = 20000) => typeof x === 'string' && x.length <= max;
const code = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const digest = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const key = x => `${x.case_id}:${x.variant_id}:${x.repeat}`;
const wordCount = x => (x.match(/[A-Za-z]+(?:['’\u002d][A-Za-z]+)*/g) || []).length;
const mean = x => x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
export function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, min: sorted[0], median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, p90: sorted[Math.ceil(n * .9) - 1], max: sorted[n - 1] };
}
// No spelling, morphology, case, punctuation, translation, or grammar repair.
export function errorRate(reference, prediction, unit = 'word') {
  if (!text(reference) || !text(prediction) || !['word', 'character'].includes(unit)) fail();
  const tokenize = x => unit === 'word' ? (x.normalize('NFC').trim() ? x.normalize('NFC').trim().split(/\s+/u) : []) : [...x.normalize('NFC')];
  const a = tokenize(reference), b = tokenize(prediction);
  if (a.length * b.length > 4_000_000) fail();
  let row = b.map((_, i) => i + 1); row.unshift(0);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(row[j + 1] + 1, next[j] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return { edits: row[b.length], reference_units: a.length, rate: a.length ? row[b.length] / a.length : null };
}
export async function readBoundedJson(path) {
  if ((await stat(path)).size > MAX_BYTES) fail();
  const data = await readFile(path);
  if (data.length > MAX_BYTES) fail();
  return JSON.parse(data.toString('utf8'));
}
export function selectStudy(suite, study = 'reply') {
  if (!object(suite) || suite.schema_version !== 1 || suite.origin !== 'authored_scripts_not_observations' || !object(suite.studies) || !['reply', 'asr', 'turntaking'].includes(study) || !object(suite.studies[study]) || suite.studies[study].study_id !== study) fail();
  return { ...suite.studies[study], suite_sha256: digest(suite) };
}
export function validateManifest(manifest) {
  if (!object(manifest) || manifest.schema_version !== 1 || !code(manifest.benchmark_id) || !code(manifest.source_version) || !['reply', 'asr', 'turntaking'].includes(manifest.study_id) || !/^[a-f0-9]{64}$/.test(manifest.suite_sha256 || '') || manifest.origin !== 'authored_scripts_not_observations' || manifest.normalization !== NORMALIZATION || !Number.isInteger(manifest.repetitions) || manifest.repetitions < 1 || manifest.repetitions > 10 || !Array.isArray(manifest.cases) || !manifest.cases.length || manifest.cases.length > 100 || !Array.isArray(manifest.variants) || manifest.variants.length !== 2) fail();
  if (!['authored_research_prototypes_not_deployed_replay', 'supplied_effective_session_capture'].includes(manifest.condition_scope) || (manifest.condition_scope === 'supplied_effective_session_capture' && manifest.effective_config_capture_attested !== true)) fail();
  const base = manifest.base_config;
  if (!object(base) || base.voice_model !== 'gpt-realtime-2.1-mini' || base.transcription_model !== 'gpt-realtime-whisper' || !text(base.instructions) || !base.instructions.trim()) fail();
  const treatment = { reply: 'instructions', asr: 'transcription_language', turntaking: 'turn_detection' }[manifest.study_id];
  const variants = new Map(), cases = new Map();
  for (const v of manifest.variants) {
    if (!object(v) || !code(v.id) || variants.has(v.id) || !object(v.treatment_patch) || !Array.isArray(v.declared_treatments) || new Set(v.declared_treatments).size !== v.declared_treatments.length || v.declared_treatments.some(x => !code(x) || !(x in base)) || Object.keys(v.treatment_patch).some(x => !v.declared_treatments.includes(x)) || ['voice_model', 'transcription_model'].some(x => x in v.treatment_patch)) fail();
    const config = { ...base, ...v.treatment_patch };
    if (!text(config.instructions) || !config.instructions.trim()) fail();
    variants.set(v.id, config);
  }
  if (Object.keys(manifest.variants[0].treatment_patch).length || manifest.variants[0].declared_treatments.length || manifest.variants[1].declared_treatments.length !== 1 || manifest.variants[1].declared_treatments[0] !== treatment || Object.keys(manifest.variants[1].treatment_patch).length !== 1 || !(treatment in manifest.variants[1].treatment_patch) || digest(base[treatment]) === digest(manifest.variants[1].treatment_patch[treatment])) fail();
  for (const c of manifest.cases) {
    if (!object(c) || !code(c.id) || cases.has(c.id) || c.source_version !== manifest.source_version || c.kind !== manifest.study_id || !object(c.input) || c.input_sha256 !== digest(c.input) || !Array.isArray(c.requirements) || !c.requirements.length || c.requirements.some(x => !text(x, 2000))) fail();
    cases.set(c.id, c);
  }
  return { variants, cases };
}
function validateResults(manifest, predictions, variants, cases) {
  if (!object(predictions) || predictions.schema_version !== 1 || predictions.study_id !== manifest.study_id || predictions.benchmark_id !== manifest.benchmark_id || predictions.source_version !== manifest.source_version || predictions.manifest_sha256 !== digest(manifest) || predictions.provenance_attested !== true || !Array.isArray(predictions.records) || predictions.records.length > 2000) fail();
  const records = new Map();
  for (const r of predictions.records) {
    const c = cases.get(r?.case_id), config = variants.get(r?.variant_id);
    if (!object(r) || !c || !config || r.source_version !== c.source_version || !Number.isInteger(r.repeat) || r.repeat < 1 || r.repeat > manifest.repetitions || !ORIGINS.includes(r.origin) || r.input_sha256 !== c.input_sha256 || digest(r.model_config) !== digest(config) || r.config_sha256 !== digest(config) || !object(r.output) || r.output_sha256 !== digest(r.output) || !STATUSES.includes(r.output.status) || ![null, 'max_output_tokens', 'client_cancel', 'transport', 'other'].includes(r.output.reason) || records.has(key(r))) fail();
    if (r.origin !== 'synthetic_fixture' && (!/^[a-f0-9]{64}$/.test(c.input.audio_sha256 || '') || c.input.audio_origin !== (r.origin === 'provider_on_human' ? 'consented_human' : 'tts'))) fail();
    if (Object.keys(r.output).some(x => !['status', 'reason', 'reply_text', 'asr_text', 'assistant_audio_start_ms', 'provider_speech_stopped_ms', 'assistant_audio_sha256'].includes(x))) fail();
    for (const field of ['reply_text', 'asr_text']) if (field in r.output && !text(r.output[field])) fail();
    for (const field of ['assistant_audio_start_ms', 'provider_speech_stopped_ms']) if (field in r.output && !finite(r.output[field])) fail();
    if ('assistant_audio_sha256' in r.output && !/^[a-f0-9]{64}$/.test(r.output.assistant_audio_sha256)) fail();
    if (r.output.status === 'missing' && ['reply_text', 'asr_text', 'assistant_audio_start_ms', 'provider_speech_stopped_ms', 'assistant_audio_sha256'].some(x => x in r.output)) fail();
    if (r.output.reason === 'max_output_tokens' && r.output.status !== 'incomplete') fail();
    records.set(key(r), r);
  }
  return records;
}
function validateLabels(manifest, labels, records, cases) {
  if (!object(labels) || labels.schema_version !== 1 || labels.study_id !== manifest.study_id || labels.benchmark_id !== manifest.benchmark_id || labels.source_version !== manifest.source_version || labels.manifest_sha256 !== digest(manifest) || labels.provenance_attested !== true || !Array.isArray(labels.reviews) || labels.reviews.length > 4000 || !Array.isArray(labels.references) || labels.references.length > 100) fail();
  const reviews = new Map(), references = new Map();
  for (const ref of labels.references) {
    const c = cases.get(ref?.case_id);
    if (!object(ref) || !c || c.kind !== 'asr' || ref.source_version !== c.source_version || references.has(ref.case_id) || ref.input_sha256 !== c.input_sha256 || !text(ref.text) || ref.reference_sha256 !== digest(ref.text) || !code(ref.reviewer_code) || ref.verbatim_attested !== true || ref.adjudicated !== true || !['none', 'uncertain'].includes(ref.uncertainty)) fail();
    references.set(ref.case_id, ref);
  }
  for (const l of labels.reviews) {
    const r = records.get(key(l)), labelKey = `${key(l)}:${l?.reviewer_code}`;
    if (!object(l) || !r || reviews.has(labelKey) || l.source_version !== manifest.source_version || l.output_sha256 !== r.output_sha256 || l.input_sha256 !== r.input_sha256 || !code(l.reviewer_code) || l.origin !== 'human_review' || !object(l.judgments)) fail();
    const j = l.judgments;
    if ('audio_reviewed' in l && typeof l.audio_reviewed !== 'boolean') fail();
    if (l.audio_reviewed === true && !r.output.assistant_audio_sha256) fail();
    const spokenJudgment = (j.language_policy && j.language_policy !== 'uncertain') || (j.unfinished && j.unfinished !== 'uncertain');
    if (cases.get(r.case_id).kind === 'reply' && r.origin !== 'synthetic_fixture' && spokenJudgment && (l.audio_reviewed !== true || !r.output.assistant_audio_sha256)) fail();
    if (Object.keys(j).some(x => !['adequacy', 'language_policy', 'unfinished', 'true_end_ms', 'intended_continuation'].includes(x))) fail();
    if ('adequacy' in j && ![0, 1, 2, 'uncertain'].includes(j.adequacy)) fail();
    if ('language_policy' in j && !['compliant', 'violation', 'uncertain'].includes(j.language_policy)) fail();
    if ('unfinished' in j && !['yes', 'no', 'uncertain'].includes(j.unfinished)) fail();
    if ('true_end_ms' in j && j.true_end_ms !== 'uncertain' && !finite(j.true_end_ms)) fail();
    if ('intended_continuation' in j && ![true, false, 'uncertain'].includes(j.intended_continuation)) fail();
    reviews.set(labelKey, l);
  }
  return { reviews: [...reviews.values()], references };
}
export function evaluateVoiceExperience(manifest, predictions, labels) {
  const { variants, cases } = validateManifest(manifest), records = validateResults(manifest, predictions, variants, cases);
  const { reviews, references } = validateLabels(manifest, labels, records, cases), groups = [];
  let editWork = 0;
  for (const origin of ORIGINS) for (const variant_id of variants.keys()) {
    const rows = [...records.values()].filter(x => x.origin === origin && x.variant_id === variant_id), statuses = Object.fromEntries(STATUSES.map(s => [s, rows.filter(r => r.output.status === s).length]));
    const replies = rows.filter(r => cases.get(r.case_id).kind === 'reply' && r.output.status === 'completed' && typeof r.output.reply_text === 'string');
    const asr = rows.filter(r => cases.get(r.case_id).kind === 'asr'), scores = [];
    let noReference = 0, unavailable = 0, uncertainReference = 0;
    for (const r of asr) {
      const ref = references.get(r.case_id), outputUnavailable = r.output.status !== 'completed' || typeof r.output.asr_text !== 'string';
      if (outputUnavailable) unavailable++;
      if (!ref) { noReference++; continue; }
      if (ref.uncertainty !== 'none') { uncertainReference++; continue; }
      if (outputUnavailable) continue;
      editWork += ref.text.length * r.output.asr_text.length; if (editWork > 20_000_000) fail();
      scores.push({ non_speech_output: ref.text.length === 0 && r.output.asr_text.length > 0, word: errorRate(ref.text, r.output.asr_text), character: errorRate(ref.text, r.output.asr_text, 'character') });
    }
    const rs = reviews.filter(l => rows.some(r => key(l) === key(r))), timing = [], missingFields = { adequacy: 0, language_policy: 0, unfinished: 0 }, judgments = { adequacy: { 0: 0, 1: 0, 2: 0, uncertain: 0 }, language_policy: { compliant: 0, violation: 0, uncertain: 0 }, unfinished: { yes: 0, no: 0, uncertain: 0 } };
    let premature = 0, continuation = 0, timingUnmeasured = 0;
    for (const l of rs) {
      const j = l.judgments, r = records.get(key(l));
      for (const k of Object.keys(judgments)) { if (k in j) judgments[k][j[k]]++; else missingFields[k]++; }
      if (cases.get(l.case_id).kind !== 'turntaking') continue;
      if (!finite(j.true_end_ms) || typeof j.intended_continuation !== 'boolean' || !finite(r.output.assistant_audio_start_ms)) { timingUnmeasured++; continue; }
      const delta = r.output.assistant_audio_start_ms - j.true_end_ms;
      timing.push(delta); if (delta < 0) premature++; if (delta < 0 && j.intended_continuation) continuation++;
    }
    const disagreementKeys = new Map();
    for (const l of rs) {
      if (!disagreementKeys.has(key(l))) disagreementKeys.set(key(l), new Map());
      for (const [field, value] of Object.entries(l.judgments)) {
        if (value === 'uncertain') continue;
        const fields = disagreementKeys.get(key(l)); if (!fields.has(field)) fields.set(field, new Set());
        fields.get(field).add(digest(value));
      }
    }
    const sumRate = unit => { const denom = scores.reduce((s, x) => s + x[unit].reference_units, 0); return denom ? scores.reduce((s, x) => s + x[unit].edits, 0) / denom : null; };
    groups.push({ origin, variant_id, record_count: rows.length, outcomes: statuses, token_exhaustion_count: rows.filter(r => r.output.reason === 'max_output_tokens').length,
      diagnostics: { english_word_count: distribution(replies.map(r => wordCount(r.output.reply_text))), hangul_present_count: replies.length ? replies.filter(r => /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(r.output.reply_text)).length : null, diagnostic_reply_count: replies.length, unmeasured_reply_record_count: rows.filter(r => cases.get(r.case_id).kind === 'reply').length - replies.length, word_tokenizer: "ASCII letters with internal apostrophe or hyphen; punctuation otherwise splits", language_judgment_from_scripts: false },
      asr: { scored_count: scores.length, non_speech_output_count: scores.length ? scores.filter(x => x.non_speech_output).length : null, missing_reference_count: noReference, uncertain_reference_count: uncertainReference, unavailable_output_count: unavailable, word_error_rate: sumRate('word'), character_error_rate: sumRate('character'), word_edits: scores.length ? scores.reduce((s,x)=>s+x.word.edits,0) : null, character_edits: scores.length ? scores.reduce((s,x)=>s+x.character.edits,0) : null, reference_word_units: scores.length ? scores.reduce((s,x)=>s+x.word.reference_units,0) : null, reference_character_units: scores.length ? scores.reduce((s,x)=>s+x.character.reference_units,0) : null },
      human_review: { review_count: rs.length, audio_review_attested_count: rs.filter(l => l.audio_reviewed === true).length, audio_review_independently_verified: false, reviewer_count: new Set(rs.map(l => l.reviewer_code)).size, unreviewed_record_count: rows.filter(r => !rs.some(l => key(l) === key(r))).length, judgments, missing_fields: missingFields, disagreements_not_adjudicated: [...disagreementKeys.values()].filter(fields => [...fields.values()].some(values => values.size > 1)).length },
      turntaking: { timing_label_count: timing.length, unmeasured_label_count: timingUnmeasured, response_minus_human_true_end_ms: distribution(timing), starts_before_human_true_end_count: timing.length ? premature : null, intended_continuation_takeover_count: timing.length ? continuation : null, provider_speech_stop_is_gold: false } });
  }
  const [a, b] = [...variants.keys()], pairs = Object.fromEntries(ORIGINS.map(origin => [origin, { record_pairs: 0, words: [], wer: [], cer: [], timing: [] }])); let completePairs = 0, incompatibleOrigins = 0, explicitMissingPairs = 0;
  const agreedTiming = r => {
    const known = reviews.filter(l => key(l) === key(r) && finite(l.judgments.true_end_ms) && typeof l.judgments.intended_continuation === 'boolean').map(l => ({ true_end_ms: l.judgments.true_end_ms, intended_continuation: l.judgments.intended_continuation }));
    return known.length && new Set(known.map(digest)).size === 1 ? known[0] : null;
  };
  for (const c of cases.values()) for (let repeat = 1; repeat <= manifest.repetitions; repeat++) {
    const left = records.get(key({ case_id: c.id, variant_id: a, repeat })), right = records.get(key({ case_id: c.id, variant_id: b, repeat }));
    if (!left || !right) continue;
    if (left.origin !== right.origin) { incompatibleOrigins++; continue; }
    if (left.output.status === 'missing' || right.output.status === 'missing') { explicitMissingPairs++; continue; }
    completePairs++; const group = pairs[left.origin]; group.record_pairs++;
    if (c.kind === 'reply' && left.output.status === 'completed' && right.output.status === 'completed' && typeof left.output.reply_text === 'string' && typeof right.output.reply_text === 'string') group.words.push(wordCount(right.output.reply_text) - wordCount(left.output.reply_text));
    const ref = references.get(c.id);
    if (c.kind === 'asr' && ref?.uncertainty === 'none' && [left, right].every(r => r.output.status === 'completed' && typeof r.output.asr_text === 'string')) {
      for (const [unit, target] of [['word', 'wer'], ['character', 'cer']]) {
        const x = errorRate(ref.text, left.output.asr_text, unit).rate, y = errorRate(ref.text, right.output.asr_text, unit).rate;
        if (x !== null && y !== null) group[target].push(y - x);
      }
    }
    const lt = agreedTiming(left), rt = agreedTiming(right);
    if (c.kind === 'turntaking' && lt && rt && digest(lt) === digest(rt) && finite(left.output.assistant_audio_start_ms) && finite(right.output.assistant_audio_start_ms)) group.timing.push(right.output.assistant_audio_start_ms - left.output.assistant_audio_start_ms);
  }
  const expectedPairs = cases.size * manifest.repetitions;
  return { schema_version: 1, mode: 'offline_measurement_only', condition_scope: manifest.condition_scope, study_id: manifest.study_id, benchmark_id: manifest.benchmark_id, source_version: manifest.source_version, manifest_sha256: digest(manifest), suite_sha256: manifest.suite_sha256, normalization: NORMALIZATION,
    authored_scenario_count: cases.size, observation_count: records.size, supplied_provider_observation_count: [...records.values()].filter(r => r.origin !== 'synthetic_fixture').length, synthetic_software_output_count: [...records.values()].filter(r => r.origin === 'synthetic_fixture').length, expected_cells: expectedPairs * 2, missing_cells: expectedPairs * 2 - records.size,
    pairing: { expected_pairs: expectedPairs, comparable_record_pairs: completePairs, missing_or_incompatible_pairs: expectedPairs - completePairs, incompatible_origin_pairs: incompatibleOrigins, explicit_missing_output_pairs: explicitMissingPairs, by_origin: Object.entries(pairs).map(([origin, p]) => ({ origin, comparable_record_pairs: p.record_pairs, reply_word_difference_candidate_minus_baseline: distribution(p.words), reply_mean_word_difference: mean(p.words), word_error_rate_difference: distribution(p.wer), character_error_rate_difference: distribution(p.cer), true_end_latency_difference_ms: distribution(p.timing) })) },
    groups, provenance: 'supplied_attestation_not_independently_verified', all_metrics_descriptive: true, human_label_disagreements_retained: true, participant_count: null,
    model_performance_measured: [...records.values()].some(r => r.origin !== 'synthetic_fixture') ? 'supplied_provider_observations_not_independently_verified' : null, learner_outcomes_measured: false, learning_effect_claim_supported: false, deployment_decision: null, automatic_pass_gate: false };
}
export const emptyInputs = manifest => [{ schema_version: 1, study_id: manifest.study_id, benchmark_id: manifest.benchmark_id, source_version: manifest.source_version, manifest_sha256: digest(manifest), provenance_attested: true, records: [] }, { schema_version: 1, study_id: manifest.study_id, benchmark_id: manifest.benchmark_id, source_version: manifest.source_version, manifest_sha256: digest(manifest), provenance_attested: true, reviews: [], references: [] }];
async function main() {
  const args = process.argv.slice(2), allowed = ['--manifest', '--study', '--predictions', '--labels', '--output'];
  if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.includes(x)) || new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2) fail();
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  if (Boolean(options['--predictions']) !== Boolean(options['--labels'])) fail();
  const suite = await readBoundedJson(options['--manifest'] || new URL('../test/fixtures/voice-experience-benchmark.json', import.meta.url));
  const manifest = selectStudy(suite, options['--study'] || 'reply');
  const [predictions, labels] = options['--predictions'] ? await Promise.all([readBoundedJson(options['--predictions']), readBoundedJson(options['--labels'])]) : emptyInputs(manifest);
  const result = JSON.stringify(evaluateVoiceExperience(manifest, predictions, labels), null, 2) + '\n';
  if (options['--output']) await writeFile(options['--output'], result, { mode: 0o600 });
  process.stdout.write(result);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Voice evaluation data could not be validated; source text and private identifiers were not printed.'); process.exitCode = 1; });
