-- Portable phase-one retrieval. Exact cosine scans are bounded to the newest
-- 2,000 eligible latest-session analyses; migrate to ANN before growing this cap.
create table public.memory_state (
 user_id uuid not null references auth.users(id) on delete cascade,
 companion_id text not null check(companion_id in ('alex','mia','juno')),
 revision bigint not null default 0 check(revision >= 0), history_cutoff timestamptz,
 primary key(user_id,companion_id)
);
create table public.memory_fact_overrides (
 user_id uuid not null references auth.users(id) on delete cascade,
 companion_id text not null check(companion_id in ('alex','mia','juno')),
 key text not null check(key in ('name','occupation','location','goal','interest','preference')),
 value text not null check(char_length(value)<=240), updated_at timestamptz not null default now(),
 primary key(user_id,companion_id,key)
);
create table public.memory_session_exclusions (
 user_id uuid not null references auth.users(id) on delete cascade,
 companion_id text not null check(companion_id in ('alex','mia','juno')),
 session_id uuid not null, created_at timestamptz not null default now(),
 primary key(user_id,companion_id,session_id),
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.memory_embeddings (
 analysis_id uuid not null references public.analyses(id) on delete cascade,
 model text not null check(char_length(model) between 1 and 200),
 content_hash text not null, embedding real[] not null,
 created_at timestamptz not null default now(), primary key(analysis_id,model)
);
alter table public.memory_state enable row level security;
alter table public.memory_fact_overrides enable row level security;
alter table public.memory_session_exclusions enable row level security;
alter table public.memory_embeddings enable row level security;
create policy memory_state_read on public.memory_state for select to authenticated using(user_id=auth.uid() and public.is_approved_user());
create policy memory_overrides_read on public.memory_fact_overrides for select to authenticated using(user_id=auth.uid() and public.is_approved_user());
create policy memory_exclusions_read on public.memory_session_exclusions for select to authenticated using(user_id=auth.uid() and public.is_approved_user());
revoke all on public.memory_state,public.memory_fact_overrides,public.memory_session_exclusions,public.memory_embeddings from public,anon,authenticated;
grant select on public.memory_state,public.memory_fact_overrides,public.memory_session_exclusions to authenticated;
grant all on public.memory_state,public.memory_fact_overrides,public.memory_session_exclusions,public.memory_embeddings to service_role;

create function loop_private.memory_guard(p_user_id uuid,p_companion_id text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_user_id is null or p_companion_id is null or p_companion_id not in ('alex','mia','juno') then raise exception 'Invalid memory scope' using errcode='22023'; end if;
 if not exists(select 1 from auth.users u join loop_private.approved_emails a on a.email=lower(btrim(u.email)) where u.id=p_user_id and u.email_confirmed_at is not null) then raise exception 'Account not approved' using errcode='42501'; end if;
end; $$;
create function loop_private.memory_vector_valid(p_embedding real[]) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(array_ndims(p_embedding)=1 and cardinality(p_embedding)=512
 and not exists(select 1 from unnest(p_embedding) x where x is null or x::text in ('NaN','Infinity','-Infinity'))
 and (select sum(x::double precision*x::double precision) from unnest(p_embedding) x)>0,false)
$$;
create function loop_private.memory_document(p_content jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare v text;
begin
 select concat_ws(E'\n',p_content->>'summary',p_content->>'note',
 (select string_agg(concat_ws(' ',x->>'original',x->>'improved'),E'\n') from jsonb_array_elements(case when jsonb_typeof(p_content->'corrections')='array' then p_content->'corrections' else '[]'::jsonb end) x),
 (select string_agg(x->>'expression',E'\n') from jsonb_array_elements(case when jsonb_typeof(p_content->'practice')='array' then p_content->'practice' else '[]'::jsonb end) x),
 (select string_agg(x->>'text',E'\n') from jsonb_array_elements(case when jsonb_typeof(p_content->'strengths')='array' then p_content->'strengths' else '[]'::jsonb end) x)) into v;
 v:=left(v,6000); while octet_length(v)>6000 loop v:=left(v,char_length(v)-1); end loop; return v; end; $$;
-- Profile extraction intentionally ignores history_cutoff: other structured slots
-- survive an edit. Exclusions apply to both the profile and free-text retrieval.
create function loop_private.memory_facts(p_user_id uuid,p_companion_id text) returns jsonb
language sql stable security definer set search_path='' as $$
 with latest as materialized (
 select distinct on(a.session_id) a.* from public.analyses a join public.sessions s on s.id=a.session_id and s.user_id=a.user_id
 where a.user_id=p_user_id and a.kind='session' and s.companion_id=p_companion_id
 and not exists(select 1 from public.memory_session_exclusions e where e.user_id=p_user_id and e.companion_id=p_companion_id and e.session_id=s.id)
 order by a.session_id,a.created_at desc,a.id desc
 ), facts as (
 select f.item,a.id analysis_id,a.session_id,max(e.timestamp) spoken_at from latest a
 cross join lateral jsonb_array_elements(case when jsonb_typeof(a.content->'memory_facts')='array' then a.content->'memory_facts' else '[]'::jsonb end) f(item)
 join public.transcript_events e on e.user_id=p_user_id and e.session_id=a.session_id and e.speaker='user' and e.id=any(a.source_event_ids)
 and (f.item->'evidence_ids') ? e.id::text and char_length(f.item->>'quote')>0 and position(f.item->>'quote' in e.text)>0
 where f.item->>'key' in ('name','occupation','location','goal','interest','preference') and jsonb_typeof(f.item->'value')='string' and char_length(f.item->>'value')<=240
 group by f.item,a.id,a.session_id
 ), slots as (select distinct on(item->>'key') * from facts order by item->>'key',spoken_at desc,analysis_id desc), combined as (
 select item->>'key' key,jsonb_build_object('key',item->>'key','value',item->>'value','forgotten',item->>'value'='','quote',item->>'quote','evidence_ids',item->'evidence_ids','session_id',session_id,'spoken_at',spoken_at) fact
 from slots where not exists(select 1 from public.memory_fact_overrides o where o.user_id=p_user_id and o.companion_id=p_companion_id and o.key=item->>'key')
 union all select o.key,jsonb_build_object('key',o.key,'value',o.value,'forgotten',o.value='','manual',true,'updated_at',o.updated_at) from public.memory_fact_overrides o where o.user_id=p_user_id and o.companion_id=p_companion_id
 ) select coalesce(jsonb_agg(fact order by key),'[]'::jsonb) from combined
$$;
create function loop_private.memory_eligible(p_user_id uuid,p_companion_id text) returns setof public.analyses
language sql stable security definer set search_path='' as $$
 select distinct on(a.session_id) a.* from public.analyses a join public.sessions s on s.id=a.session_id and s.user_id=a.user_id
 where a.user_id=p_user_id and a.kind='session' and s.companion_id=p_companion_id
 and not exists(select 1 from public.memory_session_exclusions e where e.user_id=p_user_id and e.companion_id=p_companion_id and e.session_id=s.id)
 and not exists(select 1 from public.memory_state st where st.user_id=p_user_id and st.companion_id=p_companion_id and s.created_at<=st.history_cutoff)
 order by a.session_id,a.created_at desc,a.id desc
$$;
create function public.memory_context(p_user_id uuid,p_companion_id text,p_query text default '',p_embedding real[] default null,p_embedding_model text default 'text-embedding-3-small',p_limit integer default 12) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_hybrid boolean:=false; v_query tsquery; v_revision bigint; v_limited boolean;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_limit is null or p_limit<1 or char_length(coalesce(p_query,''))>2000 or p_embedding_model is null or char_length(p_embedding_model) not between 1 and 200 then raise exception 'Invalid memory query' using errcode='22023'; end if;
 if p_embedding is not null and not loop_private.memory_vector_valid(p_embedding) then raise exception 'Invalid memory vector' using errcode='22023'; end if;
 v_query:=websearch_to_tsquery('simple'::regconfig,coalesce(p_query,''));
 select coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0) into v_revision;
 with eligible as materialized(select * from loop_private.memory_eligible(p_user_id,p_companion_id)), bounded as materialized(select * from eligible order by created_at desc,id desc limit 2000),
 vectors as (
 select a.id, (select sum(x::double precision*y::double precision)/sqrt(sum(x::double precision*x::double precision)*sum(y::double precision*y::double precision)) from unnest(e.embedding,p_embedding) z(x,y)) similarity
 from bounded a join public.memory_embeddings e on e.analysis_id=a.id and e.model=p_embedding_model and e.content_hash=md5(loop_private.memory_document(a.content))
 where p_embedding is not null
 ), vrank as (select id,row_number() over(order by similarity desc,id) rank from vectors),
 krank as (select id,row_number() over(order by ts_rank_cd(to_tsvector('simple'::regconfig,loop_private.memory_document(content)),v_query) desc,id) rank from bounded where to_tsvector('simple'::regconfig,loop_private.memory_document(content))@@v_query),
 scored as (select a.*,coalesce(1.0/(60+v.rank),0)+coalesce(1.0/(60+k.rank),0) score from bounded a left join vrank v on v.id=a.id left join krank k on k.id=a.id),
 recent as(select id from bounded order by created_at desc,id desc limit least(4,greatest(0,least(p_limit,12)-1))),
 ranked as(select id from scored where id not in(select id from recent) order by score desc,created_at desc,id desc limit least(p_limit,12)-least(4,greatest(0,least(p_limit,12)-1))),
 chosen as(select * from scored where id in(select id from recent union all select id from ranked))
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'session_id',session_id,'kind',kind,'model',model,'content',content,'source_event_ids',source_event_ids,'created_at',created_at) order by score desc,created_at desc,id desc),'[]'::jsonb),exists(select 1 from vectors),(select count(*)>2000 from eligible)
 into v_result,v_hybrid,v_limited from chosen;
 return jsonb_build_object('revision',v_revision,'facts',loop_private.memory_facts(p_user_id,p_companion_id),'memories',v_result,'limited',v_limited,'retrieval',case when v_hybrid then 'hybrid' else 'keyword' end);
