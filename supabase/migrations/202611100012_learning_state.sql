-- Canonical learning state is additive to legacy per-analysis learning_items.
-- First-release learning is self-reported progress; sources and recommendation
-- validity are separate from the durable canonical item and its action revision.
alter table public.sessions add column record_incomplete boolean not null default false;
create function public.learning_finish_partial(p_session_id uuid) returns public.sessions
language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype;
begin
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 perform public.finish_session(p_session_id);
 update public.sessions set record_incomplete=true where id=p_session_id and user_id=auth.uid() returning * into s;
 return s;
end $$;

create function public.learning_key(p_text text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(lower(p_text), '[[:punct:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g'))
$$;
create function public.learning_transcript_digest(p_session_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select md5(coalesce(jsonb_agg(jsonb_build_array(id,speaker,text,timestamp) order by id)::text,'[]'))
  from public.transcript_events where session_id=p_session_id
$$;
create table public.learning_state_items (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  companion_id text not null check(companion_id in ('alex','mia','juno')),
  expression text not null check(length(btrim(expression)) between 1 and 3000), canonical_key text not null,
  revision integer not null default 1, status text not null default 'candidate' check(status in ('candidate','active','deferred','practiced','excluded')),
  enrolled boolean not null default false, practice_count integer not null default 0 check(practice_count>=0),
  practiced_at timestamptz, defer_count integer not null default 0, next_eligible_at timestamptz,
  priority_at timestamptz, review_requested boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restored_session_id uuid, unique(user_id,companion_id,canonical_key), unique(id,user_id),
  foreign key(restored_session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_feedback (
  analysis_id uuid primary key references public.analyses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, session_id uuid not null,
  transcript_digest text not null, complete_version boolean not null, exposed_at timestamptz,
  foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_sources (
  item_id uuid not null, user_id uuid not null, analysis_id uuid not null references public.analyses(id) on delete cascade,
  session_id uuid not null, original text not null default '', reason text not null default '',
  category text not null check(category in ('error','alternative')), evidence_ids uuid[] not null,
  next_scenario text not null default '', rank integer not null check(rank between 1 and 3),
  primary key(item_id,analysis_id), foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
  foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_source_holds (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null, item_id uuid, evidence_ids uuid[] not null default '{}',
  reason text not null check(reason in ('wrong_transcript','intent')), created_at timestamptz not null default now(),
  foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
  foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_actions (
  user_id uuid not null references auth.users(id) on delete cascade, action_id uuid not null,
  item_id uuid not null references public.learning_state_items(id) on delete cascade, action text not null,
  expected_revision integer not null, payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
  primary key(user_id,action_id)
);
create table public.learning_practice_days (
  item_id uuid not null references public.learning_state_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, day date not null, primary key(item_id,day)
);
create table public.learning_daily (
  user_id uuid not null references auth.users(id) on delete cascade, companion_id text not null check(companion_id in ('alex','mia','juno')),
  day date not null, recent_only boolean not null default false, allowance integer not null default 1 check(allowance between 1 and 3), item_ids uuid[] not null default '{}',
  primary key(user_id,companion_id,day)
);
create table public.learning_visits (
  user_id uuid not null references auth.users(id) on delete cascade, companion_id text not null,
  last_seen_at timestamptz not null default now(), primary key(user_id,companion_id)
);
create table public.learning_next_plans (
  user_id uuid not null references auth.users(id) on delete cascade, companion_id text not null,
  id uuid not null, item_id uuid not null references public.learning_state_items(id) on delete cascade,
  source_session_id uuid not null, source_analysis_id uuid not null references public.analyses(id) on delete cascade,
  scenario text not null, prepared_at timestamptz not null default now(), primary key(user_id,companion_id),
  foreign key(source_session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_events (
  user_id uuid not null references auth.users(id) on delete cascade, event_id uuid not null,
  name text not null check(name in ('feedback_ready','feedback_exposed','practice_started','practice_saved','practice_deferred','practice_excluded','next_call_prepared','call_connected','flow_failure')),
  companion_id text not null check(companion_id in ('alex','mia','juno')), session_id uuid, analysis_id uuid,
  item_id uuid, attempt_id uuid, action_id uuid, attribution text not null check(attribution in ('session','library')),
  occurred_at timestamptz not null, received_at timestamptz not null default now(), payload jsonb not null default '{}',
  paired boolean not null default false, diagnostic boolean not null default false,
  primary key(user_id,event_id), foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade,
  foreign key(analysis_id) references public.analyses(id) on delete cascade,
  foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade
);
create unique index learning_event_attempt on public.learning_events(user_id,name,attempt_id) where name in ('practice_started','practice_saved');
create unique index learning_event_feedback on public.learning_events(user_id,name,analysis_id) where name in ('feedback_ready','feedback_exposed');
create unique index learning_event_action on public.learning_events(user_id,name,action_id) where action_id is not null;
create unique index learning_event_connected on public.learning_events(user_id,name,session_id) where name='call_connected';
create index learning_sources_session on public.learning_sources(session_id,analysis_id);

-- A source must be latest for its session AND still describe the entire current
-- transcript. Late uploads/edits invalidate immediately without erasing progress.
create function public.learning_source_valid(p_item uuid,p_analysis uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.learning_sources s
 join public.learning_feedback f on f.analysis_id=s.analysis_id
 join public.analyses a on a.id=s.analysis_id
 join public.sessions call on call.id=s.session_id and call.user_id=s.user_id
 join auth.users owner on owner.id=s.user_id and owner.email_confirmed_at is not null
 join loop_private.approved_emails approval on approval.email=lower(btrim(owner.email))
 where call.status='ended'
 and not exists(select 1 from public.memory_state privacy where privacy.user_id=s.user_id and privacy.companion_id=call.companion_id and call.created_at<=privacy.history_cutoff)
 and not exists(select 1 from public.memory_session_exclusions privacy where privacy.user_id=s.user_id and privacy.companion_id=call.companion_id and privacy.session_id=call.id)
 and s.item_id=p_item and s.analysis_id=p_analysis and f.complete_version
 and f.transcript_digest=public.learning_transcript_digest(s.session_id)
 and not exists(select 1 from public.analyses n where n.session_id=s.session_id and n.kind='session' and (n.created_at,n.id)>(a.created_at,a.id))
 and not exists(select 1 from public.learning_source_holds h where h.user_id=s.user_id and h.session_id=s.session_id
   and ((h.reason='intent' and h.item_id=s.item_id) or (h.reason='wrong_transcript' and (cardinality(h.evidence_ids)=0 or h.evidence_ids && s.evidence_ids)))))
$$;

create function public.learning_ingest(p_analysis uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.analyses%rowtype; c text; e jsonb; ids uuid[]; k text; v_item uuid; n integer:=0; v_new boolean; complete boolean;
begin
 select * into a from public.analyses where id=p_analysis and kind='session';
 if not found then return; end if;
 select companion_id into c from public.sessions where id=a.session_id and user_id=a.user_id;
 select coalesce(array_agg(id order by id),'{}'::uuid[]) = (select coalesce(array_agg(x order by x),'{}'::uuid[]) from unnest(a.source_event_ids) x)
   and count(*) filter(where speaker='user')>0 into complete from public.transcript_events where session_id=a.session_id;
 insert into public.learning_feedback(analysis_id,user_id,session_id,transcript_digest,complete_version)
 values(a.id,a.user_id,a.session_id,public.learning_transcript_digest(a.session_id),complete) on conflict do nothing;
 if not found then return; end if;
 -- Invalid imported/old results remain historical only. Never trust imported evidence.
 if complete then
 for e in select value from jsonb_array_elements(
  case when jsonb_typeof(a.content->'corrections')='array' then a.content->'corrections' else '[]'::jsonb end ||
  case when jsonb_typeof(a.content->'practice')='array' then a.content->'practice' else '[]'::jsonb end) loop
  -- Practice suggestions may be expression-only; their user citations still
  -- must belong to the complete analysis source set.
  if not (e ? 'improved') and e ? 'expression' then e:=e||jsonb_build_object('improved',e->'expression'); end if;
  exit when n>=3;
  if jsonb_typeof(e->'improved') is distinct from 'string' or length(btrim(e->>'improved')) not between 1 and 3000
    or jsonb_typeof(e->'evidence_ids') is distinct from 'array' or jsonb_array_length(e->'evidence_ids') not between 1 and 12 then continue; end if;
  -- Validate UUID strings before casting; each citation must quote user speech.
  if exists(select 1 from jsonb_array_elements_text(e->'evidence_ids') x where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then continue; end if;
  select array_agg(x::uuid) into ids from jsonb_array_elements_text(e->'evidence_ids') x;
  if not ids <@ a.source_event_ids or exists(select 1 from unnest(ids) x left join public.transcript_events t on t.id=x where t.id is null or t.session_id<>a.session_id or t.user_id<>a.user_id or t.speaker<>'user')
    or (length(coalesce(e->>'original',''))>0 and not exists(select 1 from public.transcript_events t where t.id=any(ids) and strpos(t.text,e->>'original')>0)) then continue; end if;
  k:=public.learning_key(e->>'improved'); if length(k)=0 then continue; end if;
  if exists(select 1 from public.learning_sources s join public.learning_state_items i on i.id=s.item_id where s.analysis_id=a.id and i.canonical_key=k) then continue; end if;
  n:=n+1;
  insert into public.learning_state_items(user_id,companion_id,expression,canonical_key,status,enrolled)
    values(a.user_id,c,e->>'improved',k,case when n=1 then 'active' else 'candidate' end,n=1)
    on conflict(user_id,companion_id,canonical_key) do nothing returning id into v_item;
  v_new:=found;
  if not v_new then select id into v_item from public.learning_state_items where user_id=a.user_id and companion_id=c and canonical_key=k; end if;
  insert into public.learning_sources(item_id,user_id,analysis_id,session_id,original,reason,category,evidence_ids,next_scenario,rank)
   values(v_item,a.user_id,a.id,a.session_id,left(coalesce(e->>'original',''),3000),left(coalesce(e->>'reason',''),3000),case when e->>'category'='error' then 'error' else 'alternative' end,ids,left(coalesce(a.content->>'next_scenario',''),400),n)
   on conflict do nothing;
  -- New sources may enroll the canonical default, but never undo a user state.
  if n=1 and not v_new then update public.learning_state_items set enrolled=true,status=case when status='candidate' then 'active' else status end,revision=revision+1,updated_at=now() where id=v_item and not enrolled; end if;
 end loop;
 end if;
 if complete then
 insert into public.learning_events(user_id,event_id,name,companion_id,session_id,analysis_id,attribution,occurred_at)
 values(a.user_id,gen_random_uuid(),'feedback_ready',c,a.session_id,a.id,'session',a.created_at) on conflict do nothing;
 end if;
end $$;
create function public.learning_analysis_insert() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.learning_ingest(new.id); return new; end $$;
create trigger learning_analysis_insert after insert on public.analyses for each row execute function public.learning_analysis_insert();
-- Backfill only results whose source set still matches the current transcript.
do $$ declare a record; begin for a in select id from public.analyses where kind='session' order by created_at,id loop perform public.learning_ingest(a.id); end loop; end $$;

-- Each legacy row is imported once; later replays cannot overwrite canonical
-- user actions. Known timestamps seed distinct KST days; missing dates do not
-- invent practice counts. Legacy rows and their API remain intact.
create table loop_private.learning_legacy_imports (
 legacy_item_id uuid primary key references public.learning_items(id) on delete cascade,
 item_id uuid not null references public.learning_state_items(id) on delete cascade
);
revoke all on loop_private.learning_legacy_imports from public,anon,authenticated,service_role;
create function loop_private.learning_import_legacy() returns void
language plpgsql security definer set search_path='' as $$
declare old public.learning_items%rowtype; item uuid; key text;
begin
 for old in select * from public.learning_items order by updated_at,id loop
  if exists(select 1 from loop_private.learning_legacy_imports x where x.legacy_item_id=old.id) then continue; end if;
  key:=public.learning_key(old.expression); if length(key)=0 then continue; end if;
  insert into public.learning_state_items(user_id,companion_id,expression,canonical_key,status,enrolled,restored_session_id,updated_at)
  values(old.user_id,old.companion_id,old.expression,key,case old.state when 'practiced' then 'practiced' when 'later' then 'deferred' else 'active' end,true,old.session_id,old.updated_at)
  on conflict(user_id,companion_id,canonical_key) do nothing;
  select id into item from public.learning_state_items where user_id=old.user_id and companion_id=old.companion_id and canonical_key=key for update;
  insert into loop_private.learning_legacy_imports values(old.id,item) on conflict do nothing;
  if not found then continue; end if;
  if old.state='practiced' and old.practiced_at is not null then
   insert into public.learning_practice_days(item_id,user_id,day) values(item,old.user_id,(old.practiced_at at time zone 'Asia/Seoul')::date) on conflict do nothing;
  end if;
  update public.learning_state_items i set enrolled=true,restored_session_id=coalesce(i.restored_session_id,old.session_id),
   status=case when i.status='practiced' or old.state='practiced' then 'practiced' when i.status='deferred' or old.state='later' then 'deferred' else 'active' end,
   practice_count=(select count(*) from public.learning_practice_days d where d.item_id=item),
   practiced_at=greatest(i.practiced_at,case when old.state='practiced' then old.practiced_at end),
   defer_count=greatest(i.defer_count,case when old.state='later' then 1 else 0 end),
   updated_at=greatest(i.updated_at,old.updated_at)
  where i.id=item;
 end loop;
end $$;
revoke all on function loop_private.learning_import_legacy() from public,anon,authenticated,service_role;
select loop_private.learning_import_legacy();

create function public.learning_item_json(p_item uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',i.id,'companion_id',i.companion_id,'expression',i.expression,'original',coalesce(s.original,''),'reason',coalesce(s.reason,''),'category',coalesce(s.category,'alternative'),
 'revision',i.revision,'status',i.status,'enrolled',i.enrolled,'source_session_id',coalesce(s.session_id,i.restored_session_id),'source_analysis_id',s.analysis_id,
 'evidence_ids',coalesce(to_jsonb(s.evidence_ids),'[]'::jsonb),'next_scenario',coalesce(s.next_scenario,''),'practice_count',i.practice_count,'practiced_at',i.practiced_at,
 'sources',coalesce((select jsonb_agg(jsonb_build_object('session_id',x.session_id,'analysis_id',x.analysis_id,'valid',public.learning_source_valid(x.item_id,x.analysis_id))) from public.learning_sources x where x.item_id=i.id),'[]'::jsonb),
 'defer_count',i.defer_count,'next_eligible_at',i.next_eligible_at,'has_valid_source',coalesce(public.learning_source_valid(i.id,s.analysis_id),false),'updated_at',i.updated_at)
 from public.learning_state_items i left join lateral(select s.* from public.learning_sources s join public.analyses a on a.id=s.analysis_id where s.item_id=i.id
 order by public.learning_source_valid(s.item_id,s.analysis_id) desc,a.created_at desc,a.id desc limit 1) s on true where i.id=p_item
$$;

-- Durable server blockers share the same transcript version as feedback.
create function public.learning_feedback_block(p_session_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select case
 when exists(select 1 from public.analyses a join public.learning_feedback f on f.analysis_id=a.id
   where a.session_id=s.id and a.kind='session' and f.complete_version and f.transcript_digest=public.learning_transcript_digest(s.id)
   and not exists(select 1 from public.analyses n where n.session_id=s.id and n.kind='session' and (n.created_at,n.id)>(a.created_at,a.id))) then jsonb_build_object('blocked_reason',null,'blocked_until',null)
 when exists(select 1 from public.learning_events e where e.user_id=s.user_id and e.session_id=s.id and e.name='flow_failure' and e.payload->>'reason'='input_too_large' and e.payload->>'source_version'=public.learning_transcript_digest(s.id)) then jsonb_build_object('blocked_reason','input_too_large','blocked_until',null)
 when exists(select 1 from public.api_daily_usage u where u.user_id=s.user_id and u.kind='session' and u.day=(now() at time zone 'UTC')::date and u.reservations>=20) then jsonb_build_object('blocked_reason','quota','blocked_until',(((now() at time zone 'UTC')::date+1)::timestamp at time zone 'UTC'))
 else jsonb_build_object('blocked_reason',null,'blocked_until',null) end
 from public.sessions s where s.id=p_session_id
$$;

create function public.learning_snapshot(p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); d date:=(now() at time zone 'Asia/Seoul')::date; v_ids uuid[]; v_allow integer; v_recent boolean; v_more uuid[]; v_pending record; v_plan jsonb;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 perform loop_private.memory_guard(u,p_companion_id);
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_companion_id,0));
 for v_pending in select a.id from public.analyses a join public.sessions s on s.id=a.session_id where a.user_id=u and s.companion_id=p_companion_id and a.kind='session' and not exists(select 1 from public.learning_feedback f where f.analysis_id=a.id) order by a.created_at,a.id loop perform public.learning_ingest(v_pending.id); end loop;
 insert into public.learning_daily(user_id,companion_id,day,recent_only) values(u,p_companion_id,d,exists(select 1 from public.learning_visits where user_id=u and companion_id=p_companion_id and last_seen_at<now()-interval '14 days')) on conflict do nothing;
 select item_ids,allowance,recent_only into v_ids,v_allow,v_recent from public.learning_daily where user_id=u and companion_id=p_companion_id and day=d for update;
 select coalesce(array_agg(id),'{}'::uuid[]) into v_more from (
 select i.id from public.learning_state_items i where i.user_id=u and i.companion_id=p_companion_id and i.enrolled and i.status in ('active','deferred')
 and (i.next_eligible_at is null or i.next_eligible_at<=now()) and not(i.id=any(v_ids))
 and exists(select 1 from public.learning_sources s where s.item_id=i.id and public.learning_source_valid(i.id,s.analysis_id))
 order by (not v_recent and i.priority_at is not null) desc,case when not v_recent then i.priority_at end desc nulls last,(not v_recent and i.status='active' and not i.review_requested) desc,
 (not v_recent and i.review_requested) desc,(select max(a.created_at) from public.learning_sources s join public.analyses a on a.id=s.analysis_id where s.item_id=i.id and public.learning_source_valid(i.id,s.analysis_id)) desc,i.id
 limit greatest(0,v_allow-cardinality(v_ids))) chosen;
 v_ids:=v_ids||v_more;
 update public.learning_daily set item_ids=v_ids where user_id=u and companion_id=p_companion_id and day=d;
 insert into public.learning_visits(user_id,companion_id) values(u,p_companion_id) on conflict(user_id,companion_id) do update set last_seen_at=now();
 select to_jsonb(p)-'user_id' into v_plan from public.learning_next_plans p where p.user_id=u and p.companion_id=p_companion_id
 and exists(select 1 from public.learning_state_items i where i.id=p.item_id and i.status<>'excluded') and public.learning_source_valid(p.item_id,p.source_analysis_id);
 return jsonb_build_object('items',coalesce((select jsonb_agg(public.learning_item_json(id) order by created_at desc,id) from public.learning_state_items where user_id=u and companion_id=p_companion_id),'[]'::jsonb),
 'recommended_item_ids',coalesce((select jsonb_agg(i.id order by array_position(v_ids,i.id)) from public.learning_state_items i where i.id=any(v_ids) and i.status in ('active','deferred') and (i.next_eligible_at is null or i.next_eligible_at<=now()) and exists(select 1 from public.learning_sources s where s.item_id=i.id and public.learning_source_valid(i.id,s.analysis_id))),'[]'::jsonb),
 'feedback',coalesce((select jsonb_agg(jsonb_build_object('session_id',s.id,'analysis_id',a.id,'record_incomplete',s.record_incomplete,'source_version',public.learning_transcript_digest(s.id),'blocked_reason',public.learning_feedback_block(s.id)->'blocked_reason','blocked_until',public.learning_feedback_block(s.id)->'blocked_until','current',coalesce(f.complete_version and f.transcript_digest=public.learning_transcript_digest(s.id),false),
 'job_state',case when j.state='running' and j.lease_expires_at<=now() then 'expired' when j.state is not null then j.state when a.id is not null then 'completed' else 'not_requested' end,
 'job_expires_at',j.lease_expires_at,'exposed_at',f.exposed_at,'has_user_speech',exists(select 1 from public.transcript_events t where t.session_id=s.id and t.speaker='user')) order by s.created_at desc)
 from public.sessions s left join lateral(select a.* from public.analyses a where a.session_id=s.id and a.kind='session' order by created_at desc,id desc limit 1) a on true
 left join public.learning_feedback f on f.analysis_id=a.id left join lateral(select j.* from public.analysis_jobs j where j.session_id=s.id and j.kind='session' order by updated_at desc,id desc limit 1) j on true
 where s.user_id=u and s.companion_id=p_companion_id),'[]'::jsonb),'next_plan',v_plan);
end $$;
create function public.learning_recommend_more(p_companion_id text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform loop_private.memory_guard(auth.uid(),p_companion_id);
 insert into public.learning_daily(user_id,companion_id,day,allowance) values(auth.uid(),p_companion_id,(now() at time zone 'Asia/Seoul')::date,3)
 on conflict(user_id,companion_id,day) do update set allowance=3,recent_only=false;
 return public.learning_snapshot(p_companion_id);
end $$;

create function public.learning_record_event(p_event_id uuid,p_name text,p_companion_id text,p_session_id uuid default null,p_analysis_id uuid default null,p_item_id uuid default null,p_attempt_id uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); attr text; occurred timestamptz; existing public.learning_events%rowtype; v_source public.learning_sources%rowtype; event_payload jsonb:=p_payload;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if p_event_id is null or p_name is null or p_name not in ('feedback_exposed','practice_started','call_connected','flow_failure') or p_companion_id is null or p_companion_id not in ('alex','mia','juno') then raise exception 'Invalid client event'; end if;
 perform loop_private.memory_guard(u,p_companion_id);
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('attribution','action_id','occurred_at','status','stage','reason','foreground','visible_ratio','visible_ms','new_session_id')) then raise exception 'Event payload contains unsupported fields'; end if;
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

create function public.learning_action(p_item_id uuid,p_expected_revision integer,p_action_id uuid,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); i public.learning_state_items%rowtype; old public.learning_actions%rowtype; src public.learning_sources%rowtype; result jsonb; attempt uuid; attr text; sid uuid; aid uuid; v_name text; v_reason text; v_day date:=(now() at time zone 'Asia/Seoul')::date; v_count integer; v_plan jsonb; occurred timestamptz;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if p_action_id is null or p_expected_revision is null or p_action is null or p_action not in ('enroll','practice','defer','review_again','known','exclude','restore','hold_wrong_transcript','hold_intent','prepare_next') then raise exception 'Invalid action'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('attempt_id','attribution','source_session_id','source_analysis_id','occurred_at','scenario')) then raise exception 'Unsupported action payload'; end if;
 -- Serialize user action IDs even when two devices target different items.
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_action_id::text,0));
 select * into old from public.learning_actions where user_id=u and action_id=p_action_id;
 if found then
  if old.item_id<>p_item_id or old.action<>p_action or old.expected_revision<>p_expected_revision or old.payload<>p_payload then raise exception 'Action ID reused with different content'; end if;
  return old.result;
 end if;
 select * into i from public.learning_state_items where id=p_item_id and user_id=u for update;
 if not found then raise exception 'Item not found' using errcode='42501'; end if;
 perform loop_private.memory_guard(u,i.companion_id);
 if i.revision<>p_expected_revision then
  result:=jsonb_build_object('outcome','conflict','item',public.learning_item_json(i.id),'revision',i.revision);
 else
  if i.status='excluded' and p_action not in ('restore','exclude','known','hold_wrong_transcript','hold_intent') then raise exception 'Restore excluded item before this action'; end if;
  occurred:=coalesce((p_payload->>'occurred_at')::timestamptz,now());
  sid:=(p_payload->>'source_session_id')::uuid; aid:=(p_payload->>'source_analysis_id')::uuid;
  if sid is not null or aid is not null then
   select * into src from public.learning_sources where item_id=i.id and user_id=u and analysis_id=aid and session_id=sid;
   if not found then raise exception 'Source not found' using errcode='42501'; end if;
  else
   select s.* into src from public.learning_sources s join public.analyses a on a.id=s.analysis_id where s.item_id=i.id order by public.learning_source_valid(s.item_id,s.analysis_id) desc,a.created_at desc,a.id desc limit 1;
  end if;
  if p_action='practice' then
   attempt:=(p_payload->>'attempt_id')::uuid; attr:=coalesce(p_payload->>'attribution','library');
   if attempt is null or attr not in ('library','session') or (attr='session' and (sid is null or aid is null)) or (attr='library' and (sid is not null or aid is not null)) then raise exception 'Practice requires attempt and fixed attribution'; end if;
   if exists(select 1 from public.learning_events e where e.user_id=u and e.attempt_id=attempt and (e.name='practice_saved' or e.name='practice_started' and (e.item_id is distinct from i.id or e.session_id is distinct from sid or e.analysis_id is distinct from aid or e.attribution<>attr))) then raise exception 'Attempt already saved or attribution mismatch'; end if;
   insert into public.learning_practice_days(item_id,user_id,day) values(i.id,u,(case when occurred between now()-interval '90 days' and now()+interval '5 minutes' then occurred else now() end at time zone 'Asia/Seoul')::date) on conflict do nothing;
   get diagnostics v_count=row_count;
   update public.learning_state_items set status='practiced',enrolled=true,practice_count=practice_count+v_count,practiced_at=greatest(coalesce(practiced_at,occurred),occurred),review_requested=false,next_eligible_at=null where id=i.id;
   v_name:='practice_saved';
  elsif p_action='enroll' then
   update public.learning_state_items set enrolled=true,status=case when status='candidate' then 'active' else status end,priority_at=now() where id=i.id;
  elsif p_action='defer' then
   update public.learning_state_items set status='deferred',defer_count=defer_count+1,next_eligible_at=((v_day+case when defer_count=0 then 1 else 7 end)::timestamp at time zone 'Asia/Seoul'),priority_at=null where id=i.id;
   v_name:='practice_deferred';
  elsif p_action='review_again' then
   update public.learning_state_items set status='active',enrolled=true,review_requested=true,priority_at=null,next_eligible_at=((v_day+1)::timestamp at time zone 'Asia/Seoul') where id=i.id;
  elsif p_action in ('known','exclude') then
   update public.learning_state_items set status='excluded',priority_at=null where id=i.id; v_name:='practice_excluded'; v_reason:=p_action;
  elsif p_action='restore' then
   update public.learning_state_items set status=case when enrolled then 'active' else 'candidate' end,next_eligible_at=null,priority_at=null where id=i.id;
  elsif p_action in ('hold_wrong_transcript','hold_intent') then
   if src.analysis_id is null then raise exception 'Source required for hold'; end if;
   insert into public.learning_source_holds(user_id,session_id,item_id,evidence_ids,reason) values(u,src.session_id,case when p_action='hold_intent' then i.id end,src.evidence_ids,case when p_action='hold_intent' then 'intent' else 'wrong_transcript' end);
   v_name:='practice_excluded'; v_reason:=case when p_action='hold_intent' then 'intent' else 'wrong_transcript' end;
  elsif p_action='prepare_next' then
   if i.status='excluded' or src.analysis_id is null or not public.learning_source_valid(i.id,src.analysis_id) then raise exception 'Valid source required for next plan'; end if;
   if p_payload ? 'scenario' and (jsonb_typeof(p_payload->'scenario')<>'string' or length(btrim(p_payload->>'scenario')) not between 1 and 500) then raise exception 'Invalid scenario'; end if;
   insert into public.learning_next_plans(user_id,companion_id,id,item_id,source_session_id,source_analysis_id,scenario)
   values(u,i.companion_id,p_action_id,i.id,src.session_id,src.analysis_id,coalesce(p_payload->>'scenario',nullif(src.next_scenario,''),'Everyday conversation'))
   on conflict(user_id,companion_id) do update set id=excluded.id,item_id=excluded.item_id,source_session_id=excluded.source_session_id,source_analysis_id=excluded.source_analysis_id,scenario=excluded.scenario,prepared_at=now();
   select to_jsonb(p)-'user_id' into v_plan from public.learning_next_plans p where p.user_id=u and p.companion_id=i.companion_id;
   v_name:='next_call_prepared';
  end if;
  update public.learning_state_items set revision=revision+1,updated_at=now() where id=i.id returning * into i;
  if v_name is not null then
   -- User content never enters analytics. Server confirmation produces events.
   if p_action<>'practice' then
    attr:=coalesce(p_payload->>'attribution',case when sid is not null or p_action in ('hold_wrong_transcript','hold_intent','prepare_next') then 'session' else 'library' end);
    if attr not in ('session','library') then raise exception 'Invalid attribution'; end if;
    if attr='session' then sid:=src.session_id; aid:=src.analysis_id; else sid:=null; aid:=null; end if;
   end if;
   insert into public.learning_events(user_id,event_id,name,companion_id,session_id,analysis_id,item_id,attempt_id,action_id,attribution,occurred_at,payload,paired,diagnostic)
   values(u,p_action_id,v_name,i.companion_id,sid,aid,i.id,attempt,p_action_id,attr,occurred,jsonb_strip_nulls(jsonb_build_object('status','success','reason',v_reason,'source_valid',case when aid is not null then public.learning_source_valid(i.id,aid) end)),
    p_action='practice' and exists(select 1 from public.learning_events e where e.user_id=u and e.name='practice_started' and e.attempt_id=attempt),occurred>now()+interval '5 minutes' or occurred<now()-interval '90 days');
   if p_action='practice' then update public.learning_events set paired=true where user_id=u and name='practice_started' and attempt_id=attempt; end if;
  end if;
  result:=jsonb_build_object('outcome','applied','item',public.learning_item_json(i.id),'revision',i.revision);
  if v_plan is not null then result:=result||jsonb_build_object('next_plan',v_plan); end if;
 end if;
 insert into public.learning_actions(user_id,action_id,item_id,action,expected_revision,payload,result) values(u,p_action_id,p_item_id,p_action,p_expected_revision,p_payload,result);
 return result;
end $$;

-- Restore self-reports only. IDs/evidence/category from backup never create a
-- trusted source; a regenerated analysis must independently match the words.
create function public.learning_restore(p_items jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); e jsonb; sid uuid; c text; k text; v_status text; n integer:=0; skipped integer:=0; v_id uuid; stamp timestamptz; h jsonb; hs uuid; hr text; held_count integer:=0;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>500 then raise exception 'Restore expects at most 500 items'; end if;
 for e in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(e)<>'object' or jsonb_typeof(e->'expression') is distinct from 'string' or length(btrim(e->>'expression')) not between 1 and 3000 then raise exception 'Invalid restored expression'; end if;
  if e ? 'user_id' and (e->>'user_id')::uuid is distinct from u then raise exception 'Backup belongs to another user' using errcode='42501'; end if;
  sid:=coalesce((e->>'source_session_id')::uuid,(e->>'restored_session_id')::uuid);
  select companion_id into c from public.sessions where id=sid and user_id=u;
  if not found or e ? 'companion_id' and e->>'companion_id' is distinct from c then raise exception 'Owned matching source session required' using errcode='42501'; end if;
  perform loop_private.memory_guard(u,c);
  k:=public.learning_key(e->>'expression'); if length(k)=0 then raise exception 'Invalid restored expression'; end if;
  v_status:=coalesce(e->>'status','practiced');
  if v_status not in ('candidate','active','deferred','practiced','excluded') or coalesce((e->>'practice_count')::integer,0) not between 0 and 100000 or coalesce((e->>'defer_count')::integer,0) not between 0 and 100000 then raise exception 'Invalid restored state'; end if;
  stamp:=coalesce((e->>'updated_at')::timestamptz,(e->>'practiced_at')::timestamptz,now());
  if stamp>now()+interval '5 minutes' then raise exception 'Future restored state'; end if;
  insert into public.learning_state_items(user_id,companion_id,expression,canonical_key,status,enrolled,practice_count,practiced_at,defer_count,next_eligible_at,restored_session_id,updated_at)
  values(u,c,e->>'expression',k,v_status,coalesce((e->>'enrolled')::boolean,v_status<>'candidate'),coalesce((e->>'practice_count')::integer,0),(e->>'practiced_at')::timestamptz,coalesce((e->>'defer_count')::integer,0),(e->>'next_eligible_at')::timestamptz,sid,stamp)
  on conflict(user_id,companion_id,canonical_key) do nothing returning id into v_id;
  if found then
   n:=n+1;
   if coalesce((e->>'practice_count')::integer,0)>0 and e->>'practiced_at' is not null then
    if (e->>'practiced_at')::timestamptz>now()+interval '5 minutes' then raise exception 'Future restored practice'; end if;
    insert into public.learning_practice_days(item_id,user_id,day) values(v_id,u,((e->>'practiced_at')::timestamptz at time zone 'Asia/Seoul')::date) on conflict do nothing;
   end if;
   if e ? 'held_sources' and jsonb_typeof(e->'held_sources')<>'array' then raise exception 'Invalid restored holds'; end if;
   for h in select value from jsonb_array_elements(coalesce(e->'held_sources','[]'::jsonb)) loop
    hs:=(h->>'session_id')::uuid; hr:=h->>'reason';
    if hs is null or hr is null or hr not in ('wrong_transcript','intent') or not exists(select 1 from public.sessions where id=hs and user_id=u and companion_id=c) then raise exception 'Invalid restored hold source' using errcode='42501'; end if;
    if not exists(select 1 from public.learning_source_holds where user_id=u and session_id=hs and reason=hr and item_id is not distinct from case when hr='intent' then v_id end and cardinality(evidence_ids)=0) then
     insert into public.learning_source_holds(user_id,session_id,item_id,reason) values(u,hs,case when hr='intent' then v_id end,hr); held_count:=held_count+1;
    end if;
   end loop;
  else skipped:=skipped+1; end if;
 end loop;
 return jsonb_build_object('inserted',n,'skipped_existing',skipped,'holds_restored',held_count);
end $$;
create function public.learning_voice_context(p_user_id uuid,p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_focus jsonb; suppress boolean;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 select coalesce(jsonb_agg(jsonb_build_object('expression',q.expression,'evidence_ids',q.evidence_ids,'source_session_id',q.session_id)),'[]'::jsonb) into v_focus from (
 select i.expression,s.evidence_ids,s.session_id from public.learning_state_items i
 join public.learning_sources s on s.item_id=i.id
 left join public.learning_next_plans p on p.user_id=i.user_id and p.companion_id=i.companion_id and p.item_id=i.id and p.source_analysis_id=s.analysis_id
 where i.user_id=p_user_id and i.companion_id=p_companion_id and i.status<>'excluded'
 and length(i.expression)<=500 and octet_length(i.expression)<=2000 and (p.id is not null or i.status='practiced') and public.learning_source_valid(i.id,s.analysis_id)
 order by (p.id is not null) desc,p.prepared_at desc nulls last,i.practiced_at desc nulls last,s.analysis_id limit 1) q;
 -- Historical summaries may paraphrase excluded content, so omit all memory if
 -- a reliable content-level filter cannot establish safety.
 select exists(select 1 from public.memory_state m where m.user_id=p_user_id and m.companion_id=p_companion_id and m.history_cutoff is not null)
 or exists(select 1 from public.memory_session_exclusions x where x.user_id=p_user_id and x.companion_id=p_companion_id)
 or exists(select 1 from public.learning_state_items i where i.user_id=p_user_id and i.companion_id=p_companion_id
 and (i.status='excluded' or not exists(select 1 from public.learning_sources s where s.item_id=i.id and public.learning_source_valid(i.id,s.analysis_id))))
 or exists(select 1 from public.learning_source_holds h join public.sessions s on s.id=h.session_id where h.user_id=p_user_id and s.companion_id=p_companion_id)
 or exists(select 1 from public.analyses a join public.sessions s on s.id=a.session_id
  where a.user_id=p_user_id and s.companion_id=p_companion_id and a.kind='session'
  and not exists(select 1 from public.analyses n where n.session_id=a.session_id and n.kind='session' and (n.created_at,n.id)>(a.created_at,a.id))
  and not exists(select 1 from public.learning_feedback f where f.analysis_id=a.id and f.complete_version and f.transcript_digest=public.learning_transcript_digest(s.id)))
 into suppress;
 return jsonb_build_object('focus',v_focus,'suppress_memory',suppress);
end $$;

-- Every table is account-scoped; all writes go through validated RPCs.
do $$ declare t text; f record; begin
 foreach t in array array['learning_state_items','learning_feedback','learning_sources','learning_source_holds','learning_actions','learning_practice_days','learning_daily','learning_visits','learning_next_plans','learning_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy %I on public.%I for select to authenticated using(user_id=(select auth.uid()) and public.is_approved_user())',t||'_read_own',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname=any(array['learning_finish_partial','learning_key','learning_transcript_digest','learning_source_valid','learning_ingest','learning_analysis_insert','learning_item_json','learning_feedback_block','learning_snapshot','learning_recommend_more','learning_record_event','learning_action','learning_restore','learning_voice_context']) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.learning_snapshot(text),public.learning_recommend_more(text),public.learning_action(uuid,integer,uuid,text,jsonb),public.learning_record_event(uuid,text,text,uuid,uuid,uuid,uuid,jsonb),public.learning_restore(jsonb),public.learning_finish_partial(uuid) to authenticated;
grant execute on function public.learning_voice_context(uuid,text) to service_role;
