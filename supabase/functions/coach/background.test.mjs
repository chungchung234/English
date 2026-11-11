import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from './core.ts';
import {requireBackground,authorizeBackground,recoveryOutcome,drainPostCall} from './background.ts';
import {handler} from './index.ts';
const uid='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222',token='33333333-3333-4333-8333-333333333333';
const task={id:sid,user_id:uid,session_id:sid,companion_id:'alex',kind:'session',source_version:'digest',revision:0,lease_token:token};
test('background route requires the existing server credential and rejects browser origins and ordinary user tokens',()=>{
 const request=(key,origin)=>new Request('https://example.com/background-work',{headers:{Authorization:'Bearer '+key,...(origin?{Origin:origin}:{})}});
 assert.doesNotThrow(()=>requireBackground(request('server'),'server'));
 assert.throws(()=>requireBackground(request('user'),'server'),e=>e.status===401);
 assert.throws(()=>requireBackground(request('server','https://example.com'),'server'),e=>e.status===403);
});
test('a service-role claim is not authorization; alternate issued keys require provider proof',async()=>{
 const token=role=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
 const request=role=>new Request('https://example.com/background-work',{headers:{Authorization:'Bearer '+token(role)}});
 await assert.rejects(authorizeBackground(request('service_role'),'different-key',async()=>false),e=>e.status===401);
 await authorizeBackground(request('service_role'),'different-key',async header=>{assert.equal(header,'Bearer '+token('service_role'));return true;});
 await assert.rejects(authorizeBackground(request('authenticated'),'different-key',async()=>assert.fail('A learner token cannot request server proof')),e=>e.status===401);
});
test('failure policy keeps continuation, busy leases, budgets, invalid evidence and provider configuration distinct',()=>{
 for(const [code,outcome] of [['ANALYSIS_CONTINUE','continue'],['JOB_IN_PROGRESS','busy'],['COST_BUDGET_EXCEEDED','budget'],['INVALID_MODEL_OUTPUT','retryable'],['ANALYSIS_CONFIGURATION','blocked'],['NO_TRANSCRIPT','cancelled']])assert.equal(recoveryOutcome(new AppError(503,code,'not logged')).outcome,outcome);
 assert.equal(recoveryOutcome(new AppError(429,'ANALYSIS_RATE_LIMITED','private',{retry_seconds:90})).seconds,90);
});
test('one invocation processes only its server-claimed task and reports no learner data',async()=>{
 const calls=[];const result=await drainPostCall({rpc:async(name,body)=>{calls.push([name,body]);if(name==='claim_post_call_task')return task;if(name==='report_post_call_task')return {status:'ready',kind:'session'};return 1;},memory:()=>{throw Error('Wrong kind');},review:async t=>{assert.equal(t.user_id,uid);return {analysis:{content:{summary:'private learner content'}}};}});
 assert.deepEqual(result,{status:'ready',kind:'session'});assert.equal(calls.filter(c=>c[0]==='claim_post_call_task').length,1);assert(!JSON.stringify(result).includes('private'));
 const none=await drainPostCall({rpc:async name=>name==='claim_post_call_task'?null:0,memory:()=>assert.fail(),review:()=>assert.fail()});assert.deepEqual(none,{status:'idle'});
});
test('partial analysis resumes without being counted as a failed generation; memory uses its existing retry deadline',async()=>{
 let report;const rpc=async(name,body)=>{if(name==='claim_post_call_task')return task;if(name==='report_post_call_task'){report=body;return {status:'retry_wait'};}return 0;};
 await drainPostCall({rpc,memory:()=>assert.fail(),review:async()=>{throw new AppError(409,'ANALYSIS_CONTINUE','parts saved');}});assert.equal(report.p_outcome,'continue');
 await drainPostCall({rpc:async(name,body)=>name==='claim_post_call_task'?{...task,kind:'handoff'}:rpc(name,body),memory:async()=>({status:'retry_wait',retry_at:new Date(Date.now()+90_000).toISOString()}),review:()=>assert.fail()});assert.equal(report.p_outcome,'busy');assert(report.p_retry_seconds>=89);
});
test('unapproved or absent worker credentials cannot read the queue or call AI through the real handler',async()=>{
 const previousDeno=globalThis.Deno,previousFetch=globalThis.fetch;
 const config={ACCESS_MODE:'invite',ALLOWED_EMAILS:'owner@example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server',OPENAI_API_KEY:'fixture',ALLOWED_ORIGINS:'https://example.com'};
 globalThis.Deno={env:{get:key=>config[key]}};globalThis.fetch=()=>assert.fail('Authentication must finish before database access');
 try{for(const value of ['','Bearer user']){const result=await handler(new Request('https://project.supabase.co/functions/v1/coach/background-work',{method:'POST',headers:{Authorization:value,'Content-Type':'application/json'},body:'{}'}));assert.equal(result.status,401);}}
 finally{globalThis.Deno=previousDeno;globalThis.fetch=previousFetch;}
});
test('the handler verifies a different issued server token with the project provider before accessing queue state',async()=>{
 const previousDeno=globalThis.Deno,previousFetch=globalThis.fetch;
 const config={ACCESS_MODE:'invite',ALLOWED_EMAILS:'owner@example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'runtime-server-key',OPENAI_API_KEY:'fixture',ALLOWED_ORIGINS:'https://example.com'};
 const token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.signature';let proof=false;
 globalThis.Deno={env:{get:key=>config[key]}};
 globalThis.fetch=async(url,options)=>{const path=new URL(String(url)).pathname;if(path.endsWith('/background_worker_authorized')){assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.headers.apikey,token);proof=true;return new Response('true');}assert(proof,'queue access must follow provider proof');if(path.endsWith('/discover_post_call_tasks'))return new Response('0');if(path.endsWith('/claim_post_call_task'))return new Response('null');assert.fail('Unexpected provider request');};
 try{const result=await handler(new Request('https://project.supabase.co/functions/v1/coach/background-work',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'}));assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:'idle'});}
 finally{globalThis.Deno=previousDeno;globalThis.fetch=previousFetch;}
});