end; $$;
create or replace function public.memory_search(p_user_id uuid,p_query text,p_limit integer default 12,p_companion_id text default 'alex') returns setof public.analyses
language plpgsql security definer set search_path='' as $$
declare v jsonb;
begin
 v:=public.memory_context(p_user_id,p_companion_id,p_query,null,'text-embedding-3-small',p_limit);
 return query select (jsonb_populate_record(null::public.analyses,m.value || jsonb_build_object('content',m.value->'content'||jsonb_build_object('memory_profile',v->'facts')))).* from jsonb_array_elements(v->'memories') m(value);
end; $$;
-- The former raw helper is also constrained, even though no API role can call it.
create or replace function public.memory_search_hits(p_user_id uuid,p_query text,p_limit integer default 12,p_companion_id text default 'alex') returns setof public.analyses
language sql security definer set search_path='' as $$ select * from public.memory_search(p_user_id,p_query,p_limit,p_companion_id) $$;

create function public.memory_manage(p_user_id uuid,p_companion_id text,p_action text,p_key text default null,p_value text default null,p_session_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_revision bigint; v_cutoff timestamptz; v_excluded jsonb; v_excluded_limited boolean;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_action is null or p_action not in ('list','setFact','forgetFact','excludeSession','restoreSession') then raise exception 'Invalid memory action' using errcode='22023'; end if;
 if p_action<>'list' then
 insert into public.memory_state(user_id,companion_id) values(p_user_id,p_companion_id) on conflict do nothing;
 perform 1 from public.memory_state where user_id=p_user_id and companion_id=p_companion_id for update;
 if exists(select 1 from public.sessions where user_id=p_user_id and companion_id=p_companion_id and status='active') then raise exception 'Finish unfinished calls before changing memory' using errcode='55000'; end if;
 if p_action in ('setFact','forgetFact') then
 if p_key is null or p_key not in ('name','occupation','location','goal','interest','preference') or (p_action='setFact' and (p_value is null or char_length(btrim(p_value)) not between 1 and 240)) then raise exception 'Invalid memory fact' using errcode='22023'; end if;
 insert into public.memory_fact_overrides(user_id,companion_id,key,value) values(p_user_id,p_companion_id,p_key,case when p_action='forgetFact' then '' else btrim(p_value) end)
 on conflict(user_id,companion_id,key) do update set value=excluded.value,updated_at=now();
 update public.memory_state set history_cutoff=greatest(history_cutoff,now()) where user_id=p_user_id and companion_id=p_companion_id;
 else
 if not exists(select 1 from public.sessions where id=p_session_id and user_id=p_user_id and companion_id=p_companion_id) then raise exception 'Owned companion session required' using errcode='42501'; end if;
 if p_action='excludeSession' then insert into public.memory_session_exclusions(user_id,companion_id,session_id) values(p_user_id,p_companion_id,p_session_id) on conflict do nothing;
 else delete from public.memory_session_exclusions where user_id=p_user_id and companion_id=p_companion_id and session_id=p_session_id; end if;
 end if;
 update public.memory_state set revision=revision+1 where user_id=p_user_id and companion_id=p_companion_id;
 end if;
 select coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0),(select history_cutoff from public.memory_state where user_id=p_user_id and companion_id=p_companion_id) into v_revision,v_cutoff;
 select coalesce(jsonb_agg(jsonb_build_object('session_id',s.id,'scenario',s.scenario,'ended_at',s.ended_at) order by e.created_at desc),'[]'::jsonb) into v_excluded from (select * from public.memory_session_exclusions where user_id=p_user_id and companion_id=p_companion_id order by created_at desc,session_id limit 30) e join public.sessions s on s.id=e.session_id and s.user_id=e.user_id where e.user_id=p_user_id and e.companion_id=p_companion_id;
 select count(*)>30 into v_excluded_limited from public.memory_session_exclusions where user_id=p_user_id and companion_id=p_companion_id;
 return jsonb_build_object('revision',v_revision,'facts',loop_private.memory_facts(p_user_id,p_companion_id),'excluded_sessions',v_excluded,'excluded_sessions_limited',v_excluded_limited,'history_suppressed',v_cutoff is not null);
