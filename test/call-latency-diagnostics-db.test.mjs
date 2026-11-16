import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('latency diagnostics preserve approval, ownership, immutable ACK and strict numeric-only storage', async t => {
  const db = new PGlite({ extensions: { pgcrypto } }); t.after(() => db.close());
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'latency@example.com',now()),($2,'other@example.com',now())", [user, other]);
  await db.exec("insert into loop_private.approved_emails values('latency@example.com'),('other@example.com')");
  const as = async (id, action) => { await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); try { return await action(); } finally { await db.exec('reset role'); } };
  const session = (await as(user, () => db.query("insert into public.sessions(scenario,companion_id) values('Latency fixture','alex') returning id"))).rows[0].id;
  const context = { turn_key: randomUUID(), purpose: 'reply', start_basis: 'speech_stop_received', measurement: 'provider_output_started',
    request_ms: 140, transcription_ms: 100, provider_output_ms: 600 };
  const event = (latency_context = context, extra = {}) => ({ event_id: randomUUID(), session_id: session, occurred_at: new Date().toISOString(),
    client_build: 'git:1234567', kind: 'turn_latency', code: 'REALTIME_PROVIDER_OUTPUT', request_type: 'response.create', elapsed_ms: 1000,
    connection_state: 'connected', data_state: 'open', phase: 'connected', latency_context, ...extra });
  const record = async (rows, owner = user) => (await as(owner, () => db.query('select public.record_call_diagnostics($1::jsonb) result', [JSON.stringify(rows)]))).rows[0].result;
  const first = event();
  assert.deepEqual(await record([first]), { event_ids: [first.event_id], dropped_event_ids: [] });
  assert.deepEqual(await record([first]), { event_ids: [first.event_id], dropped_event_ids: [] });
  assert.deepEqual((await as(user, () => db.query('select latency_context from public.call_diagnostics where event_id=$1', [first.event_id]))).rows[0].latency_context, context);
  assert.deepEqual((await as(other, () => db.query('select event_id from public.call_diagnostics'))).rows, []);
  await assert.rejects(record([first], other), /Session not found/);
  await assert.rejects(record([{ ...first, latency_context: { ...context, provider_output_ms: 601 } }]), /ID reused/);
  for (const [measurement, property] of [['source_saved', 'save_ack_ms'], ['remote_stream_samples', 'first_audio_ms'], ['native_render', 'first_audio_ms']]) {
    const row = event({ ...context, measurement, [property]: 700 });
    assert.deepEqual((await record([row])).event_ids, [row.event_id]);
  }
  for (const value of [null, {}, [], true, 'private speech', { ...context, response_id: 'private provider id' },
    { ...context, transcript: 'private speech' }, { ...context, turn_key: 'private provider id' },
    { ...context, purpose: 'private speech' }, { ...context, start_basis: 'physically_heard' }, { ...context, measurement: 'heard' },
    { ...context, request_ms: -1 }, { ...context, request_ms: 120001 }, { ...context, request_ms: 1.5 }, { ...context, request_ms: '10' },
    { ...context, transcription_ms: null }, { ...context, measurement: 'native_render' }, { ...context, measurement: 'source_saved' },
  ]) await assert.rejects(record([event(value)]), /latency context/);
  const missing = event(); delete missing.latency_context;
  await assert.rejects(record([missing]), /requires context/);
  const good = event();
  await assert.rejects(record([good, event({ ...context, device_id: 'private' })]), /latency context/);
  assert.deepEqual((await db.query('select event_id from public.call_diagnostics where event_id=$1', [good.event_id])).rows, [], 'unsafe whole batch remains atomic');
  await assert.rejects(as(user, () => db.query('update public.call_diagnostics set latency_context=$1 where event_id=$2', [JSON.stringify(context), first.event_id])), /permission denied/);
  await db.exec("delete from loop_private.approved_emails where email='latency@example.com'");
  await assert.rejects(record([event()]), /Account not approved/);
});
