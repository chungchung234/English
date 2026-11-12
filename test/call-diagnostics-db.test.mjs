import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('call diagnostics isolate accounts, accept exact retries, reject content, and enforce the per-call cap',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
  create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 const directory=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
 await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'other@example.com',now())",[A,B]);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com')");
 const asUser=async(id,fn)=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);try{return await fn();}finally{await db.exec('reset role');}};
 const session=async owner=>(await asUser(owner,()=>db.query("insert into public.sessions(scenario,companion_id) values('Diagnostic fixture','alex') returning id"))).rows[0].id;
 const own=await session(A),other=await session(B),second=await session(A);
 const event=(sessionId=own,changes={})=>({event_id:randomUUID(),session_id:sessionId,occurred_at:new Date().toISOString(),client_build:'git:abcdef1234567',kind:'provider_error',code:'conversation_item_not_found',request_type:'conversation.item.delete',elapsed_ms:610000,connection_state:'connected',data_state:'open',phase:'connected',...changes});
 const record=async(rows,owner=A)=>(await asUser(owner,()=>db.query('select public.record_call_diagnostics($1::jsonb) result',[JSON.stringify(rows)]))).rows[0].result;
 const first=event();

 await t.test('strict ownership and immutable idempotent receipts',async()=>{
  assert.deepEqual(await record([first]),{event_ids:[first.event_id],dropped_event_ids:[]});
  assert.deepEqual(await record([first,first]),{event_ids:[first.event_id],dropped_event_ids:[]});
  const rows=(await asUser(A,()=>db.query('select * from public.call_diagnostics'))).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].user_id,A);assert.equal(rows[0].session_id,own);
  assert.equal(rows[0].clock_skewed,false);assert(Number.isFinite(new Date(rows[0].received_at).getTime()));
  assert.deepEqual((await asUser(B,()=>db.query('select event_id from public.call_diagnostics'))).rows,[]);
  await assert.rejects(record([first],B),/Session not found/);
  await assert.rejects(record([event(other)]),/Session not found/);
  await assert.rejects(record([{...first,session_id:second}]),/ID reused/);
  await assert.rejects(record([{...first,code:'different_code'}]),/ID reused/);
  await assert.rejects(asUser(A,()=>db.query('delete from public.call_diagnostics where event_id=$1',[first.event_id])),/permission denied/);
  await assert.rejects(asUser(A,()=>db.query("update public.call_diagnostics set code='changed' where event_id=$1",[first.event_id])),/permission denied/);
  await assert.rejects(asUser(A,()=>db.query('insert into public.call_diagnostics select * from public.call_diagnostics')),/permission denied/);
  await db.exec('set role anon');
  try{await assert.rejects(db.query('select public.record_call_diagnostics($1::jsonb)',[JSON.stringify([first])]),/permission denied/);}finally{await db.exec('reset role');}
  await assert.rejects(record([first],''),/Authentication required/);
  await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(record([first]),/Account not approved/);
  assert.deepEqual((await asUser(A,()=>db.query('select event_id from public.call_diagnostics'))).rows,[]);
  await db.exec("insert into loop_private.approved_emails values('owner@example.com')");
 });

 await t.test('only fixed diagnostic fields cross the database boundary',async()=>{
  for(const key of ['message','transcript','token','request','user_id'])await assert.rejects(record([event(own,{[key]:'must never be stored'})]),/unsupported/);
  for(const changes of [
   {client_build:'owner@example.com'},{kind:'speech'},{code:'contains speech or secrets'},{code:'x'.repeat(81)},
   {request_type:'fetch_all_transcripts'},{connection_state:'healthy'},{data_state:'unknown'},{phase:'recording'},
   {elapsed_ms:-1},{elapsed_ms:7200001},{elapsed_ms:1.5},{elapsed_ms:'1'},{kind:null},{event_id:'not-a-uuid'},
   {session_id:'not-a-uuid'},{occurred_at:'infinity'},{occurred_at:'2026-99-99T00:00:00Z'},
  ])await assert.rejects(record([event(own,changes)]));
  const missing=event();delete missing.code;await assert.rejects(record([missing]),/missing fields/);
  await assert.rejects(record(null),/Invalid diagnostic batch/);
  await assert.rejects(record({events:[]}),/Invalid diagnostic batch/);
  await assert.rejects(record(Array.from({length:21},()=>event())),/Invalid diagnostic batch/);
  await assert.rejects(record([event(own,{code:'x'.repeat(32769)})]),/Invalid diagnostic batch/);
  const good=event();await assert.rejects(record([good,event(own,{message:'private'})]),/unsupported/);
  assert.deepEqual((await db.query('select event_id from public.call_diagnostics where event_id=$1',[good.event_id])).rows,[],'a rejected batch cannot write a valid prefix');
 });

 await t.test('ended calls accept delayed receipts, with clock skew explicitly marked',async()=>{
  await db.query("update public.sessions set status='ended',ended_at=now() where id=$1",[own]);
  const late=event(own,{occurred_at:new Date(Date.now()-91*86400000).toISOString(),phase:'ended'});
  const future=event(own,{occurred_at:new Date(Date.now()+10*60000).toISOString(),phase:'ended'});
  assert.deepEqual((await record([late,future])).event_ids,[late.event_id,future.event_id]);
  assert.equal((await db.query('select count(*)::integer n from public.call_diagnostics where clock_skewed')).rows[0].n,2);
  assert.deepEqual((await record([late])).event_ids,[late.event_id]);
 });

 await t.test('audio settings and interruption provenance are strict, private, and part of immutable receipt identity',async()=>{
  const context={requested_mode:'speakerphone',expected_noise:'far_field',effective_noise:'far_field',capture_echo:'on',capture_noise:'on',capture_gain:'unreported',vad_type:'semantic_vad',interrupt_response:'on',output_state:'playing',cancel_origin:'provider_turn_detected',response_key:randomUUID()};
  const configuration=event(own,{kind:'audio_configuration',code:'AUDIO_CONFIGURATION',audio_context:context});
  const interruption=event(own,{kind:'audio_interruption',code:'TURN_DETECTED',audio_context:context});
  assert.deepEqual(await record([configuration,interruption]),{event_ids:[configuration.event_id,interruption.event_id],dropped_event_ids:[]});
  assert.deepEqual((await record([{...configuration,audio_context:Object.fromEntries(Object.entries(context).reverse())}])).event_ids,[configuration.event_id]);
  const stored=(await asUser(A,()=>db.query('select audio_context from public.call_diagnostics where event_id=$1',[interruption.event_id]))).rows[0].audio_context;
  assert.deepEqual(stored,context);
  assert.deepEqual((await asUser(B,()=>db.query('select event_id from public.call_diagnostics where event_id=$1',[interruption.event_id]))).rows,[]);
  await assert.rejects(record([{...interruption,audio_context:{...context,effective_noise:'near_field'}}]),/ID reused/);
  await assert.rejects(record([{...interruption,audio_context:{...context,response_key:randomUUID()}}]),/ID reused/);
  const missing={...interruption};delete missing.audio_context;await assert.rejects(record([missing]),/requires context/);
  await assert.rejects(record([{...first,audio_context:context}]),/ID reused/,'an old receipt cannot acquire new audio metadata on retry');
  assert.equal((await db.query('select audio_context from public.call_diagnostics where event_id=$1',[first.event_id])).rows[0].audio_context,null);
  assert.deepEqual((await record([event(own,{audio_context:{requested_mode:'unknown'}})])).dropped_event_ids,[],'old diagnostic kinds can optionally carry safe settings');
  for(const audio_context of [null,{},[],true,'private message',{deviceId:'private device'},
   {...context,message:'private speech'},{...context,transcript:'private speech'},{...context,sdp:'private negotiation'},
   {...context,response_id:'resp_provider_id'},{...context,raw_event:{token:'private credential'}},
  ])await assert.rejects(record([event(own,{kind:'audio_interruption',audio_context})]),/audio context/);
  for(const key of Object.keys(context)){
   for(const value of ['not_an_enum',true,1,null,[],{}])await assert.rejects(record([event(own,{kind:'audio_configuration',audio_context:{...context,[key]:value}})]),/audio context/);
  }
  const allowed={requested_mode:['speakerphone','headset','unknown'],expected_noise:['far_field','near_field','provider_default','unreported'],effective_noise:['far_field','near_field','off','unreported'],capture_echo:['on','off','unreported'],capture_noise:['on','off','unreported'],capture_gain:['on','off','unreported'],vad_type:['semantic_vad','server_vad','off','unreported'],interrupt_response:['on','off','unreported'],output_state:['playing','generating','idle','unknown'],cancel_origin:['provider_turn_detected','client_hold','client_end','client_other','unattributed']};
  for(const [key,values] of Object.entries(allowed))for(const value of values){
   const item=event(own,{kind:'audio_configuration',audio_context:{[key]:value}});
   assert.deepEqual((await record([item])).event_ids,[item.event_id]);
  }
  const good=event(own,{kind:'audio_configuration',audio_context:context});
  await assert.rejects(record([good,event(own,{kind:'audio_interruption',audio_context:{...context,deviceId:'private'}})]),/audio context/);
  assert.deepEqual((await db.query('select event_id from public.call_diagnostics where event_id=$1',[good.event_id])).rows,[],'unsafe context rejects the whole batch');
  await assert.rejects(db.query(`insert into public.call_diagnostics(event_id,user_id,session_id,occurred_at,client_build,kind,code,request_type,elapsed_ms,connection_state,data_state,phase,audio_context)
   select $1,user_id,session_id,occurred_at,client_build,kind,code,request_type,elapsed_ms,connection_state,data_state,phase,$2::jsonb from public.call_diagnostics where event_id=$3`,[randomUUID(),JSON.stringify({deviceId:'private'}),first.event_id]),/check constraint/,'the table itself also rejects unsafe context');
 });

 await t.test('200 receipts per call, explicit capped acknowledgements, and no starvation of later calls',async()=>{
  const capped=await session(A),events=Array.from({length:200},()=>event(capped));
  for(let i=0;i<events.length;i+=20)assert.equal((await record(events.slice(i,i+20))).event_ids.length,20);
  const overflow=event(capped),fresh=event(second);
  assert.deepEqual(await record([events[0],overflow,fresh]),{event_ids:[events[0].event_id,fresh.event_id],dropped_event_ids:[overflow.event_id]});
  assert.deepEqual(await record([overflow,overflow]),{event_ids:[],dropped_event_ids:[overflow.event_id]});
  assert.equal((await db.query('select count(*)::integer n from public.call_diagnostics where session_id=$1',[capped])).rows[0].n,200);
  assert.equal((await db.query('select count(*)::integer n from public.call_diagnostics where session_id=$1',[second])).rows[0].n,1);
  assert.deepEqual(await record([]),{event_ids:[],dropped_event_ids:[]});
 });
});
