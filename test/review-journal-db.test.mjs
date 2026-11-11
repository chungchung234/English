import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function setup(t) {
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 for(const f of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+f,'utf8'));
 await db.query("insert into auth.users values($1,'owner@example.com',now()),($2,'other@example.com',now())",[A,B]);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com') on conflict do nothing");return db;
}
async function user(db,uid,sql,args=[]) {await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);try{return (await db.query(sql,args)).rows;}finally{await db.exec('reset role');}}
const note=async(db,s,u=A)=>(await user(db,u,'select public.review_note($1) result',[s.id]))[0].result;
const journal=async(db,opts=[],u=A)=>(await user(db,u,'select public.review_journal('+opts.map((_,i)=>'$'+(i+1)).join(',')+') result',opts))[0].result;
const save=async(db,s,key,saved=true,rev=0,u=A)=>(await user(db,u,'select public.review_bookmark($1,$2,$3,$4) result',[s.id,key,saved,rev]))[0].result;
async function call(db,{companion='alex',at='2026-11-10T14:00:00Z',zone='Asia/Seoul',owner=A}={}) {
 const s=(await db.query("insert into public.sessions(user_id,companion_id,scenario,status,created_at,ended_at,time_zone) values($1,$2,'발표 준비','ended',$3,$3::timestamptz+interval '10 minutes',$4) returning *",[owner,companion,at,zone])).rows[0];
 const e=(await db.query("insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,'user','I go yesterday. Give me a moment. I have a plan.',$4) returning id",[owner,s.id,randomUUID(),at])).rows[0].id;
 return {...s,e};
}
async function analysis(db,s,{errors=3,alternatives=0,reusable=2,duplicate=false}={}) {
 const corrections=Array.from({length:errors+alternatives},(_,n)=>({original:'I go yesterday.',improved:`I went yesterday ${n}.`,meaning:'어제 갔어요.',reason:'지난 일은 과거형으로 말해요.',category:n<errors?'error':'alternative',evidence_ids:[s.e]}));
 const practice=Array.from({length:reusable},(_,n)=>({expression:`I have a plan ${n}.`,meaning:'계획이 있어요.',reason:'앞으로 할 일을 이야기할 때 써요.',evidence_ids:[s.e]}));
 if(duplicate)practice.push({expression:corrections[0].improved,evidence_ids:[s.e]});
 return (await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values($1,$2,'session',$3,'fixture',$4) returning id",[s.user_id,s.id,JSON.stringify({summary:'발표 준비를 이야기했어요.',strengths:[{text:'생각할 시간을 요청했어요.',evidence_ids:[s.e]}],corrections,practice}),[s.e]])).rows[0].id;
}
test('review uses every evidenced expression, with zero/many kinds and no recommendation cap or duplicate',async t=>{
 const db=await setup(t),s=await call(db);await analysis(db,s,{duplicate:true});const n=await note(db,s);
 assert.equal(n.status,'ready');assert.equal(n.expressions.length,5);assert.equal(n.expressions.filter(x=>x.kind==='error').length,3);assert.equal(n.expressions.filter(x=>x.kind==='alternative').length,0);assert.equal(n.expressions.filter(x=>x.kind==='reusable').length,2);
 assert.equal(n.strengths.length,1);assert(n.expressions.every(e=>!e.saved));assert.equal((await db.query('select count(*)::int n from public.learning_state_items')).rows[0].n,3,'review is not limited by the independent recommendation ingest');
 const empty=await call(db,{companion:'mia'});await analysis(db,empty,{errors:0,reusable:0});assert.equal((await note(db,empty)).expressions.length,0);
});
test('new learning details and well-used quotations project safely without changing legacy notes or practice state',async t=>{
 const db=await setup(t),s=await call(db);
 const learning={focus:'lexical',form:'colloquial',source_quote:'I have a plan.',source_is_question:false,usage:'친구의 제안에 동의할 때 써요.',register:'informal',example:{prompt:'Want to join?',response:"I'm down."},alternative:'Sure.'};
 const content={summary:'계획',strengths:[{text:'시간을 요청했어요.',expression:'Give me a moment.',meaning:'잠시만요.',evidence_ids:[s.e]},{text:'조작된 강점',expression:'I never said this.',evidence_ids:[s.e]}],corrections:[],practice:[{expression:"I'm down.",meaning:'나도 할래.',reason:'동의',learning,evidence_ids:[s.e]}]};
 const id=(await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values($1,$2,'session',$3,'fixture',$4) returning id",[A,s.id,JSON.stringify(content),[s.e]])).rows[0].id;
 const n=await note(db,s);assert.equal(n.expressions.length,2);assert.equal(n.expressions.find(e=>e.kind==='positive').original,'Give me a moment.');assert.equal(n.expressions.find(e=>e.kind==='reusable').learning.form,'colloquial');
 const positive=n.expressions.find(e=>e.kind==='positive');await save(db,s,positive.key);assert.equal((await note(db,s)).expressions.find(e=>e.key===positive.key).saved,true);
 content.practice[0].learning.source_quote='Invented question';content.practice[0].learning.source_is_question=true;
 await db.query('update public.analyses set content=$1 where id=$2',[JSON.stringify(content),id]);assert.deepEqual((await note(db,s)).expressions.find(e=>e.kind==='reusable').learning,{},'bad imported metadata never fabricates a learner quotation');
 await db.query("insert into public.learning_source_holds(user_id,session_id,evidence_ids,reason) values($1,$2,$3,'wrong_transcript')",[A,s.id,[s.e]]);assert.equal((await note(db,s)).expressions.length,0);await assert.rejects(save(db,s,positive.key),/no longer available/);
});
test('all companions and older calls paginate by stable call time, including equal timestamps and local midnight',async t=>{
 const db=await setup(t);for(let i=0;i<33;i++)await call(db,{companion:i%2?'mia':'alex',at:i<2?'2026-11-10T15:01:00Z':new Date(Date.UTC(2026,10,10-i,10)).toISOString()});
 const first=await journal(db,[null,null,null,'Asia/Seoul',false,20]);assert.equal(first.calls.length,20);assert(first.next);const second=await journal(db,[first.next.before,first.next.before_id,null,'Asia/Seoul',false,20]);assert.equal(second.calls.length,13);assert.equal(second.next,null);assert.equal(new Set([...first.calls,...second.calls].map(x=>x.session.id)).size,33);
 const dated=await journal(db,[null,null,'2026-11-10','Asia/Seoul',false,20]);assert(dated.calls.every(c=>c.session.created_at!=='2026-11-10T15:01:00+00:00'));
 assert(dated.calls.every(c=>Date.parse(c.session.created_at)<Date.parse('2026-11-10T15:00:00Z')),'call date, not analysis creation date, controls date selection');
});
test('explicit bookmarks persist for every expression without enrolling, practicing or changing memory; stale writes conflict',async t=>{
 const db=await setup(t),s=await call(db);await analysis(db,s);const before=(await db.query('select * from public.learning_state_items order by id')).rows;const expression=(await note(db,s)).expressions.at(-1);
 const saved=await save(db,s,expression.key);assert(saved.saved);assert.equal((await journal(db,[null,null,null,'UTC',true,12])).calls[0].expressions.length,1);
 assert.deepEqual((await db.query('select * from public.learning_state_items order by id')).rows,before);assert.equal((await db.query("select count(*)::int n from public.learning_events where name in('practice_started','practice_saved')")).rows[0].n,0);
 assert.deepEqual(await save(db,s,expression.key),saved,'unknown-response replay of same desired save is harmless');
 const removed=await save(db,s,expression.key,false,saved.revision);assert(!removed.saved);await assert.rejects(save(db,s,expression.key,true,0),/Bookmark changed/);
 assert.equal((await journal(db,[null,null,null,'UTC',true,12])).calls.length,0);
 const restore=items=>user(db,A,'select public.review_bookmarks_restore($1::jsonb) result',[JSON.stringify(items)]);
 await restore([{session_id:s.id,expression_key:expression.key,saved:true}]);assert.equal((await journal(db,[null,null,null,'UTC',true,12])).calls.length,0,'backup cannot overwrite a later explicit unsave');
 await restore([{session_id:s.id,expression_key:'untrusted imported key',saved:true}]);assert.equal((await note(db,s)).expressions.some(e=>e.key==='untrusted imported key'),false,'backup pointers cannot invent analyzed phrases');
});
test('late transcript, holds, exclusions and other-account evidence cannot appear as current review or be bookmarked',async t=>{
 const db=await setup(t),s=await call(db);await analysis(db,s);const key=(await note(db,s)).expressions[0].key;
 await db.query("insert into public.learning_source_holds(user_id,session_id,evidence_ids,reason) values($1,$2,$3,'wrong_transcript')",[A,s.id,[s.e]]);assert.equal((await note(db,s)).expressions.length,0);assert.equal((await note(db,s)).strengths.length,0);await assert.rejects(save(db,s,key),/no longer available/);
 await db.query('delete from public.learning_source_holds');await db.query("insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,'late','user','Actually, today.',now())",[A,s.id]);const stale=await note(db,s);assert.notEqual(stale.status,'ready');assert.equal(stale.expressions.length,0);
 const other=await call(db,{owner:B});await analysis(db,other);assert.equal((await journal(db)).calls.length,1);await assert.rejects(note(db,other),/Session not found/);await assert.rejects(save(db,other,'missing'),/Session not found/);
});
test('bookmark RLS and RPC approval checks reject direct writes, anonymous users and revoked accounts',async t=>{
 const db=await setup(t),s=await call(db);await analysis(db,s);const key=(await note(db,s)).expressions[0].key;await save(db,s,key);
 assert.equal((await user(db,B,'select * from public.review_bookmarks')).length,0);await assert.rejects(user(db,A,"update public.review_bookmarks set saved=false"),/permission denied/);
 await db.exec('set role anon');try{await assert.rejects(db.query('select public.review_journal()'),/permission denied/);}finally{await db.exec('reset role');}
 await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");await assert.rejects(journal(db),/Account not approved/);assert.equal((await user(db,A,'select * from public.review_bookmarks')).length,0);
});
