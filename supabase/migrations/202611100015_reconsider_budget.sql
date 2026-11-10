-- Bound reconsideration independently while keeping all existing quotas and the shared text-cost budget.
alter table public.analysis_jobs drop constraint analysis_jobs_kind_check;
alter table public.analysis_jobs drop constraint analysis_jobs_check;
alter table public.analysis_jobs add constraint analysis_jobs_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding','reconsider'));
alter table public.analysis_jobs add constraint analysis_jobs_check check((kind in ('session','reconsider') and session_id is not null) or (kind='weekly' and session_id is null) or kind in ('voice','checkpoint','part','embedding'));
alter table public.api_daily_usage drop constraint api_daily_usage_kind_check;
alter table public.api_daily_usage add constraint api_daily_usage_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding','reconsider'));

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
  if p_user_id is null or p_kind is null or p_kind not in ('session','weekly','voice','checkpoint','part','embedding','reconsider')
    or p_request_key is null or char_length(p_request_key) not between 1 and 200
    or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid reservation' using errcode = '22023';
  end if;
  if p_kind in ('session','reconsider') and p_session_id is null or p_kind = 'weekly' and p_session_id is not null then
    raise exception 'Invalid session for job kind' using errcode = '22023';
  end if;
  if p_session_id is not null then
    perform 1 from public.sessions where id = p_session_id and user_id = p_user_id
      and (p_kind not in ('session','reconsider') or status = 'ended');
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
  v_limit := case p_kind when 'session' then 20 when 'weekly' then 3 when 'voice' then 30 when 'checkpoint' then 60 when 'part' then 80 when 'embedding' then 200 when 'reconsider' then 10 end;
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

-- Include existing chunk, checkpoint and embedding jobs in the same budget.
create or replace function public.reserve_model_spend(p_job_id uuid,p_lease_token uuid,p_model text,p_policy jsonb,p_reserved_usd numeric)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype; total numeric;
begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.kind not in ('session','weekly','part','checkpoint','embedding','reconsider')
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
