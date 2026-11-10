import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const directory=new URL('../supabase/migrations/',import.meta.url);
const migrations=await Promise.all((await readdir(directory)).filter(n=>n.endsWith('.sql')).sort().map(n=>readFile(new URL(n,directory),'utf8')));
async function database(t,beforeCanonical){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 const identities=async()=>{
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'other@example.com',now()) on conflict do nothing",[A,B]);
  await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com') on conflict do nothing");
 };
 for(const sql of migrations){
  if(beforeCanonical&&sql.startsWith('-- Canonical learning state')){await identities();await beforeCanonical(db);}
  await db.exec(sql);
 }
 await identities();return db;
}
async function user(db,u,work){await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[u]);try{return await work()}finally{await db.exec('reset role')}}
async function snapshot(db,u=A,c='alex'){return user(db,u,async()=>(await db.query('select public.learning_snapshot($1) value',[c])).rows[0].value)}
async function session(db,u=A,c='alex'){
 const s=await user(db,u,async()=>(await db.query("insert into public.sessions(scenario,companion_id) values('Weekend',$1) returning id",[c])).rows[0].id);
 const e=await user(db,u,async()=>(await db.query('select public.append_events($1,$2::jsonb) value',[s,JSON.stringify([{event_key:randomUUID(),speaker:'user',text:'Yesterday I go home. I want coffee. Thanks.'}])])).rows[0].value.event_ids[0]);
 await user(db,u,()=>db.query('select public.finish_session($1)',[s]));return {id:s,e,user:u,c};
}
async function analyze(db,s,expressions=['I went home.']){
 const id=randomUUID();
 const all=(await db.query('select id from public.transcript_events where session_id=$1',[s.id])).rows.map(x=>x.id);
 await db.query(`insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids) values($1,$2,$3,'session',$4::jsonb,'test',$5::uuid[])`,[id,s.user,s.id,JSON.stringify({summary:'연습',corrections:expressions.map((x,n)=>({original:'I go',improved:x,reason:'설명',...(n===1?{category:'error'}:{}),evidence_ids:[s.e]})),next_scenario:'Talk about yesterday'}),all]);return id;
}
async function action(db,item,name,payload={},id=randomUUID(),rev=item.revision){return user(db,A,async()=>(await db.query('select public.learning_action($1,$2,$3,$4,$5::jsonb) value',[item.id,rev,id,name,JSON.stringify(payload)])).rows[0].value)}
async function record(db,name,params={}){return user(db,A,async()=>(await db.query('select public.learning_record_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb) value',[params.event_id||randomUUID(),name,'alex',params.session_id||null,params.analysis_id||null,params.item_id||null,params.attempt_id||null,JSON.stringify(params.payload||{})])).rows[0].value)}

test('learning ownership: RLS prevents reads across accounts, all direct writes, and service voice RPC from client',async t=>{
 const db=await database(t),s=await session(db);await analyze(db,s);const x=(await snapshot(db)).items[0];
 assert.equal((await snapshot(db,B)).items.length,0);
 await assert.rejects(user(db,B,()=>db.query('select public.learning_action($1,1,$2,\'exclude\')',[x.id,randomUUID()])),/Item not found/);
 await assert.rejects(user(db,A,()=>db.query("update public.learning_state_items set status='excluded' where id=$1",[x.id])),/permission denied/i);
 await assert.rejects(user(db,A,()=>db.query("insert into public.learning_source_holds(user_id,session_id,reason) values($1,$2,'intent')",[A,s.id])),/permission denied/i);
 await assert.rejects(user(db,A,()=>db.query("select public.learning_voice_context($1,'alex')",[B])),/permission denied/i);
 await assert.rejects(user(db,A,()=>db.query('select public.learning_ingest($1)',[randomUUID()])),/permission denied/i);
});

