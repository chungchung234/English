import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('release provenance remains nullable for legacy calls, immutable for new calls, and strictly allowlisted in owned idempotent events',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
  const directory=new URL('../supabase/migrations/',import.meta.url);let legacy;
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()){
    if(name==='202611100014_telemetry_provenance.sql'){
      await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'other@example.com',now())",[A,B]);
      await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com')");
      legacy=(await db.query("insert into public.sessions(user_id,scenario,companion_id) values($1,'Legacy call','alex') returning id",[A])).rows[0].id;
    }
    await db.exec(await readFile(new URL(name,directory),'utf8'));
  }
  const asUser=async(id,fn)=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);try{return await fn();}finally{await db.exec('reset role');}};
  assert.equal((await db.query('select client_build from public.sessions where id=$1',[legacy])).rows[0].client_build,null);
  await assert.rejects(db.query("update public.sessions set client_build='git:abcdef1234567' where id=$1",[legacy]),/immutable/);
  const build='source:1234567890abcdef12345678';
  const session=(await asUser(A,()=>db.query("insert into public.sessions(scenario,companion_id,client_build) values('New call','alex',$1) returning id,client_build",[build]))).rows[0];
  assert.equal(session.client_build,build);
  await assert.rejects(db.query("update public.sessions set client_build='git:abcdef1234567' where id=$1",[session.id]),/immutable/);
  await assert.rejects(db.query('update public.sessions set client_build=null where id=$1',[session.id]),/immutable/);
  await db.query('update public.sessions set client_build=client_build where id=$1',[session.id]);
  await assert.rejects(asUser(A,()=>db.query("insert into public.sessions(scenario,companion_id,client_build) values('Invalid','alex','owner@example.com')")),/check constraint/);
  const eventId=randomUUID(),payload={attribution:'session',status:'success',occurred_at:new Date().toISOString(),new_session_id:session.id,client_build:build,telemetry_schema:1};
  const record=(id=eventId,value=payload,owner=A,sessionId=session.id)=>asUser(owner,()=>db.query("select public.learning_record_event($1,'call_connected','alex',$2,null,null,null,$3::jsonb) value",[id,sessionId,JSON.stringify(value)]));
  assert.equal((await record()).rows[0].value.saved,true);
  assert.equal((await record()).rows[0].value.duplicate,true);
  assert.deepEqual((await db.query('select payload from public.learning_events where event_id=$1',[eventId])).rows[0].payload,payload);
  assert.equal((await db.query("select count(*)::int n from public.learning_events where name='call_connected' and session_id=$1",[session.id])).rows[0].n,1);
  await assert.rejects(record(eventId,{...payload,client_build:'git:abcdef1234567'}),/Event ID reused/);
  await assert.rejects(record(randomUUID(),{...payload,token:'secret'}),/unsupported fields/);
  await assert.rejects(record(randomUUID(),{...payload,client_build:'owner@example.com'}),/Invalid client build/);
  await assert.rejects(record(randomUUID(),{...payload,telemetry_schema:'1'}),/Invalid telemetry schema/);
  await assert.rejects(record(randomUUID(),{...payload,telemetry_schema:null}),/Invalid telemetry schema/);
  await assert.rejects(record(eventId,payload,B),/Session not found/);
  assert.deepEqual((await asUser(B,()=>db.query('select id from public.sessions where id=$1',[session.id]))).rows,[]);
  await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(record(),/Account not approved/);
  await db.exec("insert into loop_private.approved_emails values('owner@example.com')");
  const oldEvent=randomUUID();await record(oldEvent,{attribution:'session'},A,legacy);
  assert.deepEqual((await db.query('select payload from public.learning_events where event_id=$1',[oldEvent])).rows[0].payload,{attribution:'session'});
  const futureEvent=randomUUID();
  const futureSession=(await asUser(A,()=>db.query("insert into public.sessions(scenario,companion_id,client_build) values('Diagnostic call','alex',$1) returning id",[build]))).rows[0].id;
  await record(futureEvent,{attribution:'session',client_build:build,telemetry_schema:1,occurred_at:new Date(Date.now()+10*60*1000).toISOString()},A,futureSession);
  assert.equal((await db.query('select diagnostic from public.learning_events where event_id=$1',[futureEvent])).rows[0].diagnostic,true);
});