end; $$;
create function public.memory_index_candidates(p_user_id uuid,p_companion_id text,p_model text,p_limit integer default 4)
returns table(analysis_id uuid,session_id uuid,document text,content_hash text,revision bigint)
language plpgsql security definer set search_path='' as $$
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_model is null or char_length(p_model) not between 1 and 200 or p_limit is null or p_limit<1 then raise exception 'Invalid memory indexing request' using errcode='22023'; end if;
 return query with bounded as materialized(select a.* from loop_private.memory_eligible(p_user_id,p_companion_id) a order by a.created_at desc,a.id desc limit 2000)
 select a.id,a.session_id,loop_private.memory_document(a.content),md5(loop_private.memory_document(a.content)),coalesce(st.revision,0) from bounded a
 left join public.memory_state st on st.user_id=p_user_id and st.companion_id=p_companion_id
 left join public.memory_embeddings e on e.analysis_id=a.id and e.model=p_model
 where e.analysis_id is null or e.content_hash<>md5(loop_private.memory_document(a.content)) order by a.created_at desc,a.id desc limit least(p_limit,20);
end; $$;
create function public.memory_store_embedding(p_user_id uuid,p_companion_id text,p_analysis_id uuid,p_model text,p_content_hash text,p_embedding real[],p_revision bigint) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if not loop_private.memory_vector_valid(p_embedding) or p_model is null or char_length(p_model) not between 1 and 200 then raise exception 'Invalid memory vector or model' using errcode='22023'; end if;
 insert into public.memory_state(user_id,companion_id) values(p_user_id,p_companion_id) on conflict do nothing;
 perform 1 from public.memory_state where user_id=p_user_id and companion_id=p_companion_id and revision=p_revision for update;
 if not found then return false; end if;
 if not exists(select 1 from loop_private.memory_eligible(p_user_id,p_companion_id) a where a.id=p_analysis_id and md5(loop_private.memory_document(a.content))=p_content_hash) then return false; end if;
 insert into public.memory_embeddings(analysis_id,model,content_hash,embedding) values(p_analysis_id,p_model,p_content_hash,p_embedding)
 on conflict(analysis_id,model) do update set content_hash=excluded.content_hash,embedding=excluded.embedding,created_at=now();
 return true;
