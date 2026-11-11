-- Independent conversation continuity and bounded, lease-protected recovery.
alter table public.analysis_jobs add column next_attempt_at timestamptz;
alter table public.analysis_jobs add column retry_blocked boolean not null default false;
alter table public.analysis_jobs drop constraint analysis_jobs_kind_check;
alter table public.analysis_jobs drop constraint analysis_jobs_check;
alter table public.analysis_jobs add constraint analysis_jobs_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding','reconsider','handoff'));
alter table public.analysis_jobs add constraint analysis_jobs_check check((kind in ('session','reconsider','handoff') and session_id is not null) or (kind='weekly' and session_id is null) or kind in ('voice','checkpoint','part','embedding'));
alter table public.api_daily_usage drop constraint api_daily_usage_kind_check;
alter table public.api_daily_usage add constraint api_daily_usage_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding','reconsider','handoff'));

create table public.conversation_memories (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null, companion_id text not null check(companion_id in ('alex','mia','juno')),
 revision bigint not null, source_version text not null, policy text not null, model text not null,
 schema_version text not null default 'conversation-handoff-v1', content jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(user_id,session_id), foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade,
 check(jsonb_typeof(content->'threads')='array' and jsonb_array_length(content->'threads')<=3 and octet_length(content::text)<=3200)
);
alter table public.conversation_memories enable row level security;
revoke all on public.conversation_memories from public,anon,authenticated;
grant all on public.conversation_memories to service_role;
create index conversation_memories_scope on public.conversation_memories(user_id,companion_id,updated_at desc);

create function loop_private.conversation_eligible(p_user_id uuid,p_companion_id text)
returns setof public.sessions language sql stable security definer set search_path='' as $$
 select s.* from public.sessions s where s.user_id=p_user_id and s.companion_id=p_companion_id
 and s.status='ended' and not s.record_incomplete and s.created_at<=now() and s.ended_at<=now()
 and exists(select 1 from public.transcript_events e where e.user_id=p_user_id and e.session_id=s.id and e.speaker='user' and btrim(e.text)<>'')
 and not exists(select 1 from public.memory_session_exclusions x where x.user_id=p_user_id and x.companion_id=p_companion_id and x.session_id=s.id)
 and not exists(select 1 from public.memory_state m where m.user_id=p_user_id and m.companion_id=p_companion_id and s.created_at<=m.history_cutoff)
 and not exists(select 1 from public.learning_source_holds h where h.user_id=p_user_id and h.session_id=s.id)
 and not exists(select 1 from public.learning_sources src join public.learning_state_items i on i.id=src.item_id where src.user_id=p_user_id and src.session_id=s.id and i.status='excluded')
 and not coalesce((public.learning_voice_context(p_user_id,p_companion_id)->>'suppress_memory')::boolean,true)
$$;
revoke all on function loop_private.conversation_eligible(uuid,text) from public,anon,authenticated,service_role;

create function public.conversation_memory_source(p_user_id uuid,p_companion_id text,p_policy text,p_session_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; m public.conversation_memories%rowtype; v_revision bigint; v_digest text;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_policy is null or p_policy!~'^[a-f0-9]{16}$' then raise exception 'Invalid conversation policy';end if;
 select * into s from loop_private.conversation_eligible(p_user_id,p_companion_id) where p_session_id is null or id=p_session_id order by created_at desc,id desc limit 1;
 if s.id is null then return jsonb_build_object('status','unavailable');end if;
 select coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0) into v_revision;
 v_digest:=public.learning_transcript_digest(s.id);
 select * into m from public.conversation_memories where user_id=p_user_id and session_id=s.id and revision=v_revision and source_version=v_digest and policy=p_policy and schema_version='conversation-handoff-v1';
 return jsonb_build_object('status',case when m.id is null then 'pending' else 'ready' end,'session',jsonb_build_object('id',s.id,'companion_id',s.companion_id,'created_at',s.created_at,'ended_at',s.ended_at,'time_zone',s.time_zone),
 'revision',v_revision,'source_version',v_digest,'request_key','handoff:'||p_policy||':'||s.companion_id||':'||s.id||':'||v_revision||':'||v_digest);
