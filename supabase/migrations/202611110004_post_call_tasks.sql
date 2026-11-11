-- Durable post-call work. No browser session, HTTP extension or cron extension
-- is needed in the database; a bounded server worker claims this queue.
create table public.post_call_tasks (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null,companion_id text not null check(companion_id in ('alex','mia','juno')),
 kind text not null check(kind in ('handoff','session')),
 state text not null default 'queued' check(state in ('queued','running','retry_wait','ready','blocked','exhausted','cancelled')),
 request_key text,source_version text,revision bigint,dirty boolean not null default true,
 attempts integer not null default 0,failures integer not null default 0 check(failures between 0 and 3),
 available_at timestamptz not null default now(),lease_token uuid,lease_expires_at timestamptz,last_error text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,session_id,kind),foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
alter table public.post_call_tasks enable row level security;
revoke all on public.post_call_tasks from public,anon,authenticated;
grant all on public.post_call_tasks to service_role;
create index post_call_tasks_due on public.post_call_tasks(available_at,created_at) where state in ('queued','retry_wait','running');

create function loop_private.post_call_eligible(p_user uuid,p_session uuid,p_kind text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sessions s join auth.users u on u.id=s.user_id
 join loop_private.approved_emails a on a.email=lower(btrim(u.email))
 where s.id=p_session and s.user_id=p_user and u.email_confirmed_at is not null and s.status='ended' and not s.record_incomplete
 and s.ended_at<=now() and s.created_at<=now()
 and exists(select 1 from public.transcript_events e where e.session_id=s.id and e.user_id=p_user and e.speaker='user' and btrim(e.text)<>'')
 and not exists(select 1 from public.learning_source_holds h where h.user_id=p_user and h.session_id=s.id)
 and not exists(select 1 from public.memory_session_exclusions x where x.user_id=p_user and x.session_id=s.id)
 and not exists(select 1 from public.learning_sources x join public.learning_state_items i on i.id=x.item_id where x.user_id=p_user and x.session_id=s.id and i.status='excluded')
 and (p_kind='session' or (p_kind='handoff' and exists(select 1 from loop_private.conversation_eligible(p_user,s.companion_id) c where c.id=s.id))))
$$;

create function loop_private.enqueue_post_call(p_session uuid,p_dirty boolean default false) returns integer
language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype;n integer;
begin
 select * into s from public.sessions where id=p_session;
 if s.id is null or s.status<>'ended' or s.record_incomplete or not exists(select 1 from public.transcript_events where session_id=s.id and speaker='user' and btrim(text)<>'')
 or not exists(select 1 from auth.users u join loop_private.approved_emails a on a.email=lower(btrim(u.email)) where u.id=s.user_id and u.email_confirmed_at is not null) then return 0;end if;
 insert into public.post_call_tasks(user_id,session_id,companion_id,kind,available_at)
 select s.user_id,s.id,s.companion_id,k,now()+interval '10 seconds' from unnest(array['handoff','session']) k
 on conflict(user_id,session_id,kind) do update set dirty=true,state='queued',available_at=now()+interval '10 seconds',lease_token=null,lease_expires_at=null,updated_at=now()
 where p_dirty;
 get diagnostics n=row_count;return n;
end;$$;

create function loop_private.enqueue_ended_call() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='ended' then perform loop_private.enqueue_post_call(new.id,true);end if;return new;
end;$$;
create trigger post_call_on_end after update of status,record_incomplete on public.sessions
for each row when(old.status is distinct from new.status or old.record_incomplete is distinct from new.record_incomplete)
execute function loop_private.enqueue_ended_call();

-- A transition table avoids rescanning transcript contents once per event.
-- The queue is marked dirty here; its digest is computed only when claimed.
create function loop_private.enqueue_ended_events() returns trigger
language plpgsql security definer set search_path='' as $$
declare sid uuid;begin
 for sid in select distinct e.session_id from inserted_post_call_events e join public.sessions s on s.id=e.session_id where s.status='ended' loop
  perform loop_private.enqueue_post_call(sid,true);
 end loop;return null;
end;$$;
create trigger post_call_on_events after insert on public.transcript_events
referencing new table as inserted_post_call_events for each statement execute function loop_private.enqueue_ended_events();

create function public.discover_post_call_tasks() returns integer
language plpgsql security definer set search_path='' as $$
declare sid uuid;n integer:=0;begin
 -- Recover the latest call of each companion and recent failed feedback only.
 -- Do not automatically regenerate an entire historical library.
 for sid in with latest as(select distinct on(s.user_id,s.companion_id) s.id from public.sessions s
  join auth.users u on u.id=s.user_id join loop_private.approved_emails a on a.email=lower(btrim(u.email))
  where s.status='ended' and not s.record_incomplete and u.email_confirmed_at is not null
  and exists(select 1 from public.transcript_events e where e.session_id=s.id and e.speaker='user' and btrim(e.text)<>'')
  order by s.user_id,s.companion_id,s.created_at desc,s.id desc),failed as(
  select distinct j.session_id from public.analysis_jobs j join public.sessions s on s.id=j.session_id
  join auth.users u on u.id=s.user_id join loop_private.approved_emails a on a.email=lower(btrim(u.email))
  where j.kind='session' and j.state='failed' and s.status='ended' and s.ended_at>=now()-interval '7 days'
  and u.email_confirmed_at is not null order by j.session_id limit 10)
 select id from latest union select session_id from failed loop n:=n+loop_private.enqueue_post_call(sid);end loop;
 return n;
