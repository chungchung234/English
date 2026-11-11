import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisSchema, validateAnalysis } from './core.ts';
const events=[{id:'user',speaker:'user',text:'I made a mistake. How do I say 나도 할래?',session_id:'s',timestamp:'2026-11-10T11:30:00Z'},{id:'ai',speaker:'assistant',text:"I'm down.",session_id:'s',timestamp:'2026-11-10T11:30:02Z'}];
const learning=()=>({focus:'lexical',form:'colloquial',source_quote:'How do I say 나도 할래?',source_is_question:true,usage:'친구의 제안에 동의할 때 써요.',register:'informal',example:{prompt:'Want to grab coffee?',response:"I'm down."},alternative:"Sure, I'd love to."});
const review=()=>({summary:'약속을 이야기했어요.',strengths:[],corrections:[],practice:[{expression:"I'm down.",meaning:'좋아, 나도 할래.',reason:'참여 의사를 표현해요.',evidence_ids:['user'],learning:learning()}],next_scenario:'다음 약속을 이야기해 보세요.'});
test('review learning keeps exact requested source and authored examples separate; legacy and checkpoint schemas remain readable',()=>{
 const r=review();assert.equal(validateAnalysis(r,events,'session'),r);
 delete r.practice[0].learning;assert.doesNotThrow(()=>validateAnalysis(r,events,'session'));
 assert(analysisSchema('session').properties.practice.items.properties.learning);
 assert(!analysisSchema('session',false).properties.practice.items.properties.learning);
 assert(!analysisSchema('session',false).properties.strengths.items.properties.expression);
});
test('review learning rejects unknown types, invented questions, assistant-source attribution and unbounded or incomplete examples',()=>{
 for(const change of [l=>l.focus='level-b2',l=>l.form='trending',l=>l.source_quote="I'm down.",l=>l.source_quote='',l=>l.usage='a'.repeat(501),l=>l.example.response='',l=>l.register='american',l=>l.extra='unsafe']){
  const r=review();change(r.practice[0].learning);assert.throws(()=>validateAnalysis(r,events,'session'),/supported analysis/);
 }
 const r=review();r.practice[0].evidence_ids=['ai'];assert.throws(()=>validateAnalysis(r,events,'session'),/supported analysis/);
});
test('well-used expressions must be actual unchanged learner quotations, not AI improvements',()=>{
 const r=review();r.strengths=[{text:'실수를 인정했어요.',expression:'I made a mistake.',meaning:'실수했어요.',evidence_ids:['user']}];
 assert.doesNotThrow(()=>validateAnalysis(r,events,'session'));
 for(const expression of ['I have made a mistake.',"I'm down.",'  ']){r.strengths[0].expression=expression;assert.throws(()=>validateAnalysis(r,events,'session'),/supported analysis/);}
 r.strengths[0].expression='I made a mistake.';r.strengths[0].learning=learning();assert.throws(()=>validateAnalysis(r,events,'session'),/supported analysis/);
 delete r.strengths[0].learning;
 r.strengths[0].expression='';r.strengths[0].meaning='';assert.doesNotThrow(()=>validateAnalysis(r,events,'session'));
});
