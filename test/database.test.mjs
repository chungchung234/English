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
    'analyses', 'analysis_jobs', 'api_daily_usage', 'sessions', 'transcript_events',
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
