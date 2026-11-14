-- Playback is a scoped client report, never proof that a person heard audio.
-- Legacy generated assistant text has no receipt and cannot become shared memory.
-- A latest profile slot can later contain a new value for the same key. Keep
-- the earlier explicit forget boundary independently, without retaining its
-- value/quotation or globally suppressing unrelated future conversations.
alter table public.memory_state add column conversation_forget_after timestamptz;

create function loop_private.advance_conversation_forget(p_user_id uuid,p_companion_id text,p_after timestamptz) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_after is null then return;end if;
 if not isfinite(p_after) or p_after>now() then raise exception 'Invalid conversation forget boundary' using errcode='22023';end if;
 -- The conflict update locks the single account/companion row. Concurrent
 -- captures cannot lower the boundary or silently reauthorize queued receipts.
 insert into public.memory_state(user_id,companion_id,conversation_forget_after,revision)
 values(p_user_id,p_companion_id,p_after,1)
 on conflict(user_id,companion_id) do update
 set conversation_forget_after=excluded.conversation_forget_after,revision=public.memory_state.revision+1
 where public.memory_state.conversation_forget_after is null or public.memory_state.conversation_forget_after<excluded.conversation_forget_after;
end;$$;
revoke all on function loop_private.advance_conversation_forget(uuid,text,timestamptz) from public,anon,authenticated,service_role;

create function loop_private.capture_conversation_forget(a public.analyses) returns void
language plpgsql security definer set search_path='' as $$
declare v_companion text;v_start timestamptz;v_end timestamptz;v_after timestamptz;
begin
 if a.kind<>'session' then return;end if;
 select s.companion_id,s.created_at,s.ended_at into v_companion,v_start,v_end from public.sessions s where s.id=a.session_id and s.user_id=a.user_id
  and s.status='ended' and not s.record_incomplete and isfinite(s.created_at) and isfinite(s.ended_at)
  and s.created_at<=s.ended_at and s.ended_at<=now()
  and exists(select 1 from public.learning_feedback f where f.analysis_id=a.id and f.complete_version
   and f.transcript_digest=public.learning_transcript_digest(s.id))
  and (select coalesce(array_agg(e.id order by e.id),'{}'::uuid[]) from public.transcript_events e where e.session_id=s.id and e.user_id=a.user_id)
   =(select coalesce(array_agg(x order by x),'{}'::uuid[]) from unnest(a.source_event_ids) x)
  and not exists(select 1 from public.memory_session_exclusions x where x.user_id=a.user_id and x.companion_id=s.companion_id and x.session_id=s.id)
  and not exists(select 1 from public.learning_source_holds h where h.user_id=a.user_id and h.session_id=s.id)
  and not exists(select 1 from public.learning_sources src join public.learning_state_items i on i.id=src.item_id
   where src.user_id=a.user_id and src.session_id=s.id and i.status='excluded');
 if v_companion is null then return;end if;
 -- Match the established profile's source admission: a recognized empty slot
 -- must cite an exact quotation from actual user speech in this same source.
 -- No companion text or unsupported model-only forget flag can advance it.
 select max(e.timestamp) into v_after
 from jsonb_array_elements(case when jsonb_typeof(a.content->'memory_facts')='array' then a.content->'memory_facts' else '[]'::jsonb end) f
 join public.transcript_events e on e.user_id=a.user_id and e.session_id=a.session_id and e.speaker='user'
  and e.timestamp between v_start and v_end
  and e.id=any(a.source_event_ids) and jsonb_typeof(f->'evidence_ids')='array' and (f->'evidence_ids') ? e.id::text
  and jsonb_typeof(f->'quote')='string'
  and char_length(f->>'quote') between 1 and 500 and length(btrim(f->>'quote'))>0 and position(f->>'quote' in e.text)>0
 where f->>'key' in ('name','occupation','location','goal','interest','preference')
  and jsonb_typeof(f->'value')='string' and f->>'value'='';
 perform loop_private.advance_conversation_forget(a.user_id,v_companion,v_after);