test('canonical words merge only within companion; all source versions survive while current transcript gates validity',async t=>{
 const db=await database(t),s=await session(db);await analyze(db,s,['I went home.','I WENT  HOME!','I would go home.','Fourth ignored']);
 let snap=await snapshot(db);assert.equal(snap.items.length,3);assert.equal(snap.items.filter(x=>x.enrolled).length,1);assert.equal(snap.items[0].category,'alternative');
 const item=snap.items.find(x=>x.expression==='I went home.');
 const practiced=await action(db,item,'practice',{attempt_id:randomUUID(),attribution:'library'});
 await analyze(db,s,['I went home!']);snap=await snapshot(db);
 assert.equal(snap.items.find(x=>x.id===item.id).practice_count,1);assert.equal(snap.items.find(x=>x.id===item.id).revision,practiced.revision);
 assert.equal(snap.items.find(x=>x.expression==='I would go home.').has_valid_source,false);
 await user(db,A,()=>db.query('select public.append_events($1,$2::jsonb)',[s.id,JSON.stringify([{event_key:'late',speaker:'user',text:'Late speech'}])]));
 snap=await snapshot(db);assert.equal(snap.feedback[0].current,false);assert.ok(snap.items.every(x=>!x.has_valid_source));assert.equal(snap.items.find(x=>x.id===item.id).practice_count,1);
 const mia=await session(db,A,'mia');await analyze(db,mia,['I went home!']);assert.notEqual((await snapshot(db,A,'mia')).items[0].id,item.id);
});

test('CAS idempotency preserves original response and same-KST-day attempts count once',async t=>{
 const db=await database(t),s=await session(db);await analyze(db,s);let item=(await snapshot(db)).items[0];
 const id=randomUUID(),payload={attempt_id:randomUUID(),attribution:'library'};
 const first=await action(db,item,'practice',payload,id);assert.deepEqual(await action(db,item,'practice',payload,id),first);
 const conflict=await action(db,item,'exclude');assert.equal(conflict.outcome,'conflict');assert.equal(conflict.item.status,'practiced');
 item=first.item;const second=await action(db,item,'practice',{attempt_id:randomUUID(),attribution:'library'});assert.equal(second.item.practice_count,1);
 const yesterday=new Date(Date.now()-86400000).toISOString();
 const third=await action(db,second.item,'practice',{attempt_id:randomUUID(),attribution:'library',occurred_at:yesterday});assert.equal(third.item.practice_count,2);
 assert.equal((await db.query("select count(*)::int n from public.learning_events where name='practice_saved'")).rows[0].n,3);
 await assert.rejects(action(db,third.item,'exclude',{},id),/Action ID reused/);
 const excluded=await action(db,third.item,'exclude');assert.equal(excluded.item.status,'excluded');
 assert.equal((await action(db,third.item,'restore')).outcome,'conflict');
 await assert.rejects(action(db,excluded.item,'defer'),/Restore excluded/);
 const restored=await action(db,excluded.item,'restore');assert.equal(restored.item.practice_count,2);
 const review=await action(db,restored.item,'review_again');assert.equal(review.item.practice_count,2);assert.ok(Date.parse(review.item.next_eligible_at)>Date.now());
});

test('defer dates use KST midnight, review preserves history, and source holds survive reanalysis but valid alternate source sustains item',async t=>{
 const db=await database(t),s=await session(db);const a=await analyze(db,s);let item=(await snapshot(db)).items[0];
 let r=await action(db,item,'defer');const d1=r.item.next_eligible_at;
 r=await action(db,r.item,'defer');assert.equal((Date.parse(r.item.next_eligible_at)-Date.parse(d1))/86400000,6);
 const kst=await db.query("select ((now() at time zone 'Asia/Seoul')::date+7)::timestamp at time zone 'Asia/Seoul' x");assert.equal(Date.parse(r.item.next_eligible_at),kst.rows[0].x.getTime());
 const other=await session(db);await analyze(db,other);r=await action(db,r.item,'hold_intent',{source_session_id:s.id,source_analysis_id:a});assert.equal(r.item.has_valid_source,true);assert.equal(r.item.sources.find(x=>x.analysis_id===a).valid,false);
 await analyze(db,s);assert.equal((await snapshot(db)).items[0].has_valid_source,true);
 const held=await action(db,r.item,'hold_wrong_transcript',{source_session_id:other.id,source_analysis_id:r.item.source_analysis_id});assert.equal(held.item.has_valid_source,false);
 const restored=await action(db,held.item,'restore');assert.equal(restored.item.has_valid_source,false);assert.deepEqual((await snapshot(db)).recommended_item_ids,[]);
});

