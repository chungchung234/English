import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateLabels,observationWindows,syntheticEvaluation} from '../scripts/evaluate-learning-enhancements.mjs';

const prediction={schema_version:1,origin:'real_conversation',cases:[{id:'a',source_version:'v1',observation:{kind:'observed',mode:'undetermined'}}]};
const labels={schema_version:1,origin:'human_review',independent_review_attested:true,reviewer_code:'reviewer-01',cases:[{id:'a',source_version:'v1',kind:'observed',mode:'after_hint',opportunity:'present',appropriate_use:'yes'}]};

test('synthetic phrase fixtures exercise abstention and never count as a real user study',async()=>{
 const r=await syntheticEvaluation();assert.equal(r.failed,0);assert.equal(r.fixture_count,14);assert.equal(r.human_quality_measured,false);assert.equal(r.participant_count,null);assert.equal(r.learning_effect_measured,false);assert.equal(r.production_gate,'observational_only');
});
test('human evidence preserves unknown mode instead of turning phrase presence into mastery',()=>{
 const r=evaluateLabels(prediction,labels);assert.equal(r.human_quality_measured,true);assert.equal(r.lexical_presence_precision,1);assert.equal(r.mode_match_rate,0);assert.equal(r.human_appropriate_usage_rate,1);assert.equal(r.learning_effect_measured,false);assert.equal(r.production_gate,'observational_only');
});
test('missing labels, unknown opportunities and uncertain references do not become failures or successes',()=>{
 const r=evaluateLabels({...prediction,cases:[...prediction.cases,{id:'b',source_version:'v1',observation:{kind:'undetermined',mode:'undetermined'}}]}, {...labels,cases:[{...labels.cases[0],kind:'uncertain',opportunity:'unknown',appropriate_use:'uncertain',mode:'undetermined'}]});
 assert.equal(r.unreviewed_count,1);assert.equal(r.lexical_presence_precision,null);assert.equal(r.opportunity_unknown_count,1);assert.equal(r.human_appropriate_usage_rate,null);
});
test('duplicate, foreign and stale-version review rows fail instead of inflating metrics',()=>{
 assert.throws(()=>evaluateLabels(prediction,{...labels,cases:[...labels.cases,...labels.cases]}));
 assert.throws(()=>evaluateLabels(prediction,{...labels,cases:[{...labels.cases[0],id:'foreign'}]}));
 assert.throws(()=>evaluateLabels(prediction,{...labels,cases:[{...labels.cases[0],source_version:'old'}]}));
 assert.throws(()=>evaluateLabels({...prediction,cases:[{...prediction.cases[0],source_version:undefined}]},{...labels,cases:[{...labels.cases[0],source_version:undefined}]}));
});
test('conversion maturity uses16days plus72h while return uses7days plus72h',()=>{
 const cohort=[{ended_at:'2026-11-01T00:00:00Z'}];
 assert.equal(observationWindows(cohort,'2026-11-10T23:59:59Z').return_mature,0);
 assert.equal(observationWindows(cohort,'2026-11-11T00:00:00Z').return_mature,1);
 const before=observationWindows(cohort,'2026-11-19T23:59:59Z');assert.equal(before.conversion_mature,0);assert.equal(before.conversion_immature,1);assert.equal(before.immature_is_failure,false);
 assert.equal(observationWindows(cohort,'2026-11-20T00:00:00Z').conversion_mature,1);
 assert.throws(()=>observationWindows(cohort,'2026-10-31T00:00:00Z'));
});
