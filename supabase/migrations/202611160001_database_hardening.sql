-- Keep the same approval/ownership rules, evaluating stable authentication
-- lookups once per statement rather than once for every candidate row.
-- Deployment wraps this migration in a transaction. Refuse a long lock wait
-- rather than queueing active call writes behind schema maintenance.
set local lock_timeout='3s';

alter policy memory_state_read on public.memory_state
 using(user_id=(select auth.uid()) and (select public.is_approved_user()));
alter policy memory_overrides_read on public.memory_fact_overrides
 using(user_id=(select auth.uid()) and (select public.is_approved_user()));
alter policy memory_exclusions_read on public.memory_session_exclusions
 using(user_id=(select auth.uid()) and (select public.is_approved_user()));
alter policy learning_read on public.learning_items
 using(user_id=(select auth.uid()) and (select public.is_approved_user()));
alter policy learning_plans_read on public.learning_plans
 using(user_id=(select auth.uid()) and (select public.is_approved_user()));
alter policy review_bookmarks_owner on public.review_bookmarks
 using(user_id=(select auth.uid()) and (select public.is_approved_user()));

-- Some hosted projects install this DDL event trigger outside application
-- migrations. Trigger firing does not require client EXECUTE permissions.
-- Do not change its body, owner, trigger binding, or administrator privileges.
do $hardening$
declare target regprocedure:=to_regprocedure('public.rls_auto_enable()');
begin
 if target is not null and exists(select 1 from pg_proc where oid=target and prorettype='pg_catalog.event_trigger'::regtype) then
  revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
  if has_function_privilege('anon',target,'execute') or has_function_privilege('authenticated',target,'execute') then
   raise exception 'Client event-trigger execution privileges were not revoked';
  end if;
 end if;
end $hardening$;

-- Add lookup paths used by current conversation/history/cleanup operations.
-- Preserve existing chronological indexes. Reversed composite FK declarations
-- with an existing same-column unique index do not need a duplicate index just
-- to silence an advisory (for example post_call_tasks and conversation_memories).
create index if not exists analyses_session_owner_recent
 on public.analyses(session_id,user_id,created_at desc,id desc);
create index if not exists analysis_jobs_session_owner
 on public.analysis_jobs(session_id,user_id);
create index if not exists transcript_events_owner_session
 on public.transcript_events(user_id,session_id);
create index if not exists conversation_playback_event
 on public.conversation_playback_receipts(event_id);
create index if not exists conversation_playback_session_owner
 on public.conversation_playback_receipts(session_id,user_id);
create index if not exists conversation_playback_batches_session_owner
 on public.conversation_playback_batches(session_id,user_id);
create index if not exists call_diagnostics_owner
 on public.call_diagnostics(user_id);
create index if not exists learning_source_holds_owner_session
 on public.learning_source_holds(user_id,session_id);
