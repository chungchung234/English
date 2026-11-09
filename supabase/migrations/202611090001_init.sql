-- English: private transcripts, durable analyses, and server-owned API reservations.
create extension if not exists pgcrypto with schema extensions;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  scenario text not null default 'Everyday conversation' check (char_length(btrim(scenario)) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (id, user_id),
  check ((status = 'active' and ended_at is null) or (status = 'ended' and ended_at is not null))
);

create table public.transcript_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  event_key text not null check (char_length(event_key) between 1 and 200),
  speaker text not null check (speaker in ('user', 'assistant')),
  text text not null check (char_length(btrim(text)) between 1 and 20000),
  timestamp timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade,
  unique (session_id, event_key)
);
create index transcript_events_session_time on public.transcript_events(session_id, timestamp, id);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid,
  kind text not null check (kind in ('session', 'weekly')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  model text not null check (char_length(model) between 1 and 200),
  created_at timestamptz not null default now(),
  source_event_ids uuid[] not null default '{}',
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade,
  check ((kind = 'session' and session_id is not null) or (kind = 'weekly' and session_id is null))
);
create index analyses_user_created on public.analyses(user_id, created_at desc);
create index analyses_content_search on public.analyses using gin (to_tsvector('simple'::regconfig, content::text));
create index sessions_user_created on public.sessions(user_id, created_at desc);

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid,
  kind text not null check (kind in ('session', 'weekly', 'voice')),
  request_key text not null check (char_length(request_key) between 1 and 200),
  state text not null default 'failed' check (state in ('running', 'completed', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, request_key),
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade,
  check ((kind = 'session' and session_id is not null) or kind = 'voice' or (kind = 'weekly' and session_id is null))
);

create table public.api_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('session', 'weekly', 'voice')),
  reservations integer not null check (reservations >= 0),
  primary key (user_id, day, kind)
);

alter table public.sessions enable row level security;
alter table public.transcript_events enable row level security;
alter table public.analyses enable row level security;
alter table public.analysis_jobs enable row level security;
alter table public.api_daily_usage enable row level security;

create policy sessions_read_own on public.sessions for select to authenticated using (user_id = (select auth.uid()));
create policy sessions_create_own on public.sessions for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'active' and ended_at is null
    and created_at between now() - interval '1 minute' and now() + interval '1 minute');
create policy transcript_read_own on public.transcript_events for select to authenticated using (user_id = (select auth.uid()));
create policy analyses_read_own on public.analyses for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.sessions, public.transcript_events, public.analyses, public.analysis_jobs, public.api_daily_usage from public, anon, authenticated;
grant select, insert on public.sessions to authenticated;
grant select on public.transcript_events, public.analyses to authenticated;
grant all on public.sessions, public.transcript_events, public.analyses, public.analysis_jobs, public.api_daily_usage to service_role;

