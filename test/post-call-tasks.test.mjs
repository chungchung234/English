import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function setup(t){const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);for(const f of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+f,'utf8'));await db.query("insert into auth.users values($1,'owner@example.com',now())",[user]);await db.exec("insert into loop_private.approved_emails values('owner@example.com') on conflict do nothing");return db;}
async function rpc(db,name,args=[]){await db.exec('set role service_role');try{return (await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;}finally{await db.exec('reset role');}}
async function call(db,{companion='alex',partial=false,hasSpeech=true}={}){const s=(await db.query("insert into public.sessions(user_id,companion_id,status,scenario,created_at,ended_at,record_incomplete) values($1,$2,'ended','Everyday conversation',now()-interval '1 hour',now()-interval '50 minutes',$3) returning *",[user,companion,partial])).rows[0];if(hasSpeech)await speech(db,s.id);return s;}
async function speech(db,id,text='I will have an interview tomorrow.'){return (await db.query("insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,'user',$4,now()-interval '55 minutes') returning *",[user,id,randomUUID(),text])).rows[0];}
async function claim(db,kind='session'){await db.query("update public.post_call_tasks set available_at=case when kind=$1 then now()-interval '1 second' else now()+interval '1 hour' end",[kind]);return rpc(db,'claim_post_call_task');}
const report=(db,task,outcome,error=null,seconds=30)=>rpc(db,'report_post_call_task',[task.id,task.lease_token,outcome,error,seconds]);
test('saved and delayed transcripts durably enqueue separate tasks; idempotent discovery does not multiply them',async t=>{
 const db=await setup(t),s=await call(db);assert.equal((await db.query('select count(*)::int n from public.post_call_tasks')).rows[0].n,2);
 await rpc(db,'discover_post_call_tasks');await rpc(db,'discover_post_call_tasks');assert.equal((await db.query('select count(*)::int n from public.post_call_tasks')).rows[0].n,2);
 const first=await claim(db);assert.equal(first.kind,'session');assert.equal(await rpc(db,'claim_post_call_task'),null,'a running lease is not returned again');
 await speech(db,s.id,'The interview was postponed.');assert.equal((await report(db,first,'retryable','INVALID_MODEL_OUTPUT')).status,'superseded');
 const next=await claim(db);assert.notEqual(next.source_version,first.source_version);assert.notEqual(next.lease_token,first.lease_token);
});
test('retries persist across workers, honor backoff and stop after three failures while continuations and budgets do not consume failures',async t=>{
 const db=await setup(t);await call(db);let task=await claim(db);
 for(const outcome of ['continue','busy','budget']){const r=await report(db,task,outcome);assert.equal(r.failures,0);task=await claim(db);}
 for(let i=1;i<=3;i++){const r=await report(db,task,'retryable','INVALID_MODEL_OUTPUT');assert.equal(r.failures,i);assert.equal(r.status,i===3?'exhausted':'retry_wait');if(i<3){assert.equal(await rpc(db,'claim_post_call_task'),null,'the deadline prevents immediate retry');task=await claim(db);}}
 assert.equal(await claim(db),null,'another process cannot reset exhaustion');
});
test('valid cached feedback completes queue work without reanalysis; successful worker leases stay out of public content',async t=>{
 const db=await setup(t),s=await call(db),task=await claim(db);const events=(await db.query('select id from public.transcript_events where session_id=$1',[s.id])).rows.map(e=>e.id);
 const run=await rpc(db,'reserve_run',[user,'session','queue-review',s.id,180]);
 const content={summary:'Interview preparation.',strengths:[],corrections:[],practice:[],next_scenario:'Everyday conversation',background_guard:{task_id:task.id,lease_token:task.lease_token,source_version:task.source_version}};
 const saved=await rpc(db,'complete_analysis_run',[run.job_id,run.lease_token,JSON.stringify(content),'fixture',events]);assert(!saved.analysis.content.background_guard);
 assert.equal((await report(db,task,'ready')).status,'ready');await rpc(db,'discover_post_call_tasks');assert.equal(await claim(db),null);
});
test('a changed source or replaced lease cannot publish an old feedback result or falsely report completion',async t=>{
 const db=await setup(t),s=await call(db),task=await claim(db),event=(await db.query('select id from public.transcript_events where session_id=$1',[s.id])).rows[0];
 await assert.rejects(report(db,task,'ready'),/not committed/);
 const run=await rpc(db,'reserve_run',[user,'session','stale-review',s.id,180]);await speech(db,s.id,'Actually, I have already finished it.');
 await assert.rejects(rpc(db,'complete_analysis_run',[run.job_id,run.lease_token,JSON.stringify({summary:'Stale',background_guard:{task_id:task.id,lease_token:task.lease_token,source_version:task.source_version}}),'fixture',[event.id]]),/source changed/i);
 assert.equal((await db.query('select count(*)::int n from public.analyses')).rows[0].n,0);
});
test('partial, held, excluded and revoked sources cannot be claimed; ordinary users cannot read or invoke the queue',async t=>{
 const db=await setup(t);await call(db,{partial:true});await call(db,{hasSpeech:false});assert.equal((await db.query('select count(*)::int n from public.post_call_tasks')).rows[0].n,0);
 const s=await call(db);await rpc(db,'memory_manage',[user,'alex','excludeSession',null,null,s.id]);assert.equal(await claim(db),null);
 await db.exec('set role authenticated');try{await assert.rejects(db.query('select public.claim_post_call_task()'),/permission denied/);await assert.rejects(db.query('select * from public.post_call_tasks'),/permission denied/);}finally{await db.exec('reset role');}
 await call(db,{companion:'mia'});await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");assert.equal(await claim(db),null);
});
test('expired workers can be replaced, while in-progress calls defer automatic work',async t=>{
 const db=await setup(t);await call(db);const old=await claim(db);await db.query("update public.post_call_tasks set lease_expires_at=now()-interval '1 second' where id=$1",[old.id]);const next=await rpc(db,'claim_post_call_task');assert.equal(next.id,old.id);assert.notEqual(next.lease_token,old.lease_token);assert.equal((await report(db,old,'blocked','ANALYSIS_CONFIGURATION')).status,'superseded');
 await report(db,next,'continue');const active=(await db.query("insert into public.sessions(user_id,scenario) values($1,'Live call') returning id",[user])).rows[0];assert.equal(await claim(db),null);
 await db.query("update public.sessions set status='ended',ended_at=now() where id=$1",[active.id]);assert((await claim(db)).id);
});
test('manual requests cannot bypass the same-input cooldown or exhaustion, while a changed policy can recover',async t=>{
 const db=await setup(t),s=await call(db);let task=await claim(db);
 for(let n=0;n<3;n++){
  const run=await rpc(db,'reserve_run',[user,'session','same-policy',s.id,180]);assert(run.reserved);
  await rpc(db,'fail_run',[run.job_id,run.lease_token,'INVALID_MODEL_OUTPUT']);await report(db,task,'retryable','INVALID_MODEL_OUTPUT');
  assert.equal((await rpc(db,'reserve_run',[user,'session','same-policy',s.id,180])).reason,n===2?'retry_exhausted':'retry_wait');
  if(n<2)task=await claim(db);
 }
 assert((await rpc(db,'reserve_run',[user,'session','new-policy',s.id,180])).reserved);
});