end; $$;
revoke all on function loop_private.memory_guard(uuid,text),loop_private.memory_vector_valid(real[]),loop_private.memory_document(jsonb),loop_private.memory_facts(uuid,text),loop_private.memory_eligible(uuid,text) from public,anon,authenticated;
revoke all on function public.memory_context(uuid,text,text,real[],text,integer),public.memory_manage(uuid,text,text,text,text,uuid),public.memory_index_candidates(uuid,text,text,integer),public.memory_store_embedding(uuid,text,uuid,text,text,real[],bigint) from public,anon,authenticated;
grant execute on function public.memory_context(uuid,text,text,real[],text,integer),public.memory_manage(uuid,text,text,text,text,uuid),public.memory_index_candidates(uuid,text,text,integer),public.memory_store_embedding(uuid,text,uuid,text,text,real[],bigint) to service_role;

-- Independent budgets for each model invocation stage.
alter table public.analysis_jobs drop constraint analysis_jobs_kind_check;
alter table public.analysis_jobs drop constraint analysis_jobs_check;
alter table public.analysis_jobs add constraint analysis_jobs_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding'));
alter table public.analysis_jobs add constraint analysis_jobs_check check((kind='session' and session_id is not null) or (kind='weekly' and session_id is null) or kind in ('voice','checkpoint','part','embedding'));
alter table public.api_daily_usage drop constraint api_daily_usage_kind_check;
alter table public.api_daily_usage add constraint api_daily_usage_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding'));
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
  if p_user_id is null or p_kind is null or p_kind not in ('session','weekly','voice','checkpoint','part','embedding')
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
  v_limit := case p_kind when 'session' then 20 when 'weekly' then 3 when 'voice' then 30 when 'checkpoint' then 60 when 'part' then 80 when 'embedding' then 200 end;
  -- A bounded continuation reuses the original request budget. Model parts
  -- have separate reservations, so this cannot create unmetered API calls.
  if v_job.attempts = 0 or v_job.error is distinct from 'ANALYSIS_CONTINUE' then
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