end;$$;

create function public.claim_post_call_task() returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.post_call_tasks%rowtype;d text;r bigint;s public.sessions%rowtype;
begin
 for t in select q.* from public.post_call_tasks q where
 ((q.state in ('queued','retry_wait') and q.available_at<=now()) or (q.state='running' and q.lease_expires_at<=now()))
 and not exists(select 1 from public.sessions c where c.user_id=q.user_id and c.status='active' and c.created_at>now()-interval '30 minutes')
 order by q.available_at,q.created_at,q.id for update skip locked limit 12 loop
  if not loop_private.post_call_eligible(t.user_id,t.session_id,t.kind) then
   update public.post_call_tasks set state='cancelled',lease_token=null,lease_expires_at=null,dirty=false,last_error='SOURCE_UNAVAILABLE',updated_at=now() where id=t.id;continue;
  end if;
  select * into s from public.sessions where id=t.session_id;
  d:=public.learning_transcript_digest(t.session_id);
  r:=coalesce((select revision from public.memory_state where user_id=t.user_id and companion_id=t.companion_id),0);
  if t.source_version is distinct from d or t.revision is distinct from r then t.failures:=0;t.attempts:=0;end if;
  if (t.kind='handoff' and exists(select 1 from public.conversation_memories m where m.user_id=t.user_id and m.session_id=t.session_id and m.source_version=d and m.revision=r and m.schema_version='conversation-handoff-v1'))
  or (t.kind='session' and exists(select 1 from public.learning_feedback f join public.analyses a on a.id=f.analysis_id where f.user_id=t.user_id and f.session_id=t.session_id and f.complete_version and f.transcript_digest=d
   and not exists(select 1 from public.analyses newer where newer.session_id=t.session_id and newer.kind='session' and (newer.created_at,newer.id)>(a.created_at,a.id)))) then
   update public.post_call_tasks set state='ready',source_version=d,revision=r,dirty=false,last_error=null,lease_token=null,lease_expires_at=null,updated_at=now() where id=t.id;continue;
  end if;
  if t.failures>=3 then update public.post_call_tasks set state='exhausted',dirty=false,lease_token=null,lease_expires_at=null where id=t.id;continue;end if;
  update public.post_call_tasks set state='running',source_version=d,revision=r,dirty=false,attempts=t.attempts+1,failures=t.failures,
   lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now() where id=t.id returning * into t;
  return jsonb_build_object('id',t.id,'user_id',t.user_id,'session_id',t.session_id,'companion_id',t.companion_id,'kind',t.kind,'source_version',t.source_version,'revision',t.revision,'lease_token',t.lease_token);
 end loop;
 return null;
end;$$;

