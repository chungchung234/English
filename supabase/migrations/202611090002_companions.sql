-- Preserve existing Alex conversations and give each companion its own memory.
alter table public.sessions
  add column companion_id text not null default 'alex'
  constraint sessions_companion_id_check check (companion_id in ('mia', 'alex', 'juno'));
create index sessions_user_companion_created
  on public.sessions(user_id, companion_id, created_at desc);

-- Remove the previous signature so calls with three arguments resolve through
-- the new default rather than an ambiguous overload. Only the server can search.
drop function public.memory_search(uuid,text,integer);
create function public.memory_search(
  p_user_id uuid, p_query text, p_limit integer default 12,
  p_companion_id text default 'alex'
) returns setof public.analyses language plpgsql security definer set search_path = '' as $$
declare v_query tsquery;
begin
  if p_user_id is null or p_limit is null or p_limit not between 1 and 30
    or p_companion_id is null or p_companion_id not in ('mia','alex','juno')
    or char_length(coalesce(p_query,'')) > 2000 then
    raise exception 'Invalid memory search' using errcode = '22023';
  end if;
  v_query := websearch_to_tsquery('simple'::regconfig,coalesce(p_query,''));
  return query
    with latest as materialized (
      select distinct on (a.session_id) a.* from public.analyses as a
      join public.sessions as s on s.id = a.session_id and s.user_id = a.user_id
      where a.user_id = p_user_id and a.kind = 'session'
        and s.companion_id = p_companion_id
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

-- Restore companion identity exactly. Only backups without the property are
-- legacy Alex backups; an explicit null or unknown companion is invalid.
create or replace function public.restore_history(p_backup jsonb)
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
  v_companion text;
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
    if v_item ? 'companion_id' then
      if jsonb_typeof(v_item->'companion_id') is distinct from 'string'
        or v_item->>'companion_id' not in ('mia','alex','juno') then
        raise exception 'Invalid backup companion' using errcode = '22023';
      end if;
      v_companion := v_item->>'companion_id';
    else
      v_companion := 'alex';
    end if;
    v_id := (v_item->>'id')::uuid;
    v_created := (v_item->>'created_at')::timestamptz;
    v_ended := (v_item->>'ended_at')::timestamptz;
    v_status := v_item->>'status';
    insert into public.sessions(id,user_id,scenario,status,created_at,ended_at,companion_id)
      values(v_id,v_user,v_item->>'scenario',v_status,v_created,v_ended,v_companion)
      on conflict(id) do nothing;
    get diagnostics v_count = row_count;
    v_session_count := v_session_count + v_count;
    select * into v_existing from public.sessions where id = v_id and user_id = v_user for update;
    if not found then raise exception 'Session id unavailable' using errcode = '42501'; end if;
    if v_existing.scenario <> v_item->>'scenario' or v_existing.status <> v_status
      or v_existing.created_at <> v_created or v_existing.ended_at is distinct from v_ended
      or v_existing.companion_id <> v_companion then
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

revoke all on function public.memory_search(uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.memory_search(uuid,text,integer,text) to service_role;
revoke all on function public.restore_history(jsonb) from public, anon, authenticated;
grant execute on function public.restore_history(jsonb) to authenticated;