test('practice events fix one attribution, pair delayed starts, enforce exposure and reject content analytics',async t=>{
 const db=await database(t),s=await session(db);const aid=await analyze(db,s),item=(await snapshot(db)).items[0],attempt=randomUUID();
 await action(db,item,'practice',{attempt_id:attempt,attribution:'session',source_session_id:s.id,source_analysis_id:aid});
 assert.equal((await db.query("select paired from public.learning_events where name='practice_saved'")).rows[0].paired,false);
 await assert.rejects(record(db,'practice_started',{item_id:item.id,attempt_id:attempt,payload:{attribution:'library'}}),/attribution mismatch/);
 await record(db,'practice_started',{item_id:item.id,attempt_id:attempt,session_id:s.id,analysis_id:aid,payload:{attribution:'session'}});
 assert.ok((await db.query("select paired from public.learning_events where name in ('practice_saved','practice_started')")).rows.every(x=>x.paired));
 await assert.rejects(record(db,'feedback_exposed',{session_id:s.id,analysis_id:aid}),/threshold/);
 const exposure={foreground:true,visible_ratio:0.5,visible_ms:1000};
 await record(db,'feedback_exposed',{session_id:s.id,analysis_id:aid,payload:exposure});assert.ok((await snapshot(db)).feedback[0].exposed_at);
 await assert.rejects(record(db,'flow_failure',{payload:{expression:'private speech'}}),/unsupported fields/);
 await assert.rejects(record(db,'flow_failure',{payload:{reason:'private speech'}}),/Invalid event code/);
 await assert.rejects(record(db,'practice_saved',{item_id:item.id,attempt_id:randomUUID()}),/Invalid client event/);
 const events=(await db.query('select payload from public.learning_events')).rows;assert.ok(events.every(x=>!JSON.stringify(x.payload).includes('I went')));
});

test('daily recommendation cap is one distinct item, explicit more allows three; library and candidates remain available',async t=>{
 const db=await database(t);for(let n=0;n<5;n++){const s=await session(db);await analyze(db,s,[`Phrase ${n}.`]);}
 let snap=await snapshot(db);assert.equal(snap.items.length,5);assert.equal(snap.recommended_item_ids.length,1);
 const first=snap.items.find(x=>x.id===snap.recommended_item_ids[0]);await action(db,first,'practice',{attempt_id:randomUUID()});assert.equal((await snapshot(db)).recommended_item_ids.length,0);
 snap=await user(db,A,async()=>(await db.query("select public.learning_recommend_more('alex') value")).rows[0].value);assert.equal(snap.recommended_item_ids.length,2);
 const manual=snap.items.find(x=>!snap.recommended_item_ids.includes(x.id)&&x.id!==first.id);await action(db,manual,'practice',{attempt_id:randomUUID()});
 assert.equal((await db.query('select cardinality(item_ids) n from public.learning_daily')).rows[0].n,3);
});

test('next preparation persists without voice activity; exclusion or stale transcript suppresses memory and focus',async t=>{
 const db=await database(t),s=await session(db);await analyze(db,s);const item=(await snapshot(db)).items[0];
 const prepared=await action(db,item,'prepare_next');assert.equal(prepared.next_plan.scenario,'Talk about yesterday');assert.equal(prepared.next_plan.source_session_id,s.id);
 assert.equal((await snapshot(db)).next_plan.item_id,item.id);
 const voice=async()=>{await db.exec('set role service_role');try{return (await db.query("select public.learning_voice_context($1,'alex') value",[A])).rows[0].value}finally{await db.exec('reset role')}};
 assert.deepEqual((await voice()).focus[0].evidence_ids,[s.e]);assert.equal((await voice()).suppress_memory,false);
 assert.equal((await db.query("select count(*)::int n from public.analysis_jobs where kind='voice'")).rows[0].n,0);
 await action(db,prepared.item,'known');assert.deepEqual(await voice(),{focus:[],suppress_memory:true});assert.equal((await snapshot(db)).next_plan,null);
});