create function public.report_post_call_task(p_id uuid,p_lease uuid,p_outcome text,p_error text default null,p_retry_seconds integer default 30) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.post_call_tasks%rowtype;v_next timestamptz;v_state text;v_failures integer;
begin
 select * into t from public.post_call_tasks where id=p_id for update;
 if t.id is null or t.state<>'running' or t.lease_token is distinct from p_lease or t.lease_expires_at<=now() or t.dirty then return jsonb_build_object('status','superseded');end if;
 if p_outcome not in('ready','retryable','continue','busy','budget','blocked','exhausted','cancelled') or p_retry_seconds not between 1 and 900
 or p_error is not null and p_error!~'^[A-Z0-9_:-]{1,100}$' then raise exception 'Invalid task outcome';end if;
 if t.source_version is distinct from public.learning_transcript_digest(t.session_id) or t.revision is distinct from coalesce((select revision from public.memory_state where user_id=t.user_id and companion_id=t.companion_id),0)
 or not loop_private.post_call_eligible(t.user_id,t.session_id,t.kind) then
  update public.post_call_tasks set state='cancelled',lease_token=null,lease_expires_at=null,last_error='SOURCE_CHANGED',updated_at=now() where id=t.id;return jsonb_build_object('status','superseded');
 end if;
 if p_outcome='ready' and not (
  (t.kind='handoff' and exists(select 1 from public.conversation_memories m where m.user_id=t.user_id and m.session_id=t.session_id and m.source_version=t.source_version and m.revision=t.revision))
  or (t.kind='session' and exists(select 1 from public.learning_feedback f where f.user_id=t.user_id and f.session_id=t.session_id and f.complete_version and f.transcript_digest=t.source_version))) then raise exception 'Task result is not committed' using errcode='40001';end if;
 v_failures:=least(3,t.failures+case when p_outcome='retryable' then 1 when p_outcome='exhausted' then 3 else 0 end);
 v_state:=case when p_outcome='ready' then 'ready' when p_outcome in('blocked','cancelled') then p_outcome when v_failures>=3 then 'exhausted' else 'retry_wait' end;
 v_next:=case when p_outcome='budget' then (date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')+interval '1 day'
  when p_outcome='continue' then now()+interval '5 seconds'
  when v_state='retry_wait' then now()+make_interval(secs=>greatest(p_retry_seconds,case when v_failures<=1 then 30 else 120 end))+random()*interval '5 seconds' else now() end;
 update public.post_call_tasks set state=v_state,failures=v_failures,available_at=v_next,last_error=p_error,lease_token=null,lease_expires_at=null,updated_at=now() where id=t.id;
 return jsonb_build_object('status',v_state,'kind',t.kind,'failures',v_failures);
end;$$;

-- Guard publication from a worker against changed transcripts, privacy policy,
-- cancelled work and replaced leases. Never save this internal lease in a note.
do $copy_analysis$ declare definition text;begin
 definition:=pg_get_functiondef('public.complete_analysis_run(uuid,uuid,jsonb,text,uuid[])'::regprocedure);
 execute replace(definition,'CREATE OR REPLACE FUNCTION public.complete_analysis_run','CREATE OR REPLACE FUNCTION loop_private.complete_analysis_run');
end;$copy_analysis$;
revoke all on function loop_private.complete_analysis_run(uuid,uuid,jsonb,text,uuid[]) from public,anon,authenticated,service_role;
create or replace function public.complete_analysis_run(p_job_id uuid,p_lease_token uuid,p_content jsonb,p_model text,p_source_event_ids uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.post_call_tasks%rowtype;j public.analysis_jobs%rowtype;g jsonb:=p_content->'background_guard';
begin
 if g is not null then
  select * into q from public.post_call_tasks where id=(g->>'task_id')::uuid for update;
  select * into j from public.analysis_jobs where id=p_job_id;

  if q.id is null or j.user_id is distinct from q.user_id or j.session_id is distinct from q.session_id or q.kind<>'session' or q.state<>'running' or q.dirty
  or q.lease_token is distinct from (g->>'lease_token')::uuid or q.lease_expires_at<=now()
  or q.source_version is distinct from g->>'source_version' or q.source_version is distinct from public.learning_transcript_digest(q.session_id)
  or q.revision is distinct from coalesce((select revision from public.memory_state where user_id=q.user_id and companion_id=q.companion_id),0)
  or not loop_private.post_call_eligible(q.user_id,q.session_id,q.kind) then raise exception 'Background source changed' using errcode='40001';end if;
 end if;
 return loop_private.complete_analysis_run(p_job_id,p_lease_token,p_content-'background_guard',p_model,p_source_event_ids);
end;$$;

revoke all on function loop_private.post_call_eligible(uuid,uuid,text),loop_private.enqueue_post_call(uuid,boolean),loop_private.enqueue_ended_call(),loop_private.enqueue_ended_events() from public,anon,authenticated,service_role;
revoke all on function public.discover_post_call_tasks(),public.claim_post_call_task(),public.report_post_call_task(uuid,uuid,text,text,integer),public.complete_analysis_run(uuid,uuid,jsonb,text,uuid[]) from public,anon,authenticated;
grant execute on function public.discover_post_call_tasks(),public.claim_post_call_task(),public.report_post_call_task(uuid,uuid,text,text,integer),public.complete_analysis_run(uuid,uuid,jsonb,text,uuid[]) to service_role;

-- Manual requests share the same-source retry gate; a changed policy key may recover.
create or replace function public.reserve_run(
  p_user_id uuid, p_kind text, p_request_key text,
  p_session_id uuid default null, p_lease_seconds integer default 180
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.analysis_jobs%rowtype;
  v_limit integer;
  v_task public.post_call_tasks%rowtype;
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
  if p_kind='session' then
    select * into v_task from public.post_call_tasks where user_id=p_user_id and session_id=p_session_id and kind='session' for update;
    if v_task.id is not null then
      if not v_task.dirty and v_task.source_version=public.learning_transcript_digest(p_session_id)
      and v_task.request_key=p_request_key
      and not exists(select 1 from public.analysis_jobs where user_id=p_user_id and kind=p_kind and request_key=p_request_key and state='completed') then
        if v_task.state in ('blocked','exhausted') then
          return jsonb_build_object('reserved',false,'reason','retry_exhausted');
        end if;
        if v_task.state='retry_wait' and v_task.available_at>now() then
          return jsonb_build_object('reserved',false,'reason','retry_wait','retry_at',v_task.available_at);
        end if;
      end if;
      if v_task.request_key is distinct from p_request_key then
        update public.post_call_tasks set request_key=p_request_key,
         failures=case when request_key is not null then 0 else failures end,
         state=case when state in ('blocked','exhausted') then 'queued' else state end,
         available_at=case when state in ('blocked','exhausted') then now() else available_at end
        where id=v_task.id;
      end if;
    end if;
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
