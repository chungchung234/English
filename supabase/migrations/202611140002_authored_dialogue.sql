-- Authored dialogue is a separate, service-owned two-stage transport. Client
-- qualification/playback are reports, never proof of speech or human hearing.
create table public.authored_dialogue_authority (
 user_id uuid not null references auth.users(id) on delete cascade,
 companion_id text not null check(companion_id in ('mia','alex','juno')),
 epoch bigint not null default 0 check(epoch>=0), primary key(user_id,companion_id)
);
create table public.authored_dialogue_calls (
 session_id uuid primary key,user_id uuid not null,companion_id text not null check(companion_id in ('mia','alex','juno')),
 call_epoch bigint not null default 1,authority_generation bigint not null default 1,turn_generation bigint not null default 0,
 memory_mode text not null check(memory_mode in ('included','omitted')),memory_revision bigint,
 checkpoint jsonb,retired_before timestamptz,updated_at timestamptz not null default now(),
 unique(session_id,user_id),foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade,
 check(call_epoch>0 and authority_generation>0 and turn_generation>=0),
 check((memory_mode='omitted' and memory_revision is null) or (memory_mode='included' and memory_revision>=0))
);
create table public.authored_dialogue_turns (
 id uuid primary key default gen_random_uuid(),assistant_event_id uuid not null unique default gen_random_uuid(),
 session_id uuid not null,user_id uuid not null,companion_id text not null,
 call_epoch bigint not null,authority_generation bigint not null,turn_generation bigint not null,playback_epoch bigint not null,
 turn_nonce uuid not null,purpose text not null check(purpose in ('startup','reply','hint')),hint text,
 memory_mode text not null,memory_revision bigint,policy_fingerprint text not null,
 current_user_ids uuid[] not null,history_ids uuid[] not null,request_digest text not null,context_digest text not null,
 source_manifest jsonb not null default '{}',status text not null default 'reserved'
  check(status in ('reserved','text_complete','synthesizing','published','played','cancelled')),
 dialogue_job_id uuid,dialogue_lease_token uuid,synthesis_job_id uuid,synthesis_lease_token uuid,
 written_text_sha256 text,assistant_event_digest text,synthesis_settings jsonb,
 transcript_sha256 text,audio_sha256 text,audio_bytes bigint,audio_frames bigint,pcm_rate integer,
 playback_receipt_id uuid,playback_user_ids uuid[],
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,session_id,call_epoch,turn_nonce),unique(session_id,call_epoch,turn_generation),
 foreign key(session_id,user_id) references public.authored_dialogue_calls(session_id,user_id) on delete cascade
);
create table public.authored_dialogue_cancellations (
 user_id uuid not null,session_id uuid not null,call_epoch bigint not null,authority_generation bigint not null,
 turn_nonce uuid not null,turn_generation bigint not null,created_at timestamptz not null default now(),
 primary key(user_id,session_id,call_epoch,turn_nonce),
 foreign key(session_id,user_id) references public.authored_dialogue_calls(session_id,user_id) on delete cascade
);
do $$declare t text;begin
 foreach t in array array['authored_dialogue_authority','authored_dialogue_calls','authored_dialogue_turns','authored_dialogue_cancellations'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end;$$;

create function loop_private.authored_sha(v text) returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(convert_to(v,'UTF8'),'sha256'),'hex')
$$;
create function loop_private.authored_time(v text) returns text language plpgsql immutable set search_path='' as $$
declare t timestamptz;begin
 if v is null then return null;end if;t:=v::timestamptz;if not isfinite(t) then return null;end if;
 return to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
exception when others then return null;end;$$;
create function loop_private.authored_ids(v uuid[],allow_empty boolean default true) returns boolean
language sql immutable set search_path='' as $$
 select v is not null and cardinality(v)<=3000 and (allow_empty or cardinality(v)>0)
 and (cardinality(v)=0 or array_ndims(v)=1) and array_position(v,null) is null
 and cardinality(v)=(select count(distinct x) from unnest(v) x)
$$;
create function loop_private.authored_bump(u uuid,c text) returns void language plpgsql security definer set search_path='' as $$
begin
 if u is null or c is null or not exists(select 1 from auth.users where id=u) then return;end if;
 insert into public.authored_dialogue_authority(user_id,companion_id,epoch) values(u,c,1)
 on conflict(user_id,companion_id) do update set epoch=public.authored_dialogue_authority.epoch+1;
end;$$;
-- AFTER triggers serialize commit/publication through an authority row. A
-- publisher holds that row while reading sources with MVCC (not source row
-- locks). A pending mutation can commit either before or after publication;
-- it cannot become committed halfway through that source check.
create function loop_private.authored_source_mutation() returns trigger language plpgsql security definer set search_path='' as $$
declare r jsonb;u uuid;c text;s public.sessions%rowtype;e text;
begin
 for r in select x from unnest(case when TG_OP='INSERT' then array[to_jsonb(new)] when TG_OP='DELETE' then array[to_jsonb(old)] else array[to_jsonb(old),to_jsonb(new)] end) x loop
  if TG_TABLE_SCHEMA='auth' then
   u:=(r->>'id')::uuid;foreach c in array array['alex','juno','mia'] loop perform loop_private.authored_bump(u,c);end loop;
  elsif TG_TABLE_NAME='approved_emails' then
   for u in select id from auth.users where lower(btrim(email))=r->>'email' order by id loop
    foreach c in array array['alex','juno','mia'] loop perform loop_private.authored_bump(u,c);end loop;
   end loop;
  else
   u:=(r->>'user_id')::uuid;c:=r->>'companion_id';
   if c is null and r->>'session_id' is not null then
    select * into s from public.sessions where id=(r->>'session_id')::uuid and user_id=u;c:=s.companion_id;
    -- Active raw INSERTs are not accepted turn instructions. New qualified
    -- turns advance the explicit generation; raw background noise does not.
    if TG_TABLE_NAME='transcript_events' and TG_OP='INSERT' and s.status='active' then continue;end if;
   end if;
   perform loop_private.authored_bump(u,c);
  end if;
 end loop;
 return null;
end;$$;
do $$declare t text;begin
 foreach t in array array['sessions','transcript_events','analyses','memory_state','memory_fact_overrides','memory_session_exclusions','conversation_memories','learning_source_holds','learning_sources','learning_state_items','learning_feedback'] loop
 execute format('create trigger authored_dialogue_authority after insert or update or delete on public.%I for each row execute function loop_private.authored_source_mutation()',t);
 end loop;
end;$$;
create trigger authored_dialogue_authority after insert or update or delete on loop_private.approved_emails for each row execute function loop_private.authored_source_mutation();
create trigger authored_dialogue_authority after update or delete on auth.users for each row execute function loop_private.authored_source_mutation();

create function loop_private.authored_lock_call(u uuid,sid uuid,check_memory boolean default true) returns public.authored_dialogue_calls
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;s public.sessions%rowtype;begin
 -- Acquire current-session FK protection before authority. Legacy append/
 -- finish also take session locks; publication never locks historical rows.
 perform 1 from public.sessions where id=sid and user_id=u for key share;
 select * into c from public.authored_dialogue_calls where session_id=sid and user_id=u for update;
 if c.session_id is null then raise exception 'DIALOGUE_SCOPE_DENIED' using errcode='42501';end if;
 insert into public.authored_dialogue_authority(user_id,companion_id) values(u,c.companion_id) on conflict do nothing;
 perform 1 from public.authored_dialogue_authority where user_id=u and companion_id=c.companion_id for update;
 select * into s from public.sessions where id=sid and user_id=u;
 perform loop_private.memory_guard(u,c.companion_id);
 if s.id is null or s.companion_id<>c.companion_id or s.status<>'active' then raise exception 'DIALOGUE_SESSION_ENDED' using errcode='40001';end if;
 if check_memory and c.memory_mode='included' and c.memory_revision is distinct from (select revision from public.memory_state where user_id=u and companion_id=c.companion_id)
 then raise exception 'DIALOGUE_MEMORY_CHANGED' using errcode='40001';end if;
 return c;
