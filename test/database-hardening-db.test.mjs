import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const file = '202611160001_database_hardening.sql';
const directory = new URL('../supabase/migrations/', import.meta.url);
const hardening = await readFile(new URL(file, directory), 'utf8');
const tables = ['memory_state', 'memory_fact_overrides', 'memory_session_exclusions', 'learning_items', 'learning_plans', 'review_bookmarks'];

test('database hardening preserves approval, ownership and server boundaries while improving lookup plans', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on function auth.uid() to public;`);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql') && name < file).sort()) {
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  const publicRpcPrivileges = async () => (await db.query(`select p.oid::regprocedure::text as name,p.proacl::text as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and p.proname<>'rls_auto_enable' order by 1`)).rows;
  const originalRpcPrivileges = await publicRpcPrivileges();
  const originalPolicies = (await db.query(`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
    from pg_policies order by schemaname,tablename,policyname`)).rows;
  // Local databases need no hosted event trigger. Its absence must be harmless.
  await db.exec(hardening);
  assert.equal((await db.query("select to_regprocedure('public.rls_auto_enable()') as fn")).rows[0].fn, null);

  const users = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const sessions = [];
  for (const [i, id] of users.entries()) {
    const email = i === 3 ? null : `hardening-${i}@example.test`;
    await db.query('insert into auth.users values($1,$2,$3)', [id, email, i === 4 ? null : new Date()]);
    if ([0, 1, 4].includes(i)) await db.query('insert into loop_private.approved_emails values($1)', [email]);
    const session = randomUUID(), analysis = randomUUID();
    sessions.push(session);
    await db.query("insert into public.sessions(id,user_id,scenario,companion_id) values($1,$2,'Hardening fixture','alex')", [session, id]);
    await db.query("insert into public.analyses(id,user_id,session_id,kind,content,model) values($1,$2,$3,'session','{}','fixture')", [analysis, id, session]);
    await db.query("insert into public.memory_state(user_id,companion_id) values($1,'alex') on conflict do nothing", [id]);
    await db.query("insert into public.memory_fact_overrides(user_id,companion_id,key,value) values($1,'alex','interest','Walking')", [id]);
    await db.query("insert into public.memory_session_exclusions(user_id,companion_id,session_id) values($1,'alex',$2)", [id, session]);
    await db.query("insert into public.learning_items(user_id,companion_id,session_id,analysis_id,position,original,expression,reason) values($1,'alex',$2,$3,1,'A fixture','A fixture','Fixture')", [id, session, analysis]);
    await db.query("insert into public.learning_plans(user_id,companion_id,scenario) values($1,'alex','A walk')", [id]);
    await db.query("insert into public.review_bookmarks(user_id,session_id,expression_key) values($1,$2,'fixture')", [id, session]);
  }
  const asUser = async (id, work) => {
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try { return await work(); } finally { await db.exec('reset role'); }
  };

  await t.test('all six policies keep account, verified-email and current-approval isolation', async () => {
    for (const table of tables) {
      for (const [i, user] of users.entries()) {
        const rows = (await asUser(user, () => db.query(`select user_id from public.${table}`))).rows;
        assert.deepEqual(rows, i < 2 ? [{ user_id: user }] : [], `${table}, identity ${i}`);
      }
      assert.deepEqual((await asUser('', () => db.query(`select user_id from public.${table}`))).rows, []);
      await assert.rejects(asUser(users[0], () => db.query(`delete from public.${table} where user_id=$1`, [users[0]])), /permission denied/);
      await db.exec('set role anon');
      try { await assert.rejects(db.query(`select * from public.${table}`), /permission denied/); }
      finally { await db.exec('reset role'); }
    }
    // InitPlans cache within a statement, never across approval changes.
    await db.query("insert into loop_private.approved_emails values('hardening-2@example.test')");
    assert.deepEqual((await asUser(users[2], () => db.query('select user_id from public.memory_state'))).rows, [{ user_id: users[2] }]);
    await db.query("delete from loop_private.approved_emails where email='hardening-2@example.test'");
    assert.deepEqual((await asUser(users[2], () => db.query('select user_id from public.memory_state'))).rows, []);
  });

  await t.test('authentication lookups are planned once per statement without changing other policies or RPC grants', async () => {
    const plans = (await asUser(users[0], () => db.query('explain (format json) select * from public.memory_state'))).rows[0]['QUERY PLAN'];
    const walk = value => value && typeof value === 'object' ? [...(value['Parent Relationship'] === 'InitPlan' ? [value] : []), ...Object.values(value).flatMap(walk)] : [];
    assert(walk(plans).length >= 2, 'both stable authentication lookups should become InitPlans');
    const policies = (await db.query(`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies order by schemaname,tablename,policyname`)).rows;
    assert.equal(policies.length, originalPolicies.length);
    for (const before of originalPolicies) {
      const after = policies.find(row => row.schemaname === before.schemaname && row.tablename === before.tablename && row.policyname === before.policyname);
      if (before.schemaname === 'public' && tables.includes(before.tablename)) {
        assert.deepEqual({ ...after, qual: before.qual }, before, 'only the six read expressions change');
      } else assert.deepEqual(after, before);
    }
    assert.deepEqual(await publicRpcPrivileges(), originalRpcPrivileges);
  });

  await t.test('the hosted event trigger keeps firing and its owner retains execution after client ACL removal', async () => {
    await db.exec(`create table loop_private.hardening_trigger_receipts(tag text);
      create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path='pg_catalog' as $$
        begin insert into loop_private.hardening_trigger_receipts(tag) values(tg_tag); end $$;
      grant execute on function public.rls_auto_enable() to public,anon,authenticated;
      create event trigger hardening_auto_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable();`);
    await db.exec(hardening);
    assert.deepEqual((await db.query(`select has_function_privilege('anon','public.rls_auto_enable()','execute') as anon,
      has_function_privilege('authenticated','public.rls_auto_enable()','execute') as authenticated,
      has_function_privilege(current_user,'public.rls_auto_enable()','execute') as owner`)).rows, [{ anon: false, authenticated: false, owner: true }]);
    await db.exec('create table loop_private.hardening_event_probe(id integer)');
    assert.deepEqual((await db.query('select tag from loop_private.hardening_trigger_receipts')).rows, [{ tag: 'CREATE TABLE' }]);
    await db.exec('drop event trigger hardening_auto_rls');
    await db.exec('drop function public.rls_auto_enable()');
    await db.exec("create function public.rls_auto_enable() returns integer language sql as $$select 1$$; grant execute on function public.rls_auto_enable() to anon");
    await db.exec(hardening);
    assert.equal((await db.query("select has_function_privilege('anon','public.rls_auto_enable()','execute') as allowed")).rows[0].allowed, true, 'an unrelated same-named ordinary function is not changed');
  });

  await t.test('selected lookup indexes exist, account deletion still cascades, and server-only tables stay closed', async () => {
    const expected = {
      analyses_session_owner_recent: ['session_id', 'user_id', 'created_at', 'id'],
      analysis_jobs_session_owner: ['session_id', 'user_id'],
      transcript_events_owner_session: ['user_id', 'session_id'],
      conversation_playback_event: ['event_id'],
      conversation_playback_session_owner: ['session_id', 'user_id'],
      conversation_playback_batches_session_owner: ['session_id', 'user_id'],
      call_diagnostics_owner: ['user_id'],
      learning_source_holds_owner_session: ['user_id', 'session_id'],
    };
    const indexes = (await db.query(`select c.relname as name,array_agg(a.attname order by k.ord)::text[] as columns,
      i.indisvalid,i.indisready,array_agg((i.indoption[(k.ord-1)::int]::int & 1)=1 order by k.ord) as descending
      from pg_index i join pg_class c on c.oid=i.indexrelid
      cross join lateral unnest(i.indkey) with ordinality k(attnum,ord)
      join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
      where c.relnamespace='public'::regnamespace and c.relname=any($1::text[])
      group by c.relname,i.indisvalid,i.indisready`, [Object.keys(expected)])).rows;
    assert.equal(indexes.length, Object.keys(expected).length);
    for (const index of indexes) {
      assert.deepEqual(index.columns, expected[index.name]);
      assert.equal(index.indisvalid, true);
      assert.equal(index.indisready, true);
      assert.deepEqual(index.descending, index.name === 'analyses_session_owner_recent' ? [false, false, true, true] : index.columns.map(() => false));
    }
    const boundaries = (await db.query(`select c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'select,insert,update,delete') as anon,
      has_table_privilege('authenticated',c.oid,'select,insert,update,delete') as authenticated,
      (select count(*)::int from pg_policy p where p.polrelid=c.oid) as policies
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname=any($1::text[])`, [['analysis_jobs','api_daily_usage','authored_dialogue_authority','authored_dialogue_calls',
      'authored_dialogue_cancellations','authored_dialogue_turns','conversation_memories','conversation_playback_batches',
      'conversation_playback_receipts','memory_embeddings','model_spend','post_call_tasks']])).rows;
    assert.equal(boundaries.length, 12);
    assert(boundaries.every(row => row.relrowsecurity && row.policies === 0 && !row.anon && !row.authenticated));
    await db.query('delete from auth.users where id=$1', [users[1]]);
    for (const table of tables) assert.equal((await db.query(`select count(*)::int as n from public.${table} where user_id=$1`, [users[1]])).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.sessions where id=$1', [sessions[1]])).rows[0].n, 0);
    assert.deepEqual(await publicRpcPrivileges(), originalRpcPrivileges);
  });
});
