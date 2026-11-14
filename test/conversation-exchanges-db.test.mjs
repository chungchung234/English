// Local PostgreSQL exercises the actual receipt, ownership and memory SQL.
// A client playback receipt is not proof that a human heard the audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at=hours=>new Date(Date.now()-hours*3600000).toISOString();
async function setup(t,beforeExchangeMigration){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 for(const name of (await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort()){
  if(name==='202611140001_conversation_exchanges.sql'&&beforeExchangeMigration)await beforeExchangeMigration(db);
  await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
 }
 await db.query("insert into auth.users values($1,'owner@example.com',now()),($2,'other@example.com',now()) on conflict(id) do nothing",[owner,other]);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com') on conflict do nothing");return db;
}
async function role(db,name,user,work){
 await db.exec('set role '+name);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);
 try{return await work();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}
}
const service=(db,name,args)=>role(db,'service_role',null,async()=>(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result);
const record=(db,c,revision=0,receipt=randomUUID(),users=[c.user.id],events=[c.assistant.id],user=c.session.user_id)=>role(db,'authenticated',user,async()=>(await db.query('select public.record_conversation_playback($1,$2,$3,$4,$5) result',[c.session.id,events,receipt,users,revision])).rows[0].result);
const context=(db,companion='alex',user=owner)=>service(db,'conversation_exchange_context',[user,companion]);
async function event(db,s,speaker,text,seconds){return(await db.query('insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,$4,$5,$6) returning *',[s.user_id,s.id,randomUUID(),speaker,text,new Date(Date.parse(s.created_at)+seconds*1000).toISOString()])).rows[0];}
async function call(db,{companion='alex',user=owner,hours=24,status='ended'}={}){
 const created=at(hours),session=(await db.query("insert into public.sessions(user_id,companion_id,scenario,status,created_at,ended_at,time_zone) values($1,$2,'Natural English conversation about everyday life',$3,$4,$5,'Asia/Seoul') returning *",[user,companion,status,created,status==='ended'?new Date(Date.parse(created)+600000).toISOString():null])).rows[0];
 const u=await event(db,session,'user','I found a small bakery on a side street.',60);
 const noise=await event(db,session,'user','Unqualified background transcription.',70);
 const a=await event(db,session,'assistant','That is a pretty good wrong turn. I would notice the window first.',90);
 return{session,user:u,noise,assistant:a};
}

test('source-backed conversation exchanges preserve speaker identity, playback admission and privacy',async t=>{
 const db=await setup(t);
 await t.test('only receipt-backed, qualified user exchanges enter the existing memory retrieval',async()=>{
  const c=await call(db),legacy=await call(db,{hours:23});
  assert.deepEqual((await context(db)).exchanges,[],'generated legacy assistant text alone is not shared playback');
  const receipt=randomUUID(),ack=await record(db,c,0,receipt);
  assert.deepEqual(ack,{session_id:c.session.id,acknowledged_ids:[c.assistant.id],discarded_ids:[],reason:null});
  assert.deepEqual(await record(db,c,0,receipt),ack);
  const value=await context(db);assert.equal(value.revision,0);assert.equal(value.exchanges.length,1);
  const exchange=value.exchanges[0];assert.equal(exchange.source_session_id,c.session.id);assert.equal(exchange.admission,'client_reported_playback_completed');
  assert.equal(exchange.caller.id,c.user.id);assert.equal(exchange.caller.speaker,'user');assert.equal(exchange.caller.quote,c.user.text);
  assert.equal(exchange.companion.id,c.assistant.id);assert.equal(exchange.companion.speaker,'assistant');assert.equal(exchange.companion.quote,c.assistant.text);
  assert(!JSON.stringify(value).includes(c.noise.text));assert(!value.exchanges.some(x=>x.source_session_id===legacy.session.id));
  const existing=await service(db,'memory_context',[owner,'alex','',null,'text-embedding-3-small',12]);
  assert.deepEqual(existing.shared_exchanges,value.exchanges);assert(Array.isArray(existing.facts));assert(Array.isArray(existing.memories));
  for(let n=0;n<3;n++){
   const u=await event(db,c.session,'user','Bye!',150+n*20),a=await event(db,c.session,'assistant','See you next time.',160+n*20);
   await record(db,{...c,user:u,assistant:a});
  }
  const selected=(await context(db)).exchanges.filter(x=>x.source_session_id===c.session.id);
  assert(selected.length<=2);assert(selected.some(x=>x.caller.id===c.user.id),'later farewells do not evict the substantive exchange');
 });
 await t.test('receipt payload and both speaker/source clocks remain immutable across retries',async()=>{
  const c=await call(db,{hours:22}),receipt=randomUUID();await record(db,c,0,receipt);
  const another=await event(db,c.session,'assistant','Another actual response.',120);
  await assert.rejects(record(db,c,0,receipt,[c.user.id],[another.id]),/PLAYBACK_RECEIPT_CHANGED/);
  await assert.rejects(record(db,c,0,randomUUID(),[c.user.id,c.noise.id]),/PLAYBACK_SOURCE_CHANGED/);
  const duplicate=randomUUID();await record(db,c,0,duplicate);
  await assert.rejects(record(db,c,0,duplicate,[c.user.id],[another.id]),/PLAYBACK_RECEIPT_CHANGED/,'even an all-duplicate accepted request has a payload anchor');
  await db.query('update public.transcript_events set text=$1 where id=$2',['Changed user source.',c.user.id]);
  assert(!(await context(db)).exchanges.some(x=>x.source_session_id===c.session.id));
  await assert.rejects(record(db,c,0,receipt),/PLAYBACK_SOURCE_CHANGED/);
  await db.query('update public.transcript_events set text=$1 where id=$2',[c.user.text,c.user.id]);
  await db.query('update public.transcript_events set text=$1 where id=$2',['Changed generated response.',c.assistant.id]);
  assert(!(await context(db)).exchanges.some(x=>x.source_session_id===c.session.id));
  await db.query('update public.transcript_events set text=$1 where id=$2',[c.assistant.text,c.assistant.id]);
  await assert.rejects(db.query("update public.sessions set time_zone='UTC' where id=$1",[c.session.id]),/Session time zone is immutable/);
 });
 await t.test('ownership, approval, role grants and source types cannot be bypassed',async()=>{
  const c=await call(db,{companion:'juno',hours:20}),alien=await call(db,{companion:'juno',user:other,hours:19});
  await assert.rejects(record(db,c,0,randomUUID(),[c.user.id],[c.assistant.id],other),/PLAYBACK_SCOPE_DENIED/);
  await assert.rejects(record(db,c,0,randomUUID(),[alien.user.id]),/PLAYBACK_SOURCE_NOT_SAVED/);
  await assert.rejects(record(db,c,0,randomUUID(),[c.user.id],[c.user.id]),/PLAYBACK_SCOPE_DENIED/);
  await assert.rejects(record(db,c,0,randomUUID(),[c.assistant.id]),/PLAYBACK_SCOPE_DENIED/);
  await assert.rejects(role(db,'authenticated',owner,()=>db.query('select public.record_conversation_playback($1,ARRAY[ARRAY[$2::uuid]],$3,ARRAY[$4::uuid],0)',[c.session.id,c.assistant.id,randomUUID(),c.user.id])),/PLAYBACK_INVALID_RECEIPT/);
  await assert.rejects(role(db,'authenticated',owner,()=>db.query('select * from public.conversation_playback_receipts')),/permission denied/);
  await assert.rejects(role(db,'authenticated',owner,()=>db.query('select * from public.conversation_playback_batches')),/permission denied/);
  await assert.rejects(role(db,'authenticated',owner,()=>db.query('select public.conversation_exchange_context($1,$2)',[owner,'juno'])),/permission denied/);
  await assert.rejects(role(db,'authenticated',owner,()=>db.query('select public.conversation_context_authorized($1,$2)',[owner,c.session.id])),/permission denied/);
  await assert.rejects(role(db,'anon',null,()=>db.query('select public.record_conversation_playback($1,$2,$3,$4,0)',[c.session.id,[c.assistant.id],randomUUID(),[c.user.id]])),/permission denied/);
  await record(db,c);await record(db,alien);
  assert((await context(db,'juno',owner)).exchanges.every(x=>x.source_session_id===c.session.id));
  assert((await context(db,'juno',other)).exchanges.every(x=>x.source_session_id===alien.session.id));
  assert.deepEqual((await context(db,'mia',owner)).exchanges,[]);
  await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(record(db,c),/Account not approved/);await assert.rejects(context(db,'juno'),/Account not approved/);await assert.rejects(service(db,'conversation_context_authorized',[owner,c.session.id]),/Account not approved/);
  await db.exec("insert into loop_private.approved_emails values('owner@example.com')");
 });
 await t.test('active/incomplete calls and excluded sources cannot become shared history',async()=>{
  const c=await call(db,{companion:'juno',hours:18,status:'active'});await record(db,c);
  assert.equal(await service(db,'conversation_context_authorized',[owner,c.session.id]),true);
  assert.equal(await service(db,'conversation_context_authorized',[other,c.session.id]),false);
  assert(!(await context(db,'juno')).exchanges.some(x=>x.source_session_id===c.session.id));
  await db.query("update public.sessions set status='ended',ended_at=$1 where id=$2",[new Date(Date.parse(c.session.created_at)+600000).toISOString(),c.session.id]);
  assert.equal(await service(db,'conversation_context_authorized',[owner,c.session.id]),false);
  assert((await context(db,'juno')).exchanges.some(x=>x.source_session_id===c.session.id),'the normal active-to-ended transition does not invalidate playback');
  await db.query('update public.sessions set record_incomplete=true where id=$1',[c.session.id]);
  assert(!(await context(db,'juno')).exchanges.some(x=>x.source_session_id===c.session.id));
  await db.query('update public.sessions set record_incomplete=false where id=$1',[c.session.id]);
  await service(db,'memory_manage',[owner,'juno','excludeSession',null,null,c.session.id]);
  assert(!(await context(db,'juno')).exchanges.some(x=>x.source_session_id===c.session.id));
  const queued=await call(db,{companion:'juno',hours:17});
  const discarded=await record(db,queued,0);
  assert.deepEqual(discarded.acknowledged_ids,[]);assert.deepEqual(discarded.discarded_ids,[queued.assistant.id]);assert.equal(discarded.reason,'stale_revision');
  assert.equal((await db.query('select count(*)::int n from public.conversation_playback_receipts where event_id=$1',[queued.assistant.id])).rows[0].n,0);
  await service(db,'memory_manage',[owner,'juno','restoreSession',null,null,c.session.id]);
  assert(!(await context(db,'juno')).exchanges.some(x=>x.source_session_id===c.session.id),'restoring a source does not re-authorize receipts from a revoked revision');
 });
 await t.test('spoken forget advances a durable boundary and never revives prior quotes after the profile changes',async()=>{
  const c=await call(db,{companion:'mia',hours:6});await record(db,c);
  assert((await context(db,'mia')).exchanges.some(x=>x.source_session_id===c.session.id));
  const forgotten=await call(db,{companion:'mia',hours:4});
  await db.query('update public.transcript_events set text=$1 where id=$2',['Please forget my location.',forgotten.user.id]);
  const analysis=(await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values($1,$2,'session',$3::jsonb,'local-fixture',$4::uuid[]) returning id",[owner,forgotten.session.id,JSON.stringify({summary:'',strengths:[],corrections:[],practice:[],memory_facts:[{key:'location',value:'',quote:'Please forget my location.',evidence_ids:[forgotten.user.id]}]}),[forgotten.user.id,forgotten.noise.id,forgotten.assistant.id]])).rows[0];
  await role(db,'authenticated',owner,()=>db.query('select public.learning_snapshot($1) result',['mia']));
  const after=await context(db,'mia');assert.equal(after.revision,1);assert.deepEqual(after.exchanges,[]);
  const fresh=await call(db,{companion:'mia',hours:2});await record(db,fresh,1);
  const next=await context(db,'mia');assert(next.exchanges.length>0);assert(next.exchanges.every(x=>x.source_session_id===fresh.session.id),'new unrelated exchanges can remain useful after the forget boundary');
  const renewed=await call(db,{companion:'mia',hours:1});
  await db.query('update public.transcript_events set text=$1 where id=$2',['I live in a new city now.',renewed.user.id]);
  await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values($1,$2,'session',$3::jsonb,'local-fixture',$4::uuid[])",[owner,renewed.session.id,JSON.stringify({summary:'',strengths:[],corrections:[],practice:[],memory_facts:[{key:'location',value:'a new city',quote:'I live in a new city now.',evidence_ids:[renewed.user.id]}]}),[renewed.user.id,renewed.noise.id,renewed.assistant.id]]);
  await role(db,'authenticated',owner,()=>db.query('select public.learning_snapshot($1) result',['mia']));
  const reappeared=await context(db,'mia');assert.equal(reappeared.revision,1);
  assert(!reappeared.exchanges.some(x=>x.source_session_id===c.session.id),'a newly stated fact must not resurrect the forgotten prior exchange');
  assert(reappeared.exchanges.some(x=>x.source_session_id===fresh.session.id),'the earlier unrelated post-forget source remains eligible');
  const state=(await db.query('select * from public.memory_state where user_id=$1 and companion_id=$2',[owner,'mia'])).rows[0];
  assert.equal(new Date(state.conversation_forget_after).toISOString(),new Date(forgotten.user.timestamp).toISOString());
  await db.query('delete from public.analyses where id=$1',[analysis.id]);
  await db.query('delete from public.sessions where id=$1',[forgotten.session.id]);
  const delayed=await call(db,{companion:'mia',hours:5});await record(db,delayed,1);
  assert(!(await context(db,'mia')).exchanges.some(x=>x.source_session_id===delayed.session.id),'deleting the original forget source cannot lower the saved boundary');
 });
});

test('durable forget backfill, source validation and backup merges preserve account scope and monotonic revisions',async t=>{
 let legacy;
 const fact=(c,value='')=>({key:'location',value,quote:c.user.text,evidence_ids:[c.user.id]});
 const insertAnalysis=async(db,c,facts,{sourceIds=[c.user.id,c.noise.id,c.assistant.id],corrections=[]}={})=> (await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values($1,$2,'session',$3::jsonb,'local-fixture',$4::uuid[]) returning *",[c.session.user_id,c.session.id,JSON.stringify({summary:'',strengths:[],corrections,practice:[],memory_facts:facts}),sourceIds])).rows[0];
 const db=await setup(t,async db=>{
  await db.query("insert into auth.users values($1,'owner@example.com',now())",[owner]);
  await db.exec("insert into loop_private.approved_emails values('owner@example.com') on conflict do nothing");
  legacy=await call(db,{companion:'mia',hours:12});
  await db.query('update public.transcript_events set text=$1 where id=$2',['Please forget my location.',legacy.user.id]);legacy.user.text='Please forget my location.';
  await insertAnalysis(db,legacy,[fact(legacy)]);
 });
 const state=async()=> (await db.query('select * from public.memory_state where user_id=$1 and companion_id=$2',[owner,'mia'])).rows[0];
 const first=await state();assert.equal(first.revision,1);assert.equal(new Date(first.conversation_forget_after).toISOString(),new Date(legacy.user.timestamp).toISOString());
 const originalBoundary=first.conversation_forget_after;
 await assert.rejects(role(db,'authenticated',owner,()=>db.query("update public.memory_state set conversation_forget_after=null where companion_id='mia'")),/permission denied/);
 await assert.rejects(role(db,'authenticated',other,()=>db.query('select loop_private.advance_conversation_forget($1,$2,now())',[owner,'mia'])),/permission denied/);
 assert.deepEqual((await role(db,'authenticated',other,()=>db.query("select conversation_forget_after from public.memory_state where companion_id='mia'"))).rows,[]);
 const fake=await call(db,{companion:'mia',hours:8});
 await insertAnalysis(db,fake,[{...fact(fake),quote:'A quotation absent from all speech.'},{...fact(fake),quote:fake.assistant.text,evidence_ids:[fake.assistant.id]},
  {...fact(fake),evidence_ids:[legacy.user.id]},{...fact(fake),quote:' '},{...fact(fake),evidence_ids:{[fake.user.id]:true}}]);
 assert.equal((await state()).revision,1,'unsupported or assistant-only tombstones cannot advance the boundary');
 await db.query('update public.transcript_events set timestamp=$1 where id=$2',[new Date(Date.parse(fake.session.ended_at)+3600000).toISOString(),fake.user.id]);
 await insertAnalysis(db,fake,[fact(fake)]);assert.equal((await state()).revision,1,'quoted speech outside the source call cannot create a permanent boundary');
 await db.query("update public.transcript_events set timestamp='infinity'::timestamptz where id=$1",[fake.user.id]);
 await insertAnalysis(db,fake,[fact(fake)]);assert.equal((await state()).revision,1,'a nonfinite speech timestamp cannot advance the boundary');
 await db.query('update public.transcript_events set timestamp=$1 where id=$2',[fake.user.timestamp,fake.user.id]);
 await insertAnalysis(db,fake,[fact(fake)],{sourceIds:[fake.user.id]});
 assert.equal((await state()).revision,1,'an incomplete analysis source set cannot advance the boundary');
 await db.query('update public.sessions set record_incomplete=true where id=$1',[fake.session.id]);await insertAnalysis(db,fake,[fact(fake)]);
 assert.equal((await state()).revision,1,'partial source calls cannot advance the boundary');
 await db.query('update public.sessions set record_incomplete=false where id=$1',[fake.session.id]);
 await db.query("insert into public.learning_source_holds(user_id,session_id,reason) values($1,$2,'wrong_transcript')",[owner,fake.session.id]);
 await insertAnalysis(db,fake,[fact(fake)]);assert.equal((await state()).revision,1,'held user speech cannot create an irreversible restriction');
 await db.query('delete from public.learning_source_holds where session_id=$1',[fake.session.id]);
 await db.query("insert into public.memory_session_exclusions(user_id,companion_id,session_id) values($1,'mia',$2)",[owner,fake.session.id]);
 await insertAnalysis(db,fake,[fact(fake)]);assert.equal((await state()).revision,1,'excluded source calls cannot advance the boundary');
 await db.query('delete from public.memory_session_exclusions where session_id=$1',[fake.session.id]);
 await insertAnalysis(db,fake,[],{corrections:[{original:'I found',improved:'I discovered',reason:'A supported alternative.',category:'alternative',evidence_ids:[fake.user.id]}]});
 await db.query("update public.learning_state_items set status='excluded' where user_id=$1 and companion_id='mia'",[owner]);
 await insertAnalysis(db,fake,[fact(fake)]);assert.equal((await state()).revision,1,'excluded learning sources cannot advance the boundary');
 const newer=await call(db,{companion:'mia',hours:6});
 await db.query('update public.transcript_events set text=$1 where id=$2',['Please forget my location again.',newer.user.id]);newer.user.text='Please forget my location again.';
 const captured=await insertAnalysis(db,newer,[fact(newer)]);const advanced=await state();assert.equal(advanced.revision,2);
 await db.query('update public.analyses set content=content where id=$1',[captured.id]);
 await insertAnalysis(db,legacy,[fact(legacy)]);assert.equal((await state()).revision,2,'duplicate and earlier requests are idempotent');
 await db.query("update public.analyses set content='{}'::jsonb where id=$1",[captured.id]);
 assert.equal((await state()).revision,2);assert.equal((await state()).conversation_forget_after.getTime(),advanced.conversation_forget_after.getTime(),'reanalysis cannot lower an applied boundary');
 const restore=boundary=>role(db,'authenticated',owner,()=>db.query('select public.restore_history($1::jsonb) result',[JSON.stringify({sessions:[],events:[],memory_controls:{state:[{user_id:owner,companion_id:'mia',conversation_forget_after:boundary}],facts:[],exclusions:[]}})]));
 await assert.rejects(restore('infinity'),/Invalid conversation forget boundary/);
 await assert.rejects(restore(new Date(Date.now()+3600000).toISOString()),/Invalid conversation forget boundary/);
 assert.equal((await state()).revision,2,'malformed or future backups cannot apply a permanent restriction');
 await restore(originalBoundary);assert.equal((await state()).revision,2,'older backups cannot lower the boundary or bump the revision');
 const later=at(4);await restore(later);assert.equal((await state()).revision,3);await restore(later);assert.equal((await state()).revision,3,'same backup is idempotent');
 const active=await call(db,{companion:'mia',hours:1,status:'active'});
 await assert.rejects(restore(at(2)),/Finish unfinished calls/);assert.equal((await state()).revision,3);
 await db.query("update public.sessions set status='ended',ended_at=now() where id=$1",[active.session.id]);
 await assert.rejects(role(db,'authenticated',other,()=>db.query('select public.restore_history($1::jsonb)',[JSON.stringify({sessions:[],events:[],memory_controls:{state:[{user_id:owner,companion_id:'mia',conversation_forget_after:at(1)}],facts:[],exclusions:[]}})])),/Memory controls belong to another user/);
 await assert.rejects(role(db,'authenticated',owner,()=>db.query("select public.restore_history_before_exchanges_v1('{}'::jsonb)")),/permission denied/);
});
