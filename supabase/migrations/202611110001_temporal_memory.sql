-- Record a call's display time zone without rewriting its UTC instants.
-- An absent legacy value stays unknown; time zone does not imply location.
alter table public.sessions add column time_zone text;

create function loop_private.session_time_zone_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.time_zone is distinct from old.time_zone then
  raise exception 'Session time zone is immutable' using errcode='22023';
 end if;
 if new.time_zone is not null and (
  char_length(new.time_zone) not between 1 and 100
  or not exists(select 1 from pg_catalog.pg_timezone_names z where z.name=new.time_zone)
 ) then raise exception 'Invalid session time zone' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function loop_private.session_time_zone_guard() from public,anon,authenticated,service_role;
create trigger session_time_zone_guard before insert or update of time_zone on public.sessions
for each row execute function loop_private.session_time_zone_guard();

-- Keep the approved-user and memory-control wrapper unchanged. Restore the
-- original named zone when supplied; old backups preserve any existing value.
create or replace function loop_private.restore_history(p_backup jsonb)
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
  v_time_zone text;
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
    if v_item ? 'time_zone' and jsonb_typeof(v_item->'time_zone') not in ('string','null') then
      raise exception 'Invalid backup time zone' using errcode = '22023';
    end if;
    v_time_zone := v_item->>'time_zone';
    v_id := (v_item->>'id')::uuid;
    v_created := (v_item->>'created_at')::timestamptz;
    v_ended := (v_item->>'ended_at')::timestamptz;
    v_status := v_item->>'status';
    insert into public.sessions(id,user_id,scenario,status,created_at,ended_at,companion_id,time_zone)
      values(v_id,v_user,v_item->>'scenario',v_status,v_created,v_ended,v_companion,v_time_zone)
      on conflict(id) do nothing;
    get diagnostics v_count = row_count;
    v_session_count := v_session_count + v_count;
    select * into v_existing from public.sessions where id = v_id and user_id = v_user for update;
    if not found then raise exception 'Session id unavailable' using errcode = '42501'; end if;
    if v_existing.scenario <> v_item->>'scenario' or v_existing.status <> v_status
      or v_existing.created_at <> v_created or v_existing.ended_at is distinct from v_ended
      or v_existing.companion_id <> v_companion
      or (v_item ? 'time_zone' and v_existing.time_zone is distinct from v_time_zone) then
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


create or replace function public.memory_context(p_user_id uuid,p_companion_id text,p_query text default '',p_embedding real[] default null,p_embedding_model text default 'text-embedding-3-small',p_limit integer default 12) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_hybrid boolean:=false; v_query tsquery; v_revision bigint; v_limited boolean;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_limit is null or p_limit<1 or char_length(coalesce(p_query,''))>2000 or p_embedding_model is null or char_length(p_embedding_model) not between 1 and 200 then raise exception 'Invalid memory query' using errcode='22023'; end if;
 if p_embedding is not null and not loop_private.memory_vector_valid(p_embedding) then raise exception 'Invalid memory vector' using errcode='22023'; end if;
 v_query:=websearch_to_tsquery('simple'::regconfig,coalesce(p_query,''));
 select coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0) into v_revision;
 with eligible as materialized(
  select a.*,s.created_at as conversation_created_at
  from loop_private.memory_eligible(p_user_id,p_companion_id) a
  join public.sessions s on s.id=a.session_id and s.user_id=a.user_id and s.companion_id=p_companion_id
 ), bounded as materialized(select * from eligible order by conversation_created_at desc,session_id desc,id desc limit 2000),
 vectors as (
 select a.id, (select sum(x::double precision*y::double precision)/sqrt(sum(x::double precision*x::double precision)*sum(y::double precision*y::double precision)) from unnest(e.embedding,p_embedding) z(x,y)) similarity
 from bounded a join public.memory_embeddings e on e.analysis_id=a.id and e.model=p_embedding_model and e.content_hash=md5(loop_private.memory_document(a.content))
 where p_embedding is not null
 ), vrank as (select id,row_number() over(order by similarity desc,id) rank from vectors),
 krank as (select id,row_number() over(order by ts_rank_cd(to_tsvector('simple'::regconfig,loop_private.memory_document(content)),v_query) desc,id) rank from bounded where to_tsvector('simple'::regconfig,loop_private.memory_document(content))@@v_query),
 scored as (select a.*,coalesce(1.0/(60+v.rank),0)+coalesce(1.0/(60+k.rank),0) score from bounded a left join vrank v on v.id=a.id left join krank k on k.id=a.id),
 recent as(select id from bounded order by conversation_created_at desc,session_id desc,id desc limit least(4,greatest(0,least(p_limit,12)-1))),
 ranked as(select id from scored where id not in(select id from recent) order by score desc,conversation_created_at desc,session_id desc,id desc limit least(p_limit,12)-least(4,greatest(0,least(p_limit,12)-1))),
 chosen as(select * from scored where id in(select id from recent union all select id from ranked))
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'user_id',c.user_id,'session_id',c.session_id,'kind',c.kind,
  'model',c.model,'content',c.content,'source_event_ids',c.source_event_ids,
  'created_at',c.created_at,'session_created_at',s.created_at,
  'session_ended_at',s.ended_at,'session_time_zone',s.time_zone,
  'evidence',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'text',e.text,'timestamp',e.timestamp) order by e.timestamp,e.id),'[]'::jsonb)
    from (select t.id,left(t.text,500) as text,t.timestamp
      from public.transcript_events t
      where t.user_id=p_user_id and t.session_id=c.session_id
      and t.speaker='user' and t.id=any(c.source_event_ids)
      order by t.timestamp,t.id limit 6) e)
  ) order by c.score desc,c.conversation_created_at desc,c.session_id desc,c.id desc),'[]'::jsonb),
  exists(select 1 from vectors),(select count(*)>2000 from eligible)
 into v_result,v_hybrid,v_limited
 from chosen c join public.sessions s on s.id=c.session_id and s.user_id=c.user_id and s.companion_id=p_companion_id;
 return jsonb_build_object('revision',v_revision,'facts',loop_private.memory_facts(p_user_id,p_companion_id),'memories',v_result,'limited',v_limited,'retrieval',case when v_hybrid then 'hybrid' else 'keyword' end);
end; $$;

-- Additive source evidence and call-date recency. Hybrid scoring, exclusions,
-- revision checks, eligibility and learning suppression are preserved; no new
-- public bypass is introduced.
revoke all on function loop_private.restore_history(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.memory_context(uuid,text,text,real[],text,integer) from public,anon,authenticated,service_role;
grant execute on function public.memory_context(uuid,text,text,real[],text,integer) to service_role;