end;$$;
revoke all on function loop_private.capture_conversation_forget(public.analyses) from public,anon,authenticated,service_role;

create function loop_private.conversation_forget_capture() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform loop_private.capture_conversation_forget(new);return new;end;$$;
revoke all on function loop_private.conversation_forget_capture() from public,anon,authenticated,service_role;
-- PostgreSQL orders same-event triggers by name: admit only after the existing
-- learning_analysis_insert trigger has verified complete source coverage.
create trigger learning_conversation_forget_capture after insert or update of content,source_event_ids,session_id,user_id,kind on public.analyses
for each row execute function loop_private.conversation_forget_capture();

-- Preserve valid historical forget requests even if a newer profile slot or
-- reanalysis has replaced them. Replaying the backfill is idempotent.
do $$ declare a public.analyses%rowtype;begin
 for a in select * from public.analyses where kind='session' order by created_at,id loop
  perform loop_private.capture_conversation_forget(a);
 end loop;
end;$$;

create table public.conversation_playback_receipts (
 user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null,
 event_id uuid not null references public.transcript_events(id) on delete cascade,
 companion_id text not null check(companion_id in ('alex','mia','juno')),
 receipt_id uuid not null,
 memory_revision bigint not null check(memory_revision>=0),
 event_digest text not null,
 source_session_digest text not null,
 user_digests jsonb not null check(jsonb_typeof(user_digests)='object'),
 request_digest text not null,
 qualified_user_ids uuid[] not null default '{}',
 reported_at timestamptz not null default now(),
 kind text not null default 'client_reported_playback_completed' check(kind='client_reported_playback_completed'),
 primary key(user_id,event_id),
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade,
 check(cardinality(qualified_user_ids)<=3000)
);
alter table public.conversation_playback_receipts enable row level security;
revoke all on public.conversation_playback_receipts from public,anon,authenticated;
grant all on public.conversation_playback_receipts to service_role;
create index conversation_playback_source on public.conversation_playback_receipts(user_id,companion_id,memory_revision,session_id,reported_at desc);
create index conversation_playback_recent on public.conversation_playback_receipts(user_id,companion_id,memory_revision,reported_at desc,event_id desc);