test('restore keeps selfreports untrusted, maps regenerated exact expression, and never overwrites existing state',async t=>{
 const db=await database(t),s=await session(db),backup={source_session_id:s.id,companion_id:'alex',expression:'I went home.',status:'practiced',enrolled:true,practice_count:4,revision:999,source_analysis_id:randomUUID(),has_valid_source:true};
 const restore=x=>user(db,A,async()=>(await db.query('select public.learning_restore($1::jsonb) value',[JSON.stringify(x)])).rows[0].value);
 assert.equal((await restore([backup])).inserted,1);let item=(await snapshot(db)).items[0];assert.equal(item.practice_count,4);assert.equal(item.has_valid_source,false);assert.equal(item.revision,1);
 await analyze(db,s);item=(await snapshot(db)).items[0];assert.equal(item.has_valid_source,true);assert.equal(item.practice_count,4);
 const excluded=await action(db,item,'exclude');assert.equal((await restore([{...backup,status:'active',practice_count:0}])).skipped_existing,1);assert.equal((await snapshot(db)).items[0].revision,excluded.revision);
 await assert.rejects(restore([{...backup,user_id:B}]),/another user/);
 const foreign=await session(db,B);await assert.rejects(restore([{...backup,source_session_id:foreign.id}]),/Owned matching/);
});


test('old analysis seeding and transcript-race rejection preserve evidence trust; long return starts with one recent item',async t=>{
 const db=await database(t),s=await session(db);
 await db.exec('alter table public.analyses disable trigger learning_analysis_insert');
 const aid=await analyze(db,s,['Old chosen expression.']);
 await db.exec('alter table public.analyses enable trigger learning_analysis_insert');
 let snap=await snapshot(db);assert.equal(snap.items.length,1);assert.equal(snap.feedback[0].analysis_id,aid);
 const old=snap.items[0];await action(db,old,'enroll');
 const recent=await session(db);await analyze(db,recent,['Recent expression.']);
 await db.query('delete from public.learning_daily where user_id=$1',[A]);
 await db.query("update public.learning_visits set last_seen_at=now()-interval '15 days' where user_id=$1",[A]);
 snap=await snapshot(db);assert.equal(snap.recommended_item_ids.length,1);assert.equal(snap.items.find(x=>x.id===snap.recommended_item_ids[0]).expression,'Recent expression.');
 // Model read the old transcript; a delayed upload arrived before its result.
 const race=await session(db);await user(db,A,()=>db.query('select public.append_events($1,$2::jsonb)',[race.id,JSON.stringify([{event_key:'raced',speaker:'user',text:'Another utterance'}])]));
 await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values($1,$2,'session',$3::jsonb,'test',$4::uuid[])",[A,race.id,JSON.stringify({corrections:[{original:'I go',improved:'Unsafe race phrase',evidence_ids:[race.e]}]}),[race.e]]);
 snap=await snapshot(db);assert.ok(!snap.items.some(x=>x.expression==='Unsafe race phrase'));assert.equal(snap.feedback.find(x=>x.session_id===race.id).current,false);
});


test('clean restore preserves source quality holds and seeds last practice KST day without trusting imported analyses',async t=>{
 const db=await database(t),s=await session(db),now=new Date().toISOString();
 const payload=[{expression:'I went home.',source_session_id:s.id,companion_id:'alex',status:'practiced',practice_count:3,practiced_at:now,held_sources:[{session_id:s.id,reason:'wrong_transcript'}]}];
 const restore=()=>user(db,A,async()=>(await db.query('select public.learning_restore($1::jsonb) value',[JSON.stringify(payload)])).rows[0].value);
 assert.equal((await restore()).holds_restored,1);assert.equal((await restore()).holds_restored,0);
 await analyze(db,s);let item=(await snapshot(db)).items[0];assert.equal(item.has_valid_source,false);assert.equal(item.practice_count,3);
 item=(await action(db,item,'practice',{attempt_id:randomUUID(),attribution:'library'})).item;assert.equal(item.practice_count,3);assert.deepEqual((await snapshot(db)).recommended_item_ids,[]);
 const foreign=await session(db,B);payload[0]={...payload[0],expression:'Another phrase',held_sources:[{session_id:foreign.id,reason:'intent'}]};await assert.rejects(restore(),/Invalid restored hold source/);
 assert.equal((await snapshot(db)).items.length,1,'invalid batch rolls back new item');
});


