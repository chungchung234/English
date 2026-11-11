-- Prove a presented server credential with this project's PostgREST JWT
-- validation and role ACL instead of assuming two issued keys are identical.
create function public.background_worker_authorized() returns boolean
language sql stable security invoker set search_path='' as $$select current_user='service_role'$$;
revoke all on function public.background_worker_authorized() from public,anon,authenticated;
grant execute on function public.background_worker_authorized() to service_role;
notify pgrst,'reload schema';
