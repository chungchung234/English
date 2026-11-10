import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {observationalUsage} from '../supabase/functions/coach/enhancements.ts';

const record=x=>x&&typeof x==='object'&&!Array.isArray(x);
const ratio=(n,d)=>d?n/d:null;
const MODES=new Set(['undetermined','repetition','after_hint','new_context']);

// This measures observed phrase presence. It never enables a learner-facing
// success/mastery label, even when supplied review labels are perfectly matched.
export function evaluateLabels(predictions,labels){
 if(!record(predictions)||predictions.schema_version!==1||!Array.isArray(predictions.cases)||!record(labels)||labels.schema_version!==1||!Array.isArray(labels.cases))throw Error('Invalid evaluation format.');
 const byId=new Map(),reviews=new Map();
 for(const c of predictions.cases){
  if(!record(c)||typeof c.id!=='string'||!c.id.trim()||byId.has(c.id)||typeof c.source_version!=='string'||!c.source_version.trim()||c.source_version.length>200||!record(c.observation)||!['observed','undetermined'].includes(c.observation.kind)||!MODES.has(c.observation.mode))throw Error('Invalid or duplicate prediction.');
  byId.set(c.id,c);
 }
 for(const l of labels.cases){
  if(!record(l)||!byId.has(l.id)||reviews.has(l.id)||!['observed','undetermined','uncertain'].includes(l.kind)||!MODES.has(l.mode)||!['present','absent','unknown'].includes(l.opportunity)||!['yes','no','uncertain'].includes(l.appropriate_use))throw Error('Invalid or duplicate review label.');
  if(l.source_version!==byId.get(l.id).source_version)throw Error('Review labels do not match the source version.');
  reviews.set(l.id,l);
 }
 let tp=0,fp=0,fn=0,known=0,correct=0,opportunities=0,appropriate=0,unknownOpportunity=0,unreviewed=0,modeKnown=0,modeCorrect=0;
 for(const [id,c] of byId){
  const l=reviews.get(id);if(!l){unreviewed++;continue;}
  if(l.kind!=='uncertain'){
   known++;if(c.observation.kind===l.kind)correct++;
   if(c.observation.kind==='observed')l.kind==='observed'?tp++:fp++;
   else if(l.kind==='observed')fn++;
  }
  if(l.mode!=='undetermined'){modeKnown++;if(c.observation.mode===l.mode)modeCorrect++;}
  if(l.opportunity==='unknown')unknownOpportunity++;
  if(l.opportunity==='present'&&l.appropriate_use!=='uncertain'){opportunities++;if(l.appropriate_use==='yes')appropriate++;}
 }
 const live=predictions.origin==='real_conversation'&&labels.origin==='human_review'&&labels.independent_review_attested===true&&typeof labels.reviewer_code==='string'&&labels.reviewer_code.trim().length>0&&reviews.size>0;
 return {prediction_count:byId.size,reviewed_count:reviews.size,unreviewed_count:unreviewed,
  lexical_presence_accuracy:ratio(correct,known),lexical_presence_precision:ratio(tp,tp+fp),lexical_presence_recall:ratio(tp,tp+fn),
  lexical_true_positives:tp,lexical_false_positives:fp,lexical_false_negatives:fn,
  mode_known_label_count:modeKnown,mode_match_rate:ratio(modeCorrect,modeKnown),
  opportunity_known_appropriate_denominator:opportunities,opportunity_unknown_count:unknownOpportunity,
  human_appropriate_usage_rate:live?ratio(appropriate,opportunities):null,
  human_quality_measured:live,learning_effect_measured:false,live_source_eligibility_rechecked:false,
  production_gate:'observational_only'};
}

export function observationWindows(cohorts,asOf){
 const end=Date.parse(asOf);if(!Number.isFinite(end)||!Array.isArray(cohorts))throw Error('Invalid observation window.');
 const day=86400000,result={cohort_count:cohorts.length,conversion_mature:0,conversion_immature:0,return_mature:0,return_immature:0};
 for(const c of cohorts){
  const start=Date.parse(c.ended_at);if(!Number.isFinite(start)||start>end)throw Error('Invalid cohort time.');
  // Full conversion windows:1+7+7+1 days, then72h transmission grace.
  result[end>=start+19*day?'conversion_mature':'conversion_immature']++;
  // Next-call observation:7 days, then72h transmission grace.
  result[end>=start+10*day?'return_mature':'return_immature']++;
 }
 return {...result,immature_is_failure:false};
}

export async function syntheticEvaluation(){
 const fixture=JSON.parse(await readFile(new URL('../test/fixtures/learning-enhancement-evaluation.json',import.meta.url),'utf8'));
 const predictions={schema_version:1,origin:'synthetic_fixture',cases:[]},labels={schema_version:1,origin:'synthetic_fixture',cases:[]};
 let passed=0;
 for(const c of fixture.cases){
  const events=c.events.map((e,n)=>({id:`00000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`,session_id:'00000000-0000-4000-8000-000000000099',timestamp:`2026-11-10T10:00:${String(n).padStart(2,'0')}.000Z`,...e}));
  const observation=observationalUsage(events,{expression:c.target});
  const valid=observation.kind===c.expected_kind&&observation.mode==='undetermined'&&observation.mode_evidence_ids.length===0&&observation.evidence_ids.every(id=>events.find(e=>e.id===id)?.speaker==='user');
  if(valid)passed++;
  predictions.cases.push({id:c.id,source_version:'synthetic-v1',observation});
  labels.cases.push({id:c.id,source_version:'synthetic-v1',kind:c.expected_kind,mode:'undetermined',opportunity:'unknown',appropriate_use:'uncertain'});
 }
 return {mode:'synthetic_phrase_observation',fixture_count:fixture.cases.length,passed,failed:fixture.cases.length-passed,
  ...evaluateLabels(predictions,labels),participant_count:null,actual_user_study_completed:false};
}

async function main(){
 const args=process.argv.slice(2),get=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
 let result;
 if(get('--predictions')||get('--labels')){
  if(!get('--predictions')||!get('--labels'))throw Error('Both prediction and label files are required.');
  const [p,l]=await Promise.all([get('--predictions'),get('--labels')].map(async path=>JSON.parse(await readFile(path,'utf8'))));
  result={mode:'supplied_review_labels',...evaluateLabels(p,l)};
 }else result=await syntheticEvaluation();
 const serialized=JSON.stringify(result,null,2)+'\n';
 if(get('--output'))await writeFile(get('--output'),serialized,{mode:0o600});
 process.stdout.write(serialized);
 if(result.failed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Evaluation input could not be validated; source data was not printed.');process.exitCode=1;});