end;$$;

create function public.complete_conversation_memory(p_job_id uuid,p_lease_token uuid,p_revision bigint,p_source_version text,p_policy text,p_content jsonb,p_model text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype; s public.sessions%rowtype; v_revision bigint; item jsonb; ids uuid[]; v_seen uuid[]:='{}';
begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if j.id is null or j.kind<>'handoff' or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=now() then raise exception 'Invalid memory lease' using errcode='40001';end if;
 select * into s from public.sessions where id=j.session_id and user_id=j.user_id for update;
 perform loop_private.memory_guard(j.user_id,s.companion_id);
 perform 1 from public.memory_state where user_id=j.user_id and companion_id=s.companion_id for update;
 select coalesce((select revision from public.memory_state where user_id=j.user_id and companion_id=s.companion_id),0) into v_revision;
 if p_revision is distinct from v_revision or p_source_version is distinct from public.learning_transcript_digest(s.id)
 or not exists(select 1 from loop_private.conversation_eligible(j.user_id,s.companion_id) where id=s.id)
 or j.request_key is distinct from 'handoff:'||p_policy||':'||s.companion_id||':'||s.id||':'||p_revision||':'||p_source_version
 then raise exception 'Memory source changed' using errcode='40001';end if;
 if p_content is null or jsonb_typeof(p_content->'threads') is distinct from 'array' or jsonb_array_length(p_content->'threads')>3 or octet_length(p_content::text)>3200 or p_model is null then raise exception 'Invalid conversation memory';end if;
 for item in select value from jsonb_array_elements(p_content->'threads') loop
  if coalesce(length(btrim(item->>'note')),0) not between 1 and 180 or coalesce(item->>'state','') not in ('stated','planned','resolved','unknown')
   or coalesce(length(btrim(item->>'quote')),0) not between 1 and 180 or jsonb_typeof(item->'evidence_ids') is distinct from 'array'
   or coalesce(length(item->>'when'),0)>80 or coalesce(length(item->>'follow_up'),0)>100
   or jsonb_array_length(item->'evidence_ids') <>1 then raise exception 'Invalid conversation thread';end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(item->'evidence_ids');
  if ids&&v_seen then raise exception 'Duplicate conversation evidence';end if;v_seen:=v_seen||ids;
  if exists(select 1 from unnest(ids) x where not exists(select 1 from public.transcript_events e where e.id=x and e.session_id=s.id and e.user_id=j.user_id and e.speaker='user'))
   or not exists(select 1 from public.transcript_events e where e.id=any(ids) and e.session_id=s.id and e.user_id=j.user_id and e.speaker='user' and position(item->>'quote' in e.text)>0)
   or (item->>'when' is not null and not exists(select 1 from public.transcript_events e where e.id=any(ids) and e.session_id=s.id and e.user_id=j.user_id and e.speaker='user' and position(item->>'when' in e.text)>0))
   then raise exception 'Invalid conversation evidence';end if;
 end loop;
 insert into public.conversation_memories(user_id,session_id,companion_id,revision,source_version,policy,model,content)
 values(j.user_id,s.id,s.companion_id,p_revision,p_source_version,p_policy,p_model,p_content)
 on conflict(user_id,session_id) do update set revision=excluded.revision,source_version=excluded.source_version,policy=excluded.policy,model=excluded.model,content=excluded.content,updated_at=now();
 update public.analysis_jobs set state='completed',result=jsonb_build_object('session_id',s.id,'thread_count',jsonb_array_length(p_content->'threads'),'content_bytes',octet_length(p_content::text),'source_version',p_source_version),error=null,lease_token=null,lease_expires_at=null,next_attempt_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','ready','session_id',s.id,'thread_count',jsonb_array_length(p_content->'threads'));
end;$$;

create function public.fail_conversation_memory(p_job_id uuid,p_lease_token uuid,p_error text,p_class text,p_retry_seconds integer default 30)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype; v_next timestamptz;
begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if j.id is null or j.kind<>'handoff' or j.state<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'Invalid memory lease' using errcode='40001';end if;
 if p_class not in ('retryable','budget','source_changed','blocked') or p_retry_seconds not between 1 and 900 then raise exception 'Invalid memory recovery';end if;
 v_next:=case when p_class='budget' then (date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')+interval '1 day' when p_class='retryable' and j.attempts<3 then now()+make_interval(secs=>greatest(p_retry_seconds,case when j.attempts=1 then 30 else 120 end)) else null end;
 update public.analysis_jobs set state='failed',error=left(p_error,100),retry_blocked=p_class in ('source_changed','blocked'),next_attempt_at=v_next,
 attempts=case when p_class='budget' then greatest(0,attempts-1) else attempts end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id returning * into j;
 return jsonb_build_object('status',case when j.retry_blocked then 'blocked' when j.attempts>=3 then 'exhausted' else 'retry_wait' end,'session_id',j.session_id,'attempts',j.attempts,'retry_at',v_next);
end;$$;

revoke all on function public.conversation_memory_source(uuid,text,text,uuid),public.complete_conversation_memory(uuid,uuid,bigint,text,text,jsonb,text),public.fail_conversation_memory(uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.conversation_memory_source(uuid,text,text,uuid),public.complete_conversation_memory(uuid,uuid,bigint,text,text,jsonb,text),public.fail_conversation_memory(uuid,uuid,text,text,integer) to service_role;

create or replace function public.reserve_run(
  p_user_id uuid, p_kind text, p_request_key text,
  p_session_id uuid default null, p_lease_seconds integer default 180
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.analysis_jobs%rowtype;
  v_limit integer;
  v_count integer;
  v_day date := (now() at time zone 'UTC')::date;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('session','weekly','voice','checkpoint','part','embedding','reconsider','handoff')
    or p_request_key is null or char_length(p_request_key) not between 1 and 200
    or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid reservation' using errcode = '22023';
  end if;
  if p_kind in ('session','reconsider','handoff') and p_session_id is null or p_kind = 'weekly' and p_session_id is not null then
    raise exception 'Invalid session for job kind' using errcode = '22023';
  end if;
  if p_session_id is not null then
    perform 1 from public.sessions where id = p_session_id and user_id = p_user_id
      and (p_kind not in ('session','reconsider','handoff') or status = 'ended');
    if not found then raise exception 'Owned ended session required for session analysis' using errcode = '42501'; end if;
  end if;
  perform loop_private.memory_guard(p_user_id,'alex');
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
  if p_kind='handoff' and (v_job.retry_blocked or v_job.attempts>=3) then
    return jsonb_build_object('job_id',v_job.id,'state',v_job.state,'reserved',false,'reason',case when v_job.retry_blocked then 'blocked' else 'exhausted' end,'attempts',v_job.attempts);
  end if;
  if p_kind='handoff' and v_job.next_attempt_at>now() then
    return jsonb_build_object('job_id',v_job.id,'state',v_job.state,'reserved',false,'reason','retry_wait','retry_at',v_job.next_attempt_at,'attempts',v_job.attempts);
  end if;
  v_limit := case p_kind when 'session' then 20 when 'weekly' then 3 when 'voice' then 30 when 'checkpoint' then 60 when 'part' then 80 when 'embedding' then 200 when 'reconsider' then 10 when 'handoff' then 30 end;
  -- A bounded continuation reuses the original request budget. Model parts
  -- have separate reservations, so this cannot create unmetered API calls.
  if p_kind='reconsider' or v_job.attempts = 0 or v_job.error is distinct from 'ANALYSIS_CONTINUE' then
  insert into public.api_daily_usage(user_id,day,kind,reservations) values(p_user_id,v_day,p_kind,0)
    on conflict(user_id,day,kind) do nothing;
  update public.api_daily_usage set reservations = reservations + 1
    where user_id = p_user_id and day = v_day and kind = p_kind and reservations < v_limit
    returning reservations into v_count;
  if not found then
    return jsonb_build_object('job_id',v_job.id,'state',v_job.state,'reserved',false,'reason','budget_exceeded','attempts',v_job.attempts);
  end if;
  end if;
  update public.analysis_jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1,
    error = null, updated_at = now() where id = v_job.id returning * into v_job;
  return jsonb_build_object('job_id',v_job.id,'lease_token',v_job.lease_token,'state',v_job.state,
    'reserved',true,'reason','reserved','attempts',v_job.attempts);
end;
$$;

create or replace function public.reserve_model_spend(p_job_id uuid,p_lease_token uuid,p_model text,p_policy jsonb,p_reserved_usd numeric)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype; total numeric;
begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.kind not in ('session','weekly','part','checkpoint','embedding','reconsider','handoff')
 then raise exception 'Invalid spend lease' using errcode='40001'; end if;
 if p_reserved_usd is null or p_reserved_usd<=0 or p_reserved_usd>1 or p_model is null or p_policy is null
 then raise exception 'Invalid cost reservation' using errcode='22023'; end if;
 -- Serialize all jobs for this account, including different companions/kinds.
 perform pg_advisory_xact_lock(hashtextextended(j.user_id::text, 83921));
 if exists(select 1 from public.model_spend where job_id=p_job_id and lease_token=p_lease_token) then return false; end if;
 select coalesce(sum(reserved_usd),0) into total from public.model_spend
 where user_id=j.user_id and day=(now() at time zone 'UTC')::date;
 if total+p_reserved_usd>1 then return false; end if;
 insert into public.model_spend(job_id,lease_token,user_id,model,policy,reserved_usd)
 values(p_job_id,p_lease_token,j.user_id,p_model,p_policy,p_reserved_usd);
 return true;
end; $$;


-- Replacements retain the existing service-only boundary explicitly.
revoke all on function public.reserve_run(uuid,text,text,uuid,integer),public.reserve_model_spend(uuid,uuid,text,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.reserve_run(uuid,text,text,uuid,integer),public.reserve_model_spend(uuid,uuid,text,jsonb,numeric) to service_role;

create function loop_private.conversation_payload(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('mode','handoff','session_id',s.id,'session_created_at',s.created_at,'session_ended_at',s.ended_at,'session_time_zone',s.time_zone,
 'analysis_status',case when exists(select 1 from public.analyses where user_id=m.user_id and session_id=s.id and kind='session') then 'ready' else coalesce((select case when state='failed' then 'failed' when state='running' then 'pending' else 'unavailable' end from public.analysis_jobs where user_id=m.user_id and session_id=s.id and kind='session' order by updated_at desc limit 1),'unavailable') end,
 'threads',(select coalesce(jsonb_agg(t.value-'quote'),'[]'::jsonb) from jsonb_array_elements(m.content->'threads') t),
 'turns',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'speaker','user','text',t.value->>'quote','timestamp',e.timestamp) order by e.timestamp,e.id),'[]'::jsonb)
 from jsonb_array_elements(m.content->'threads') t join public.transcript_events e on e.id=(t.value->'evidence_ids'->>0)::uuid and e.session_id=s.id and e.user_id=m.user_id and e.speaker='user'))
 from public.conversation_memories m join public.sessions s on s.id=m.session_id and s.user_id=m.user_id where m.id=p_id
$$;
revoke all on function loop_private.conversation_payload(uuid) from public,anon,authenticated,service_role;

create or replace function loop_private.recent_conversation(p_user_id uuid,p_companion_id text)
returns jsonb language sql stable security definer set search_path='' as $$
 with previous as (select * from loop_private.conversation_eligible(p_user_id,p_companion_id) order by created_at desc,id desc limit 1),
 memory as (select m.* from public.conversation_memories m join previous s on s.id=m.session_id
 where m.user_id=p_user_id and m.companion_id=p_companion_id and m.schema_version='conversation-handoff-v1'
 and m.revision=coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0)
 and m.source_version=public.learning_transcript_digest(s.id)),
 analysis as (select a.* from loop_private.memory_eligible(p_user_id,p_companion_id) a join previous s on s.id=a.session_id
 join public.learning_feedback f on f.analysis_id=a.id and f.complete_version and f.transcript_digest=public.learning_transcript_digest(s.id)
 order by a.created_at desc,a.id desc limit 1)
 select coalesce((select loop_private.conversation_payload(id) from memory),
 jsonb_build_object('mode',case when a.id is null then 'excerpt_fallback' else 'analysis_fallback' end,
 'session_id',s.id,'session_created_at',s.created_at,'session_ended_at',s.ended_at,'session_time_zone',s.time_zone,
 'analysis_status',case when a.id is not null then 'ready' else coalesce((select case when state='failed' then 'failed' when state='running' then 'pending' else 'unavailable' end from public.analysis_jobs where user_id=p_user_id and session_id=s.id and kind='session' order by updated_at desc limit 1),'unavailable') end,
 'summary',left(a.content->>'summary',600),'threads','[]'::jsonb,
 'turns',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'speaker','user','text',left(e.text,180),'timestamp',e.timestamp) order by e.timestamp,e.id),'[]'::jsonb)
 from (select t.* from public.transcript_events t where t.user_id=p_user_id and t.session_id=s.id and t.speaker='user' and length(btrim(t.text))>=16
 order by (least(length(t.text),180)+case when t.text~*'(tomorrow|next |plan|going to|interview|내일|다음|계획|예정)' then 100 else 0 end) desc,t.timestamp desc,t.id desc limit case when a.id is null then 2 else 1 end)e)))
 from previous s left join analysis a on true
