import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function database(t) {
  const db = new PGlite({ extensions: { pgcrypto } }); t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated,service_role; grant execute on function auth.uid() to public;`);
  const directory = new URL('../supabase/migrations/', import.meta.url); let legacy;
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    if (name === '202611110001_temporal_memory.sql') {
      await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'other@example.com',now())", [A, B]);
      await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com')");
      legacy = (await db.query("insert into public.sessions(user_id,scenario,status,created_at,ended_at) values($1,'Legacy','ended','2026-10-01T00:00:00Z','2026-10-01T00:10:00Z') returning id", [A])).rows[0].id;
    }
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  return { db, legacy };
}
async function asRole(db, role, user, work) {
  await db.exec(`set role ${role}`);
  if (user) await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  try { return await work(); } finally { await db.exec('reset role'); }
}
const asUser = (db, user, work) => asRole(db, 'authenticated', user, work);
const asService = (db, work) => asRole(db, 'service_role', null, work);
const restore = (db, backup, user = A) => asUser(db, user, async () => (await db.query('select public.restore_history($1::jsonb) value', [JSON.stringify(backup)])).rows[0].value);
const context = (db, user = A, companion = 'alex', limit = 12) => asService(db, async () => (await db.query("select public.memory_context($1,$2,'',null,'text-embedding-3-small',$3) value", [user, companion, limit])).rows[0].value);
async function session(db, { user = A, companion = 'alex', created = '2026-11-01T05:00:00Z', zone = 'America/New_York' } = {}) {
  return (await db.query("insert into public.sessions(user_id,scenario,companion_id,status,created_at,ended_at,time_zone) values($1,'A past call',$2,'ended',$3,$3::timestamptz+interval '20 minutes',$4) returning *", [user, companion, created, zone])).rows[0];
}
async function speech(db, call, text, { speaker = 'user', timestamp = '2026-11-01T05:01:00Z' } = {}) {
  return (await db.query('insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,$4,$5,$6) returning *', [call.user_id, call.id, randomUUID(), speaker, text, timestamp])).rows[0];
}
async function analysis(db, call, sources = [], created = '2026-11-02T00:00:00Z') {
  return (await db.query("insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids,created_at) values($1,$2,'session','{\"summary\":\"A remembered conversation\"}','fixture',$3,$4) returning *", [call.user_id, call.id, sources, created])).rows[0];
}

test('call time zone is validated and immutable while legacy UTC instants and unknown zones stay intact', async t => {
  const { db, legacy } = await database(t);
  assert.equal((await db.query('select time_zone from public.sessions where id=$1', [legacy])).rows[0].time_zone, null);
  const call = (await asUser(db, A, () => db.query("insert into public.sessions(scenario,time_zone) values('New call','Asia/Seoul') returning *"))).rows[0];
  assert.equal(call.time_zone, 'Asia/Seoul');
  for (const zone of ['', 'Asia/Not_A_Zone', '+09:00', 'owner@example.com', 'A'.repeat(101)]) {
    await assert.rejects(asUser(db, A, () => db.query("insert into public.sessions(scenario,time_zone) values('Bad zone',$1)", [zone])), /Invalid session time zone/);
  }
  await assert.rejects(db.query("update public.sessions set time_zone='UTC' where id=$1", [call.id]), /immutable/);
  await assert.rejects(db.query('update public.sessions set time_zone=null where id=$1', [call.id]), /immutable/);
  await assert.rejects(db.query("update public.sessions set time_zone='Asia/Seoul' where id=$1", [legacy]), /immutable/);
  await db.query('update public.sessions set time_zone=time_zone where id=$1', [call.id]);
  assert.deepEqual((await asUser(db, B, () => db.query('select id,time_zone from public.sessions where id=$1', [call.id]))).rows, []);
  await assert.rejects(asUser(db, A, () => db.query("insert into public.sessions(user_id,scenario,time_zone) values($1,'Other user','UTC')", [B])), /row-level security/);
  const dst = await db.query("select '2026-11-01T05:30:00Z'::timestamptz first_utc,'2026-11-01T06:30:00Z'::timestamptz second_utc,to_char('2026-11-01T05:30:00Z'::timestamptz at time zone 'America/New_York','YYYY-MM-DD HH24:MI') first_local,to_char('2026-11-01T06:30:00Z'::timestamptz at time zone 'America/New_York','YYYY-MM-DD HH24:MI') second_local");
  assert.equal(dst.rows[0].first_local, dst.rows[0].second_local);
  assert.equal(new Date(dst.rows[0].second_utc) - new Date(dst.rows[0].first_utc), 3_600_000, 'DST repeated clock time never collapses the stored UTC instant');
});

test('backup restoration preserves explicit zones, old backups, strict replay conflicts and memory exclusions atomically', async t => {
  const { db } = await database(t);
  const row = { id: randomUUID(), user_id: A, companion_id: 'alex', scenario: 'Saved call', status: 'ended', created_at: '2026-11-01T05:10:00Z', ended_at: '2026-11-01T05:20:00Z', time_zone: 'America/New_York' };
  const backup = { sessions: [row], events: [], memory_controls: { state: [], facts: [], exclusions: [{ companion_id: 'alex', session_id: row.id }] } };
  assert.equal((await restore(db, backup)).sessions_inserted, 1);
  assert.equal((await restore(db, backup)).sessions_inserted, 0);
  let saved = (await db.query('select * from public.sessions where id=$1', [row.id])).rows[0];
  assert.equal(saved.time_zone, row.time_zone); assert.equal(new Date(saved.created_at).toISOString(), '2026-11-01T05:10:00.000Z');
  assert.equal((await db.query('select count(*)::int n from public.memory_session_exclusions where session_id=$1', [row.id])).rows[0].n, 1);
  const oldRow = { ...row }; delete oldRow.time_zone;
  await restore(db, { sessions: [oldRow], events: [] });
  assert.equal((await db.query('select time_zone from public.sessions where id=$1', [row.id])).rows[0].time_zone, row.time_zone);
  for (const zone of ['Asia/Seoul', null]) await assert.rejects(restore(db, { sessions: [{ ...row, time_zone: zone }], events: [] }), /conflicts/);
  for (const zone of [42, {}, 'Not/AZone']) await assert.rejects(restore(db, { sessions: [{ ...row, time_zone: zone }], events: [] }), /Invalid .*time zone/);
  const insertedBeforeConflict = { ...row, id: randomUUID() };
  await assert.rejects(restore(db, { sessions: [insertedBeforeConflict, { ...row, time_zone: 'UTC' }], events: [] }), /conflicts/);
  assert.equal((await db.query('select count(*)::int n from public.sessions where id=$1', [insertedBeforeConflict.id])).rows[0].n, 0);
  await assert.rejects(restore(db, { sessions: [row], events: [] }, B), /another user/);
  await assert.rejects(asUser(db, A, () => db.query('select loop_private.restore_history($1::jsonb)', [JSON.stringify(backup)])), /permission denied/);
  await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(restore(db, backup), /Account not approved/);
});

test('retrieved memories retain original call dates and bounded same-source user evidence without crossing scopes', async t => {
  const { db } = await database(t);
  const own = await session(db), other = await session(db, { user: B }), mia = await session(db, { companion: 'mia' });
  const included = [];
  for (let n = 0; n < 8; n++) included.push(await speech(db, own, n === 0 ? 'x'.repeat(700) : `My original detail ${n}`, { timestamp: `2026-11-01T05:0${n}:00Z` }));
  const assistant = await speech(db, own, 'Assistant text must not become remembered user evidence.', { speaker: 'assistant' });
  const foreign = await speech(db, other, 'Another account secret.'), crossCompanion = await speech(db, mia, 'Mia-only detail.');
  const uncited = await speech(db, own, 'Uncited current detail.');
  const a = await analysis(db, own, [...included.map(row => row.id), assistant.id, foreign.id, crossCompanion.id]);
  await analysis(db, other, [foreign.id]); await analysis(db, mia, [crossCompanion.id]);
  const memory = (await context(db)).memories[0];
  assert.equal(memory.id, a.id); assert.equal(memory.session_time_zone, 'America/New_York');
  assert.equal(new Date(memory.session_created_at).toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(new Date(memory.created_at).toISOString(), '2026-11-02T00:00:00.000Z', 'analysis generation time remains a distinct field');
  assert.equal(new Date(memory.session_ended_at).toISOString(), '2026-11-01T05:20:00.000Z');
  assert.equal(memory.evidence.length, 6); assert.equal(memory.evidence[0].text.length, 500);
  assert.deepEqual(memory.evidence.map(row => row.id), included.slice(0, 6).map(row => row.id));
  assert(!memory.evidence.some(row => [assistant.id, foreign.id, crossCompanion.id, uncited.id].includes(row.id)));
  assert.equal((await context(db, A, 'mia')).memories[0].evidence[0].id, crossCompanion.id);
  await assert.rejects(asUser(db, A, () => db.query("select public.memory_context($1,'alex')", [A])), /permission denied/);
  await asService(db, () => db.query("select public.memory_manage($1,'alex','excludeSession',null,null,$2)", [A, own.id]));
  assert.deepEqual((await context(db)).memories, []);
  assert.equal((await context(db, B)).memories.length, 1, 'another owner is unaffected by this exclusion');
});

test('recent and fallback retrieval use conversation dates even when an old call is reanalysed later', async t => {
  const { db } = await database(t);
  const old = await session(db, { created: '2026-09-01T00:00:00Z', zone: null });
  const recent = await session(db, { created: '2026-11-01T00:00:00Z', zone: 'Asia/Seoul' });
  const oldAnalysis = await analysis(db, old, [], '2026-11-10T00:00:00Z');
  const recentAnalysis = await analysis(db, recent, [], '2026-11-02T00:00:00Z');
  const memories = (await context(db, A, 'alex', 1)).memories;
  assert.deepEqual(memories.map(row => row.id), [recentAnalysis.id]);
  const both = (await context(db, A, 'alex', 2)).memories;
  assert.deepEqual(both.map(row => row.id), [recentAnalysis.id, oldAnalysis.id]);
  assert.equal(both[1].session_time_zone, null, 'old call time zone is not inferred');
});

test('last conversation survives failed analysis, skips empty calls, and cannot cross account, companion, exclusion or approval boundaries',async t=>{
  const {db}=await database(t);
  for(const companion of ['alex','mia','juno']){
    const previous=await session(db,{companion,created:'2026-11-09T00:00:00Z'});
    await speech(db,previous,'Yesterday I planned a train trip.',{timestamp:'2026-11-09T00:01:00Z'});
    await speech(db,previous,'Where would you like to go?',{speaker:'assistant',timestamp:'2026-11-09T00:02:00Z'});
    await db.query("insert into public.analysis_jobs(user_id,session_id,kind,request_key,state,error) values($1,$2,'session',$3,'failed','INVALID_MODEL_OUTPUT')",[A,previous.id,'failed-review-'+previous.id]);
    await session(db,{companion,created:'2026-11-10T00:00:00Z'}); // no user speech
    const foreign=await session(db,{user:B,companion,created:'2026-11-10T00:00:00Z'});await speech(db,foreign,'Another account secret.');
    const result=await context(db,A,companion);
    assert.equal(result.recent_conversation.session_id,previous.id);assert.equal(result.recent_conversation.analysis_status,'failed');
    assert.equal(result.recent_conversation.turns.length,2);assert(!JSON.stringify(result).includes('Another account secret'));
    assert.deepEqual(result.memories,[],'recent original speech does not require an analysis');
    await asService(db,()=>db.query("select public.memory_manage($1,$2,'excludeSession',null,null,$3)",[A,companion,previous.id]));
    assert.equal((await context(db,A,companion)).recent_conversation,null,'excluded dialogue never returns through raw fallback');
  }
  await assert.rejects(asUser(db,A,()=>db.query("select loop_private.recent_conversation($1,'alex')",[B])),/permission denied/);
  await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(context(db,A,'alex'),/Account not approved/);
});

test('partial call and wrong-transcript hold never become a raw-memory bypass',async t=>{
 const {db}=await database(t);const prior=await session(db);
 await speech(db,prior,'This source needs correction.');
 await db.query("insert into public.learning_source_holds(user_id,session_id,reason) values($1,$2,'wrong_transcript')",[A,prior.id]);
 assert.equal((await context(db)).recent_conversation,null);
 await db.query('delete from public.learning_source_holds where session_id=$1',[prior.id]);
 await db.query('update public.sessions set record_incomplete=true where id=$1',[prior.id]);
 assert.equal((await context(db)).recent_conversation,null,'explicit incomplete-record finalization is not normal remembered history');
 await db.query('update public.sessions set record_incomplete=false where id=$1',[prior.id]);
 await db.query("update public.sessions set status='active',ended_at=null where id=$1",[prior.id]);
 assert.equal((await context(db)).recent_conversation,null);
 await db.query("update public.sessions set status='ended',ended_at=created_at+interval '20 minutes' where id=$1",[prior.id]);
 assert((await context(db)).recent_conversation);
 await asService(db,()=>db.query("select public.memory_manage($1,'alex','forgetFact','goal')",[A]));
 const forgotten=await context(db);assert.equal(forgotten.recent_conversation,null);assert(forgotten.facts.some(f=>f.key==='goal'&&f.forgotten));
});