-- Anchor every accepted request, including a new receipt ID that merely
-- acknowledges already-recorded events. It cannot later name another payload.
create table public.conversation_playback_batches (
 user_id uuid not null references auth.users(id) on delete cascade,
 receipt_id uuid not null, session_id uuid not null,
 request_digest text not null, reported_at timestamptz not null default now(),
 primary key(user_id,receipt_id),
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
alter table public.conversation_playback_batches enable row level security;
revoke all on public.conversation_playback_batches from public,anon,authenticated;
grant all on public.conversation_playback_batches to service_role;

create function loop_private.conversation_event_digest(e public.transcript_events) returns text
language sql immutable set search_path='' as $$
 select md5(jsonb_build_array(e.id,e.session_id,e.speaker,e.text,extract(epoch from e.timestamp))::text)
$$;
revoke all on function loop_private.conversation_event_digest(public.transcript_events) from public,anon,authenticated;

-- A receipt may be recorded before the call ends. Bind the stable source clock
-- and identity, rather than the expected active -> ended lifecycle transition.
create function loop_private.conversation_session_digest(s public.sessions) returns text
language sql immutable set search_path='' as $$
 select md5(jsonb_build_array(s.id,s.user_id,s.companion_id,extract(epoch from s.created_at),s.time_zone)::text)
$$;
revoke all on function loop_private.conversation_session_digest(public.sessions) from public,anon,authenticated;

create function public.record_conversation_playback(
 p_session_id uuid,p_event_ids uuid[],p_receipt_id uuid,p_qualified_user_ids uuid[],p_expected_memory_revision bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); s public.sessions%rowtype; v_revision bigint; e public.transcript_events%rowtype; r public.conversation_playback_receipts%rowtype;
 v_users uuid[]; v_user_digests jsonb; v_request_digest text; v_session_digest text;
begin
 if p_session_id is null or p_receipt_id is null or p_expected_memory_revision is null or p_expected_memory_revision<0
 or p_event_ids is null or array_ndims(p_event_ids)<>1 or cardinality(p_event_ids) not between 1 and 50
 or p_qualified_user_ids is null or (cardinality(p_qualified_user_ids)>0 and array_ndims(p_qualified_user_ids)<>1) or cardinality(p_qualified_user_ids)>3000
 or array_position(p_event_ids,null) is not null or array_position(p_qualified_user_ids,null) is not null
 or cardinality(p_event_ids)<>(select count(distinct x) from unnest(p_event_ids) x)
 or cardinality(p_qualified_user_ids)<>(select count(distinct x) from unnest(p_qualified_user_ids) x)
 then raise exception 'PLAYBACK_INVALID_RECEIPT' using errcode='22023';end if;
 select * into s from public.sessions where id=p_session_id and user_id=v_user for share;
 if s.id is null then raise exception 'PLAYBACK_SCOPE_DENIED' using errcode='42501';end if;
 perform loop_private.memory_guard(v_user,s.companion_id);
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':conversation-playback-receipt:'||p_receipt_id::text,0));
 -- Serialize different receipt IDs for the same source session as well as exact
 -- retries, so a conflicting race cannot acknowledge an INSERT DO NOTHING.
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':conversation-playback:'||s.id::text,0));
 insert into public.memory_state(user_id,companion_id) values(v_user,s.companion_id) on conflict do nothing;
 select revision into v_revision from public.memory_state where user_id=v_user and companion_id=s.companion_id for share;
 -- The version captured at playback time survives queue retries. A late offline
 -- receipt must never acquire a new revision after a forget/exclusion operation.
 if v_revision<>p_expected_memory_revision then
  return jsonb_build_object('session_id',s.id,'acknowledged_ids','[]'::jsonb,'discarded_ids',to_jsonb(p_event_ids),'reason','stale_revision');
 end if;
 if exists(select 1 from unnest(p_event_ids||p_qualified_user_ids) x
   where not exists(select 1 from public.transcript_events t where t.id=x and t.session_id=s.id and t.user_id=v_user))
 then raise exception 'PLAYBACK_SOURCE_NOT_SAVED' using errcode='40001';end if;
 if exists(select 1 from public.transcript_events t where t.id=any(p_event_ids) and t.speaker<>'assistant')
 or exists(select 1 from public.transcript_events t where t.id=any(p_qualified_user_ids) and t.speaker<>'user')
 then raise exception 'PLAYBACK_SCOPE_DENIED' using errcode='42501';end if;
 select coalesce(array_agg(x order by x),'{}'::uuid[]) into v_users from unnest(p_qualified_user_ids) x;
 select coalesce(jsonb_object_agg(t.id::text,loop_private.conversation_event_digest(t)),'{}'::jsonb) into v_user_digests
 from public.transcript_events t where t.id=any(v_users) and t.user_id=v_user and t.session_id=s.id;
 v_session_digest:=loop_private.conversation_session_digest(s);
 v_request_digest:=md5(jsonb_build_array(s.id,(select array_agg(x order by x) from unnest(p_event_ids) x),v_users,p_expected_memory_revision)::text);
 if exists(select 1 from public.conversation_playback_batches x where x.user_id=v_user and x.receipt_id=p_receipt_id and x.request_digest<>v_request_digest)
 then raise exception 'PLAYBACK_RECEIPT_CHANGED' using errcode='40001';end if;
 insert into public.conversation_playback_batches(user_id,receipt_id,session_id,request_digest)
 values(v_user,p_receipt_id,s.id,v_request_digest) on conflict(user_id,receipt_id) do nothing;
 for e in select * from public.transcript_events where id=any(p_event_ids) and user_id=v_user and session_id=s.id loop
  select * into r from public.conversation_playback_receipts where user_id=v_user and event_id=e.id for update;
  if r.event_id is not null and (r.event_digest is distinct from loop_private.conversation_event_digest(e) or r.memory_revision<>v_revision
   or r.source_session_digest is distinct from v_session_digest or r.user_digests is distinct from v_user_digests
   or r.qualified_user_ids is distinct from v_users or r.session_id<>s.id or r.companion_id<>s.companion_id)
  then raise exception 'PLAYBACK_SOURCE_CHANGED' using errcode='40001';end if;
  insert into public.conversation_playback_receipts(user_id,session_id,event_id,companion_id,receipt_id,memory_revision,event_digest,source_session_digest,user_digests,request_digest,qualified_user_ids)
  values(v_user,s.id,e.id,s.companion_id,p_receipt_id,v_revision,loop_private.conversation_event_digest(e),v_session_digest,v_user_digests,v_request_digest,v_users)
  on conflict(user_id,event_id) do nothing;
 end loop;
 return jsonb_build_object('session_id',s.id,'acknowledged_ids',to_jsonb(p_event_ids),'discarded_ids','[]'::jsonb,'reason',null);
