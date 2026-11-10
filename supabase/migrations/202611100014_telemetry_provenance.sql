-- Release provenance is optional for legacy rows. Never infer a version for an
-- old call or change the version asserted when a new call was created.
alter table public.sessions add column client_build text
 check (client_build is null or client_build ~ '^(git:[0-9a-f]{7,64}|source:[0-9a-f]{12,64}|dev:unversioned)$');

create function loop_private.learning_client_build_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.client_build is distinct from old.client_build then
  raise exception 'Session client build is immutable' using errcode='22023';
 end if;
 return new;
end $$;
revoke all on function loop_private.learning_client_build_immutable() from public,anon,authenticated;
create trigger learning_client_build_immutable before update of client_build on public.sessions
for each row execute function loop_private.learning_client_build_immutable();

-- Keep the original account, source, exposure, replay, and timestamp validation.
-- New payload keys carry fixed codes only; no speech, tokens, or email fields.
create or replace function public.learning_record_event(p_event_id uuid,p_name text,p_companion_id text,p_session_id uuid default null,p_analysis_id uuid default null,p_item_id uuid default null,p_attempt_id uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); attr text; occurred timestamptz; existing public.learning_events%rowtype; v_source public.learning_sources%rowtype; event_payload jsonb:=p_payload;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if p_event_id is null or p_name is null or p_name not in ('feedback_exposed','practice_started','call_connected','flow_failure') or p_companion_id is null or p_companion_id not in ('alex','mia','juno') then raise exception 'Invalid client event'; end if;
 perform loop_private.memory_guard(u,p_companion_id);
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('attribution','action_id','occurred_at','status','stage','reason','foreground','visible_ratio','visible_ms','new_session_id','client_build','telemetry_schema')) then raise exception 'Event payload contains unsupported fields'; end if;
 if p_payload ? 'client_build' and (jsonb_typeof(p_payload->'client_build')<>'string' or p_payload->>'client_build' !~ '^(git:[0-9a-f]{7,64}|source:[0-9a-f]{12,64}|dev:unversioned)$') then raise exception 'Invalid client build'; end if;
 if p_payload ? 'telemetry_schema' and p_payload->'telemetry_schema' <> '1'::jsonb then raise exception 'Invalid telemetry schema'; end if;
 attr:=coalesce(p_payload->>'attribution',case when p_session_id is null then 'library' else 'session' end);
 if attr not in ('session','library') or (attr='session')<>(p_session_id is not null) then raise exception 'Invalid attribution'; end if;
 if p_payload ? 'status' and p_payload->>'status' not in ('success','pending','failure') or p_payload ? 'stage' and p_payload->>'stage' not in ('record','analysis','practice','voice') or p_payload ? 'reason' and p_payload->>'reason' not in ('network','offline','auth','quota','input_too_large','invalid_output','expired','conflict','storage','unknown','known','exclude','wrong_transcript','intent') then raise exception 'Invalid event code'; end if;
 if p_payload ? 'action_id' then perform (p_payload->>'action_id')::uuid; end if;
 if p_payload ? 'new_session_id' and not exists(select 1 from public.sessions where id=(p_payload->>'new_session_id')::uuid and user_id=u and companion_id=p_companion_id) then raise exception 'Session not found' using errcode='42501'; end if;
 if p_payload ? 'foreground' and jsonb_typeof(p_payload->'foreground')<>'boolean' or p_payload ? 'visible_ratio' and (jsonb_typeof(p_payload->'visible_ratio')<>'number' or (p_payload->>'visible_ratio')::numeric not between 0 and 1) or p_payload ? 'visible_ms' and (jsonb_typeof(p_payload->'visible_ms')<>'number' or (p_payload->>'visible_ms')::numeric not between 0 and 86400000) then raise exception 'Invalid exposure fields'; end if;
 occurred:=coalesce((p_payload->>'occurred_at')::timestamptz,now());
 if p_session_id is not null and not exists(select 1 from public.sessions where id=p_session_id and user_id=u and companion_id=p_companion_id) then raise exception 'Session not found' using errcode='42501'; end if;
 if p_analysis_id is not null and not exists(select 1 from public.analyses a join public.sessions s on s.id=a.session_id where a.id=p_analysis_id and a.user_id=u and a.session_id=p_session_id and s.companion_id=p_companion_id) then raise exception 'Analysis not found' using errcode='42501'; end if;
 if p_item_id is not null and not exists(select 1 from public.learning_state_items where id=p_item_id and user_id=u and companion_id=p_companion_id) then raise exception 'Item not found' using errcode='42501'; end if;
 if p_name='practice_started' then
  if p_item_id is null or p_attempt_id is null then raise exception 'Practice requires item and attempt'; end if;
  if attr='session' and not exists(select 1 from public.learning_sources where item_id=p_item_id and analysis_id=p_analysis_id and session_id=p_session_id and user_id=u) then raise exception 'Practice attribution source not found'; end if;
  if attr='library' and p_analysis_id is not null then raise exception 'Library practice has no analysis attribution'; end if;
 end if;
 if p_name='feedback_exposed' then
  if p_analysis_id is null or (p_payload->>'foreground')::boolean is distinct from true or coalesce((p_payload->>'visible_ratio')::numeric,0)<0.5 or coalesce((p_payload->>'visible_ms')::integer,0)<1000 then raise exception 'Feedback exposure threshold not met'; end if;
  if not exists(select 1 from public.learning_feedback where analysis_id=p_analysis_id) then raise exception 'Feedback not ready'; end if;
 end if;
 if p_name='call_connected' and p_session_id is null then raise exception 'Connected event requires new session'; end if;
 select * into existing from public.learning_events where user_id=u and event_id=p_event_id;
 if found then
  if existing.name<>p_name or existing.item_id is distinct from p_item_id or existing.session_id is distinct from p_session_id or existing.analysis_id is distinct from p_analysis_id or existing.attempt_id is distinct from p_attempt_id or (existing.payload-'source_version')<>p_payload then raise exception 'Event ID reused with different content'; end if;
  return jsonb_build_object('saved',true,'duplicate',true,'paired',existing.paired);
 end if;
 -- A late start must match the saved action's one fixed attribution.
 if p_name='practice_started' and exists(select 1 from public.learning_events e where e.user_id=u and e.name in ('practice_saved','practice_started') and e.attempt_id=p_attempt_id and (e.item_id is distinct from p_item_id or e.session_id is distinct from p_session_id or e.analysis_id is distinct from p_analysis_id or e.attribution<>attr)) then raise exception 'Attempt attribution mismatch'; end if;
 if p_name='flow_failure' and p_payload->>'reason'='input_too_large' and p_session_id is not null then event_payload:=p_payload||jsonb_build_object('source_version',public.learning_transcript_digest(p_session_id)); end if;
 insert into public.learning_events(user_id,event_id,name,companion_id,session_id,analysis_id,item_id,attempt_id,action_id,attribution,occurred_at,payload,diagnostic)
 values(u,p_event_id,p_name,p_companion_id,p_session_id,p_analysis_id,p_item_id,p_attempt_id,(p_payload->>'action_id')::uuid,attr,occurred,event_payload,occurred>now()+interval '5 minutes' or occurred<now()-interval '90 days') on conflict do nothing;
 if p_name='feedback_exposed' then update public.learning_feedback set exposed_at=coalesce(exposed_at,occurred) where analysis_id=p_analysis_id and user_id=u; end if;
 if p_name='practice_started' then
 update public.learning_events e set paired=true where e.user_id=u and e.attempt_id=p_attempt_id and e.name in ('practice_started','practice_saved') and exists(select 1 from public.learning_events x where x.user_id=u and x.attempt_id=p_attempt_id and x.name='practice_saved');
 end if;
 return jsonb_build_object('saved',true,'paired',coalesce((select paired from public.learning_events where user_id=u and event_id=p_event_id),false));
end $$;
