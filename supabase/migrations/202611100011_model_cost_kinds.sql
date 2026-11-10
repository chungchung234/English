-- Include existing chunk, checkpoint and embedding jobs in the same budget.
create or replace function public.reserve_model_spend(p_job_id uuid,p_lease_token uuid,p_model text,p_policy jsonb,p_reserved_usd numeric)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype; total numeric;
begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.kind not in ('session','weekly','part','checkpoint','embedding')
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