end;$$;
revoke all on function public.record_conversation_playback(uuid,uuid[],uuid,uuid[],bigint) from public,anon,authenticated;
grant execute on function public.record_conversation_playback(uuid,uuid[],uuid,uuid[],bigint) to authenticated;

create function public.conversation_exchange_context(p_user_id uuid,p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_revision bigint; result jsonb; v_forget_after timestamptz; v_durable_forget timestamptz; v_unknown_forget boolean;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 select coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0) into v_revision;
 select conversation_forget_after into v_durable_forget from public.memory_state where user_id=p_user_id and companion_id=p_companion_id;
 -- Spoken forget markers can be materialized without changing memory_state.
 -- Exclude their source call and all older exchanges, including AI paraphrases.
 select max(coalesce((f->>'spoken_at')::timestamptz,(f->>'updated_at')::timestamptz)),
 coalesce(bool_or(coalesce(f->>'spoken_at',f->>'updated_at') is null),false)
 into v_forget_after,v_unknown_forget from jsonb_array_elements(loop_private.memory_facts(p_user_id,p_companion_id)) f
 where f->>'forgotten'='true' or f->>'value'='';
 if v_unknown_forget then return jsonb_build_object('version','conversation-exchange-v1','revision',v_revision,'exchanges','[]'::jsonb);end if;
 v_forget_after:=greatest(v_forget_after,v_durable_forget);
 with recent_receipts as materialized (
  select * from public.conversation_playback_receipts r where r.user_id=p_user_id and r.companion_id=p_companion_id and r.memory_revision=v_revision
  order by r.reported_at desc,r.event_id desc limit 200
 ), eligible as materialized (
  select s.* from loop_private.conversation_eligible(p_user_id,p_companion_id) s
  where (v_forget_after is null or s.created_at>v_forget_after)
  and exists(select 1 from recent_receipts r where r.session_id=s.id)
 ), pairs as (
  select s.*,a.id assistant_id,a.text assistant_text,a.timestamp assistant_at,u.id user_event_id,u.text user_text,u.timestamp user_at
  from eligible s join recent_receipts r on r.session_id=s.id and r.source_session_digest=loop_private.conversation_session_digest(s)
  join public.transcript_events a on a.id=r.event_id and a.user_id=p_user_id and a.session_id=s.id and a.speaker='assistant'
   and r.event_digest=loop_private.conversation_event_digest(a) and length(btrim(a.text))>0 and a.timestamp between s.created_at and s.ended_at
  cross join lateral (
   select t.id,t.text,t.timestamp from public.transcript_events t
   where t.user_id=p_user_id and t.session_id=s.id and t.speaker='user' and t.id=any(r.qualified_user_ids)
   and length(btrim(t.text))>0 and t.timestamp between s.created_at and a.timestamp
   order by t.timestamp desc,t.id desc limit 1
  ) u
  where r.user_digests=(select coalesce(jsonb_object_agg(t.id::text,loop_private.conversation_event_digest(t)),'{}'::jsonb)
   from public.transcript_events t where t.user_id=p_user_id and t.session_id=s.id and t.speaker='user' and t.id=any(r.qualified_user_ids))
 ), chosen_sessions as (select distinct id,created_at from pairs order by created_at desc,id desc limit 2),
 -- Reuse an independent handoff's selected user event as a relevance hint.
 -- Otherwise prefer a substantive excerpt over a later short farewell. This
 -- ranks context only; raw speech and in-call turn ownership are unchanged.
 ranked as (select p.*,row_number() over(partition by p.id order by
  exists(select 1 from public.conversation_memories m cross join lateral jsonb_array_elements(m.content->'threads') thread
   where m.user_id=p_user_id and m.session_id=p.id and m.companion_id=p_companion_id and m.revision=v_revision
    and m.schema_version='conversation-handoff-v1' and thread->'evidence_ids' ? p.user_event_id::text) desc,
  least(length(p.user_text),180) desc,assistant_at desc,assistant_id desc) as source_rank from pairs p join chosen_sessions c using(id,created_at)),
 bounded as (select * from ranked where source_rank<=2 order by created_at desc,id desc,assistant_at desc limit 4)
 select coalesce(jsonb_agg(jsonb_build_object(
  'version','conversation-exchange-v1','source_session_id',id,'companion_id',p_companion_id,'memory_revision',v_revision,
  'session_created_at',created_at,'session_ended_at',ended_at,'session_time_zone',time_zone,
  'admission','client_reported_playback_completed',
  'caller',jsonb_build_object('id',user_event_id,'speaker','user','quote',left(user_text,600),'timestamp',user_at,'truncated',length(user_text)>600),
  'companion',jsonb_build_object('id',assistant_id,'speaker','assistant','quote',left(assistant_text,600),'timestamp',assistant_at,'truncated',length(assistant_text)>600)
 ) order by created_at desc,id desc,assistant_at desc),'[]'::jsonb) into result from bounded;
 return jsonb_build_object('version','conversation-exchange-v1','revision',v_revision,'exchanges',result);