-- Backup restore is additive: omission cannot clear a tombstone, exclusion, or
-- cutoff, and an existing override always wins over an older backup value.
create or replace function public.restore_history(p_backup jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_controls jsonb; v_row jsonb; v_companion text; v_companions text[]:='{}'; v_changed text[]:='{}'; v_user uuid:=auth.uid(); v_new boolean;
begin
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if not p_backup ? 'memory_controls' then return loop_private.restore_history(p_backup); end if;
 v_controls:=p_backup->'memory_controls';
 if jsonb_typeof(v_controls)<>'object' then raise exception 'Invalid memory controls' using errcode='22023'; end if;
 for v_companion in select unnest(array['state','facts','exclusions']) loop
 if v_controls ? v_companion and (jsonb_typeof(v_controls->v_companion)<>'array' or jsonb_array_length(v_controls->v_companion)>10000) then raise exception 'Invalid memory controls' using errcode='22023'; end if;
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'state','[]'::jsonb)) union all select value from jsonb_array_elements(coalesce(v_controls->'facts','[]'::jsonb)) union all select value from jsonb_array_elements(coalesce(v_controls->'exclusions','[]'::jsonb)) loop
 if jsonb_typeof(v_row)<>'object' or (v_row ? 'user_id' and (v_row->>'user_id')::uuid is distinct from v_user) then raise exception 'Memory controls belong to another user' using errcode='42501'; end if;
 v_companion:=v_row->>'companion_id'; perform loop_private.memory_guard(v_user,v_companion);
 if not v_companion=any(v_companions) then v_companions:=array_append(v_companions,v_companion); end if;
 end loop;
 -- Deterministic lock order also serializes concurrent new-call inserts.
 for v_companion in select x from unnest(v_companions) x order by x loop
 insert into public.memory_state(user_id,companion_id) values(v_user,v_companion) on conflict do nothing;
 perform 1 from public.memory_state where user_id=v_user and companion_id=v_companion for update;
 end loop;
 -- Determine actual new restrictions before importing sessions. An idempotent
 -- re-import neither advances the cutoff nor invalidates in-flight revisions.
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'state','[]'::jsonb)) loop
 v_companion:=v_row->>'companion_id';
 select (v_row->>'history_cutoff')::timestamptz is not null and (history_cutoff is null or history_cutoff<(v_row->>'history_cutoff')::timestamptz) into v_new from public.memory_state where user_id=v_user and companion_id=v_companion;
 if v_new and not v_companion=any(v_changed) then v_changed:=array_append(v_changed,v_companion); end if;
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'facts','[]'::jsonb)) loop
 if jsonb_typeof(v_row->'value') is distinct from 'string' or v_row->>'key' is null or v_row->>'key' not in ('name','occupation','location','goal','interest','preference') or char_length(v_row->>'value')>240 then raise exception 'Invalid memory fact' using errcode='22023'; end if;
 v_companion:=v_row->>'companion_id';
 if not exists(select 1 from public.memory_fact_overrides where user_id=v_user and companion_id=v_companion and key=v_row->>'key') and not v_companion=any(v_changed) then v_changed:=array_append(v_changed,v_companion); end if;
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'exclusions','[]'::jsonb)) loop
 v_companion:=v_row->>'companion_id';
 if not exists(select 1 from public.memory_session_exclusions where user_id=v_user and companion_id=v_companion and session_id=(v_row->>'session_id')::uuid) and not v_companion=any(v_changed) then v_changed:=array_append(v_changed,v_companion); end if;
 end loop;
 if exists(select 1 from public.sessions where user_id=v_user and companion_id=any(v_changed) and status='active') then raise exception 'Finish unfinished calls before changing memory' using errcode='55000'; end if;
 v_result:=loop_private.restore_history(p_backup);
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'state','[]'::jsonb)) loop
 update public.memory_state set history_cutoff=greatest(history_cutoff,(v_row->>'history_cutoff')::timestamptz) where user_id=v_user and companion_id=v_row->>'companion_id';
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'facts','[]'::jsonb)) loop
 insert into public.memory_fact_overrides(user_id,companion_id,key,value) values(v_user,v_row->>'companion_id',v_row->>'key',v_row->>'value') on conflict do nothing;
 if found then update public.memory_state set history_cutoff=greatest(history_cutoff,now()) where user_id=v_user and companion_id=v_row->>'companion_id'; end if;
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'exclusions','[]'::jsonb)) loop
 if not exists(select 1 from public.sessions where id=(v_row->>'session_id')::uuid and user_id=v_user and companion_id=v_row->>'companion_id') then raise exception 'Owned companion session required' using errcode='42501'; end if;
 insert into public.memory_session_exclusions(user_id,companion_id,session_id) values(v_user,v_row->>'companion_id',(v_row->>'session_id')::uuid) on conflict do nothing;
 end loop;
 update public.memory_state set revision=revision+1 where user_id=v_user and companion_id=any(v_changed);
 return v_result;
end; $$;


-- Serialize new active calls with memory edits, including service-side inserts.
create function loop_private.memory_session_lock() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='active' then
 insert into public.memory_state(user_id,companion_id) values(new.user_id,new.companion_id) on conflict do nothing;
 perform 1 from public.memory_state where user_id=new.user_id and companion_id=new.companion_id for update;
 end if;
 return new;
end; $$;
revoke all on function loop_private.memory_session_lock() from public,anon,authenticated;
create trigger memory_session_serialize before insert on public.sessions for each row execute function loop_private.memory_session_lock();
