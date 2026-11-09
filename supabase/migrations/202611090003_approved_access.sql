-- Approval is checked against the current verified Auth email, not a stale JWT
-- claim or a client-supplied email. Keep the approval list outside the API schema.
create schema if not exists loop_private;
revoke all on schema loop_private from public, anon, authenticated;
create table loop_private.approved_emails (
  email text primary key check (email = lower(btrim(email)))
);
insert into loop_private.approved_emails values ('a8207637@naver.com');
revoke all on loop_private.approved_emails from public, anon, authenticated;

create function public.is_approved_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    join loop_private.approved_emails a on a.email = lower(btrim(u.email))
    where u.id = auth.uid() and u.email_confirmed_at is not null
  )
$$;
revoke all on function public.is_approved_user() from public, anon, authenticated;
grant execute on function public.is_approved_user() to authenticated;

-- Restrictive policies combine with every existing ownership policy.
create policy sessions_approval on public.sessions as restrictive for all to authenticated
  using ((select public.is_approved_user())) with check ((select public.is_approved_user()));
create policy transcript_approval on public.transcript_events as restrictive for all to authenticated
  using ((select public.is_approved_user())) with check ((select public.is_approved_user()));
create policy analyses_approval on public.analyses as restrictive for all to authenticated
  using ((select public.is_approved_user())) with check ((select public.is_approved_user()));

-- SECURITY DEFINER RPCs bypass RLS, so guard their public entry points too.
-- Move implementations out of the exposed schema and revoke direct execution.
alter function public.append_events(uuid,jsonb) set schema loop_private;
alter function public.finish_session(uuid) set schema loop_private;
alter function public.restore_history(jsonb) set schema loop_private;
revoke all on function loop_private.append_events(uuid,jsonb), loop_private.finish_session(uuid),
  loop_private.restore_history(jsonb) from public, anon, authenticated;

create function public.append_events(p_session_id uuid, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_approved_user() then raise exception 'Account not approved' using errcode = '42501'; end if;
  return loop_private.append_events(p_session_id,p_events);
end;
$$;
create function public.finish_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_approved_user() then raise exception 'Account not approved' using errcode = '42501'; end if;
  return loop_private.finish_session(p_session_id);
end;
$$;
create function public.restore_history(p_backup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_approved_user() then raise exception 'Account not approved' using errcode = '42501'; end if;
  return loop_private.restore_history(p_backup);
end;
$$;
revoke all on function public.append_events(uuid,jsonb), public.finish_session(uuid), public.restore_history(jsonb) from public, anon, authenticated;
grant execute on function public.append_events(uuid,jsonb), public.finish_session(uuid), public.restore_history(jsonb) to authenticated;
