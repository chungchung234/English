-- Preserve deployed diagnostic receipts and their ACK/RLS/cap contract while
-- adding enum-only audio configuration and interruption provenance. Provider
-- IDs, raw events, audio, SDP, device identifiers, and messages are not accepted.
create function loop_private.call_audio_context_valid(p_context jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare k text; v jsonb;
begin
 if p_context is null or jsonb_typeof(p_context)<>'object' or p_context='{}'::jsonb then return false; end if;
 for k,v in select key,value from jsonb_each(p_context) loop
  if jsonb_typeof(v) is distinct from 'string' then return false; end if;
  case k
   when 'requested_mode' then if v #>> '{}' not in ('speakerphone','headset','unknown') then return false; end if;
   when 'expected_noise' then if v #>> '{}' not in ('far_field','near_field','provider_default','unreported') then return false; end if;
   when 'effective_noise' then if v #>> '{}' not in ('far_field','near_field','off','unreported') then return false; end if;
   when 'capture_echo','capture_noise','capture_gain','interrupt_response' then if v #>> '{}' not in ('on','off','unreported') then return false; end if;
   when 'vad_type' then if v #>> '{}' not in ('semantic_vad','server_vad','off','unreported') then return false; end if;
   when 'output_state' then if v #>> '{}' not in ('playing','generating','idle','unknown') then return false; end if;
   when 'cancel_origin' then if v #>> '{}' not in ('provider_turn_detected','client_hold','client_end','client_other','unattributed') then return false; end if;
   when 'response_key' then if v #>> '{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then return false; end if;
   else return false;
  end case;
 end loop;
 return true;
end $$;
revoke all on function loop_private.call_audio_context_valid(jsonb) from public,anon,authenticated;
grant execute on function loop_private.call_audio_context_valid(jsonb) to service_role;

alter table public.call_diagnostics add column audio_context jsonb;
alter table public.call_diagnostics drop constraint call_diagnostics_kind_check;
alter table public.call_diagnostics add constraint call_diagnostics_kind_check
 check (kind in ('provider_error','request_timeout','connection_state','context_error','transcription_error','media_error','audio_configuration','audio_interruption'));
alter table public.call_diagnostics add constraint call_diagnostics_audio_context_check
 check (audio_context is null or loop_private.call_audio_context_valid(audio_context));
alter table public.call_diagnostics add constraint call_diagnostics_audio_kind_context_check
 check (kind not in ('audio_configuration','audio_interruption') or audio_context is not null);

create or replace function public.record_call_diagnostics(p_events jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 u uuid:=auth.uid(); e jsonb; k text; sid uuid; eid uuid; occurred timestamptz;
 elapsed integer; existing public.call_diagnostics%rowtype;
 acknowledgements jsonb:='[]'::jsonb; dropped jsonb:='[]'::jsonb;
 required_keys constant text[]:=array['event_id','session_id','occurred_at','client_build','kind','code','request_type','elapsed_ms','connection_state','data_state','phase'];
 string_keys constant text[]:=array['event_id','session_id','occurred_at','client_build','kind','code','request_type','connection_state','data_state','phase'];
begin
 if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if p_events is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>20 or octet_length(p_events::text)>32768 then
  raise exception 'Invalid diagnostic batch' using errcode='22023';
 end if;
 -- Validate the entire batch before writing. New fields must be deliberately
 -- added here; an accidental provider error object cannot cross this boundary.
 for e in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(e)<>'object' or not e ?& required_keys or exists(select 1 from jsonb_object_keys(e) x where not x=any(required_keys||array['audio_context'])) then
   raise exception 'Diagnostic contains unsupported or missing fields' using errcode='22023';
  end if;
  foreach k in array string_keys loop
   if jsonb_typeof(e->k) is distinct from 'string' then raise exception 'Invalid diagnostic field type' using errcode='22023'; end if;
  end loop;
  if e->>'event_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   or e->>'session_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   or e->>'occurred_at' !~ '^\d{4}-\d{2}-\d{2}T'
   or e->>'client_build' !~ '^(git:[0-9a-f]{7,64}|source:[0-9a-f]{12,64}|dev:unversioned)$'
   or e->>'kind' not in ('provider_error','request_timeout','connection_state','context_error','transcription_error','media_error','audio_configuration','audio_interruption')
   or e->>'code' !~ '^[A-Za-z0-9_.:-]{1,80}$'
   or e->>'request_type' not in ('unknown','checkpoint','session.update','conversation.item.delete','response.create','response.cancel','input_audio_buffer.commit','output_audio_buffer.clear')
   or e->>'connection_state' not in ('new','connecting','connected','disconnected','failed','closed')
   or e->>'data_state' not in ('connecting','open','closing','closed')
   or e->>'phase' not in ('connecting','connected','ending','ended') then
   raise exception 'Invalid diagnostic code' using errcode='22023';
  end if;
  if jsonb_typeof(e->'elapsed_ms') is distinct from 'number' or (e->>'elapsed_ms')::numeric not between 0 and 7200000
   or trunc((e->>'elapsed_ms')::numeric)<>(e->>'elapsed_ms')::numeric then
   raise exception 'Invalid diagnostic elapsed time' using errcode='22023';
  end if;
  if e ? 'audio_context' and not loop_private.call_audio_context_valid(e->'audio_context') then
   raise exception 'Invalid diagnostic audio context' using errcode='22023';
  end if;
  if e->>'kind' in ('audio_configuration','audio_interruption') and not e ? 'audio_context' then
   raise exception 'Audio diagnostic requires context' using errcode='22023';
  end if;
  occurred:=(e->>'occurred_at')::timestamptz;
  if not isfinite(occurred) then raise exception 'Invalid diagnostic timestamp' using errcode='22023'; end if;
 end loop;
 -- Every writer locks owned session rows in the same order. This serializes
 -- the count/insert operation without deadlocks across multi-session batches.
 -- Ended sessions intentionally remain eligible for delayed/offline receipts.
 for sid in select distinct (value->>'session_id')::uuid from jsonb_array_elements(p_events) order by 1 loop
  perform 1 from public.sessions s where s.id=sid and s.user_id=u for update;
  if not found then raise exception 'Session not found' using errcode='42501'; end if;
 end loop;
 for e in select value from jsonb_array_elements(p_events) loop
  eid:=(e->>'event_id')::uuid;sid:=(e->>'session_id')::uuid;occurred:=(e->>'occurred_at')::timestamptz;elapsed:=(e->>'elapsed_ms')::integer;
  select * into existing from public.call_diagnostics where event_id=eid;
  if found then
   if existing.user_id<>u or existing.session_id<>sid or existing.occurred_at<>occurred
    or existing.client_build<>e->>'client_build' or existing.kind<>e->>'kind' or existing.code<>e->>'code'
    or existing.request_type<>e->>'request_type' or existing.elapsed_ms<>elapsed
    or existing.connection_state<>e->>'connection_state' or existing.data_state<>e->>'data_state' or existing.phase<>e->>'phase'
    or existing.audio_context is distinct from e->'audio_context' then
    raise exception 'Diagnostic event ID reused with different content' using errcode='22023';
   end if;
  elsif (select count(*) from public.call_diagnostics where session_id=sid)>=200 then
   -- Tell the client to retire capped receipts as well: a noisy call must not
   -- create an unbounded local retry backlog or prevent later calls' uploads.
   if not dropped @> jsonb_build_array(eid) then dropped:=dropped||jsonb_build_array(eid); end if;
   continue;
  else
   insert into public.call_diagnostics(event_id,user_id,session_id,occurred_at,clock_skewed,client_build,kind,code,request_type,elapsed_ms,connection_state,data_state,phase,audio_context)
   values(eid,u,sid,occurred,occurred>now()+interval '5 minutes' or occurred<now()-interval '90 days',e->>'client_build',e->>'kind',e->>'code',e->>'request_type',elapsed,e->>'connection_state',e->>'data_state',e->>'phase',e->'audio_context');
  end if;
  if not acknowledgements @> jsonb_build_array(eid) then acknowledgements:=acknowledgements||jsonb_build_array(eid); end if;
 end loop;
 return jsonb_build_object('event_ids',acknowledgements,'dropped_event_ids',dropped);
end $$;
revoke all on function public.record_call_diagnostics(jsonb) from public,anon,authenticated;
grant execute on function public.record_call_diagnostics(jsonb) to authenticated;