$$;

create function loop_private.conversation_recall(p_user_id uuid,p_companion_id text,p_query text) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(loop_private.conversation_payload(id) order by score desc,created_at desc),'[]'::jsonb) from (
 select m.id,s.created_at,ts_rank_cd(to_tsvector('simple'::regconfig,m.content::text),websearch_to_tsquery('simple'::regconfig,coalesce(p_query,''))) score
 from public.conversation_memories m join loop_private.conversation_eligible(p_user_id,p_companion_id) s on s.id=m.session_id
 where m.user_id=p_user_id and m.companion_id=p_companion_id and m.schema_version='conversation-handoff-v1' and jsonb_array_length(m.content->'threads')>0
 and m.revision=coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0)
 and m.source_version=public.learning_transcript_digest(s.id)
 order by score desc,s.created_at desc,m.id desc limit 4) selected
$$;
revoke all on function loop_private.conversation_recall(uuid,text,text) from public,anon,authenticated,service_role;

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
 return jsonb_build_object('revision',v_revision,'facts',loop_private.memory_facts(p_user_id,p_companion_id),'memories',v_result,'limited',v_limited,'retrieval',case when v_hybrid then 'hybrid' else 'keyword' end,'conversation_memories',loop_private.conversation_recall(p_user_id,p_companion_id,p_query),'recent_conversation',case when (public.learning_voice_context(p_user_id,p_companion_id)->>'suppress_memory')::boolean then null else loop_private.recent_conversation(p_user_id,p_companion_id) end);
end; $$;
revoke all on function public.memory_context(uuid,text,text,real[],text,integer) from public,anon,authenticated;
grant execute on function public.memory_context(uuid,text,text,real[],text,integer) to service_role;
