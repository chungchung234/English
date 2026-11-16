// Exercise the actual migration and guards locally. PGlite does not simulate
// PostgREST's retry runner; the transaction-error-code invariant is explicit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationPath = 'supabase/migrations/202611160003_nonretryable_business_conflicts.sql';
const businessRaise = /(using\s+errcode\s*=\s*)'40001'/gi;
const routinesSQL = `select p.oid,p.oid::regprocedure::text as signature,p.prosrc,p.prosecdef,p.proconfig,p.proacl::text as acl,
 p.provolatile,p.proparallel,p.prorettype,p.proretset,p.prokind,p.proargtypes::text as argtypes,p.proargnames,
 pg_get_userbyid(p.proowner) as owner,pg_get_function_result(p.oid) as result
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
 where n.nspname in ('public','loop_private') and l.lanname='plpgsql' order by p.oid`;
const conflict = message => error => error.code === 'PT409' && error.message === message;

test('business conflicts preserve all guards and metadata while terminating outside serialization retry', async t => {
 const db = new PGlite({ extensions: { pgcrypto } }); t.after(() => db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 const names = (await readdir('supabase/migrations')).filter(name => name.endsWith('.sql') && name < '202611160003').sort();
 for (const name of names) await db.exec(await readFile('supabase/migrations/' + name, 'utf8'));
 const original = (await db.query(routinesSQL)).rows;
 const targeted = original.filter(row => [...row.prosrc.matchAll(new RegExp(businessRaise))].length);
 assert.equal(targeted.length, 29);
 assert.equal(targeted.reduce((n, row) => n + [...row.prosrc.matchAll(new RegExp(businessRaise))].length, 0), 60);
 await db.exec(`create function loop_private.unlisted_serialization_canary() returns void language plpgsql as $$begin raise sqlstate '40001';end$$;`);
 const canary = (await db.query("select prosrc from pg_proc where oid='loop_private.unlisted_serialization_canary()'::regprocedure")).rows[0].prosrc;
 const migration = await readFile(migrationPath, 'utf8'); await db.exec(migration);
 const updated = (await db.query(routinesSQL)).rows;
 await t.test('exact allowlist changes only literal business SQLSTATEs, retaining all routine metadata and permissions', async () => {
  assert.equal(updated.length, original.length + 1);
  for (const before of original) {
   const after = updated.find(row => row.oid === before.oid); assert(after, before.signature);
   const expected = before.prosrc.replace(businessRaise, "$1'PT409'");
   assert.equal(after.prosrc, expected, before.signature + ' body');
   assert.deepEqual({ ...after, prosrc: before.prosrc }, before, before.signature + ' metadata');
  }
  assert.equal((await db.query("select prosrc from pg_proc where oid='loop_private.unlisted_serialization_canary()'::regprocedure")).rows[0].prosrc, canary);
  await assert.rejects(db.query('select loop_private.unlisted_serialization_canary()'), error => error.code === '40001', 'unlisted serialization behavior stays unchanged');
  assert.equal([...updated.filter(row => row.prosrc !== canary).flatMap(row => [...row.prosrc.matchAll(new RegExp(businessRaise))])].length, 0);
  // PTxyz is PostgREST's explicit HTTP status family, not Hasql's 40001/40P01 retry family.
  assert.equal(Number('PT409'.slice(2)), 409); assert(!['40001', '40P01'].includes('PT409'));
 });
 const user = randomUUID();
 await db.query("insert into auth.users values($1,'business-conflict-fixture@example.test',now())", [user]);
 await db.exec("insert into loop_private.approved_emails values('business-conflict-fixture@example.test')");
 async function call(epoch = 1) {
  const sid = (await db.query("insert into public.sessions(user_id,companion_id,scenario,created_at) values($1,'alex','Natural English conversation about everyday life',now()-interval '1 hour') returning id", [user])).rows[0].id;
  const state = (await db.query('select public.authored_dialogue_context($1,$2,true,$3,false) as state', [user, sid, epoch])).rows[0].state;
  return { sid, state };
 }
 await t.test('ended-call, stale-authority and retired-history guards still reject the original requests once with PT409', async () => {
  const ended = await call();
  await db.query("update public.sessions set status='ended',ended_at=now() where id=$1", [ended.sid]);
  await assert.rejects(db.query('select loop_private.authored_lock_call($1,$2,false)', [user, ended.sid]), conflict('DIALOGUE_SESSION_ENDED'));
  const active = await call(3), generation = active.state.authority_generation;
  await assert.rejects(db.query('select public.authored_dialogue_state($1,$2,1,$3,0,null,$4)', [user, active.sid, generation, randomUUID()]), conflict('DIALOGUE_STALE_AUTHORITY'));
  const old = (await db.query("insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,'user','A synthetic earlier turn.',now()-interval '20 minutes') returning id", [user, active.sid, randomUUID()])).rows[0].id;
  await db.query("update public.authored_dialogue_calls set retired_before=now()-interval '10 minutes' where session_id=$1", [active.sid]);
  await assert.rejects(db.query('select public.authored_dialogue_history($1,$2,3,$3,0,$4::uuid[],$5::uuid[],null)', [user, active.sid, generation, [], [old]]), conflict('DIALOGUE_RETIRED_HISTORY'));
  await assert.rejects(db.query('select public.complete_run($1,$2,$3)', [randomUUID(), randomUUID(), {}]), conflict('Stale or missing job lease'));
  await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  try {
   await assert.rejects(db.query('select public.record_conversation_playback($1,$2::uuid[],$3,$4::uuid[],0)', [active.sid, [randomUUID()], randomUUID(), [old]]), conflict('PLAYBACK_SOURCE_NOT_SAVED'));
  } finally { await db.exec('reset role'); }
 });
 await t.test('idempotence is exact and an unexpected routine body fails closed', async () => {
  const before = (await db.query(routinesSQL)).rows; await db.exec(migration);
  assert.deepEqual((await db.query(routinesSQL)).rows, before);
  await db.exec('begin');
  try {
   const row = (await db.query("select pg_get_functiondef('loop_private.authored_lock_call(uuid,uuid,boolean)'::regprocedure) as definition")).rows[0];
   await db.exec(row.definition.replace('DIALOGUE_SESSION_ENDED', 'UNEXPECTED_SOURCE_CANARY'));
   await assert.rejects(db.exec(migration), conflict('BUSINESS_CONFLICT_SOURCE_CHANGED: loop_private.authored_lock_call(uuid,uuid,boolean)'));
  } finally { await db.exec('rollback'); }
  assert.deepEqual((await db.query(routinesSQL)).rows, before, 'source rejection cannot partially patch unrelated routines');
 });
});