test('voice suppresses stale latest analyses even with a valid alternate source or zero extracted items',async t=>{
 const db=await database(t),a=await session(db),b=await session(db);await analyze(db,a);await analyze(db,b);const item=(await snapshot(db)).items[0];await action(db,item,'prepare_next');
 await user(db,A,()=>db.query('select public.append_events($1,$2::jsonb)',[a.id,JSON.stringify([{event_key:'late',speaker:'user',text:'Late A'}])]));
 const voice=async()=>{await db.exec('set role service_role');try{return(await db.query("select public.learning_voice_context($1,'alex') value",[A])).rows[0].value}finally{await db.exec('reset role')}};
 const ctx=await voice();assert.equal(ctx.suppress_memory,true);assert.equal(ctx.focus.length,1);
 await analyze(db,a);const empty=await session(db);await analyze(db,empty,[]);assert.equal((await voice()).suppress_memory,false);
 await user(db,A,()=>db.query('select public.append_events($1,$2::jsonb)',[empty.id,JSON.stringify([{event_key:'late-empty',speaker:'user',text:'Late empty analysis'}])]));assert.equal((await voice()).suppress_memory,true);
});

test('feedback blockers persist across snapshots, follow transcript versions, and quota respects UTC reset and cached results',async t=>{
 const db=await database(t),s=await session(db);let f=(await snapshot(db)).feedback[0];assert.ok(f.source_version);assert.equal(f.blocked_reason,null);
 const failure={event_id:randomUUID(),session_id:s.id,payload:{reason:'input_too_large',stage:'analysis',status:'failure'}};
 await record(db,'flow_failure',failure);await record(db,'flow_failure',failure);
 f=(await snapshot(db)).feedback[0];assert.equal(f.blocked_reason,'input_too_large');assert.equal(f.blocked_until,null);
 const stamp=(await db.query("select payload->>'source_version' v from public.learning_events where name='flow_failure'")).rows[0].v;assert.equal(stamp,f.source_version);
 await user(db,A,()=>db.query('select public.append_events($1,$2::jsonb)',[s.id,JSON.stringify([{event_key:'newversion',speaker:'user',text:'New transcript'}])]));
 f=(await snapshot(db)).feedback[0];assert.notEqual(f.source_version,stamp);assert.equal(f.blocked_reason,null);
 await db.query("insert into public.api_daily_usage(user_id,day,kind,reservations) values($1,(now() at time zone 'UTC')::date,'session',20)",[A]);
 f=(await snapshot(db)).feedback[0];assert.equal(f.blocked_reason,'quota');assert.equal(new Date(f.blocked_until).getUTCHours(),0);
 await analyze(db,s);f=(await snapshot(db)).feedback[0];assert.equal(f.current,true);assert.equal(f.blocked_reason,null);
 assert.equal((await db.query('select reservations from public.api_daily_usage')).rows[0].reservations,20);
});


test('explicit received-record-only finish persists a partial marker and is ownership checked',async t=>{
 const db=await database(t),s=await session(db);
 const finish=()=>db.query('select (public.learning_finish_partial($1)).*',[s.id]);
 await assert.rejects(user(db,B,finish),/Session not found/);
 const result=await user(db,A,finish);assert.equal(result.rows[0].status,'ended');assert.equal(result.rows[0].record_incomplete,true);
 assert.equal((await snapshot(db)).feedback[0].record_incomplete,true);
 await user(db,A,()=>db.query('select public.finish_session($1)',[s.id]));
 assert.equal((await snapshot(db)).feedback[0].record_incomplete,true,'ordinary finish never silently clears partial status');
});

const voice=async(db,u=A,c='alex')=>{await db.exec('set role service_role');try{return(await db.query('select public.learning_voice_context($1,$2) value',[u,c])).rows[0].value}finally{await db.exec('reset role')}};