end;$$;
create function loop_private.authored_facts(u uuid,c text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare f jsonb;r jsonb;a jsonb:='[]';t text;begin
 for f in select value from jsonb_array_elements(loop_private.memory_facts(u,c)) loop
  r:=jsonb_build_object('key',f->>'key','value',case when f->>'forgotten'='true' or f->>'value'='' then '' else f->>'value' end,'forgotten',f->>'forgotten'='true' or f->>'value'='');
  if r->>'forgotten'='true' then
   t:=loop_private.authored_time(f->>'spoken_at');
   if t is not null then r:=r||jsonb_build_object('spoken_at',t);else t:=loop_private.authored_time(f->>'updated_at');if t is not null then r:=r||jsonb_build_object('updated_at',t);end if;end if;
  elsif f->>'manual'='true' then
   r:=r||jsonb_build_object('manual',true);t:=loop_private.authored_time(f->>'updated_at');if t is not null then r:=r||jsonb_build_object('updated_at',t);end if;
  else
   t:=loop_private.authored_time(f->>'spoken_at');if t is not null then r:=r||jsonb_build_object('spoken_at',t);end if;
   if f ? 'session_id' then r:=r||jsonb_build_object('session_id',f->'session_id');end if;
   if length(btrim(f->>'quote'))>0 and length(f->>'quote')<=500 then r:=r||jsonb_build_object('quote',f->'quote');end if;
   if jsonb_typeof(f->'evidence_ids')='array' then r:=r||jsonb_build_object('evidence_ids',(select coalesce(jsonb_agg(v),'[]') from (select value v from jsonb_array_elements(f->'evidence_ids') limit 12) q));end if;
  end if;
  a:=a||jsonb_build_array(r);
 end loop;return a;
end;$$;
create function loop_private.authored_source_stamp(u uuid,c text,sid uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare s public.sessions%rowtype;r jsonb;begin
 select * into s from loop_private.conversation_eligible(u,c) where id=sid;
 if s.id is null then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 r:=jsonb_build_array(loop_private.conversation_session_digest(s),s.status,s.record_incomplete,s.ended_at,
  public.learning_transcript_digest(sid),
  (select md5(to_jsonb(a)::text) from public.analyses a where a.user_id=u and a.session_id=sid and a.kind='session' order by a.created_at desc,a.id desc limit 1),
  (select md5(to_jsonb(m)::text) from public.conversation_memories m where m.user_id=u and m.session_id=sid));
 return md5(r::text);
end;$$;
create function loop_private.authored_event_digests(u uuid,sid uuid,ids uuid[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r jsonb;begin
 if not loop_private.authored_ids(ids) or exists(select 1 from unnest(ids) x(event_id) where not exists(select 1 from public.transcript_events e where e.id=x.event_id and e.user_id=u and e.session_id=sid))
 then raise exception 'DIALOGUE_INVALID_SOURCE_IDS' using errcode='22023';end if;
 select coalesce(jsonb_object_agg(e.id::text,loop_private.conversation_event_digest(e)),'{}') into r from public.transcript_events e where e.id=any(ids) and e.user_id=u and e.session_id=sid;
 return r;
end;$$;

create function loop_private.authored_keys(v jsonb,allowed text[]) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='object',false) and not exists(select 1 from jsonb_object_keys(case when jsonb_typeof(v)='object' then v else '{}'::jsonb end) k where not k=any(allowed))
$$;
create function loop_private.authored_quote(u uuid,sid uuid,q jsonb,speaker text,field text) returns void
language plpgsql stable security definer set search_path='' as $$
declare e public.transcript_events%rowtype;s public.sessions%rowtype;v text;begin
 if not loop_private.authored_keys(q,array['id','speaker','text','quote','timestamp','truncated']) then raise exception 'DIALOGUE_INVALID_QUOTE';end if;
 select * into e from public.transcript_events where id=(q->>'id')::uuid and user_id=u and session_id=sid;
 select * into s from public.sessions where id=sid and user_id=u;v:=q->>field;
 if e.id is null or e.speaker<>speaker or (q ? 'speaker' and q->>'speaker'<>speaker)
 or v is null or length(btrim(v)) not between 1 and 600 or position(v in e.text)=0
 or loop_private.authored_time(q->>'timestamp') is distinct from loop_private.authored_time(e.timestamp::text)
 or e.timestamp<s.created_at or e.timestamp>coalesce(s.ended_at,now())
 then raise exception 'DIALOGUE_INVALID_QUOTE' using errcode='40001';end if;
end;$$;
create function loop_private.authored_source_clock(u uuid,c text,v jsonb,sid uuid,start_field text,end_field text,zone_field text) returns void
language plpgsql stable security definer set search_path='' as $$
declare s public.sessions%rowtype;begin
 select * into s from loop_private.conversation_eligible(u,c) where id=sid;
 if s.id is null or loop_private.authored_time(v->>start_field) is distinct from loop_private.authored_time(s.created_at::text)
 or loop_private.authored_time(v->>end_field) is distinct from loop_private.authored_time(s.ended_at::text)
 or (v->>zone_field) is distinct from s.time_zone
 then raise exception 'DIALOGUE_SOURCE_CLOCK_CHANGED' using errcode='40001';end if;
end;$$;
create function loop_private.authored_conversation(u uuid,c text,v jsonb) returns uuid language plpgsql stable security definer set search_path='' as $$
declare sid uuid;q jsonb;t jsonb;m public.conversation_memories%rowtype;begin
 if not loop_private.authored_keys(v,array['session_id','session_created_at','session_ended_at','session_time_zone','mode','summary','threads','turns'])
 or v->'summary' is distinct from 'null'::jsonb or v->>'mode' not in ('handoff','excerpt_fallback')
 or jsonb_typeof(v->'turns')<>'array' or jsonb_array_length(v->'turns') not between 1 and 3
 or jsonb_typeof(v->'threads')<>'array' or jsonb_array_length(v->'threads')>3
 then raise exception 'DIALOGUE_INVALID_CONVERSATION' using errcode='22023';end if;
 sid:=(v->>'session_id')::uuid;perform loop_private.authored_source_clock(u,c,v,sid,'session_created_at','session_ended_at','session_time_zone');
 for q in select value from jsonb_array_elements(v->'turns') loop perform loop_private.authored_quote(u,sid,q,'user','text');end loop;
 if v->>'mode'='handoff' then
  select * into m from public.conversation_memories where user_id=u and session_id=sid and companion_id=c
   and revision=(select revision from public.memory_state where user_id=u and companion_id=c)
   and source_version=public.learning_transcript_digest(sid);
  if m.id is null or jsonb_array_length(v->'threads')=0 then raise exception 'DIALOGUE_HANDOFF_CHANGED' using errcode='40001';end if;
  for t in select value from jsonb_array_elements(v->'threads') loop
   if not loop_private.authored_keys(t,array['note','state','when','follow_up','evidence_ids']) or t->'follow_up' is distinct from 'null'::jsonb
   or not exists(select 1 from jsonb_array_elements(m.content->'threads') original where original->>'note'=t->>'note' and original->>'state'=t->>'state'
    and original->'when'=t->'when' and original->'evidence_ids'=t->'evidence_ids')
   or not exists(select 1 from jsonb_array_elements(v->'turns') as quote_src(value) where (t->'evidence_ids') ? (quote_src.value->>'id'))
   then raise exception 'DIALOGUE_HANDOFF_CHANGED' using errcode='40001';end if;
  end loop;
 elsif jsonb_array_length(v->'threads')<>0 then raise exception 'DIALOGUE_INVALID_CONVERSATION';end if;
 return sid;
end;$$;
create function loop_private.authored_shared(u uuid,c text,v jsonb,revision bigint) returns uuid language plpgsql stable security definer set search_path='' as $$
declare sid uuid;r public.conversation_playback_receipts%rowtype;begin
 if not loop_private.authored_keys(v,array['version','source_session_id','companion_id','memory_revision','session_created_at','session_ended_at','session_time_zone','admission','caller','companion'])
 or v->>'version'<>'conversation-exchange-v1' or v->>'admission'<>'client_reported_playback_completed' or v->>'companion_id'<>c
 or (v->>'memory_revision')::bigint is distinct from revision
 then raise exception 'DIALOGUE_INVALID_SHARED_SOURCE';end if;
 if exists(select 1 from public.transcript_events e where e.id=(v#>>'{caller,id}')::uuid and left(e.text,length(v#>>'{caller,quote}')) is distinct from v#>>'{caller,quote}')
 or exists(select 1 from public.transcript_events e where e.id=(v#>>'{companion,id}')::uuid and left(e.text,length(v#>>'{companion,quote}')) is distinct from v#>>'{companion,quote}') then raise exception 'DIALOGUE_INVALID_SHARED_PREFIX';end if;
 sid:=(v->>'source_session_id')::uuid;perform loop_private.authored_source_clock(u,c,v,sid,'session_created_at','session_ended_at','session_time_zone');
 perform loop_private.authored_quote(u,sid,v->'caller','user','quote');perform loop_private.authored_quote(u,sid,v->'companion','assistant','quote');
 select * into r from public.conversation_playback_receipts where user_id=u and session_id=sid and event_id=(v#>>'{companion,id}')::uuid and memory_revision=revision;
 if r.event_id is null or not (v#>>'{caller,id}')::uuid=any(r.qualified_user_ids)
 or r.event_digest is distinct from (select loop_private.conversation_event_digest(e) from public.transcript_events e where e.id=r.event_id)
 or r.source_session_digest is distinct from (select loop_private.conversation_session_digest(s) from public.sessions s where s.id=sid)
 or r.user_digests is distinct from loop_private.authored_event_digests(u,sid,r.qualified_user_ids)
 or exists(select 1 from public.memory_state where user_id=u and companion_id=c and conversation_forget_after>=(select created_at from public.sessions where id=sid))
 then raise exception 'DIALOGUE_SHARED_SOURCE_CHANGED' using errcode='40001';end if;
 return sid;
end;$$;
create function loop_private.authored_validate_context(u uuid,sid uuid,c text,mode text,revision bigint,context jsonb,opening jsonb,checkpoint jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare mem jsonb;v jsonb;q jsonb;t jsonb;ids uuid[]:='{}';source uuid;s public.sessions%rowtype;m public.conversation_memories%rowtype;manifest jsonb:='{}';facts jsonb;suppressed boolean;scenario text;begin
 if not loop_private.authored_keys(context,array['companionId','scenario','memory','checkpoint']) or context->>'companionId'<>c
 or not loop_private.authored_keys(context->'memory',array['facts','recent_conversation','conversation_memories','memories','suppress_memory','shared_exchanges'])
 then raise exception 'DIALOGUE_INVALID_CONTEXT';end if;
 select * into s from public.sessions where id=sid and user_id=u;mem:=context->'memory';
 scenario:='Natural English conversation about everyday life';
 if mode<>'omitted' and s.scenario like 'User-prepared conversation:%' and length(btrim(substr(s.scenario,length('User-prepared conversation:')+1))) between 1 and 500
 then scenario:='User-prepared conversation: '||btrim(substr(s.scenario,length('User-prepared conversation:')+1));end if;
 if context->>'scenario' is distinct from scenario then raise exception 'DIALOGUE_SCENARIO_CHANGED';end if;
 if context->'checkpoint' is distinct from (case when checkpoint is null then 'null'::jsonb else jsonb_build_object('summary',checkpoint->>'summary') end)
 then raise exception 'DIALOGUE_CHECKPOINT_CHANGED' using errcode='40001';end if;
 facts:=case when mode='omitted' then '[]'::jsonb else loop_private.authored_facts(u,c) end;
 suppressed:=mode='omitted' or coalesce((public.learning_voice_context(u,c)->>'suppress_memory')::boolean,true);
 if mem->'facts' is distinct from facts or mem->'suppress_memory' is distinct from to_jsonb(suppressed)
 then raise exception 'DIALOGUE_FACTS_CHANGED' using errcode='40001';end if;
 if jsonb_typeof(mem->'conversation_memories')<>'array' or jsonb_typeof(mem->'memories')<>'array'
 or (mem ? 'shared_exchanges' and jsonb_typeof(mem->'shared_exchanges')<>'array')
 then raise exception 'DIALOGUE_INVALID_CONTEXT';end if;
 if mem->'recent_conversation'<>'null'::jsonb then ids:=array_append(ids,loop_private.authored_conversation(u,c,mem->'recent_conversation'));end if;
 for v in select value from jsonb_array_elements(mem->'conversation_memories') loop ids:=array_append(ids,loop_private.authored_conversation(u,c,v));end loop;
 for v in select value from jsonb_array_elements(mem->'memories') loop
  if not loop_private.authored_keys(v,array['session_id','session_created_at','session_ended_at','session_time_zone','evidence']) or jsonb_typeof(v->'evidence')<>'array' then raise exception 'DIALOGUE_INVALID_CONTEXT';end if;
  source:=(v->>'session_id')::uuid;perform loop_private.authored_source_clock(u,c,v,source,'session_created_at','session_ended_at','session_time_zone');
  for q in select value from jsonb_array_elements(v->'evidence') loop perform loop_private.authored_quote(u,source,q,'user','text');end loop;
  ids:=array_append(ids,source);
 end loop;
 for v in select value from jsonb_array_elements(coalesce(mem->'shared_exchanges','[]')) loop ids:=array_append(ids,loop_private.authored_shared(u,c,v,revision));end loop;
 if suppressed and cardinality(ids)>0 then raise exception 'DIALOGUE_SUPPRESSED_SOURCE';end if;
 if opening is not null and opening<>'null'::jsonb then
  if not loop_private.authored_keys(opening,array['version','purpose','current_utterance','role','context_kind','prepared_topic','continuity','shared_exchange','recent_openings','reason'])
  or opening->>'version'<>'opening-context-v2' or opening->>'purpose'<>'call_opening' or opening->'current_utterance' is distinct from 'null'::jsonb
  or opening->>'role'<>'optional_conversation_context' or jsonb_typeof(opening->'recent_openings')<>'array' then raise exception 'DIALOGUE_INVALID_OPENING';end if;
  v:=opening->'continuity';
  if v<>'null'::jsonb then
   source:=(v->>'session_id')::uuid;perform loop_private.authored_source_clock(u,c,v,source,'source_started_at','source_ended_at','source_time_zone');
   perform loop_private.authored_quote(u,source,jsonb_build_object('id',v->>'evidence_id','quote',v->>'quote','timestamp',v->>'source_spoken_at'),'user','quote');
   select cm.* into m from public.conversation_memories cm where cm.user_id=u and cm.session_id=source and cm.companion_id=c
    and cm.revision=authored_validate_context.revision and cm.source_version=public.learning_transcript_digest(source);
   if m.id is null or not exists(select 1 from jsonb_array_elements(m.content->'threads') as thread_src(value) where
    regexp_replace(btrim(thread_src.value->>'note'),'\s+',' ','g')=v->>'note' and thread_src.value->>'state'=v->>'state' and thread_src.value->'when'=v->'when'
    and (thread_src.value->'evidence_ids') ? (v->>'evidence_id')) then raise exception 'DIALOGUE_OPENING_CHANGED' using errcode='40001';end if;
   ids:=array_append(ids,source);
  end if;
  if opening ? 'shared_exchange' then ids:=array_append(ids,loop_private.authored_shared(u,c,opening->'shared_exchange',revision));end if;
  for v in select value from jsonb_array_elements(opening->'recent_openings') loop
   source:=(v->>'session_id')::uuid;
   if v->>'role'<>'style_only' or not exists(select 1 from public.transcript_events e where e.user_id=u and e.session_id=source and e.speaker='assistant'
    and loop_private.authored_time(e.timestamp::text)=loop_private.authored_time(v->>'occurred_at')
    and left(regexp_replace(btrim(e.text),'\s+',' ','g'),240)=v->>'text'
    and not exists(select 1 from public.transcript_events earlier where earlier.session_id=source and (earlier.timestamp,earlier.id)<(e.timestamp,e.id)))
   then raise exception 'DIALOGUE_OPENING_CHANGED' using errcode='40001';end if;
   ids:=array_append(ids,source);
  end loop;
  if opening->'prepared_topic'<>'null'::jsonb and (opening#>>'{prepared_topic,text}') is distinct from btrim(substr(s.scenario,length('User-prepared conversation:')+1)) then raise exception 'DIALOGUE_PREPARED_TOPIC_CHANGED';end if;
 end if;
 if suppressed and cardinality(ids)>0 then raise exception 'DIALOGUE_SUPPRESSED_SOURCE';end if;
 for source in select distinct x from unnest(ids) x loop
  if source=sid then raise exception 'DIALOGUE_CURRENT_SOURCE_AS_HISTORY';end if;
  manifest:=manifest||jsonb_build_object(source::text,loop_private.authored_source_stamp(u,c,source));
 end loop;
 return jsonb_build_object('sources',manifest,'facts_hash',md5(facts::text),'suppressed',suppressed);
end;$$;

-- Preserve exact selected-source manifests, not a second copy of caller memory
-- text. Publication rechecks these under the same authority-row lock as source
-- mutations. An unrelated new source does not invalidate an existing selection.
create function loop_private.authored_verify_sources(t public.authored_dialogue_turns) returns void
language plpgsql stable security definer set search_path='' as $$
declare x record;f jsonb;suppressed boolean;begin
 f:=case when t.memory_mode='omitted' then '[]'::jsonb else loop_private.authored_facts(t.user_id,t.companion_id) end;
 suppressed:=t.memory_mode='omitted' or coalesce((public.learning_voice_context(t.user_id,t.companion_id)->>'suppress_memory')::boolean,true);
 if md5(f::text) is distinct from t.source_manifest->>'facts_hash' or to_jsonb(suppressed) is distinct from t.source_manifest->'suppressed'
 then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 for x in select key,value from jsonb_each_text(t.source_manifest->'sources') loop
  if x.value is distinct from loop_private.authored_source_stamp(t.user_id,t.companion_id,x.key::uuid) then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 end loop;
 if t.assistant_event_digest is not null and not exists(select 1 from public.transcript_events e where e.id=t.assistant_event_id and e.user_id=t.user_id and e.session_id=t.session_id
  and e.speaker='assistant' and loop_private.conversation_event_digest(e)=t.assistant_event_digest and loop_private.authored_sha(e.text)=t.written_text_sha256)
 then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 if t.source_manifest->'event_digests' is distinct from loop_private.authored_event_digests(t.user_id,t.session_id,t.history_ids||t.current_user_ids)
 then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
end;$$;
create function loop_private.authored_turn_lock(u uuid,tid uuid,ce bigint,ag bigint,tg bigint) returns public.authored_dialogue_turns
language plpgsql security definer set search_path='' as $$
declare t public.authored_dialogue_turns%rowtype;c public.authored_dialogue_calls%rowtype;begin
 select * into t from public.authored_dialogue_turns where id=tid and user_id=u;
 if t.id is null then raise exception 'DIALOGUE_SCOPE_DENIED' using errcode='42501';end if;
 c:=loop_private.authored_lock_call(u,t.session_id);
 select * into t from public.authored_dialogue_turns where id=tid and user_id=u for update;
 if t.call_epoch<>ce or t.authority_generation<>ag or t.turn_generation<>tg or c.call_epoch<>ce or c.authority_generation<>ag
 or c.memory_mode<>t.memory_mode or c.memory_revision is distinct from t.memory_revision
 then raise exception 'DIALOGUE_STALE_AUTHORITY' using errcode='40001';end if;
 if t.status='cancelled' or exists(select 1 from public.authored_dialogue_cancellations x where x.user_id=u and x.session_id=t.session_id and x.call_epoch=ce and x.turn_nonce=t.turn_nonce)
 then raise exception 'DIALOGUE_CANCELLED' using errcode='40001';end if;
 perform loop_private.authored_verify_sources(t);return t;
end;$$;
create function loop_private.authored_job(u uuid,sid uuid,jid uuid,token uuid,kind text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.analysis_jobs j where j.id=jid and j.user_id=u and j.session_id=sid and j.kind=authored_job.kind
 and j.state='running' and j.lease_token=token and j.lease_expires_at>now() for update;
 if not found then raise exception 'DIALOGUE_INVALID_LEASE' using errcode='40001';end if;
end;$$;
create function loop_private.authored_history(u uuid,c public.authored_dialogue_calls,ids uuid[]) returns uuid[]
language plpgsql security definer set search_path='' as $$
declare e public.transcript_events%rowtype;t public.authored_dialogue_turns%rowtype;ordered uuid[]:='{}';begin
 perform loop_private.authored_event_digests(u,c.session_id,ids);
 for e in select * from public.transcript_events where id=any(ids) and user_id=u and session_id=c.session_id order by timestamp,id loop
  if c.retired_before is not null and e.timestamp<=c.retired_before then raise exception 'DIALOGUE_RETIRED_HISTORY' using errcode='40001';end if;
  if e.speaker='assistant' then
   select * into t from public.authored_dialogue_turns where user_id=u and session_id=c.session_id and assistant_event_id=e.id
   and call_epoch=c.call_epoch and authority_generation=c.authority_generation and status='played';
   if t.id is null or t.assistant_event_digest is distinct from loop_private.conversation_event_digest(e) then raise exception 'DIALOGUE_UNPLAYED_HISTORY' using errcode='40001';end if;
   perform loop_private.authored_verify_sources(t);
  elsif not exists(select 1 from public.authored_dialogue_turns q where q.user_id=u and q.session_id=c.session_id
   and q.call_epoch=c.call_epoch and q.authority_generation=c.authority_generation and e.id=any(q.current_user_ids))
  then raise exception 'DIALOGUE_UNQUALIFIED_HISTORY' using errcode='40001';end if;
  ordered:=array_append(ordered,e.id);
 end loop;return ordered;
end;$$;
create function public.authored_dialogue_context(p_user_id uuid,p_session_id uuid,p_omit_memory boolean,p_call_epoch bigint,p_reset boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype;c public.authored_dialogue_calls%rowtype;r bigint;mode text;invalid_checkpoint boolean:=false;covered uuid[];begin
 if p_user_id is null or p_session_id is null or p_omit_memory is null or p_reset is null or p_call_epoch is null or p_call_epoch<1 then raise exception 'DIALOGUE_INVALID_CONTEXT';end if;
 select * into s from public.sessions where id=p_session_id and user_id=p_user_id for key share;
 if s.id is null or s.status<>'active' then raise exception 'DIALOGUE_SESSION_ENDED' using errcode='40001';end if;
 perform loop_private.memory_guard(p_user_id,s.companion_id);
 insert into public.memory_state(user_id,companion_id) values(p_user_id,s.companion_id) on conflict do nothing;
 select revision into r from public.memory_state where user_id=p_user_id and companion_id=s.companion_id;
 mode:=case when p_omit_memory then 'omitted' else 'included' end;if p_omit_memory then r:=null;end if;
 insert into public.authored_dialogue_calls(session_id,user_id,companion_id,call_epoch,memory_mode,memory_revision)
 values(s.id,p_user_id,s.companion_id,p_call_epoch,mode,r) on conflict do nothing;
 -- Match every publisher: current SESSION -> CALL -> AUTHORITY, then TURN.
 select * into c from public.authored_dialogue_calls where session_id=s.id and user_id=p_user_id for update;
 insert into public.authored_dialogue_authority(user_id,companion_id) values(p_user_id,s.companion_id) on conflict do nothing;
 perform 1 from public.authored_dialogue_authority where user_id=p_user_id and companion_id=s.companion_id for update;
 select case when p_omit_memory then null else revision end into r from public.memory_state where user_id=p_user_id and companion_id=s.companion_id;
 if c.checkpoint is not null then
  begin
   covered:=array(select jsonb_array_elements_text(c.checkpoint->'covered_ids'))::uuid[];
   if c.checkpoint->'source_digest' is distinct from loop_private.authored_event_digests(p_user_id,s.id,covered) then invalid_checkpoint:=true;
   else perform loop_private.authored_history(p_user_id,c,covered);end if;
  exception when others then invalid_checkpoint:=true;end;
 end if;
 if c.call_epoch>p_call_epoch then raise exception 'DIALOGUE_STALE_AUTHORITY' using errcode='40001';end if;
 if p_reset or invalid_checkpoint or c.call_epoch<>p_call_epoch or c.memory_mode<>mode or c.memory_revision is distinct from r then
  update public.authored_dialogue_calls set call_epoch=p_call_epoch,authority_generation=authority_generation+1,
   memory_mode=mode,memory_revision=r,checkpoint=null,retired_before=now(),updated_at=now() where session_id=s.id returning * into c;
 end if;
 return to_jsonb(c);
end;$$;
create function public.authored_dialogue_playback(p_user_id uuid,p_turn_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_turn_generation bigint,
 p_playback_epoch bigint,p_receipt_id uuid,p_qualified_user_ids uuid[],p_assistant_event_id uuid,p_expected_memory_revision bigint,p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.authored_dialogue_turns%rowtype;c public.authored_dialogue_calls%rowtype;s public.sessions%rowtype;reason text;d text;users uuid[];begin
 select * into t from public.authored_dialogue_turns where id=p_turn_id and user_id=p_user_id;
 if t.id is null then raise exception 'DIALOGUE_SCOPE_DENIED' using errcode='42501';end if;
 perform 1 from public.sessions where id=t.session_id and user_id=p_user_id for key share;
 select * into c from public.authored_dialogue_calls where session_id=t.session_id and user_id=p_user_id for update;
 perform 1 from public.authored_dialogue_authority where user_id=p_user_id and companion_id=c.companion_id for update;
 select * into t from public.authored_dialogue_turns where id=p_turn_id and user_id=p_user_id for update;
 select * into s from public.sessions where id=t.session_id and user_id=p_user_id;
 perform loop_private.memory_guard(p_user_id,c.companion_id);
 if t.call_epoch is distinct from p_call_epoch or t.authority_generation is distinct from p_authority_generation or t.turn_generation is distinct from p_turn_generation
 or t.playback_epoch is distinct from p_playback_epoch or t.assistant_event_id is distinct from p_assistant_event_id or t.memory_revision is distinct from p_expected_memory_revision
 or t.companion_id is distinct from p_companion_id or p_receipt_id is null or not loop_private.authored_ids(p_qualified_user_ids)
 then raise exception 'DIALOGUE_PLAYBACK_OWNER_CHANGED' using errcode='40001';end if;
 select coalesce(array_agg(x order by x),'{}'::uuid[]) into users from unnest(p_qualified_user_ids) x;
 if t.playback_receipt_id is not null and (t.playback_receipt_id<>p_receipt_id or t.playback_user_ids is distinct from users) then raise exception 'DIALOGUE_PLAYBACK_CHANGED' using errcode='40001';end if;
 if s.status<>'active' then reason:='session_ended';
 elsif c.call_epoch<>t.call_epoch or c.authority_generation<>t.authority_generation then reason:='stale_authority';
 elsif c.memory_revision is distinct from t.memory_revision or (t.memory_mode='included' and t.memory_revision is distinct from (select revision from public.memory_state where user_id=p_user_id and companion_id=c.companion_id)) then reason:='stale_revision';
 elsif t.status='cancelled' or exists(select 1 from public.authored_dialogue_cancellations x where x.user_id=p_user_id and x.session_id=t.session_id and x.call_epoch=t.call_epoch and x.turn_nonce=t.turn_nonce) then reason:='cancelled';
 elsif t.status not in ('published','played') then raise exception 'DIALOGUE_PLAYBACK_UNPUBLISHED' using errcode='40001';
 end if;
 if reason is null then
  begin perform loop_private.authored_verify_sources(t);exception when others then reason:='source_changed';end;
 end if;
 if reason is not null then return jsonb_build_object('turn',to_jsonb(t),'receipt_id',p_receipt_id,'status','discarded','reason',reason);end if;
 if exists(select 1 from unnest(users) x where not x=any(t.current_user_ids||t.history_ids))
 or exists(select 1 from unnest(users) x where not exists(select 1 from public.transcript_events e where e.id=x and e.user_id=p_user_id and e.session_id=t.session_id and e.speaker='user'))
 then raise exception 'DIALOGUE_PLAYBACK_USER_CHANGED' using errcode='40001';end if;
 update public.authored_dialogue_turns set status='played',playback_receipt_id=p_receipt_id,playback_user_ids=users,updated_at=now() where id=t.id returning * into t;
 if t.memory_mode='included' and cardinality(users)>0 then
  d:=md5(jsonb_build_array(s.id,jsonb_build_array(t.assistant_event_id),users,t.memory_revision)::text);
  insert into public.conversation_playback_batches(user_id,receipt_id,session_id,request_digest) values(p_user_id,p_receipt_id,s.id,d) on conflict do nothing;
  if exists(select 1 from public.conversation_playback_batches where user_id=p_user_id and receipt_id=p_receipt_id and request_digest<>d) then raise exception 'DIALOGUE_PLAYBACK_CHANGED';end if;
  insert into public.conversation_playback_receipts(user_id,session_id,event_id,companion_id,receipt_id,memory_revision,event_digest,source_session_digest,user_digests,request_digest,qualified_user_ids)
  select p_user_id,s.id,e.id,s.companion_id,p_receipt_id,t.memory_revision,loop_private.conversation_event_digest(e),loop_private.conversation_session_digest(s),
   loop_private.authored_event_digests(p_user_id,s.id,users),d,users from public.transcript_events e where e.id=t.assistant_event_id on conflict do nothing;
 end if;
 return jsonb_build_object('turn',to_jsonb(t),'receipt_id',p_receipt_id,'status','recorded','reason',null);
end;$$;
create function public.authored_dialogue_batchplaybacks(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_reports jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q jsonb;r jsonb;a jsonb:='[]';c public.authored_dialogue_calls%rowtype;begin
 if jsonb_typeof(p_reports)<>'array' or jsonb_array_length(p_reports)>50 then raise exception 'DIALOGUE_INVALID_REPORTS';end if;
 c:=loop_private.authored_lock_call(p_user_id,p_session_id);
 if c.call_epoch<>p_call_epoch or c.authority_generation<>p_authority_generation then raise exception 'DIALOGUE_STALE_AUTHORITY';end if;
 for q in select value from jsonb_array_elements(p_reports) loop
  if not loop_private.authored_keys(q,array['turn_id','turn_generation','playback_epoch','receipt_id','qualified_user_ids','call_epoch','authority_generation','assistant_event_id','expected_memory_revision','companion_id'])
  or (q->>'call_epoch')::bigint is distinct from p_call_epoch or (q->>'authority_generation')::bigint is distinct from p_authority_generation
  or not exists(select 1 from public.authored_dialogue_turns where id=(q->>'turn_id')::uuid and session_id=p_session_id and user_id=p_user_id) then raise exception 'DIALOGUE_INVALID_REPORTS';end if;
  r:=public.authored_dialogue_playback(p_user_id,(q->>'turn_id')::uuid,p_call_epoch,p_authority_generation,(q->>'turn_generation')::bigint,(q->>'playback_epoch')::bigint,(q->>'receipt_id')::uuid,
   array(select jsonb_array_elements_text(q->'qualified_user_ids'))::uuid[],(q->>'assistant_event_id')::uuid,(q->>'expected_memory_revision')::bigint,q->>'companion_id');a:=a||jsonb_build_array(r);
 end loop;return jsonb_build_object('processed',jsonb_array_length(a),'results',a);
end;$$;
create function public.authored_dialogue_checkpoint(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_expected_generation bigint,
 p_covered_event_ids uuid[],p_summary text,p_expected_memory_revision bigint,p_policy_fingerprint text,p_source_event_digests jsonb,p_turn_nonce uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;ordered uuid[];v jsonb;begin
 c:=loop_private.authored_lock_call(p_user_id,p_session_id);
 if c.call_epoch<>p_call_epoch or c.authority_generation<>p_authority_generation or c.turn_generation<>p_expected_generation or c.memory_revision is distinct from p_expected_memory_revision
 or not loop_private.authored_ids(p_covered_event_ids,false) or p_summary is null or p_policy_fingerprint is null or length(btrim(p_summary)) not between 1 and 900 or length(p_policy_fingerprint)<>64 then raise exception 'DIALOGUE_CHECKPOINT_CHANGED' using errcode='40001';end if;
 if p_turn_nonce is null or exists(select 1 from public.authored_dialogue_cancellations where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce) then raise exception 'DIALOGUE_CANCELLED';end if;
 ordered:=loop_private.authored_history(p_user_id,c,p_covered_event_ids);
 if p_source_event_digests is distinct from loop_private.authored_event_digests(p_user_id,p_session_id,ordered) then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 if c.checkpoint is not null and not (array(select jsonb_array_elements_text(c.checkpoint->'covered_ids'))::uuid[] <@ ordered) then raise exception 'DIALOGUE_CHECKPOINT_WITHDRAWN';end if;
 v:=jsonb_build_object('version','conversation-checkpoint-v1','summary',p_summary,'covered_ids',to_jsonb(ordered),'policy_fingerprint',p_policy_fingerprint,
  'source_digest',loop_private.authored_event_digests(p_user_id,p_session_id,ordered));
 update public.authored_dialogue_calls set checkpoint=v,updated_at=now() where session_id=p_session_id;return jsonb_build_object('checkpoint',v);
end;$$;
create function public.authored_dialogue_begin(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_expected_generation bigint,p_turn_nonce uuid,
 p_purpose text,p_current_user_ids uuid[],p_history_ids uuid[],p_expected_memory_revision bigint,p_playback_epoch bigint,p_context jsonb,p_opening jsonb,p_policy_fingerprint text,
 p_hint text,p_pending_playbacks jsonb,p_checkpoint_covered_ids uuid[],p_speech_speed numeric,p_source_event_digests jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;t public.authored_dialogue_turns%rowtype;q public.authored_dialogue_turns%rowtype;
 manifest jsonb;digest text;hist uuid[];current_ids uuid[];coverage uuid[];begin
 c:=loop_private.authored_lock_call(p_user_id,p_session_id);
 if c.call_epoch<>p_call_epoch or c.authority_generation<>p_authority_generation or c.memory_revision is distinct from p_expected_memory_revision then raise exception 'DIALOGUE_STALE_AUTHORITY' using errcode='40001';end if;
 if p_turn_nonce is null or p_playback_epoch is null or p_playback_epoch<0 or p_expected_generation is null or p_expected_generation<0
 or p_purpose is null or p_purpose not in ('startup','reply','hint') or (p_purpose='startup' and (p_opening is null or p_opening='null'::jsonb)) or (p_purpose='reply' and cardinality(p_current_user_ids)=0) or (p_purpose<>'reply' and cardinality(p_current_user_ids)<>0)
 or (p_purpose='hint' and p_hint is distinct from 'next_sentence') or (p_purpose<>'hint' and p_hint is not null)
 or not loop_private.authored_ids(p_current_user_ids) or not loop_private.authored_ids(p_history_ids) or p_current_user_ids&&p_history_ids
 or not loop_private.authored_ids(p_checkpoint_covered_ids) or p_speech_speed not between 0.5 and 1.5 or p_speech_speed*20<>round(p_speech_speed*20) or p_speech_speed is null or p_policy_fingerprint is null or length(p_policy_fingerprint)<>64
 then raise exception 'DIALOGUE_INVALID_REQUEST' using errcode='22023';end if;
 digest:=loop_private.authored_sha(jsonb_build_array(p_call_epoch,p_authority_generation,p_expected_generation,p_turn_nonce,p_purpose,p_current_user_ids,p_history_ids,
  p_expected_memory_revision,p_playback_epoch,p_context,p_opening,p_policy_fingerprint,p_hint,p_checkpoint_covered_ids,p_speech_speed,p_source_event_digests)::text);
 select * into t from public.authored_dialogue_turns where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce;
 if t.id is not null then
  if t.request_digest<>digest then raise exception 'DIALOGUE_NONCE_CHANGED' using errcode='40001';end if;
  if t.status='cancelled' then raise exception 'DIALOGUE_CANCELLED' using errcode='40001';end if;
  perform loop_private.authored_verify_sources(t);
  return jsonb_build_object('turn',to_jsonb(t),'assistant_event',(select to_jsonb(e) from public.transcript_events e where e.id=t.assistant_event_id));
 end if;
 if exists(select 1 from public.authored_dialogue_cancellations where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce)
 then raise exception 'DIALOGUE_CANCELLED' using errcode='40001';end if;
 if c.turn_generation<>p_expected_generation then raise exception 'DIALOGUE_STALE_GENERATION' using errcode='40001';end if;
 perform public.authored_dialogue_batchplaybacks(p_user_id,p_session_id,p_call_epoch,p_authority_generation,coalesce(p_pending_playbacks,'[]'));
 hist:=loop_private.authored_history(p_user_id,c,p_history_ids);
 perform loop_private.authored_event_digests(p_user_id,p_session_id,p_current_user_ids);
 if exists(select 1 from public.transcript_events where id=any(p_current_user_ids) and (speaker<>'user' or (c.retired_before is not null and timestamp<=c.retired_before))) then raise exception 'DIALOGUE_INVALID_CURRENT_SPEECH';end if;
 select coalesce(array_agg(e.id order by e.timestamp,e.id),'{}'::uuid[]) into current_ids from public.transcript_events e where e.id=any(p_current_user_ids);
 coverage:=case when c.checkpoint is null then '{}'::uuid[] else array(select jsonb_array_elements_text(c.checkpoint->'covered_ids'))::uuid[] end;
 if coverage is distinct from p_checkpoint_covered_ids or hist[1:cardinality(coverage)] is distinct from coverage
 or (c.checkpoint is not null and c.checkpoint->'source_digest' is distinct from loop_private.authored_event_digests(p_user_id,p_session_id,coverage)) then raise exception 'DIALOGUE_CHECKPOINT_WITHDRAWN' using errcode='40001';end if;
 if p_source_event_digests is distinct from loop_private.authored_event_digests(p_user_id,p_session_id,hist||current_ids) then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 manifest:=loop_private.authored_validate_context(p_user_id,p_session_id,c.companion_id,c.memory_mode,c.memory_revision,p_context,p_opening,c.checkpoint)
  ||jsonb_build_object('event_digests',loop_private.authored_event_digests(p_user_id,p_session_id,hist||current_ids));
 -- Provider reasoning/IDs are never persisted or replayed. The author gets
 -- fresh qualified plaintext plus a source-validated conversation checkpoint.
 update public.authored_dialogue_calls set turn_generation=turn_generation+1,updated_at=now() where session_id=p_session_id returning * into c;
 insert into public.authored_dialogue_turns(user_id,session_id,companion_id,call_epoch,authority_generation,turn_generation,playback_epoch,turn_nonce,purpose,hint,memory_mode,memory_revision,
 policy_fingerprint,current_user_ids,history_ids,request_digest,context_digest,source_manifest,synthesis_settings)
 values(p_user_id,p_session_id,c.companion_id,p_call_epoch,p_authority_generation,c.turn_generation,p_playback_epoch,p_turn_nonce,p_purpose,p_hint,c.memory_mode,c.memory_revision,
 p_policy_fingerprint,current_ids,hist,digest,loop_private.authored_sha(jsonb_build_array(p_context,p_opening)::text),manifest,jsonb_build_object('speed',p_speech_speed)) returning * into t;
 return jsonb_build_object('turn',to_jsonb(t),'opaque_history','{}'::jsonb);
end;$$;
create function loop_private.authored_settled(jid uuid,token uuid,expected_outcome text) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.model_spend where job_id=jid and lease_token=token and outcome=expected_outcome)
 then raise exception 'DIALOGUE_SPEND_UNSETTLED' using errcode='40001';end if;
end;$$;
create function public.authored_dialogue_complete_text(p_user_id uuid,p_turn_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_turn_generation bigint,
 p_job_id uuid,p_lease_token uuid,p_text text,p_opaque_output jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.authored_dialogue_turns%rowtype;e public.transcript_events%rowtype;c public.authored_dialogue_calls%rowtype;begin
 t:=loop_private.authored_turn_lock(p_user_id,p_turn_id,p_call_epoch,p_authority_generation,p_turn_generation);
 select * into c from public.authored_dialogue_calls where session_id=t.session_id;
 if c.turn_generation<>p_turn_generation or t.status<>'reserved' or p_text is null or length(btrim(p_text)) not between 1 and 20000
 or p_opaque_output is not null then raise exception 'DIALOGUE_TEXT_INVALID';end if;
 perform loop_private.authored_job(p_user_id,t.session_id,p_job_id,p_lease_token,'dialogue');
 perform loop_private.authored_settled(p_job_id,p_lease_token,'generated');
 insert into public.transcript_events(id,user_id,session_id,event_key,speaker,text,timestamp)
 values(t.assistant_event_id,p_user_id,t.session_id,'authored:'||t.id::text,'assistant',p_text,clock_timestamp()) returning * into e;
 update public.authored_dialogue_turns set status='text_complete',dialogue_job_id=p_job_id,dialogue_lease_token=p_lease_token,written_text_sha256=loop_private.authored_sha(p_text),
 assistant_event_digest=loop_private.conversation_event_digest(e),updated_at=now()
 where id=t.id returning * into t;
 perform public.complete_run(p_job_id,p_lease_token,jsonb_build_object('turn_id',t.id,'assistant_event_id',e.id));
 return jsonb_build_object('turn',to_jsonb(t),'assistant_event',to_jsonb(e));
end;$$;
create function public.authored_dialogue_synthesis_begin(p_user_id uuid,p_turn_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_turn_generation bigint,
 p_playback_epoch bigint,p_job_id uuid,p_lease_token uuid,p_settings jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.authored_dialogue_turns%rowtype;e public.transcript_events%rowtype;settings jsonb;voice text;speed numeric;begin
 t:=loop_private.authored_turn_lock(p_user_id,p_turn_id,p_call_epoch,p_authority_generation,p_turn_generation);
 if t.status<>'text_complete' or t.playback_epoch<>p_playback_epoch or (select turn_generation from public.authored_dialogue_calls where session_id=t.session_id)<>p_turn_generation
 or p_settings is distinct from jsonb_build_object('model','gpt-realtime-2.1-mini','verification_policy','lexical-fidelity-v1') then raise exception 'DIALOGUE_SYNTHESIS_INVALID';end if;
 perform loop_private.authored_job(p_user_id,t.session_id,p_job_id,p_lease_token,'dialogue_synthesis');
 select * into e from public.transcript_events where id=t.assistant_event_id and user_id=p_user_id and session_id=t.session_id;
 if t.assistant_event_digest is distinct from loop_private.conversation_event_digest(e) or t.written_text_sha256 is distinct from loop_private.authored_sha(e.text) then raise exception 'DIALOGUE_SOURCE_CHANGED';end if;
 voice:=case t.companion_id when 'mia' then 'marin' when 'alex' then 'cedar' when 'juno' then 'verse' end;speed:=(t.synthesis_settings->>'speed')::numeric;
 settings:=p_settings||jsonb_build_object('voice',voice,'speed',speed,'approved_text_sha256',t.written_text_sha256);
 update public.authored_dialogue_turns set status='synthesizing',synthesis_job_id=p_job_id,synthesis_lease_token=p_lease_token,synthesis_settings=settings,updated_at=now() where id=t.id returning * into t;
 return jsonb_build_object('turn',to_jsonb(t),'text',e.text,'voice',voice,'speed',speed,'settings',settings);
end;$$;
create function public.authored_dialogue_publish(p_user_id uuid,p_turn_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_turn_generation bigint,
 p_playback_epoch bigint,p_job_id uuid,p_lease_token uuid,p_transcript text,p_audio_sha256 text,p_audio_bytes bigint,p_audio_frames bigint,p_pcm_rate integer,p_settings jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.authored_dialogue_turns%rowtype;e public.transcript_events%rowtype;begin
 t:=loop_private.authored_turn_lock(p_user_id,p_turn_id,p_call_epoch,p_authority_generation,p_turn_generation);
 if t.status<>'synthesizing' or t.playback_epoch<>p_playback_epoch or t.synthesis_job_id<>p_job_id or t.synthesis_lease_token<>p_lease_token
 or (select turn_generation from public.authored_dialogue_calls where session_id=t.session_id)<>p_turn_generation or t.synthesis_settings is distinct from p_settings
 or p_transcript is null or p_audio_sha256 is null or p_audio_bytes is null or p_audio_frames is null or p_pcm_rate is null or length(btrim(p_transcript)) not between 1 and 20000 or p_audio_sha256 !~ '^[0-9a-f]{64}$' or p_audio_bytes not between 2 and 4320000
 or p_audio_frames<1 or p_audio_bytes<>p_audio_frames*2 or p_pcm_rate<>24000 then raise exception 'DIALOGUE_PUBLICATION_INVALID';end if;
 perform loop_private.authored_job(p_user_id,t.session_id,p_job_id,p_lease_token,'dialogue_synthesis');
 perform loop_private.authored_settled(p_job_id,p_lease_token,'generated_audio');
 select * into e from public.transcript_events where id=t.assistant_event_id;
 if t.assistant_event_digest is distinct from loop_private.conversation_event_digest(e) or t.written_text_sha256 is distinct from loop_private.authored_sha(e.text) then raise exception 'DIALOGUE_SOURCE_CHANGED';end if;
 update public.authored_dialogue_turns set status='published',transcript_sha256=loop_private.authored_sha(p_transcript),audio_sha256=p_audio_sha256,audio_bytes=p_audio_bytes,audio_frames=p_audio_frames,pcm_rate=p_pcm_rate,updated_at=now() where id=t.id;
 perform public.complete_run(p_job_id,p_lease_token,jsonb_build_object('turn_id',t.id,'audio_sha256',p_audio_sha256));
 return jsonb_build_object('published',true,'turn_id',t.id,'turn_generation',t.turn_generation,'synthesis_id',p_job_id);
end;$$;
create function public.authored_dialogue_cancel(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_turn_nonce uuid,p_turn_generation bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;t public.authored_dialogue_turns%rowtype;begin
 c:=loop_private.authored_lock_call(p_user_id,p_session_id,false);
 if p_call_epoch is null or p_authority_generation is null or p_turn_nonce is null then raise exception 'DIALOGUE_INVALID_CANCELLATION';end if;
 if c.call_epoch<>p_call_epoch or c.authority_generation<>p_authority_generation then return jsonb_build_object('cancelled',true,'status','stale','turn_nonce',p_turn_nonce,'call_epoch',p_call_epoch,'authority_generation',p_authority_generation,'turn_generation',c.turn_generation);end if;
 select * into t from public.authored_dialogue_turns where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce for update;
 if t.id is not null and (t.authority_generation<>p_authority_generation or (p_turn_generation is not null and t.turn_generation<>p_turn_generation)) then raise exception 'DIALOGUE_CANCEL_OWNER_CHANGED';end if;
 insert into public.authored_dialogue_cancellations(user_id,session_id,call_epoch,authority_generation,turn_nonce,turn_generation)
 values(p_user_id,p_session_id,p_call_epoch,p_authority_generation,p_turn_nonce,coalesce(t.turn_generation,c.turn_generation)) on conflict do nothing;
 update public.authored_dialogue_turns set status='cancelled',updated_at=now() where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce;
 return jsonb_build_object('cancelled',true,'status',case when t.status='cancelled' then 'already_cancelled' else 'cancelled' end,'turn_nonce',p_turn_nonce,'call_epoch',p_call_epoch,'authority_generation',p_authority_generation,'turn_generation',c.turn_generation);
end;$$;

-- Only trusted edge handlers can attest qualification, generation and PCM.
do $$declare f record;begin
 for f in select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname like 'authored_dialogue_%') or (n.nspname='loop_private' and p.proname like 'authored_%') loop
  execute 'revoke all on function '||f.signature||' from public,anon,authenticated,service_role';
  if f.signature like 'authored_dialogue_%' or f.signature like 'public.authored_dialogue_%' then execute 'grant execute on function '||f.signature||' to service_role';end if;
 end loop;
end;$$;

-- Separate per-stage accounting. Existing reservation policy stays byte-for-
-- byte in the delegated legacy function; no voice/checkpoint budget is borrowed.
alter table public.analysis_jobs drop constraint analysis_jobs_kind_check;
alter table public.analysis_jobs drop constraint analysis_jobs_check;
alter table public.analysis_jobs add constraint analysis_jobs_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding','reconsider','handoff','dialogue','dialogue_synthesis'));
alter table public.analysis_jobs add constraint analysis_jobs_check check((kind in ('session','reconsider','handoff','dialogue','dialogue_synthesis') and session_id is not null) or (kind='weekly' and session_id is null) or kind in ('voice','checkpoint','part','embedding'));
alter table public.api_daily_usage drop constraint api_daily_usage_kind_check;
alter table public.api_daily_usage add constraint api_daily_usage_kind_check check(kind in ('session','weekly','voice','checkpoint','part','embedding','reconsider','handoff','dialogue','dialogue_synthesis'));
alter function public.reserve_run(uuid,text,text,uuid,integer) set schema loop_private;
revoke all on function loop_private.reserve_run(uuid,text,text,uuid,integer) from public,anon,authenticated,service_role;
create function public.reserve_run(p_user_id uuid,p_kind text,p_request_key text,p_session_id uuid default null,p_lease_seconds integer default 180) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype;j public.analysis_jobs%rowtype;v_day date:=(now() at time zone 'UTC')::date;n integer;begin
 if p_kind not in ('dialogue','dialogue_synthesis') or p_kind is null then return loop_private.reserve_run(p_user_id,p_kind,p_request_key,p_session_id,p_lease_seconds);end if;
 if p_user_id is null or p_session_id is null or p_request_key is null or length(p_request_key) not between 1 and 200 or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then raise exception 'Invalid reservation' using errcode='22023';end if;
 select * into s from public.sessions where id=p_session_id and user_id=p_user_id and status='active';
 if s.id is null then raise exception 'Owned active session required' using errcode='42501';end if;
 perform loop_private.memory_guard(p_user_id,s.companion_id);
 insert into public.analysis_jobs(user_id,kind,request_key,session_id) values(p_user_id,p_kind,p_request_key,p_session_id) on conflict do nothing;
 select * into j from public.analysis_jobs where user_id=p_user_id and kind=p_kind and request_key=p_request_key for update;
 if j.session_id is distinct from p_session_id then raise exception 'Request key belongs to another session';end if;
 if j.attempts>0 then return jsonb_build_object('reserved',false,'reason',case when j.state='completed' then 'completed' when j.state='running' and j.lease_expires_at>now() then 'in_progress' else 'retry_blocked' end,'job_id',j.id,'state',j.state,'attempts',j.attempts);end if;
 insert into public.api_daily_usage(user_id,day,kind,reservations) values(p_user_id,v_day,p_kind,0) on conflict do nothing;
 update public.api_daily_usage a set reservations=a.reservations+1 where a.user_id=p_user_id and a.day=v_day and a.kind=p_kind and a.reservations<600 returning reservations into n;
 if not found then return jsonb_build_object('reserved',false,'reason','budget_exceeded','job_id',j.id);end if;
 update public.analysis_jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempts=1,error=null,updated_at=now() where id=j.id returning * into j;
 return jsonb_build_object('reserved',true,'reason','reserved','job_id',j.id,'lease_token',j.lease_token,'state',j.state,'attempts',j.attempts);
end;$$;
create or replace function public.reserve_model_spend(p_job_id uuid,p_lease_token uuid,p_model text,p_policy jsonb,p_reserved_usd numeric) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype;total numeric;begin
 select * into j from public.analysis_jobs where id=p_job_id for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.kind not in ('session','weekly','part','checkpoint','embedding','reconsider','handoff','dialogue','dialogue_synthesis') then raise exception 'Invalid spend lease' using errcode='40001';end if;
 if p_reserved_usd is null or p_reserved_usd<=0 or p_reserved_usd>1 or p_model is null or p_policy is null then raise exception 'Invalid cost reservation' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(j.user_id::text,83921));
 if exists(select 1 from public.model_spend where job_id=p_job_id and lease_token=p_lease_token) then return false;end if;
 select coalesce(sum(case
  when job.kind in ('dialogue','dialogue_synthesis') and spend.outcome in ('generated','generated_audio','http_error','incomplete','reservation_exceeded')
   and spend.estimated_usd is not null and spend.estimated_usd::text not in ('NaN','Infinity','-Infinity') and spend.estimated_usd>=0
   and jsonb_typeof(spend.usage->'input_tokens')='number' and jsonb_typeof(spend.usage->'output_tokens')='number'
   and spend.usage->>'input_tokens' ~ '^[0-9]+$' and spend.usage->>'output_tokens' ~ '^[0-9]+$'
   and (job.kind<>'dialogue_synthesis' or case when jsonb_typeof(spend.usage->'output_tokens')='number' and spend.usage->>'output_tokens' ~ '^[0-9]+$' then (spend.usage->>'output_tokens')::numeric>0 else false end)
  then spend.estimated_usd else spend.reserved_usd end),0) into total
 from public.model_spend spend join public.analysis_jobs job on job.id=spend.job_id
 where spend.user_id=j.user_id and spend.day=(now() at time zone 'UTC')::date;
 if total+p_reserved_usd>1 then return false;end if;
 insert into public.model_spend(job_id,lease_token,user_id,model,policy,reserved_usd) values(p_job_id,p_lease_token,j.user_id,p_model,p_policy,p_reserved_usd);return true;
end;$$;
revoke all on function public.reserve_run(uuid,text,text,uuid,integer),public.reserve_model_spend(uuid,uuid,text,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.reserve_run(uuid,text,text,uuid,integer),public.reserve_model_spend(uuid,uuid,text,jsonb,numeric) to service_role;

-- Admission happens before any external checkpoint or dialogue model request,
-- not just at publication after provider work has already seen the material.
create function public.authored_dialogue_history(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_expected_generation bigint,
 p_current_user_ids uuid[],p_history_ids uuid[],p_expected_memory_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;hist uuid[];current_ids uuid[];begin
 c:=loop_private.authored_lock_call(p_user_id,p_session_id);
 if c.call_epoch is distinct from p_call_epoch or c.authority_generation is distinct from p_authority_generation or c.turn_generation is distinct from p_expected_generation
 or c.memory_revision is distinct from p_expected_memory_revision or not loop_private.authored_ids(p_current_user_ids) or not loop_private.authored_ids(p_history_ids) or p_current_user_ids&&p_history_ids
 then raise exception 'DIALOGUE_STALE_AUTHORITY' using errcode='40001';end if;
 hist:=loop_private.authored_history(p_user_id,c,p_history_ids);
 perform loop_private.authored_event_digests(p_user_id,p_session_id,p_current_user_ids);
 if exists(select 1 from public.transcript_events where id=any(p_current_user_ids) and (speaker<>'user' or (c.retired_before is not null and timestamp<=c.retired_before))) then raise exception 'DIALOGUE_INVALID_CURRENT_SPEECH';end if;
 select coalesce(array_agg(e.id order by e.timestamp,e.id),'{}'::uuid[]) into current_ids from public.transcript_events e where e.id=any(p_current_user_ids);
 return jsonb_build_object('current_user_ids',to_jsonb(current_ids),'history_ids',to_jsonb(hist),
  'events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'session_id',e.session_id,'speaker',e.speaker,'text',e.text,'timestamp',e.timestamp) order by e.timestamp,e.id),'[]'::jsonb) from public.transcript_events e where e.user_id=p_user_id and e.session_id=p_session_id and e.id=any(hist||current_ids)),
  'source_event_digests',loop_private.authored_event_digests(p_user_id,p_session_id,hist||current_ids));
end;$$;
revoke all on function public.authored_dialogue_history(uuid,uuid,bigint,bigint,bigint,uuid[],uuid[],bigint) from public,anon,authenticated;
grant execute on function public.authored_dialogue_history(uuid,uuid,bigint,bigint,bigint,uuid[],uuid[],bigint) to service_role;

-- Outbox tombstones distinguish a legitimately deleted owned source from a
-- transport failure. They never report another account's source existence.
create function public.authored_dialogue_receipt_source(p_user_id uuid,p_session_id uuid,p_turn_id uuid,p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype;t public.authored_dialogue_turns%rowtype;begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_session_id is null or p_turn_id is null then raise exception 'DIALOGUE_INVALID_REQUEST';end if;
 select * into s from public.sessions where id=p_session_id and user_id=p_user_id;
 if s.id is null then return jsonb_build_object('missing',true,'reason','session_missing');end if;
 if s.companion_id<>p_companion_id then raise exception 'DIALOGUE_SCOPE_DENIED' using errcode='42501';end if;
 select * into t from public.authored_dialogue_turns where id=p_turn_id and user_id=p_user_id;
 if t.id is null then return jsonb_build_object('missing',true,'reason','source_missing');end if;
 if t.session_id<>p_session_id or t.companion_id<>p_companion_id then raise exception 'DIALOGUE_SCOPE_DENIED' using errcode='42501';end if;
 return jsonb_build_object('missing',false);
end;$$;
revoke all on function public.authored_dialogue_receipt_source(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.authored_dialogue_receipt_source(uuid,uuid,uuid,text) to service_role;

-- Turn preflight is read-only: a stale request cannot switch a call back from
-- omitted to included memory merely by asking to generate another response.
create function public.authored_dialogue_state(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_expected_generation bigint,
 p_expected_memory_revision bigint,p_turn_nonce uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;covered uuid[];begin
 c:=loop_private.authored_lock_call(p_user_id,p_session_id);
 if c.call_epoch is distinct from p_call_epoch or c.authority_generation is distinct from p_authority_generation or c.turn_generation is distinct from p_expected_generation
 or c.memory_revision is distinct from p_expected_memory_revision or p_turn_nonce is null then raise exception 'DIALOGUE_STALE_AUTHORITY' using errcode='40001';end if;
 if exists(select 1 from public.authored_dialogue_cancellations where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce)
 then raise exception 'DIALOGUE_CANCELLED' using errcode='40001';end if;
 if c.checkpoint is not null then
  covered:=array(select jsonb_array_elements_text(c.checkpoint->'covered_ids'))::uuid[];
  perform loop_private.authored_history(p_user_id,c,covered);
  if c.checkpoint->'source_digest' is distinct from loop_private.authored_event_digests(p_user_id,p_session_id,covered) then raise exception 'DIALOGUE_CHECKPOINT_CHANGED' using errcode='40001';end if;
 end if;
 return to_jsonb(c);
end;$$;
revoke all on function public.authored_dialogue_state(uuid,uuid,bigint,bigint,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function public.authored_dialogue_state(uuid,uuid,bigint,bigint,bigint,bigint,uuid) to service_role;

-- A final short dispatch gate follows budget/provider-preparation awaits. It
-- establishes the authorization instant; no database lock is held over a
-- network request, so later revocation is additionally checked at publication.
create function public.authored_dialogue_dispatch(p_user_id uuid,p_session_id uuid,p_call_epoch bigint,p_authority_generation bigint,p_expected_generation bigint,
 p_expected_memory_revision bigint,p_turn_nonce uuid,p_turn_id uuid,p_stage text,p_job_id uuid,p_lease_token uuid,p_source_event_digests jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare c public.authored_dialogue_calls%rowtype;t public.authored_dialogue_turns%rowtype;ids uuid[];covered uuid[];begin
 c:=loop_private.authored_lock_call(p_user_id,p_session_id);
 if c.call_epoch is distinct from p_call_epoch or c.authority_generation is distinct from p_authority_generation or c.turn_generation is distinct from p_expected_generation
 or c.memory_revision is distinct from p_expected_memory_revision or p_turn_nonce is null or p_stage is null or p_stage not in ('dialogue','dialogue_synthesis','checkpoint')
 then raise exception 'DIALOGUE_STALE_AUTHORITY' using errcode='40001';end if;
 if exists(select 1 from public.authored_dialogue_cancellations where user_id=p_user_id and session_id=p_session_id and call_epoch=p_call_epoch and turn_nonce=p_turn_nonce)
 then raise exception 'DIALOGUE_CANCELLED' using errcode='40001';end if;
 if jsonb_typeof(p_source_event_digests) is distinct from 'object' then raise exception 'DIALOGUE_SOURCE_CHANGED';end if;
 ids:=array(select key::uuid from jsonb_object_keys(p_source_event_digests) key);
 if p_source_event_digests is distinct from loop_private.authored_event_digests(p_user_id,p_session_id,ids) then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
 if p_stage='checkpoint' then
  if p_turn_id is not null then raise exception 'DIALOGUE_SCOPE_DENIED';end if;
  perform loop_private.authored_history(p_user_id,c,ids);
  if c.checkpoint is not null then
   covered:=array(select jsonb_array_elements_text(c.checkpoint->'covered_ids'))::uuid[];
   if not covered<@ids or c.checkpoint->'source_digest' is distinct from loop_private.authored_event_digests(p_user_id,p_session_id,covered) then raise exception 'DIALOGUE_CHECKPOINT_CHANGED';end if;
  end if;
 else
  t:=loop_private.authored_turn_lock(p_user_id,p_turn_id,p_call_epoch,p_authority_generation,p_expected_generation);
  if t.session_id<>p_session_id or t.turn_nonce<>p_turn_nonce or t.source_manifest->'event_digests' is distinct from p_source_event_digests
   or (p_stage='dialogue' and t.status<>'reserved') or (p_stage='dialogue_synthesis' and (t.status<>'synthesizing' or t.synthesis_job_id<>p_job_id or t.synthesis_lease_token<>p_lease_token))
  then raise exception 'DIALOGUE_SOURCE_CHANGED' using errcode='40001';end if;
  if p_stage='dialogue_synthesis' and t.assistant_event_digest is distinct from (select loop_private.conversation_event_digest(e) from public.transcript_events e where e.id=t.assistant_event_id and e.user_id=p_user_id and e.session_id=p_session_id) then raise exception 'DIALOGUE_SOURCE_CHANGED';end if;
 end if;
 perform loop_private.authored_job(p_user_id,p_session_id,p_job_id,p_lease_token,p_stage);
 if not exists(select 1 from public.model_spend where job_id=p_job_id and lease_token=p_lease_token and outcome='pending') then raise exception 'DIALOGUE_SPEND_UNSETTLED';end if;
 return true;
end;$$;
revoke all on function public.authored_dialogue_dispatch(uuid,uuid,bigint,bigint,bigint,bigint,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.authored_dialogue_dispatch(uuid,uuid,bigint,bigint,bigint,bigint,uuid,uuid,text,uuid,uuid,jsonb) to service_role;
