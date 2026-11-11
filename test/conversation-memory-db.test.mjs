import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',policy='a'.repeat(16);
async function setup(t){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 await db.query("insert into auth.users values($1,'owner@example.com',now()),($2,'other@example.com',now())",[owner,other]);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com') on conflict do nothing");return db;
}
async function role(db,name,fn){await db.exec('set role '+name);try{return await fn();}finally{await db.exec('reset role');}}
const rpc=(db,name,args)=>role(db,'service_role',async()=>(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result);
async function call(db,companion='alex',user=owner,created='2026-11-01T00:00:00Z'){
 const s=(await db.query("insert into public.sessions(user_id,companion_id,scenario,status,created_at,ended_at,time_zone) values($1,$2,'Everyday conversation','ended',$3,$3::timestamptz+interval '10 minutes','Asia/Seoul') returning *",[user,companion,created])).rows[0];
 const e=await speech(db,s,'I have an English interview tomorrow. I want to practice asking for clarification.');return {s,e};
}
async function speech(db,s,text,speaker='user'){return (await db.query('insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,$4,$5,$6::timestamptz+interval \'1 minute\') returning *',[s.user_id,s.id,randomUUID(),speaker,text,s.created_at])).rows[0];}
const content=e=>({threads:[{note:'An English interview is planned; the outcome is not known.',state:'planned',when:'tomorrow',follow_up:'Ask about the interview when relevant.',evidence_ids:[e.id],quote:'I have an English interview tomorrow.'}]});
const source=(db,c,pol=policy)=>rpc(db,'conversation_memory_source',[c.s.user_id,c.s.companion_id,pol,c.s.id]);
const reserve=(db,src,user=owner)=>rpc(db,'reserve_run',[user,'handoff',src.request_key,src.session.id,120]);
const complete=(db,run,src,c)=>rpc(db,'complete_conversation_memory',[run.job_id,run.lease_token,src.revision,src.source_version,policy,JSON.stringify(content(c.e)),'fixture']);
const context=(db,companion='alex',user=owner,query='')=>rpc(db,'memory_context',[user,companion,query,null,'text-embedding-3-small',12]);

test('independent memory survives failed feedback for all companions and stores only selected supporting quotations',async t=>{
 const db=await setup(t);
 for(const companion of ['alex','mia','juno']){
  const c=await call(db,companion);for(let n=0;n<14;n++)await speech(db,c.s,'Thank you. See you next time.','assistant');
  await db.query("insert into public.analysis_jobs(user_id,session_id,kind,request_key,state,error) values($1,$2,'session',$3,'failed','INVALID_MODEL_OUTPUT')",[owner,c.s.id,'feedback-'+c.s.id]);
  const src=await source(db,c),run=await reserve(db,src);assert.equal((await complete(db,run,src,c)).status,'ready');
  assert.equal((await source(db,c)).status,'ready');
  const memory=(await context(db,companion)).recent_conversation;
  assert.equal(memory.mode,'handoff');assert.equal(memory.analysis_status,'failed');assert.equal(memory.threads[0].state,'planned');assert.equal(memory.turns.length,1);assert.equal(memory.turns[0].text,content(c.e).threads[0].quote);
  assert(!JSON.stringify(memory).includes('See you'));assert.equal((await context(db,companion,other)).recent_conversation,null);
 }
 assert.equal((await db.query('select count(*)::int n from public.analyses')).rows[0].n,0,'memory completion creates no fake feedback');
});

test('source versions reject delayed uploads and policy changes without overwriting committed memory',async t=>{
 const db=await setup(t),c=await call(db),src=await source(db,c),run=await reserve(db,src);
 await speech(db,c.s,'The interview has been postponed.');
 await assert.rejects(complete(db,run,src,c),/source changed/);
 const changed=await source(db,c);assert.notEqual(changed.request_key,src.request_key);
 const newer=await reserve(db,changed);await complete(db,newer,changed,c);
 assert.equal((await source(db,c)).status,'ready');assert.equal((await source(db,c,'b'.repeat(16))).status,'pending');
 assert.equal((await db.query('select count(*)::int n from public.conversation_memories')).rows[0].n,1);
});

test('exclusions, explicit forget, holds, partial calls and revoked approval remain authoritative during generation',async t=>{
 const db=await setup(t),c=await call(db),src=await source(db,c),run=await reserve(db,src);
 await rpc(db,'memory_manage',[owner,'alex','excludeSession',null,null,c.s.id]);
 assert.equal((await source(db,c)).status,'unavailable');await assert.rejects(complete(db,run,src,c),/source changed/);
 await rpc(db,'memory_manage',[owner,'alex','restoreSession',null,null,c.s.id]);
 const fresh=await source(db,c),next=await reserve(db,fresh);await complete(db,next,fresh,c);
 await rpc(db,'memory_manage',[owner,'alex','forgetFact','interest',null,null]);
 assert.equal((await context(db)).recent_conversation,null);assert.deepEqual((await context(db)).conversation_memories,[]);
 const mia=await call(db,'mia');await db.query('update public.sessions set record_incomplete=true where id=$1',[mia.s.id]);assert.equal((await source(db,mia)).status,'unavailable');
 const juno=await call(db,'juno');await db.query("insert into public.learning_source_holds(user_id,session_id,reason) values($1,$2,'wrong_transcript')",[owner,juno.s.id]);assert.equal((await source(db,juno)).status,'unavailable');
 await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");await assert.rejects(source(db,c),/approved/);
});

test('recovery persists backoff, stops after three attempts and never replays an active or completed lease',async t=>{
 const db=await setup(t),c=await call(db),src=await source(db,c);
 let first;
 for(let n=1;n<=3;n++){
  const run=await reserve(db,src);if(!first)first=run;assert.equal(run.reserved,true);assert.equal(run.attempts,n);
  assert.equal((await reserve(db,src)).reason,'in_progress');
  const failure=await rpc(db,'fail_conversation_memory',[run.job_id,run.lease_token,'INVALID_MEMORY_OUTPUT','retryable',30]);
  assert.equal(failure.status,n===3?'exhausted':'retry_wait');
  assert.equal((await reserve(db,src)).reason,n===3?'exhausted':'retry_wait');
  await db.query("update public.analysis_jobs set next_attempt_at=now()-interval '1 second' where id=$1",[run.job_id]);
 }
 await assert.rejects(complete(db,first,src,c),/lease/);
 const revision=await source(db,c,'b'.repeat(16));assert.notEqual(revision.request_key,src.request_key);assert.equal((await reserve(db,revision)).reserved,true,'a changed policy is a new source of work');
});

test('budgets defer work until UTC reset without consuming a generation attempt; provider configuration failures stop',async t=>{
 const db=await setup(t),c=await call(db),src=await source(db,c),run=await reserve(db,src);
 const failed=await rpc(db,'fail_conversation_memory',[run.job_id,run.lease_token,'COST_BUDGET_EXCEEDED','budget',30]);
 assert.equal(failed.attempts,0);assert.equal(failed.status,'retry_wait');assert.equal((await reserve(db,src)).reason,'retry_wait');
 await db.query("update public.analysis_jobs set next_attempt_at=now()-interval '1 second' where id=$1",[run.job_id]);
 const again=await reserve(db,src);assert.equal(again.attempts,1);
 const blocked=await rpc(db,'fail_conversation_memory',[again.job_id,again.lease_token,'MEMORY_PROVIDER_CONFIGURATION','blocked',30]);assert.equal(blocked.status,'blocked');assert.equal((await reserve(db,src)).reason,'blocked');
});

test('source evidence and operations are service-only; stale workers cannot publish after lease recovery',async t=>{
 const db=await setup(t),c=await call(db),foreign=await call(db,'alex',other),src=await source(db,c),old=await reserve(db,src);
 await assert.rejects(role(db,'authenticated',()=>db.query("select public.conversation_memory_source($1,'alex',$2,$3)",[owner,policy,c.s.id])),/permission denied/);
 await assert.rejects(role(db,'authenticated',()=>db.query('select * from public.conversation_memories')),/permission denied/);
 await db.query("update public.analysis_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[old.job_id]);const run=await reserve(db,src);assert.notEqual(run.lease_token,old.lease_token);
 await assert.rejects(complete(db,old,src,c),/lease/);
 await assert.rejects(complete(db,run,src,foreign),/evidence/);await complete(db,run,src,c);
 assert.equal((await reserve(db,src)).reason,'completed');assert.equal((await source(db,c)).status,'ready');
});

test('older independent memories remain retrievable without feedback, and fallback excludes conversational padding',async t=>{
 const db=await setup(t),old=await call(db),src=await source(db,old);await complete(db,await reserve(db,src),src,old);
 const latest=await call(db,'alex',owner,'2026-11-02T00:00:00Z');
 for(let n=0;n<14;n++)await speech(db,latest.s,'Goodbye!');
 const memory=await context(db,'alex',owner,'interview');assert.equal(memory.memories.length,0);assert.equal(memory.conversation_memories[0].session_id,old.s.id);
 assert.equal(memory.recent_conversation.mode,'excerpt_fallback');assert(memory.recent_conversation.turns.some(e=>e.id===latest.e.id));assert(memory.recent_conversation.turns.length<=2);
});

test('memory retries consume their own quota and share the existing account text-spend limit',async t=>{
 const db=await setup(t),c=await call(db),src=await source(db,c),a=await reserve(db,src);
 const spend=(run,amount)=>rpc(db,'reserve_model_spend',[run.job_id,run.lease_token,'gpt-6-luna','{}',amount]);
 assert.equal(await spend(a,.6),true);assert.equal(await spend(a,.6),false,'same lease cannot reserve twice');
 const part=await rpc(db,'reserve_run',[owner,'part','independent-part',c.s.id,120]);assert.equal(await spend(part,.4),true);
 const b=await rpc(db,'reserve_run',[owner,'handoff','another-memory',c.s.id,120]);assert.equal(await spend(b,.001),false,'memory cannot bypass the shared dollar reservation');
 for(let n=2;n<30;n++)assert.equal((await rpc(db,'reserve_run',[owner,'handoff','memory-'+n,c.s.id,120])).reserved,true);
 assert.equal((await rpc(db,'reserve_run',[owner,'handoff','over-limit',c.s.id,120])).reason,'budget_exceeded');
});