test('published account approval guards all canonical RPCs, RLS reads, cached action replay, and service voice',async t=>{
 const db=await database(t),s=await session(db),aid=await analyze(db,s),item=(await snapshot(db)).items[0];
 const actionId=randomUUID();await action(db,item,'enroll',{},actionId);
 await user(db,A,()=>db.query('select public.learning_review($1,$2)', ['alex',aid]));
 await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
 await user(db,A,async()=>{
  for(const table of ['learning_state_items','learning_feedback','learning_sources','learning_source_holds','learning_actions','learning_practice_days','learning_daily','learning_visits','learning_next_plans','learning_events','learning_items']){
   assert.equal((await db.query(`select count(*)::int n from public.${table}`)).rows[0].n,0,table);
  }
 });
 await assert.rejects(snapshot(db),/Account not approved/);
 await assert.rejects(action(db,item,'enroll',{},actionId),/Account not approved/);
 await assert.rejects(record(db,'flow_failure',{payload:{reason:'network'}}),/Account not approved/);
 await assert.rejects(user(db,A,()=>db.query("select public.learning_recommend_more('alex')")),/Account not approved/);
 await assert.rejects(user(db,A,()=>db.query("select public.learning_restore('[]'::jsonb)")),/Account not approved/);
 await assert.rejects(user(db,A,()=>db.query('select public.learning_finish_partial($1)',[s.id])),/Account not approved/);
 await assert.rejects(voice(db),/Account not approved/);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com')");
 await db.query('update auth.users set email_confirmed_at=null where id=$1',[A]);
 await assert.rejects(snapshot(db),/Account not approved/);
 await assert.rejects(voice(db),/Account not approved/);
});

test('published memory exclusions and history cutoff revoke source eligibility and voice focus without deleting self reports',async t=>{
 const db=await database(t),s=await session(db);await analyze(db,s);let item=(await snapshot(db)).items[0];
 item=(await action(db,item,'practice',{attempt_id:randomUUID(),attribution:'library'})).item;
 item=(await action(db,item,'prepare_next')).item;
 assert.equal((await voice(db)).focus.length,1);
 await db.query('insert into public.memory_session_exclusions(user_id,companion_id,session_id) values($1,$2,$3)',[A,'alex',s.id]);
 let snap=await snapshot(db);assert.equal(snap.items[0].has_valid_source,false);assert.equal(snap.items[0].practice_count,1);assert.equal(snap.next_plan,null);
 assert.deepEqual(await voice(db),{focus:[],suppress_memory:true});
 await assert.rejects(action(db,item,'prepare_next'),/Valid source required/);
 await db.query('delete from public.memory_session_exclusions where user_id=$1',[A]);
 assert.equal((await voice(db)).focus.length,1);
 await db.query("insert into public.memory_state(user_id,companion_id,history_cutoff) values($1,'alex',now()) on conflict(user_id,companion_id) do update set history_cutoff=excluded.history_cutoff",[A]);
 assert.equal((await snapshot(db)).items[0].has_valid_source,false);assert.deepEqual(await voice(db),{focus:[],suppress_memory:true});
 // A later source can be used; the privacy cutoff still suppresses the broad
 // history summaries that may retain paraphrases of forgotten speech.
 const fresh=await session(db);await analyze(db,fresh);snap=await snapshot(db);
 assert.equal(snap.items[0].has_valid_source,true);assert.equal(snap.items[0].practice_count,1);
 assert.equal((await voice(db)).focus.length,1);assert.equal((await voice(db)).suppress_memory,true);
});

test('additive canonical migration preserves legacy APIs, normalizes legacy self reports, counts only known distinct KST days, and is idempotent',async t=>{
 const db=await database(t),s1=await session(db),s2=await session(db),a1=await analyze(db,s1,[]),a2=await analyze(db,s2,[]);
 const insert=async(s,a,pos,expression,state,stamp)=>db.query(`insert into public.learning_items(user_id,companion_id,session_id,analysis_id,position,original,expression,reason,state,practiced_at) values($1,'alex',$2,$3,$4,'legacy',$5,'legacy reason',$6,$7) returning id`,[A,s.id,a,pos,expression,state,stamp]);
 await insert(s1,a1,1,'Legacy phrase.','practiced','2026-11-07T16:00:00Z'); // KST Nov 8
 await insert(s1,a1,2,'LEGACY  PHRASE!','practiced','2026-11-08T02:00:00Z'); // same day
 await insert(s1,a1,3,'Legacy phrase','practiced','2026-11-08T16:00:00Z'); // KST Nov 9
 await insert(s2,a2,1,'Legacy phrase?','practiced',null); // unknown date adds no day
 await insert(s2,a2,2,'Unsupported later expression','later',null);
 await db.exec('select loop_private.learning_import_legacy()');
 let snap=await snapshot(db);assert.equal(snap.items.length,2);
 const practiced=snap.items.find(x=>x.expression==='Legacy phrase.'),later=snap.items.find(x=>x.expression==='Unsupported later expression');
 assert.equal(practiced.status,'practiced');assert.equal(practiced.practice_count,2);assert.equal(practiced.has_valid_source,false);assert.equal(practiced.source_session_id,s1.id);
 assert.equal(later.status,'deferred');assert.equal(later.practice_count,0);assert.equal(later.has_valid_source,false);assert.equal(later.source_session_id,s2.id);
 assert.equal((await db.query('select count(*)::int n from public.learning_practice_days where item_id=$1',[practiced.id])).rows[0].n,2);
 const excluded=await action(db,practiced,'exclude');
 await db.exec('select loop_private.learning_import_legacy()');snap=await snapshot(db);
 assert.equal(snap.items.find(x=>x.id===practiced.id).status,'excluded');assert.equal(snap.items.find(x=>x.id===practiced.id).revision,excluded.revision);
 assert.equal((await user(db,A,()=>db.query('select count(*)::int n from public.learning_items'))).rows[0].n,5);
 for(const [signature,role] of [['public.learning_review(text,uuid,uuid,text)','authenticated'],['public.learning_plan(text,text)','authenticated'],['public.learning_context(uuid,text)','service_role']]){
  assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,signature,'EXECUTE'])).rows[0].allowed,true,signature);
 }
 await user(db,A,()=>db.query("select public.learning_plan('alex','Legacy API still works')"));
 assert.equal((await user(db,A,()=>db.query("select public.learning_plan('alex') value"))).rows[0].value.scenario,'Legacy API still works');
 assert.equal((await user(db,A,()=>db.query("select public.learning_review('alex') value"))).rows[0].value.length,5);
});

