import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function setup(t){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')&&(f.split('_')[0]<='202611100012'||f.startsWith('202611100015_'))).sort())await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 await db.query("insert into auth.users values($1,'owner@example.com',now()),($2,'other@example.com',now())",[owner,other]);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com') on conflict do nothing");
 return db;
}
async function role(db,name,user,work){
 await db.exec('set role '+name);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
 try{return await work();}finally{await db.exec('reset role');}
}
async function session(db,ended=true,user=owner){return role(db,'authenticated',user,async()=>{
 const id=(await db.query("insert into public.sessions(scenario,companion_id) values('Budget test','alex') returning id")).rows[0].id;
 if(ended)await db.query('select public.finish_session($1)',[id]);return id;
});}
async function reserve(db,id,key=randomUUID(),kind='reconsider',user=owner){return role(db,'service_role',user,async()=>(await db.query('select public.reserve_run($1,$2,$3,$4,180) result',[user,kind,key,id])).rows[0].result);}

test('reconsider jobs require an approved owner, ended source and service role',async t=>{
 const db=await setup(t),active=await session(db,false),ended=await session(db),foreign=await session(db,true,other);
 await assert.rejects(reserve(db,active),/ended session/i);
 await assert.rejects(reserve(db,foreign),/ended session/i);
 await assert.rejects(reserve(db,null),/Invalid session/i);
 await assert.rejects(role(db,'authenticated',owner,()=>db.query("select public.reserve_run($1,'reconsider',$2,$3,180)",[owner,randomUUID(),ended])),/permission denied/i);
 await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
 await assert.rejects(reserve(db,ended),/approved/i);
});

test('reconsider retries consume their own daily quota while completed requests replay without spending',async t=>{
 const db=await setup(t),id=await session(db),key=randomUUID();
 const first=await reserve(db,id,key);assert.equal(first.reserved,true);
 await role(db,'service_role',owner,()=>db.query('select public.complete_run($1,$2,$3::jsonb)',[first.job_id,first.lease_token,JSON.stringify({proposal:'stored'})]));
 const replay=await reserve(db,id,key);assert.equal(replay.reserved,false);assert.equal(replay.reason,'completed');
 assert.deepEqual(replay.result,{proposal:'stored'});
 for(let n=1;n<10;n++)assert.equal((await reserve(db,id)).reserved,true);
 assert.equal((await reserve(db,id)).reason,'budget_exceeded');
 const voice=await reserve(db,id,randomUUID(),'voice');assert.equal(voice.reserved,true,'voice keeps its independent existing budget');
 assert.equal((await db.query("select reservations from public.api_daily_usage where user_id=$1 and kind='reconsider'",[owner])).rows[0].reservations,10);
});

test('reconsider cannot turn ANALYSIS_CONTINUE into unlimited retries',async t=>{
 const db=await setup(t),id=await session(db),key=randomUUID();
 for(let n=0;n<10;n++){
  const run=await reserve(db,id,key);assert.equal(run.reserved,true);
  await role(db,'service_role',owner,()=>db.query("select public.fail_run($1,$2,'ANALYSIS_CONTINUE')",[run.job_id,run.lease_token]));
 }
 assert.equal((await reserve(db,id,key)).reason,'budget_exceeded');
});

test('reconsider text reservations share the existing dollar budget and keep lease protection',async t=>{
 const db=await setup(t),id=await session(db),a=await reserve(db,id),b=await reserve(db,id),c=await reserve(db,id);
 const spend=(run,amount,lease=run.lease_token)=>role(db,'service_role',owner,async()=>(await db.query("select public.reserve_model_spend($1,$2,'gpt-6-luna','{}'::jsonb,$3) result",[run.job_id,lease,amount])).rows[0].result);
 assert.equal(await spend(a,.6),true);assert.equal(await spend(a,.6),false,'same lease is not charged twice');
 assert.equal(await spend(b,.4),true);assert.equal(await spend(c,.001),false,'new kind cannot bypass shared budget');
 await assert.rejects(spend(c,.001,randomUUID()),/Invalid spend lease/);
 await assert.rejects(role(db,'authenticated',owner,()=>db.query("select public.reserve_model_spend($1,$2,'gpt-6-luna','{}'::jsonb,0.001)",[c.job_id,c.lease_token])),/permission denied/i);
});
