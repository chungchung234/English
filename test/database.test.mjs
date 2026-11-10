import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationsUrl = new URL('../supabase/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map((name) => readFile(new URL(name, migrationsUrl), 'utf8')));

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_TIME = '2026-11-08T12:00:00.000Z';

async function database(t) {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());

  // Supabase supplies auth and these API roles. Recreate the small contract the
  // migration needs so the tests exercise its SQL and policies in PostgreSQL.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create schema extensions;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to public;
  `);
  for (const migration of migrations) await db.exec(migration);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.com',now()), ($2,'other@example.com',now())", [USER_A, USER_B]);
  await db.exec("insert into loop_private.approved_emails values ('owner@example.com'), ('other@example.com')");
  return db;
}

async function asUser(db, userId, work) {
  await db.query('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  try {
    return await work();
  } finally {
    await db.query('reset role');
  }
}

async function asService(db, work) {
  await db.query('set role service_role');
  try {
    return await work();
  } finally {
    await db.query('reset role');
  }
}

async function makeSession(db, userId, scenario = 'Coffee shop', companionId = 'alex') {
  return asUser(db, userId, async () => {
    const { rows } = await db.query(
      'insert into public.sessions(scenario, companion_id) values ($1, $2) returning id, user_id, companion_id',
      [scenario, companionId],
    );
    return rows[0];
  });
}

function event(key, text, extras = {}) {
  return { event_key: key, speaker: 'user', text, ...extras };
}

async function append(db, sessionId, events) {
  const { rows } = await db.query(
    'select public.append_events($1, $2::jsonb) as result',
    [sessionId, JSON.stringify(events)],
  );
  return rows[0].result;
}

test('migration applies to the Supabase auth and role contract', async (t) => {
  const db = await database(t);
  const { rows } = await db.query(`
    select tablename from pg_tables
    where schemaname = 'public'
    order by tablename
  `);
  assert.deepEqual(rows.map((row) => row.tablename), [
    'analyses', 'analysis_jobs', 'api_daily_usage', 'learning_items', 'learning_plans', 'memory_embeddings', 'memory_fact_overrides',
    'memory_session_exclusions', 'memory_state', 'sessions', 'transcript_events',
  ]);
});

test('events are idempotent by event key and conflicting batches roll back atomically', async (t) => {
  const db = await database(t);
  const session = await makeSession(db, USER_A);
  const original = event('client-event-1', 'Hello', { id: EVENT_ID, timestamp: EVENT_TIME });

  const first = await asUser(db, USER_A, () => append(db, session.id, [original]));
  const duplicate = await asUser(db, USER_A, () => append(db, session.id, [original]));
  assert.equal(first.inserted, 1);
  assert.equal(duplicate.inserted, 0);
  assert.deepEqual(duplicate.event_ids, first.event_ids);

  await assert.rejects(
    asUser(db, USER_A, () => append(db, session.id, [
      event('new-event-before-conflict', 'This must roll back'),
      event('client-event-1', 'Changed content', { id: EVENT_ID, timestamp: EVENT_TIME }),
    ])),
    /event key cannot be reused/i,
  );
  const { rows } = await db.query(
    'select event_key from public.transcript_events where session_id = $1 order by event_key',
    [session.id],
  );
  assert.deepEqual(rows.map((row) => row.event_key), ['client-event-1']);
});

test('users can read only their own sessions and events; delayed events remain accepted after ending', async (t) => {
  const db = await database(t);
  const sessionA = await makeSession(db, USER_A);
  const sessionB = await makeSession(db, USER_B);

  await asUser(db, USER_A, () => append(db, sessionA.id, [event('a1', 'Earlier event')]));
  await asUser(db, USER_B, () => append(db, sessionB.id, [event('b1', 'Private event')]));

  const visibleToB = await asUser(db, USER_B, async () => {
    const sessions = await db.query('select id from public.sessions order by id');
    const events = await db.query('select session_id from public.transcript_events');
    return { sessions: sessions.rows, events: events.rows };
  });
  assert.deepEqual(visibleToB.sessions.map((row) => row.id), [sessionB.id]);
  assert.deepEqual(visibleToB.events.map((row) => row.session_id), [sessionB.id]);

  await assert.rejects(
    asUser(db, USER_B, () => append(db, sessionA.id, [event('intrusion', 'No access')])),
    /Session not found/i,
  );

  await asUser(db, USER_A, async () => {
    await db.query('select public.finish_session($1)', [sessionA.id]);
    const late = await append(db, sessionA.id, [event('delayed-upload', 'Recovered offline')]);
    assert.equal(late.inserted, 1);
  });
  const { rows } = await db.query(
    "select status, (select count(*) from public.transcript_events where session_id = $1) as event_count from public.sessions where id = $1",
    [sessionA.id],
  );
  assert.equal(rows[0].status, 'ended');
  assert.equal(Number(rows[0].event_count), 2);
});

test('job reservations are server-only, deduplicated, budgeted, and lease protected', async (t) => {
  const db = await database(t);

  await assert.rejects(
    asUser(db, USER_A, () => db.query(
      "select public.reserve_run($1, 'weekly', 'user-cannot-reserve', null, 180)",
      [USER_A],
    )),
    /permission denied/i,
  );

  const run = (requestKey) => db.query(
    "select public.reserve_run($1, 'weekly', $2, null, 180) as result",
    [USER_A, requestKey],
  );
  const first = await asService(db, async () => (await run('weekly-1')).rows[0].result);
  const retry = await asService(db, async () => (await run('weekly-1')).rows[0].result);
  assert.equal(first.reserved, true);
  assert.equal(first.attempts, 1);
  assert.equal(retry.reserved, false);
  assert.equal(retry.reason, 'in_progress');
  assert.equal(retry.job_id, first.job_id);

  await assert.rejects(
    asService(db, () => db.query(
      'select public.complete_run($1, $2, $3::jsonb)',
      [first.job_id, '22222222-2222-4222-8222-222222222222', JSON.stringify({ ok: true })],
    )),
    /Stale or missing job lease/i,
  );

  const completed = await asService(db, () => db.query(
    'select public.complete_run($1, $2, $3::jsonb) as result',
    [first.job_id, first.lease_token, JSON.stringify({ summary: 'saved' })],
  ));
  assert.deepEqual(completed.rows[0].result, { summary: 'saved' });
  const completedRetry = await asService(db, async () => (await run('weekly-1')).rows[0].result);
  assert.equal(completedRetry.reserved, false);
  assert.equal(completedRetry.reason, 'completed');
  assert.deepEqual(completedRetry.result, { summary: 'saved' });

  const budgetResults = await asService(db, async () => {
    const results = [];
    for (const key of ['weekly-2', 'weekly-3', 'weekly-4']) {
      results.push((await run(key)).rows[0].result);
    }
    return results;
  });
  assert.deepEqual(budgetResults.map((result) => result.reserved), [true, true, false]);
  assert.equal(budgetResults[2].reason, 'budget_exceeded');

  const usage = await db.query(
    "select reservations from public.api_daily_usage where user_id = $1 and kind = 'weekly'",
    [USER_A],
  );
  assert.equal(usage.rows[0].reservations, 3);
});

test('history restore is idempotent, rejects foreign data, and rolls back a conflicting batch', async (t) => {
  const db = await database(t);
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const eventId = '44444444-4444-4444-8444-444444444444';
  const createdAt = '2026-11-08T10:00:00.000Z';
  const backup = {
    sessions: [{ id: sessionId, user_id: USER_A, scenario: 'Restore me', status: 'ended', created_at: createdAt, ended_at: '2026-11-08T11:00:00.000Z' }],
    events: [{ id: eventId, user_id: USER_A, session_id: sessionId, event_key: 'restore-1', speaker: 'user', text: 'Saved locally', timestamp: EVENT_TIME }],
  };
  const restore = (payload) => db.query('select public.restore_history($1::jsonb) as result', [JSON.stringify(payload)]);

  const first = await asUser(db, USER_A, async () => (await restore(backup)).rows[0].result);
  const repeated = await asUser(db, USER_A, async () => (await restore(backup)).rows[0].result);
  assert.deepEqual(first, { sessions_inserted: 1, events_inserted: 1 });
  assert.deepEqual(repeated, { sessions_inserted: 0, events_inserted: 0 });

  await assert.rejects(
    asUser(db, USER_B, () => restore({ sessions: [{ ...backup.sessions[0], id: '55555555-5555-4555-8555-555555555555', user_id: USER_A }] })),
    /another user/i,
  );
  await assert.rejects(
    asUser(db, USER_B, () => restore({ sessions: [backup.sessions[0]] })),
    /Session id unavailable|another user/i,
  );

  const extraSessionId = '66666666-6666-4666-8666-666666666666';
  await assert.rejects(
    asUser(db, USER_A, () => restore({
      sessions: [
        { ...backup.sessions[0], id: extraSessionId, scenario: 'Must roll back too' },
        { ...backup.sessions[0], scenario: 'Conflicting existing row' },
      ],
    })),
    /conflicts with existing session/i,
  );
  const { rows } = await db.query('select count(*)::int as count from public.sessions where id = $1', [extraSessionId]);
  assert.equal(rows[0].count, 0);
});

test('analysis completion accepts only same-user same-session sources and caches the committed result', async (t) => {
  const db = await database(t);
  const sessionA = await makeSession(db, USER_A);
  const otherSessionA = await makeSession(db, USER_A, 'Different session');
  const sessionB = await makeSession(db, USER_B);
  const eventA = (await asUser(db, USER_A, () => append(db, sessionA.id, [event('analysis-a', 'A source')]))).event_ids[0];
  const eventAOther = (await asUser(db, USER_A, () => append(db, otherSessionA.id, [event('analysis-other', 'Wrong session source')]))).event_ids[0];
  const eventB = (await asUser(db, USER_B, () => append(db, sessionB.id, [event('analysis-b', 'Private source')]))).event_ids[0];
  await asUser(db, USER_A, () => db.query('select public.finish_session($1)', [sessionA.id]));

  const reserve = () => db.query(
    "select public.reserve_run($1, 'session', 'analysis-request', $2, 180) as result",
    [USER_A, sessionA.id],
  );
  const job = await asService(db, async () => (await reserve()).rows[0].result);
  const complete = (sourceIds) => db.query(
    'select public.complete_analysis_run($1, $2, $3::jsonb, $4, $5::uuid[]) as result',
    [job.job_id, job.lease_token, JSON.stringify({ feedback: 'Good progress' }), 'test-model', sourceIds],
  );
  await assert.rejects(asService(db, () => complete([eventB])), /owned transcript events/i);
  await assert.rejects(asService(db, () => complete([eventAOther])), /owned transcript events/i);

  const saved = await asService(db, async () => (await complete([eventA])).rows[0].result);
  assert.equal(saved.analysis.session_id, sessionA.id);
  assert.equal(saved.analysis.content.feedback, 'Good progress');
  const retry = await asService(db, async () => (await reserve()).rows[0].result);
  assert.equal(retry.reserved, false);
  assert.equal(retry.reason, 'completed');
  assert.deepEqual(retry.result, saved);
  const count = await db.query('select count(*)::int as count from public.analyses where session_id = $1', [sessionA.id]);
  assert.equal(count.rows[0].count, 1);
});

test('memory search includes older matches, uses the latest analysis per session, and enforces service ownership', async (t) => {
  const db = await database(t);
  const userASessions = [];
  for (let i = 0; i < 7; i += 1) userASessions.push(await makeSession(db, USER_A, `A session ${i}`));
  const userBSession = await makeSession(db, USER_B, 'B private session');

  const insertAnalysis = (userId, sessionId, content, createdAt) => db.query(
    `insert into public.analyses(user_id, session_id, kind, content, model, created_at)
     values ($1, $2, 'session', $3::jsonb, 'test-model', $4::timestamptz)`,
    [userId, sessionId, JSON.stringify(content), createdAt],
  );
  // The matching historical row should still be considered after recent sessions.
  await insertAnalysis(USER_A, userASessions[0].id, { note: 'laryngeal resonance improved' }, '2026-09-01T00:00:00Z');
  // A newer version replaces the old searchable version for that same session.
  await insertAnalysis(USER_A, userASessions[1].id, { note: 'laryngeal resonance old version' }, '2026-09-02T00:00:00Z');
  await insertAnalysis(USER_A, userASessions[1].id, { note: 'new version about pacing' }, '2026-11-07T00:00:00Z');
  for (let i = 2; i < 7; i += 1) {
    await insertAnalysis(USER_A, userASessions[i].id, { note: `recent practice ${i}` }, `2026-11-0${i}T00:00:00Z`);
  }
  await insertAnalysis(USER_B, userBSession.id, { note: 'laryngeal resonance private' }, '2026-11-08T00:00:00Z');

  const search = (userId) => db.query(
    "select id, user_id, session_id, content from public.memory_search($1, 'laryngeal', 12)",
    [userId],
  );
  await assert.rejects(asUser(db, USER_A, () => search(USER_A)), /permission denied/i);

  const resultA = await asService(db, async () => (await search(USER_A)).rows);
  assert.ok(resultA.some((row) => row.session_id === userASessions[0].id), 'older relevant session remains searchable');
  const latestVersion = resultA.find((row) => row.session_id === userASessions[1].id);
  assert.ok(latestVersion, 'recent session may be included as part of the recent context');
  assert.equal(latestVersion.content.note, 'new version about pacing', 'superseded searchable content is excluded');
  assert.equal(resultA[0].session_id, userASessions[0].id, 'keyword match ranks above recent irrelevant analyses');
  assert.ok(resultA.every((row) => row.user_id === USER_A));

  const resultB = await asService(db, async () => (await search(USER_B)).rows);
  assert.deepEqual(resultB.map((row) => row.session_id), [userBSession.id]);
});

test('companion memory stays scoped, legacy sessions default to Alex, and restore preserves companion identity', async (t) => {
  const db = await database(t);
  const alex = await makeSession(db, USER_A, 'Alex practice', 'alex');
  const mia = await makeSession(db, USER_A, 'Mia practice', 'mia');
  const juno = await makeSession(db, USER_A, 'Juno practice', 'juno');
  const privateAlex = await makeSession(db, USER_B, 'Other user Alex', 'alex');

  const insertAnalysis = (userId, sessionId, content) => db.query(
    `insert into public.analyses(user_id, session_id, kind, content, model)
     values ($1, $2, 'session', $3::jsonb, 'test-model')`,
    [userId, sessionId, JSON.stringify(content)],
  );
  await insertAnalysis(USER_A, alex.id, { note: 'Alex says use steady pacing' });
  await insertAnalysis(USER_A, mia.id, { note: 'Mia says use bright vowels' });
  await insertAnalysis(USER_A, juno.id, { note: 'Juno says use clear consonants' });
  await insertAnalysis(USER_B, privateAlex.id, { note: 'Private Alex practice' });

  const search = (userId, companion) => db.query(
    'select user_id, session_id, content from public.memory_search($1, $2, 12, $3)',
    [userId, 'use', companion],
  );
  const searchA = async (companion) => asService(db, async () => (await search(USER_A, companion)).rows);
  const alexRows = await searchA('alex');
  const miaRows = await searchA('mia');
  const junoRows = await searchA('juno');
  assert.deepEqual(alexRows.map((row) => row.session_id), [alex.id]);
  assert.deepEqual(miaRows.map((row) => row.session_id), [mia.id]);
  assert.deepEqual(junoRows.map((row) => row.session_id), [juno.id]);
  assert.ok([...alexRows, ...miaRows, ...junoRows].every((row) => row.user_id === USER_A));
  const defaultSearch = await asService(db, async () => (await db.query(
    "select session_id from public.memory_search($1, 'pacing', 12)", [USER_A],
  )).rows);
  assert.deepEqual(defaultSearch.map((row) => row.session_id), [alex.id]);

  const legacyId = '77777777-7777-4777-8777-777777777777';
  const restoredMiaId = '88888888-8888-4888-8888-888888888888';
  const baseTime = '2026-11-08T09:00:00.000Z';
  const backup = {
    sessions: [
      { id: legacyId, scenario: 'Old backup', status: 'active', created_at: baseTime },
      { id: restoredMiaId, scenario: 'Mia backup', status: 'active', created_at: baseTime, companion_id: 'mia' },
    ],
    events: [],
  };
  await asUser(db, USER_A, () => db.query('select public.restore_history($1::jsonb)', [JSON.stringify(backup)]));
  const restored = await db.query('select id, companion_id from public.sessions where id = any($1::uuid[]) order by id', [[legacyId, restoredMiaId]]);
  assert.deepEqual(restored.rows, [
    { id: legacyId, companion_id: 'alex' },
    { id: restoredMiaId, companion_id: 'mia' },
  ]);

  await assert.rejects(
    asUser(db, USER_A, () => db.query('select public.restore_history($1::jsonb)', [JSON.stringify({ sessions: [{ ...backup.sessions[0], id: '99999999-9999-4999-8999-999999999999', companion_id: 'unknown' }] })])),
    /companion/i,
  );
  await assert.rejects(
    asUser(db, USER_A, () => db.query('select public.restore_history($1::jsonb)', [JSON.stringify({ sessions: [{ ...backup.sessions[0], id: 'aaaaaaaa-9999-4999-8999-999999999999', companion_id: null }] })])),
    /companion/i,
  );
  await assert.rejects(
    asUser(db, USER_A, () => db.query('select public.restore_history($1::jsonb)', [JSON.stringify({ sessions: [{ ...backup.sessions[1], id: restoredMiaId, companion_id: 'juno' }] })])),
    /conflicts with existing session/i,
  );

  const visibleToB = await asUser(db, USER_B, () => db.query('select id from public.sessions'));
  assert.deepEqual(visibleToB.rows.map((row) => row.id), [privateAlex.id]);
  await assert.rejects(
    asUser(db, USER_A, () => db.query("insert into public.sessions(scenario, companion_id) values ('Invalid', 'unknown')")),
    /companion/i,
  );
});

test('factual profile survives search eviction, follows speech date, isolates companions and honors forget', async t => {
  const db=await database(t);
  async function factSession(user,companion,key,value,day,quote='I live in Seoul.') {
    const session=await makeSession(db,user,'Ordinary conversation',companion);
    const {rows:[speech]}=await db.query(`insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values ($1,$2,'fact','user',$3,$4) returning id`,[user,session.id,quote,`2026-11-${String(day).padStart(2,'0')}T12:00:00Z`]);
    await db.query(`insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids) values ($1,$2,'session',$3,'test',$4)`,[user,session.id,JSON.stringify({summary:'Conversation',memory_facts:[{key,value,quote,evidence_ids:[speech.id]}]}),[speech.id]]);
    return session;
  }
  const old=await factSession(USER_A,'alex','location','Seoul',1);
  await factSession(USER_A,'alex','location','Busan',5,'I moved to Busan.');
  await factSession(USER_A,'mia','location','Paris',6,'I live in Paris.');
  await factSession(USER_B,'alex','location','London',6,'I live in London.');
  // A late re-analysis of the old call must not overwrite a newer spoken fact.
  await db.query(`update public.analyses set created_at=now()+interval '1 day' where session_id=$1`,[old.id]);
  for(let i=0;i<14;i++){
    const session=await makeSession(db,USER_A,'Recent coffee practice');
    await db.query(`insert into public.analyses(user_id,session_id,kind,content,model,created_at) values ($1,$2,'session','{"summary":"Coffee"}','test',now()+interval '2 days')`,[USER_A,session.id]);
  }
  const profile=async(user,companion)=>asService(db,async()=>{
    const {rows}=await db.query('select session_id,content from public.memory_search($1,$2,12,$3)',[user,'coffee',companion]);
    return rows;
  });
  let rows=await profile(USER_A,'alex');assert.equal(rows.length,12);assert.ok(rows.every(row=>row.session_id!==old.id));
  assert.equal(rows[0].content.memory_profile[0].value,'Busan');
  assert.equal((await profile(USER_A,'mia'))[0].content.memory_profile[0].value,'Paris');
  assert.equal((await profile(USER_B,'alex'))[0].content.memory_profile[0].value,'London');
  await factSession(USER_A,'alex','location','',8,'Please forget where I live.');
  rows=await profile(USER_A,'alex');assert.equal(rows[0].content.memory_profile[0].value,'');assert.equal(rows[0].content.memory_profile[0].forgotten,true);
  // Both the wrapper and raw search stay unavailable to browser roles.
  await asUser(db,USER_A,async()=>{
    await assert.rejects(()=>db.query('select * from public.memory_search_hits($1,$2,12,$3)',[USER_A,'coffee','alex']),/permission denied/);
  });
});

test('analysis continuations retain one parent budget while ordinary failures consume retries', async t=>{
  const db=await database(t);
  const reserve=async()=>asService(db,async()=>(await db.query("select public.reserve_run($1,'weekly','continuation-test',null,600) as result",[USER_A])).rows[0].result);
  const fail=async(run,reason)=>asService(db,()=>db.query('select public.fail_run($1,$2,$3)',[run.job_id,run.lease_token,reason]));
  let run=await reserve();
  for(let i=0;i<4;i++){assert.equal(run.reserved,true);await fail(run,'ANALYSIS_CONTINUE');run=await reserve();}
  let usage=await db.query("select reservations from public.api_daily_usage where user_id=$1 and kind='weekly'",[USER_A]);
  assert.equal(usage.rows[0].reservations,1);
  await fail(run,'UPSTREAM_UNAVAILABLE');run=await reserve();assert.equal(run.reserved,true);
  usage=await db.query("select reservations from public.api_daily_usage where user_id=$1 and kind='weekly'",[USER_A]);assert.equal(usage.rows[0].reservations,2);
});

test('approval revocation blocks own data and every security-definer write path', async (t) => {
  const db = await database(t);
  const session = await makeSession(db, USER_A);
  await asUser(db, USER_A, () => append(db, session.id, [event('before-revocation', 'Hello there')]));
  await db.exec("delete from loop_private.approved_emails where email = 'owner@example.com'");
  await asUser(db, USER_A, async () => {
    for (const table of ['sessions','transcript_events','analyses']) {
      assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
    }
    await assert.rejects(db.query("insert into public.sessions(scenario) values ('Blocked')"), /row-level security/);
    await assert.rejects(append(db, session.id, [event('blocked','No access')]), /Account not approved/);
    await assert.rejects(db.query('select public.finish_session($1)', [session.id]), /Account not approved/);
    await assert.rejects(db.query("select public.restore_history('{\"sessions\":[],\"events\":[]}'::jsonb)"), /Account not approved/);
    await assert.rejects(db.query('select * from loop_private.approved_emails'), /permission denied/);
    await assert.rejects(db.query('select loop_private.finish_session($1)', [session.id]), /permission denied/);
  });
  // An unverified account is denied even if its email appears in the list.
  await db.exec("insert into loop_private.approved_emails values ('owner@example.com'); update auth.users set email_confirmed_at = null where email = 'owner@example.com'");
  assert.equal(await asUser(db, USER_A, async () => (await db.query('select public.is_approved_user() as ok')).rows[0].ok), false);
});

const vector = (axis = 0) => Array.from({ length: 512 }, (_, index) => index === axis ? 1 : 0);
async function memoryRpc(db, name, args, casts) {
  return asService(db, async () => (await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}${casts?.[i] || ''}`).join(',')}) as result`, args)).rows[0].result);
}
async function memoryFixture(db, {user=USER_A,companion='alex',content={summary:'Coffee practice'},day='2026-10-01',fact=null}={}) {
  const session=await makeSession(db,user,'Memory fixture',companion);
  let sources=[];
  if(fact) {
    const quote=fact.quote || `My ${fact.key} is ${fact.value}.`;
    const speech=await asUser(db,user,()=>append(db,session.id,[event(`fact-${session.id}`,quote,{timestamp:`${day}T12:00:00Z`})]));
    sources=speech.event_ids;
    content={...content,memory_facts:[{...fact,quote,evidence_ids:sources}]};
  }
  await asUser(db,user,()=>db.query('select public.finish_session($1)',[session.id]));
  await db.query('update public.sessions set created_at=$2 where id=$1',[session.id,`${day}T00:00:00Z`]);
  const {rows:[analysis]}=await db.query(`insert into public.analyses(user_id,session_id,kind,content,model,created_at,source_event_ids) values($1,$2,'session',$3,'fixture',$4,$5) returning *`,[user,session.id,JSON.stringify(content),`${day}T12:00:00Z`,sources]);
  return {session,analysis};
}
const context=(db,user=USER_A,companion='alex',query='',embedding=null,model='test-512',limit=12)=>memoryRpc(db,'memory_context',[user,companion,query,embedding,model,limit],['','','','::real[]']);
const manage=(db,action,key=null,value=null,session=null,user=USER_A,companion='alex')=>memoryRpc(db,'memory_manage',[user,companion,action,key,value,session]);
const candidates=async(db,user=USER_A,companion='alex',model='test-512')=>asService(db,async()=>(await db.query('select * from public.memory_index_candidates($1,$2,$3,20)',[user,companion,model])).rows);
const store=(db,candidate,embedding=vector(),user=USER_A,companion='alex',model='test-512')=>memoryRpc(db,'memory_store_embedding',[user,companion,candidate.analysis_id,model,candidate.content_hash,embedding,candidate.revision],['','','','','','::real[]']);

test('hybrid mechanics recover an older paraphrase with cosine; keyword, model and latest-version fallbacks remain bounded',async t=>{
  const db=await database(t);
  const old=await memoryFixture(db,{content:{summary:'My work involves caring for patients in a clinic.'},day:'2026-09-01'});
  const exact=await memoryFixture(db,{content:{summary:'physician pronunciation exercise'},day:'2026-09-02'});
  for(let i=1;i<=14;i++) await memoryFixture(db,{content:{summary:`Coffee conversation ${i}`},day:`2026-10-${String(i).padStart(2,'0')}`});
  await memoryFixture(db,{user:USER_B,content:{summary:'physician private'},day:'2026-10-20'});
  await memoryFixture(db,{companion:'mia',content:{summary:'physician Mia'},day:'2026-10-20'});
  for(const row of await candidates(db)) assert.equal(await store(db,row,vector(row.session_id===old.session.id?0:1)),true);
  // These vectors are deliberately synthetic: this verifies retrieval mechanics,
  // not whether a real embedding model understands this paraphrase.
  const semantic=await context(db,USER_A,'alex','medical profession',vector());
  assert.equal(semantic.retrieval,'hybrid');
  assert.equal(semantic.memories[0].session_id,old.session.id);
  assert.equal(semantic.memories.length,12);
  assert.equal(semantic.limited,false);
  assert.equal(semantic.memories.filter(m=>m.created_at>='2026-10-11').length,4,'four latest sessions retained beside old semantic hits');
  assert.equal((await context(db,USER_A,'alex','medical profession',vector(),'test-512',1)).memories[0].session_id,old.session.id);
  const keyword=await context(db,USER_A,'alex','physician');
  assert.equal(keyword.retrieval,'keyword');assert.equal(keyword.memories[0].session_id,exact.session.id);
  const mismatch=await context(db,USER_A,'alex','physician',vector(),'different-model');
  assert.equal(mismatch.retrieval,'keyword');assert.equal(mismatch.memories[0].session_id,exact.session.id);
  assert.ok(semantic.memories.every(m=>m.user_id===USER_A));
  await db.query(`insert into public.analyses(user_id,session_id,kind,content,model) values($1,$2,'session','{"summary":"replacement"}','fixture')`,[USER_A,old.session.id]);
  const replaced=await context(db,USER_A,'alex','',vector());
  assert.ok(replaced.memories.every(m=>m.id!==old.analysis.id));
  assert.ok((await candidates(db)).some(c=>c.session_id===old.session.id && c.analysis_id!==old.analysis.id));
});

test('manual facts work with no hits, changes increment revision and cutoff retains other structured slots',async t=>{
  const db=await database(t);
  const empty=await manage(db,'setFact','name','Ada');
  assert.equal(empty.revision,1);assert.equal(empty.history_suppressed,true);
  const noHistory=await context(db);assert.deepEqual(noHistory.memories,[]);assert.equal(noHistory.facts[0].value,'Ada');
  const history=await memoryFixture(db,{fact:{key:'location',value:'Seoul'},content:{summary:'Seoul city'},day:'2026-10-01'});
  await memoryFixture(db,{fact:{key:'occupation',value:'nurse'},day:'2026-10-02'});
  const before=await manage(db,'list');assert.equal(before.facts.find(f=>f.key==='location').value,'Seoul');
  const forgotten=await manage(db,'forgetFact','location');assert.equal(forgotten.revision,2);
  const after=await context(db,USER_A,'alex','Seoul');
  assert.deepEqual(after.memories,[]);assert.equal(after.facts.find(f=>f.key==='location').forgotten,true);
  assert.equal(after.facts.find(f=>f.key==='occupation').value,'nurse');
  assert.deepEqual(await candidates(db),[]);
  assert.equal((await manage(db,'setFact','location','Busan')).revision,3);
  assert.equal((await context(db)).facts.find(f=>f.key==='location').value,'Busan');
  const live=await makeSession(db,USER_A);
  await assert.rejects(manage(db,'forgetFact','name'),/Finish unfinished calls/);
  assert.equal((await manage(db,'list')).revision,3);
  await asUser(db,USER_A,()=>db.query('select public.finish_session($1)',[live.id]));
  await assert.rejects(manage(db,'setFact','name',' '.repeat(4)),/Invalid memory fact/);
  await assert.rejects(manage(db,'setFact','bad','value'),/Invalid memory fact/);
  await assert.rejects(manage(db,'setFact','name','a'.repeat(241)),/Invalid memory fact/);
  assert.ok(history.analysis.id);
});

test('exclusions gate facts, hits and indexing; restore cannot clear current restrictions',async t=>{
  const db=await database(t);
  const hidden=await memoryFixture(db,{fact:{key:'location',value:'Seoul'}});
  const savedCandidate=(await candidates(db))[0];
  assert.equal((await context(db)).facts[0].value,'Seoul');
  const excluded=await manage(db,'excludeSession',null,null,hidden.session.id);
  assert.equal(excluded.revision,1);assert.equal(excluded.excluded_sessions[0].session_id,hidden.session.id);
  assert.deepEqual((await context(db)).facts,[]);assert.deepEqual((await context(db)).memories,[]);assert.deepEqual(await candidates(db),[]);
  assert.equal(await store(db,savedCandidate),false);
  await asUser(db,USER_A,()=>db.query('select public.restore_history($1::jsonb)',[JSON.stringify({sessions:[],events:[],memory_controls:{state:[{user_id:USER_A,companion_id:'alex',revision:0,history_cutoff:null}],facts:[],exclusions:[]}})]));
  assert.equal((await manage(db,'list')).excluded_sessions.length,1);
  assert.deepEqual((await context(db)).memories,[]);
  const restored=await manage(db,'restoreSession',null,null,hidden.session.id);
  assert.equal(restored.excluded_sessions.length,0);assert.equal((await context(db)).facts[0].value,'Seoul');assert.equal((await candidates(db)).length,1);
  await manage(db,'forgetFact','location');
  await asUser(db,USER_A,()=>db.query('select public.restore_history($1::jsonb)',[JSON.stringify({sessions:[],events:[],memory_controls:{state:[{companion_id:'alex',history_cutoff:null}],facts:[{companion_id:'alex',key:'location',value:'Seoul'}],exclusions:[]}})]));
  const after=await context(db);assert.equal(after.facts[0].forgotten,true);assert.deepEqual(after.memories,[]);
  const other=await memoryFixture(db,{user:USER_B});
  await assert.rejects(manage(db,'excludeSession',null,null,other.session.id),/Owned companion session/);
  await assert.rejects(manage(db,'excludeSession',null,null,hidden.session.id,USER_A,'mia'),/Owned companion session/);
  await assert.rejects(asUser(db,USER_A,()=>db.query('select public.restore_history($1::jsonb)',[JSON.stringify({sessions:[],events:[],memory_controls:{facts:[{user_id:USER_B,companion_id:'alex',key:'name',value:'Intruder'}]}})])),/another user/);
});

test('index writes reject stale revision, hash, analysis, scope and invalid vectors; UTF8 documents are bounded',async t=>{
  const db=await database(t);
  const fixture=await memoryFixture(db,{content:{summary:'가'.repeat(5000),based_on:Array(500).fill(USER_A),scope:{ids:Array(500).fill(USER_A)}}});
  const [candidate]=await candidates(db);assert.ok(Buffer.byteLength(candidate.document,'utf8')<=6000);assert.ok(candidate.document.startsWith('가'));assert.ok(!candidate.document.includes(USER_A));
  assert.equal(await store(db,{...candidate,content_hash:'wrong'}),false);
  assert.equal(await store(db,candidate,vector(),USER_B),false);
  assert.equal(await store(db,candidate,vector(),USER_A,'mia'),false);
  for(const invalid of [[],Array(511).fill(1),Array(512).fill(0),[...Array(511).fill(1),'NaN'],[...Array(511).fill(1),'Infinity']]) {
    await assert.rejects(store(db,candidate,invalid),/Invalid memory vector/);
    await assert.rejects(context(db,USER_A,'alex','',invalid),/Invalid memory vector/);
  }
  assert.equal(await store(db,candidate),true);assert.deepEqual(await candidates(db),[]);
  await db.query(`update public.analyses set content='{"summary":"changed"}' where id=$1`,[fixture.analysis.id]);
  assert.equal(await store(db,candidate),false);assert.equal((await candidates(db)).length,1);
  const stale=(await candidates(db))[0];await manage(db,'setFact','name','Ada');assert.equal(await store(db,stale),false);
});

test('memory RPC grants and backup RLS preserve approval and ownership; stage budgets are independent',async t=>{
  const db=await database(t);
  await manage(db,'setFact','name','Ada');
  await manage(db,'setFact','name','Other',null,USER_B);
  await asUser(db,USER_A,async()=>{
    for(const sql of ['select public.memory_context($1,\'alex\')','select public.memory_manage($1,\'alex\',\'list\')','select * from public.memory_index_candidates($1,\'alex\',\'test\')','select public.memory_store_embedding($1,\'alex\',null,\'test\',\'hash\',null,0)']) await assert.rejects(db.query(sql,[USER_A]),/permission denied/);
    assert.equal((await db.query('select * from public.memory_state')).rows.length,1);
    assert.equal((await db.query('select * from public.memory_fact_overrides')).rows[0].value,'Ada');
    await assert.rejects(db.query('select * from public.memory_embeddings'),/permission denied/);
    await assert.rejects(db.query("update public.memory_fact_overrides set value='Changed'"),/permission denied/);
  });
  for(const [kind,limit] of [['checkpoint',60],['part',80],['embedding',200]]) {
    await db.query('insert into public.api_daily_usage(user_id,day,kind,reservations) values($1,current_date,$2,$3)',[USER_A,kind,limit-1]);
    const run=await memoryRpc(db,'reserve_run',[USER_A,kind,`${kind}-ok`,null,180]);assert.equal(run.reserved,true);
    const blocked=await memoryRpc(db,'reserve_run',[USER_A,kind,`${kind}-blocked`,null,180]);assert.equal(blocked.reason,'budget_exceeded');
  }
  await db.exec("delete from loop_private.approved_emails where email='owner@example.com'");
  await assert.rejects(context(db),/Account not approved/);await assert.rejects(manage(db,'list'),/Account not approved/);await assert.rejects(candidates(db),/Account not approved/);
  await assert.rejects(memoryRpc(db,'reserve_run',[USER_A,'part','unapproved',null,180]),/Account not approved/);
  await asUser(db,USER_A,async()=>{for(const table of ['memory_state','memory_fact_overrides','memory_session_exclusions']) assert.deepEqual((await db.query(`select * from public.${table}`)).rows,[]);});
});

test('restore restrictions commit atomically with active backup sessions and repeated controls retain revision and cutoff',async t=>{
  const db=await database(t);
  const id='c1111111-1111-4111-8111-111111111111';
  const backup={sessions:[{id,user_id:USER_A,companion_id:'alex',scenario:'Interrupted imported conversation',status:'active',created_at:'2026-10-01T00:00:00Z'}],events:[],memory_controls:{state:[],facts:[{companion_id:'alex',key:'name',value:'Ada'}],exclusions:[{companion_id:'alex',session_id:id}]}};
  const restore=payload=>asUser(db,USER_A,()=>db.query('select public.restore_history($1::jsonb) as result',[JSON.stringify(payload)]));
  assert.equal((await restore(backup)).rows[0].result.sessions_inserted,1);
  const state=async()=>(await db.query('select revision,history_cutoff from public.memory_state where user_id=$1 and companion_id=\'alex\'',[USER_A])).rows[0];
  const first=await state();assert.equal(Number(first.revision),1);
  assert.equal((await db.query('select status from public.sessions where id=$1',[id])).rows[0].status,'active');
  await restore(backup);assert.deepEqual(await state(),first);
  await assert.rejects(manage(db,'forgetFact','name'),/Finish unfinished calls/);
  const extra='c2222222-2222-4222-8222-222222222222';
  await assert.rejects(restore({sessions:[{...backup.sessions[0],id:extra}],events:[],memory_controls:{facts:[{companion_id:'alex',key:'occupation',value:'nurse'}]}}),/Finish unfinished calls/);
  assert.equal((await db.query('select count(*)::int n from public.sessions where id=$1',[extra])).rows[0].n,0);
  assert.equal((await context(db)).facts[0].value,'Ada');assert.deepEqual((await context(db)).memories,[]);
});

test('retrieval scan and exclusion response caps are explicit',async t=>{
  const db=await database(t);
  await db.query(`insert into public.sessions(user_id,scenario,status,created_at,ended_at)
    select $1,'bounded history','ended',now()-make_interval(secs=>n),now() from generate_series(1,2001) n`,[USER_A]);
  await db.query(`insert into public.analyses(user_id,session_id,kind,content,model,created_at)
    select user_id,id,'session',jsonb_build_object('summary','bounded keyword'),'fixture',created_at from public.sessions where user_id=$1`,[USER_A]);
  const result=await context(db,USER_A,'alex','keyword',null,'test-512',30);assert.equal(result.limited,true);assert.equal(result.memories.length,12);
  await db.query(`insert into public.memory_session_exclusions(user_id,companion_id,session_id) select user_id,companion_id,id from public.sessions where user_id=$1 limit 31`,[USER_A]);
  const listed=await manage(db,'list');assert.equal(listed.excluded_sessions.length,30);assert.equal(listed.excluded_sessions_limited,true);
});


test('fact mutations never decrease a later cutoff restored from backup',async t=>{
  const db=await database(t);
  const cutoff='2099-01-01T00:00:00.000Z';
  await asUser(db,USER_A,()=>db.query('select public.restore_history($1::jsonb)',[JSON.stringify({sessions:[],events:[],memory_controls:{state:[{companion_id:'alex',history_cutoff:cutoff}]}})]));
  await manage(db,'setFact','name','Ada');
  await manage(db,'forgetFact','name');
  const {rows:[state]}=await db.query('select revision,history_cutoff from public.memory_state where user_id=$1 and companion_id=\'alex\'',[USER_A]);
  assert.equal(new Date(state.history_cutoff).toISOString(),cutoff);
  assert.equal(Number(state.revision),3);
  assert.equal((await context(db)).facts[0].forgotten,true);
});

test('practice is cloud-confirmed, scoped, idempotent and separate from later user reuse', async t=>{
 const db=await database(t),session=await makeSession(db,USER_A);
 await asUser(db,USER_A,()=>append(db,session.id,[event('learning-source','Yesterday I go to the cafe.',{id:EVENT_ID})]));
 await asUser(db,USER_A,()=>db.query('select public.finish_session($1)',[session.id]));
 const content={corrections:[{original:'I go',improved:'I went',reason:'Past tense',evidence_ids:[EVENT_ID]}],practice:[{expression:'I went',evidence_ids:[EVENT_ID]},{expression:'That sounds nice.',evidence_ids:[EVENT_ID]},{expression:'I would like to try.',evidence_ids:[EVENT_ID]},{expression:'Fourth expression',evidence_ids:[EVENT_ID]}]};
 const {rows:[analysis]}=await db.query("insert into public.analyses(user_id,session_id,kind,model,content,source_event_ids) values($1,$2,'session','fixture',$3,$4) returning id",[USER_A,session.id,JSON.stringify(content),[EVENT_ID]]);
 const review=(user,params=[])=>asUser(db,user,async()=>{const {rows}=await db.query('select public.learning_review($1,$2,$3,$4) as result',['alex',params[0]||null,params[1]||null,params[2]||null]);return rows[0].result;});
 const plan=await asUser(db,USER_A,()=>db.query("select public.learning_plan('alex','Talk about a weekend walk.') as result"));assert.equal(plan.rows[0].result.scenario,'Talk about a weekend walk.');
 assert.equal((await asUser(db,USER_A,()=>db.query("select public.learning_plan('alex') as result"))).rows[0].result.scenario,plan.rows[0].result.scenario);
 assert.equal((await asUser(db,USER_B,()=>db.query("select public.learning_plan('alex') as result"))).rows[0].result.scenario,null);
 const initial=await review(USER_A,[analysis.id]);assert.equal(initial.length,3);assert(initial.every(row=>row.state==='unpracticed'&&row.reuse===null));
 assert.deepEqual((await review(USER_A,[analysis.id])).map(row=>row.id).sort(),initial.map(row=>row.id).sort());
 const item=initial.find(row=>row.expression==='I went');
 await assert.rejects(review(USER_B,[null,item.id,'practiced']));
 const practiced=await review(USER_A,[null,item.id,'practiced']);const when=practiced.find(row=>row.id===item.id).practiced_at;
 assert.equal((await review(USER_A,[null,item.id,'practiced'])).find(row=>row.id===item.id).practiced_at,when);
 await assert.rejects(review(USER_A,[null,item.id,'mastered']));
 const later=await makeSession(db,USER_A);
 await asUser(db,USER_A,()=>append(db,later.id,[event('assistant-reuse','I went',{speaker:'assistant'})]));
 await asUser(db,USER_A,()=>db.query('select public.finish_session($1)',[later.id]));
 assert.equal((await review(USER_A)).find(row=>row.id===item.id).reuse,null);
 await asUser(db,USER_A,()=>append(db,later.id,[event('user-reuse','I went to the park.')]));
 assert.equal((await review(USER_A)).find(row=>row.id===item.id).reuse.text,'I went to the park.');
 assert.equal((await asService(db,()=>db.query('select public.learning_context($1,$2) as result',[USER_A,'alex']))).rows[0].result.length,1);
 await db.query('insert into public.memory_session_exclusions(user_id,companion_id,session_id) values($1,$2,$3)',[USER_A,'alex',session.id]);
 assert.equal((await asService(db,()=>db.query('select public.learning_context($1,$2) as result',[USER_A,'alex']))).rows[0].result.length,0);
 await asUser(db,USER_A,()=>append(db,session.id,[event('late-learning-source','One more detail.')]));
 await assert.rejects(review(USER_A,[analysis.id]));assert.equal((await review(USER_A)).length,0,'stale source feedback cannot remain in the practice queue');
 await assert.rejects(review(USER_A,[null,item.id,'practiced']));
 await db.query("delete from loop_private.approved_emails where email='owner@example.com'");await assert.rejects(review(USER_A));
});