test('ingestion accepts correction and expression-only practice citations with shared maximum three, legacy alternative category, and invalid citations rejected',async t=>{
 const db=await database(t),s=await session(db),aid=randomUUID();
 const content={corrections:[{original:'I go',improved:'Correction phrase',evidence_ids:[s.e]}],practice:[
  {expression:'Expression only suggestion',evidence_ids:[s.e]},
  {expression:'Third suggestion',evidence_ids:[s.e]},
  {expression:'Fourth suggestion',evidence_ids:[s.e]},
 ]};
 await db.query("insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids) values($1,$2,$3,'session',$4::jsonb,'test',$5::uuid[])",[aid,A,s.id,JSON.stringify(content),[s.e]]);
 let items=(await snapshot(db)).items;assert.equal(items.length,3);assert.ok(items.some(x=>x.expression==='Expression only suggestion'));assert.ok(items.every(x=>x.category==='alternative'&&x.has_valid_source));
 assert.equal(items.filter(x=>x.enrolled).length,1);
 const other=await session(db,B),wrong=await session(db);const aid2=randomUUID();
 await db.query("insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids) values($1,$2,$3,'session',$4::jsonb,'test',$5::uuid[])",[aid2,A,wrong.id,JSON.stringify({practice:[{expression:'Untrusted other account',evidence_ids:[other.e]},{expression:'Malformed evidence',evidence_ids:['not-a-uuid']}]}),[wrong.e]]);
 items=(await snapshot(db)).items;assert.equal(items.length,3);
 await db.query("update public.transcript_events set text='Changed existing words' where id=$1",[s.e]);
 assert.ok((await snapshot(db)).items.every(x=>!x.has_valid_source));
});


test('migration applies to populated deployed legacy schema and imports unsupported historical practice without trusting it',async t=>{
 let legacyId,sourceSession;
 const db=await database(t,async old=>{
  const s=await session(old);sourceSession=s.id;
  const aid=await analyze(old,s,[]);
  legacyId=(await old.query("insert into public.learning_items(user_id,companion_id,session_id,analysis_id,position,original,expression,reason,state,practiced_at) values($1,'alex',$2,$3,1,'old','Historical unsupported phrase','old','practiced','2026-11-08T16:30:00Z') returning id",[A,s.id,aid])).rows[0].id;
 });
 const snap=await snapshot(db),item=snap.items[0];
 assert.equal(item.expression,'Historical unsupported phrase');assert.equal(item.practice_count,1);assert.equal(item.status,'practiced');assert.equal(item.source_session_id,sourceSession);assert.equal(item.has_valid_source,false);
 assert.equal((await user(db,A,()=>db.query('select id from public.learning_items'))).rows[0].id,legacyId);
 assert.deepEqual(await voice(db),{focus:[],suppress_memory:true});
});
