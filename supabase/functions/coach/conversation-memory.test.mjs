import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHandoff,handoffFailure,HANDOFF_INSTRUCTIONS} from './conversation-memory.ts';
import {boundVoiceContext,callClock} from './temporal-context.ts';
import {handler} from './index.ts';
const uid='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222',eid='33333333-3333-4333-8333-333333333333',aid='44444444-4444-4444-8444-444444444444';
const event={id:eid,session_id:sid,speaker:'user',text:'I have an English interview tomorrow. I would like to practice asking for clarification.',timestamp:'2026-11-01T00:01:00Z'};
const handoff=()=>({threads:[{note:'An English interview is planned; its outcome is unknown.',state:'planned',when:'tomorrow',follow_up:'Ask about the interview when relevant.',evidence_ids:[eid],quote:'I have an English interview tomorrow.'}]});
const session={id:sid,companion_id:'mia',created_at:'2026-11-01T00:00:00Z',ended_at:'2026-11-01T00:10:00Z',time_zone:'Asia/Seoul'};
const bundle=()=>({...session,session_id:sid,session_created_at:session.created_at,session_ended_at:session.ended_at,session_time_zone:session.time_zone,mode:'handoff',analysis_status:'failed',threads:handoff().threads.map(({quote,...thread})=>thread),turns:[{...event,text:handoff().threads[0].quote}]});
const json=(data,total=Array.isArray(data)?data.length:null)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json',...(total===null?{}:{'Content-Range':`0-0/${total}`})}});
const config={ACCESS_MODE:'invite',ALLOWED_EMAILS:'owner@example.com',ALLOWED_ORIGINS:'https://example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',OPENAI_API_KEY:'fixture-openai'};
const req=()=>new Request('https://project.supabase.co/functions/v1/coach/memory-prepare',{method:'POST',headers:{Origin:'https://example.com',Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({companionId:'mia'})});

test('conversation threads require exact learner evidence and source time phrases independently of feedback fields',()=>{
 assert.deepEqual(validateHandoff(handoff(),[event]),handoff());assert.deepEqual(validateHandoff({threads:[]},[event]),{threads:[]});
 for(const change of [{quote:'I passed the interview.'},{evidence_ids:[aid]},{when:'2026-11-02'},{state:'mastered'},{note:'x'.repeat(181)}]){
  const input=handoff();Object.assign(input.threads[0],change);assert.throws(()=>validateHandoff(input,[event,{...event,id:aid,speaker:'assistant'}]),/verified/);
 }
 assert.match(HANDOFF_INSTRUCTIONS,/WHOLE call/);assert.equal(handoffFailure('INVALID_MEMORY_OUTPUT'),'retryable');assert.equal(handoffFailure('COST_BUDGET_EXCEEDED'),'budget');assert.equal(handoffFailure('MEMORY_PROVIDER_CONFIGURATION'),'blocked');
});

test('bounded voice context preserves plan state and selected originals while removing duplicate feedback and handoffs',()=>{
 const input={memory:{facts:[],memories:[{session_id:sid,session_created_at:session.created_at,evidence:[event],summary:'Duplicated feedback summary.'}],suppress_memory:false,recent_conversation:bundle(),conversation_memories:[bundle(),bundle()]}};
 const result=boundVoiceContext(input,callClock(session,new Date('2026-11-03T00:00:00Z')));
 assert.equal(result.context.memory.memories.length,0);assert.equal(result.context.memory.conversation_memories.length,0);assert.equal(result.receipt.recent_mode,'handoff');assert.equal(result.context.memory.recent_conversation.threads[0].state,'planned');
 assert.equal(result.context.memory.recent_conversation.summary,null);assert(!JSON.stringify(result.context).includes('Duplicated feedback'));
 assert.equal(result.context.continuity.evidence_ids[0],eid);
 const omitted=boundVoiceContext({memory:{...input.memory,suppress_memory:true}},callClock(session));assert.equal(omitted.context.memory.recent_conversation,null);assert.equal(omitted.context.memory.conversation_memories.length,0);
});

async function withProvider(t,{http=200,output=handoff(),budget=true,changed=false,cached=false,busy=false,retryAfter='90'}={},fn){
 const previousFetch=globalThis.fetch,previousDeno=globalThis.Deno;t.after(()=>{globalThis.fetch=previousFetch;globalThis.Deno=previousDeno;});globalThis.Deno={env:{get:name=>config[name]}};
 const seen={provider:0,source:0,requests:[]};
 globalThis.fetch=async(url,options)=>{
  const path=String(url),body=options?.body?JSON.parse(options.body):null;seen.requests.push(path);
  if(path.includes('/auth/'))return json({id:uid,email:'owner@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'});
  if(path.includes('/conversation_memory_source')){seen.source++;return json({status:cached?'ready':'pending',session,revision:0,source_version:changed&&seen.source>1?'changed':'digest',request_key:'handoff-fixture'});}
  if(path.includes('/reserve_run')){assert.equal(body.p_kind,'handoff');return json({reserved:!busy,reason:busy?'in_progress':'reserved',job_id:sid,lease_token:eid,attempts:1});}
  if(path.includes('/transcript_events?'))return json([event,{...event,id:aid,speaker:'assistant',text:'Thanks for talking. Goodbye.'}]);
  if(path.includes('/reserve_model_spend'))return json(budget);
  if(path.includes('/record_model_spend')){seen.accounting=body;return json(null);}
  if(path.includes('/responses')){seen.provider++;seen.sent=body;return new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]}),{status:http,headers:{'Content-Type':'application/json','retry-after':retryAfter}});}
  if(path.includes('/complete_conversation_memory')){seen.commit=body;return json({status:'ready',session_id:sid,thread_count:1});}
  if(path.includes('/fail_conversation_memory')){seen.failure=body;return json({status:body.p_class==='blocked'||body.p_class==='source_changed'?'blocked':'retry_wait',session_id:sid,retry_at:'2026-11-12T00:00:00Z'});}
  throw Error('Unexpected request '+path);
 };
 await fn(seen);
}

