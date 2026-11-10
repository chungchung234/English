-- Server-owned reservations count uncertain/failed calls too, never browser estimates.
create table public.model_spend (
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  lease_token uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default (now() at time zone 'UTC')::date,
  model text not null,
  policy jsonb not null,
  reserved_usd numeric not null check (reserved_usd > 0),
  usage jsonb,
  estimated_usd numeric check (estimated_usd >= 0),
  outcome text not null default 'pending',
  created_at timestamptz not null default now(),
  primary key(job_id, lease_token)
);
create index model_spend_daily on public.model_spend(user_id,day);
alter table public.model_spend enable row level security;
revoke all on public.model_spend from public,anon,authenticated;
grant all on public.model_spend to service_role;

create function public.reserve_model_spend(p_job_id uuid,p_lease_token uuid,p_model text,p_policy jsonb,p_reserved_usd numeric)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype; total numeric;
begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.kind not in ('session','weekly')
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
create function public.record_model_spend(p_job_id uuid,p_lease_token uuid,p_usage jsonb,p_estimated_usd numeric,p_outcome text)
returns void language plpgsql security definer set search_path='' as $$
begin
 update public.model_spend set usage=p_usage,estimated_usd=p_estimated_usd,outcome=p_outcome
 where job_id=p_job_id and lease_token=p_lease_token and outcome='pending';
 if not found then raise exception 'Missing or completed cost reservation' using errcode='40001'; end if;
end; $$;
revoke all on function public.reserve_model_spend(uuid,uuid,text,jsonb,numeric),public.record_model_spend(uuid,uuid,jsonb,numeric,text) from public,anon,authenticated;
grant execute on function public.reserve_model_spend(uuid,uuid,text,jsonb,numeric),public.record_model_spend(uuid,uuid,jsonb,numeric,text) to service_role;