end;$$;
revoke all on function public.conversation_exchange_context(uuid,text) from public,anon,authenticated;
grant execute on function public.conversation_exchange_context(uuid,text) to service_role;

-- Recovery can obtain an approved memory-free voice configuration without
-- querying historical facts or transcripts. Authorization stays DB-authoritative.
create function public.conversation_context_authorized(p_user_id uuid,p_session_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype;
begin
 select * into s from public.sessions where id=p_session_id and user_id=p_user_id;
 if s.id is null then return false;end if;
 perform loop_private.memory_guard(p_user_id,s.companion_id);
 return s.status='active';
end;$$;
revoke all on function public.conversation_context_authorized(uuid,uuid) from public,anon,authenticated;
grant execute on function public.conversation_context_authorized(uuid,uuid) to service_role;

-- Keep the established required retrieval unchanged. Optional exchange lookup
-- adds no HTTP/provider request; bounded helper errors safely yield no exchanges.
-- The shared SQL statement retains the existing required retrieval timeout.
alter function public.memory_context(uuid,text,text,real[],text,integer) rename to memory_context_before_exchanges_v1;
revoke all on function public.memory_context_before_exchanges_v1(uuid,text,text,real[],text,integer) from public,anon,authenticated;
grant execute on function public.memory_context_before_exchanges_v1(uuid,text,text,real[],text,integer) to service_role;
create function public.memory_context(p_user_id uuid,p_companion_id text,p_query text default '',p_embedding real[] default null,p_embedding_model text default 'text-embedding-3-small',p_limit integer default 12)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; extra jsonb;
begin
 result:=public.memory_context_before_exchanges_v1(p_user_id,p_companion_id,p_query,p_embedding,p_embedding_model,p_limit);
 begin
  extra:=public.conversation_exchange_context(p_user_id,p_companion_id);
  if (extra->>'revision')::bigint=(result->>'revision')::bigint then
   return result||jsonb_build_object('shared_exchanges',extra->'exchanges');
  end if;
 exception when others then null;
 end;
 return result||jsonb_build_object('shared_exchanges','[]'::jsonb);
end;$$;
revoke all on function public.memory_context(uuid,text,text,real[],text,integer) from public,anon,authenticated;
grant execute on function public.memory_context(uuid,text,text,real[],text,integer) to service_role;

-- The ordinary backup exports memory_state rows, including the date-only
-- boundary. Restore merges restrictions monotonically; an older backup or a
-- source deletion cannot lower an already applied forget boundary.
alter function public.restore_history(jsonb) rename to restore_history_before_exchanges_v1;
revoke all on function public.restore_history_before_exchanges_v1(jsonb) from public,anon,authenticated,service_role;
create function public.restore_history(p_backup jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_controls jsonb;v_row jsonb;v_companion text;v_companions text[]:='{}';v_after timestamptz;v_existing timestamptz;v_result jsonb;
begin
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501';end if;
 if not p_backup ? 'memory_controls' then return public.restore_history_before_exchanges_v1(p_backup);end if;
 v_controls:=p_backup->'memory_controls';
 if jsonb_typeof(v_controls)<>'object' then raise exception 'Invalid memory controls' using errcode='22023';end if;
 foreach v_companion in array array['state','facts','exclusions'] loop
  if v_controls ? v_companion and (jsonb_typeof(v_controls->v_companion)<>'array' or jsonb_array_length(v_controls->v_companion)>10000)
  then raise exception 'Invalid memory controls' using errcode='22023';end if;
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'state','[]'::jsonb))
  union all select value from jsonb_array_elements(coalesce(v_controls->'facts','[]'::jsonb))
  union all select value from jsonb_array_elements(coalesce(v_controls->'exclusions','[]'::jsonb)) loop
  if jsonb_typeof(v_row)<>'object' or (v_row ? 'user_id' and (v_row->>'user_id')::uuid is distinct from v_user)
  then raise exception 'Memory controls belong to another user' using errcode='42501';end if;
  v_companion:=v_row->>'companion_id';perform loop_private.memory_guard(v_user,v_companion);
  if not v_companion=any(v_companions) then v_companions:=array_append(v_companions,v_companion);end if;
 end loop;
 -- Use the existing restore's full companion lock order, including facts and
 -- exclusions, before merging a boundary or inserting any restored sessions.
 for v_companion in select x from unnest(v_companions) x order by x loop
  insert into public.memory_state(user_id,companion_id) values(v_user,v_companion) on conflict do nothing;
  perform 1 from public.memory_state where user_id=v_user and companion_id=v_companion for update;
 end loop;
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'state','[]'::jsonb)) loop
  v_companion:=v_row->>'companion_id';v_after:=(v_row->>'conversation_forget_after')::timestamptz;
  if v_after is not null and (not isfinite(v_after) or v_after>now())
  then raise exception 'Invalid conversation forget boundary' using errcode='22023';end if;
  select conversation_forget_after into v_existing from public.memory_state where user_id=v_user and companion_id=v_companion;
  if v_after is not null and (v_existing is null or v_after>v_existing)
   and exists(select 1 from public.sessions where user_id=v_user and companion_id=v_companion and status='active')
  then raise exception 'Finish unfinished calls before changing memory' using errcode='55000';end if;
 end loop;
 v_result:=public.restore_history_before_exchanges_v1(p_backup);
 for v_row in select value from jsonb_array_elements(coalesce(v_controls->'state','[]'::jsonb)) loop
  perform loop_private.advance_conversation_forget(v_user,v_row->>'companion_id',(v_row->>'conversation_forget_after')::timestamptz);
 end loop;
 return v_result;
end;$$;
revoke all on function public.restore_history(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.restore_history(jsonb) to authenticated;