test('memory generation uses the whole source call, saves independently, and returns no private text',async t=>withProvider(t,{},async seen=>{
 const result=await handler(req());assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:'ready',session_id:sid,thread_count:1});
 assert.equal(seen.provider,1);assert.equal(seen.sent.model,'gpt-6-luna');assert.equal(seen.sent.max_output_tokens,1800);assert.equal(seen.sent.text.format.name,'conversation_handoff');
 assert.equal(JSON.parse(seen.sent.input[1].content[0].text).transcript_events[0].id,eid);assert.deepEqual(seen.commit.p_content,handoff());assert(seen.accounting.p_usage);
 assert(!seen.requests.some(path=>path.includes('complete_analysis_run')));
}));

test('429 honors server delay while configuration failures and invalid evidence get different recovery classes',async t=>{
 await t.test('rate limit',async t=>withProvider(t,{http:429},async seen=>{assert.equal((await handler(req())).status,200);assert.equal(seen.failure.p_class,'retryable');assert.equal(seen.failure.p_retry_seconds,90);assert.equal(seen.provider,1);assert(!seen.commit);}));
 await t.test('provider auth',async t=>withProvider(t,{http:401},async seen=>{await handler(req());assert.equal(seen.failure.p_class,'blocked');assert.equal(seen.failure.p_error,'MEMORY_PROVIDER_CONFIGURATION');}));
 await t.test('unsupported quote',async t=>{const output=handoff();output.threads[0].quote='Made up quote.';await withProvider(t,{output},async seen=>{await handler(req());assert.equal(seen.failure.p_error,'INVALID_MEMORY_OUTPUT');assert.equal(seen.failure.p_class,'retryable');assert(!seen.commit);});});
});

test('budget, cached results, active leases and changed sources never trigger duplicate or stale commits',async t=>{
 await t.test('budget',async t=>withProvider(t,{budget:false},async seen=>{await handler(req());assert.equal(seen.provider,0);assert.equal(seen.failure.p_class,'budget');}));
 await t.test('cached',async t=>withProvider(t,{cached:true},async seen=>{await handler(req());assert.equal(seen.provider,0);assert(!seen.commit);assert(!seen.requests.some(path=>path.includes('reserve_run')));}));
 await t.test('active lease',async t=>withProvider(t,{busy:true},async seen=>{const result=await handler(req());assert.equal((await result.json()).status,'retry_wait');assert.equal(seen.provider,0);}));
 await t.test('source changed',async t=>withProvider(t,{changed:true},async seen=>{await handler(req());assert.equal(seen.failure.p_class,'source_changed');assert(!seen.commit);}));
});