-- The lock serializes uploads with finish_session. Ended sessions accept delayed
-- uploads so an offline browser can safely recover its queued transcript.
create function public.append_events(p_session_id uuid, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_item jsonb;
  v_existing public.transcript_events%rowtype;
  v_key text;
  v_id uuid;
  v_timestamp timestamptz;
  v_inserted integer := 0;
  v_ids jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform 1 from public.sessions where id = p_session_id and user_id = v_user for update;
  if not found then raise exception 'Session not found' using errcode = '42501'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'events must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_events) > 100 then raise exception 'Maximum 100 events per batch' using errcode = '22023'; end if;
  for v_item in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(v_item) <> 'object'
      or jsonb_typeof(v_item->'event_key') is distinct from 'string'
      or jsonb_typeof(v_item->'speaker') is distinct from 'string'
      or jsonb_typeof(v_item->'text') is distinct from 'string' then
      raise exception 'Each event requires string event_key, speaker and text' using errcode = '22023';
    end if;
    v_key := v_item->>'event_key';
    if char_length(v_key) not between 1 and 200 or (v_item->>'speaker') not in ('user', 'assistant')
      or char_length(btrim(v_item->>'text')) not between 1 and 20000 then
      raise exception 'Invalid event key, speaker or text' using errcode = '22023';
    end if;
    v_id := coalesce((v_item->>'id')::uuid, gen_random_uuid());
    if v_item->>'timestamp' is not null and v_item->>'occurred_at' is not null
      and (v_item->>'timestamp')::timestamptz <> (v_item->>'occurred_at')::timestamptz then
      raise exception 'Conflicting event timestamps' using errcode = '22023';
    end if;
    v_timestamp := coalesce((v_item->>'occurred_at')::timestamptz, (v_item->>'timestamp')::timestamptz, now());
    select * into v_existing from public.transcript_events where session_id = p_session_id and event_key = v_key;
    if found then
      if v_existing.user_id <> v_user or v_existing.speaker <> v_item->>'speaker'
        or v_existing.text <> v_item->>'text'
        or (v_item->>'id' is not null and v_existing.id <> v_id)
        or (coalesce(v_item->>'occurred_at',v_item->>'timestamp') is not null and v_existing.timestamp <> v_timestamp) then
        raise exception 'An event key cannot be reused with different content' using errcode = '23505';
      end if;
      v_ids := v_ids || jsonb_build_array(v_existing.id);
    else
      insert into public.transcript_events(id,user_id,session_id,event_key,speaker,text,timestamp)
        values(v_id,v_user,p_session_id,v_key,v_item->>'speaker',v_item->>'text',v_timestamp);
      v_inserted := v_inserted + 1;
      v_ids := v_ids || jsonb_build_array(v_id);
    end if;
  end loop;
  return jsonb_build_object('inserted',v_inserted,'event_ids',v_ids);
end;
$$;

create function public.finish_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.sessions set status = 'ended', ended_at = coalesce(ended_at,now())
    where id = p_session_id and user_id = auth.uid() returning * into v_session;
  if not found then raise exception 'Session not found' using errcode = '42501'; end if;
  return v_session;
end;
$$;

-- Restore only user-authored data. Analyses must be regenerated by the server.
-- The entire import rolls back if any id, owner or existing content conflicts.
create function public.restore_history(p_backup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_sessions jsonb;
  v_events jsonb;
  v_item jsonb;
  v_existing public.sessions%rowtype;
  v_id uuid;
  v_created timestamptz;
  v_ended timestamptz;
  v_status text;
  v_count integer;
  v_session_count integer := 0;
  v_event_count integer := 0;
  v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_backup is null or jsonb_typeof(p_backup) <> 'object' then
    raise exception 'Backup must be an object' using errcode = '22023';
  end if;
  v_sessions := coalesce(p_backup->'sessions','[]'::jsonb);
  v_events := coalesce(p_backup->'events',p_backup->'transcript_events','[]'::jsonb);
  if jsonb_typeof(v_sessions) <> 'array' or jsonb_typeof(v_events) <> 'array' then
    raise exception 'Backup sessions and events must be arrays' using errcode = '22023';
  end if;
  if jsonb_array_length(v_sessions) > 50 or jsonb_array_length(v_events) > 1000 then
    raise exception 'Restore limit: 50 sessions and 1000 events per request' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(v_sessions) loop
    if jsonb_typeof(v_item) <> 'object' or v_item->>'id' is null
      or jsonb_typeof(v_item->'scenario') is distinct from 'string'
      or v_item->>'created_at' is null or v_item->>'status' is null then
      raise exception 'Invalid backup session' using errcode = '22023';
    end if;
    if v_item->>'user_id' is not null and (v_item->>'user_id')::uuid <> v_user then
      raise exception 'Backup belongs to another user' using errcode = '42501';
    end if;
    v_id := (v_item->>'id')::uuid;
    v_created := (v_item->>'created_at')::timestamptz;
    v_ended := (v_item->>'ended_at')::timestamptz;
    v_status := v_item->>'status';
    insert into public.sessions(id,user_id,scenario,status,created_at,ended_at)
      values(v_id,v_user,v_item->>'scenario',v_status,v_created,v_ended)
      on conflict(id) do nothing;
    get diagnostics v_count = row_count;
    v_session_count := v_session_count + v_count;
    select * into v_existing from public.sessions where id = v_id and user_id = v_user for update;
    if not found then raise exception 'Session id unavailable' using errcode = '42501'; end if;
    if v_existing.scenario <> v_item->>'scenario' or v_existing.status <> v_status
      or v_existing.created_at <> v_created or v_existing.ended_at is distinct from v_ended then
      raise exception 'Backup conflicts with existing session' using errcode = '23505';
    end if;
  end loop;
  for v_item in select value from jsonb_array_elements(v_events) loop
    if jsonb_typeof(v_item) <> 'object' or v_item->>'id' is null
      or v_item->>'session_id' is null then
      raise exception 'Invalid backup event' using errcode = '22023';
    end if;
    if v_item->>'user_id' is not null and (v_item->>'user_id')::uuid <> v_user then
      raise exception 'Backup belongs to another user' using errcode = '42501';
    end if;
    v_result := public.append_events((v_item->>'session_id')::uuid,jsonb_build_array(v_item));
    v_event_count := v_event_count + (v_result->>'inserted')::integer;
  end loop;
  return jsonb_build_object('sessions_inserted',v_session_count,'events_inserted',v_event_count);
end;
$$;

-- Only trusted server code can choose the user, job kind, daily budget or lease.
-- Retries reuse a request key; only a new lease consumes a reservation.
create function public.reserve_run(
  p_user_id uuid, p_kind text, p_request_key text,
  p_session_id uuid default null, p_lease_seconds integer default 180
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.analysis_jobs%rowtype;
  v_limit integer;
  v_count integer;
  v_day date := (now() at time zone 'UTC')::date;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('session','weekly','voice')
    or p_request_key is null or char_length(p_request_key) not between 1 and 200
    or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid reservation' using errcode = '22023';
  end if;
  if p_kind = 'session' and p_session_id is null or p_kind = 'weekly' and p_session_id is not null then
    raise exception 'Invalid session for job kind' using errcode = '22023';
  end if;
  if p_session_id is not null then
    perform 1 from public.sessions where id = p_session_id and user_id = p_user_id
      and (p_kind <> 'session' or status = 'ended');
    if not found then raise exception 'Owned ended session required for session analysis' using errcode = '42501'; end if;
  end if;
  insert into public.analysis_jobs(user_id,kind,request_key,session_id)
    values(p_user_id,p_kind,p_request_key,p_session_id) on conflict(user_id,kind,request_key) do nothing;
  select * into strict v_job from public.analysis_jobs
    where user_id = p_user_id and kind = p_kind and request_key = p_request_key for update;
  if v_job.session_id is distinct from p_session_id then raise exception 'Request key belongs to another session' using errcode = '22023'; end if;
  if v_job.state = 'completed' then
    return jsonb_build_object('job_id',v_job.id,'state',v_job.state,'reserved',false,'reason','completed','result',v_job.result,'attempts',v_job.attempts);
  end if;
  if v_job.state = 'running' and v_job.lease_expires_at > now() then
    return jsonb_build_object('job_id',v_job.id,'state',v_job.state,'reserved',false,'reason','in_progress','attempts',v_job.attempts);
  end if;
  v_limit := case p_kind when 'session' then 20 when 'weekly' then 3 when 'voice' then 30 end;
  insert into public.api_daily_usage(user_id,day,kind,reservations) values(p_user_id,v_day,p_kind,0)
    on conflict(user_id,day,kind) do nothing;
  update public.api_daily_usage set reservations = reservations + 1
    where user_id = p_user_id and day = v_day and kind = p_kind and reservations < v_limit
    returning reservations into v_count;
  if not found then
    return jsonb_build_object('job_id',v_job.id,'state',v_job.state,'reserved',false,'reason','budget_exceeded','attempts',v_job.attempts);
  end if;
  update public.analysis_jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1,
    error = null, updated_at = now() where id = v_job.id returning * into v_job;
  return jsonb_build_object('job_id',v_job.id,'lease_token',v_job.lease_token,'state',v_job.state,
    'reserved',true,'reason','reserved','attempts',v_job.attempts);
end;
$$;

create function public.complete_run(p_job_id uuid, p_lease_token uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_result is null then raise exception 'Result required' using errcode = '22023'; end if;
  update public.analysis_jobs set state = 'completed', result = p_result,
    lease_expires_at = null, updated_at = now()
    where id = p_job_id and state = 'running' and lease_token = p_lease_token
    returning result into v_result;
  if not found then raise exception 'Stale or missing job lease' using errcode = '40001'; end if;
  return v_result;
end;
$$;

create function public.fail_run(p_job_id uuid, p_lease_token uuid, p_error text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.analysis_jobs set state = 'failed', error = left(coalesce(p_error,'Run failed'),1000),
    lease_expires_at = null, updated_at = now()
    where id = p_job_id and state = 'running' and lease_token = p_lease_token;
  return found;
end;
$$;

-- Analysis and completed job result commit together, so a retry cannot create
-- duplicate durable memory when a network response is lost.
create function public.complete_analysis_run(
  p_job_id uuid, p_lease_token uuid, p_content jsonb, p_model text,
  p_source_event_ids uuid[] default '{}'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.analysis_jobs%rowtype;
  v_analysis public.analyses%rowtype;
  v_result jsonb;
begin
  select * into v_job from public.analysis_jobs where id = p_job_id for update;
  if not found or v_job.state <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.kind not in ('session','weekly') then
    raise exception 'Stale or invalid analysis lease' using errcode = '40001';
  end if;
  if p_source_event_ids is null or cardinality(p_source_event_ids) = 0 or exists (
    select 1 from unnest(p_source_event_ids) as source(id)
    left join public.transcript_events as event on event.id = source.id
    where event.id is null or event.user_id <> v_job.user_id
      or (v_job.kind = 'session' and event.session_id <> v_job.session_id)
  ) then raise exception 'Analysis sources must be owned transcript events' using errcode = '22023'; end if;
  insert into public.analyses(user_id,session_id,kind,content,model,source_event_ids)
    values(v_job.user_id,v_job.session_id,v_job.kind,p_content,p_model,p_source_event_ids)
    returning * into v_analysis;
  v_result := jsonb_build_object('analysis',to_jsonb(v_analysis));
  perform public.complete_run(p_job_id,p_lease_token,v_result);
  return v_result;
end;
$$;

-- Search every session's latest validated analysis, preserving four recent
-- memories while also retrieving older relevant ones. Keyword matches appear
-- first so a caller's bounded model context retains the most relevant evidence.
create function public.memory_search(p_user_id uuid, p_query text, p_limit integer default 12)
returns setof public.analyses language plpgsql security definer set search_path = '' as $$
declare v_query tsquery;
begin
  if p_user_id is null or p_limit is null or p_limit not between 1 and 30
    or char_length(coalesce(p_query,'')) > 2000 then
    raise exception 'Invalid memory search' using errcode = '22023';
  end if;
  v_query := websearch_to_tsquery('simple'::regconfig,coalesce(p_query,''));
  return query
    with latest as materialized (
      select distinct on (a.session_id) a.* from public.analyses as a
      where a.user_id = p_user_id and a.kind = 'session'
      order by a.session_id, a.created_at desc, a.id desc
    ), recent as (
      select a.id from latest as a order by a.created_at desc, a.id desc limit least(4,p_limit)
    ), matched as (
      select a.id from latest as a where not exists (select 1 from recent where recent.id = a.id)
      order by (to_tsvector('simple'::regconfig,a.content::text) @@ v_query) desc,
        ts_rank_cd(to_tsvector('simple'::regconfig,a.content::text),v_query) desc,
        a.created_at desc, a.id desc
      limit greatest(0,p_limit - 4)
    )
    select a.* from latest as a where a.id in (select id from recent union all select id from matched)
    order by (to_tsvector('simple'::regconfig,a.content::text) @@ v_query) desc,
      ts_rank_cd(to_tsvector('simple'::regconfig,a.content::text),v_query) desc,
      a.created_at desc, a.id desc;
end;
$$;

-- PostgreSQL grants new functions to PUBLIC by default; revoke every RPC first.
revoke all on function public.append_events(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.finish_session(uuid) from public, anon, authenticated;
revoke all on function public.restore_history(jsonb) from public, anon, authenticated;
revoke all on function public.reserve_run(uuid,text,text,uuid,integer) from public, anon, authenticated;
revoke all on function public.complete_run(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.fail_run(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.complete_analysis_run(uuid,uuid,jsonb,text,uuid[]) from public, anon, authenticated;
revoke all on function public.memory_search(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.append_events(uuid,jsonb), public.finish_session(uuid), public.restore_history(jsonb) to authenticated;
grant execute on function public.reserve_run(uuid,text,text,uuid,integer), public.complete_run(uuid,uuid,jsonb),
  public.fail_run(uuid,uuid,text), public.complete_analysis_run(uuid,uuid,jsonb,text,uuid[]),
  public.memory_search(uuid,text,integer) to service_role;
