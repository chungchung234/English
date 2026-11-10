-- Learning enhancements are explicit opt-ins and observations. Imported data
-- cannot create evidence, an accepted correction, or a mastery claim.
create table public.learning_reviews (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null,source_session_id uuid not null,source_analysis_id uuid not null references public.analyses(id) on delete cascade,
 source_version text not null,explanation text not null check(length(btrim(explanation)) between 1 and 2000),
 status text not null default 'pending' check(status in ('pending','proposed','accepted','dismissed')),
 proposal jsonb,accepted_item_id uuid,revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
 foreign key(accepted_item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
 foreign key(source_session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_schedules (
 item_id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,
 enabled boolean not null default false,days integer not null default 1 check(days in(1,3,7)),goal text not null default '' check(length(goal)<=240),
 due_at timestamptz,revision integer not null default 1,last_rating text check(last_rating in('hard','assisted','independent')),
 updated_at timestamptz not null default now(),foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade
);
create table public.learning_recalls (
 id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,item_id uuid not null,
 rating text not null check(rating in('hard','assisted','independent')),scheduled_for timestamptz not null,occurred_at timestamptz not null default now(),
 kind text not null default 'delayed' check(kind='delayed'),source_session_id uuid,source_analysis_id uuid references public.analyses(id) on delete set null,source_version text,foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade
);
create table public.learning_usage_targets (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null,session_id uuid not null,plan_id uuid not null,source_session_id uuid not null,
 source_analysis_id uuid not null references public.analyses(id) on delete cascade,source_version text not null,
 expression text not null,prepared_at timestamptz not null default now(),connected_at timestamptz,
 unique(user_id,session_id),foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade,
 foreign key(source_session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_usage_observations (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 target_id uuid not null unique references public.learning_usage_targets(id) on delete cascade,item_id uuid not null,session_id uuid not null,
 source_version text not null,kind text not null check(kind in('observed','undetermined')),
 mode text not null default 'undetermined' check(mode in('undetermined','repetition','after_hint','new_context')),
 evidence_ids uuid[] not null default '{}',mode_evidence_ids uuid[] not null default '{}',
 review_status text not null default 'unreviewed' check(review_status in('unreviewed','confirmed','rejected')),
 revision integer not null default 1,created_at timestamptz not null default now(),
 foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create table public.learning_weekly_goals (
 id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,companion_id text not null,
 analysis_id uuid not null references public.analyses(id) on delete cascade,item_id uuid not null,kind text not null check(kind in('keep','try')),
 goal text not null check(length(btrim(goal)) between 1 and 500),period_start timestamptz not null,period_end timestamptz not null,
 source_version text not null,selected_at timestamptz not null default now(),revision integer not null default 1,
 prepared_at timestamptz,call_session_id uuid,recall_id uuid references public.learning_recalls(id) on delete set null,
 unique(user_id,companion_id),check(period_end-period_start=interval '168 hours'),
 foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
 foreign key(call_session_id,user_id) references public.sessions(id,user_id) on delete set null(call_session_id)
);
create table public.learning_enhancement_actions (
 user_id uuid not null references auth.users(id) on delete cascade,action_id uuid not null,
 operation text not null,payload jsonb not null,result jsonb not null,created_at timestamptz not null default now(),primary key(user_id,action_id)
);

create table public.learning_enhancement_imports (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null,source_session_id uuid not null,kind text not null check(kind in('reviews','schedules','recalls','usage','weekly_goals')),
 payload jsonb not null,import_key text not null,created_at timestamptz not null default now(),unique(user_id,import_key),
 foreign key(item_id,user_id) references public.learning_state_items(id,user_id) on delete cascade,
 foreign key(source_session_id,user_id) references public.sessions(id,user_id) on delete cascade
);

-- Shared privacy gate is also used for held sources under reconsideration.
create function loop_private.learning_session_visible(p_user uuid,p_session uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sessions s join auth.users u on u.id=s.user_id and u.email_confirmed_at is not null
 join loop_private.approved_emails a on a.email=lower(btrim(u.email)) where s.id=p_session and s.user_id=p_user
 and not exists(select 1 from public.memory_state m where m.user_id=p_user and m.companion_id=s.companion_id and s.created_at<=m.history_cutoff)
 and not exists(select 1 from public.memory_session_exclusions x where x.user_id=p_user and x.companion_id=s.companion_id and x.session_id=s.id))
$$;
create function loop_private.learning_observation_session_visible(p_user uuid,p_session uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select loop_private.learning_session_visible(p_user,p_session)
 and not exists(select 1 from public.learning_source_holds h where h.user_id=p_user and h.session_id=p_session)
 and not exists(select 1 from public.learning_sources s join public.learning_state_items i on i.id=s.item_id where s.user_id=p_user and s.session_id=p_session and i.status='excluded')
$$;
create function loop_private.learning_current(p_user uuid,p_session uuid,p_analysis uuid,p_version text) returns boolean
language sql stable security definer set search_path='' as $$
 select loop_private.learning_session_visible(p_user,p_session) and exists(select 1 from public.analyses a
 join public.learning_feedback f on f.analysis_id=a.id join public.sessions s on s.id=a.session_id
 where a.id=p_analysis and a.user_id=p_user and a.session_id=p_session and a.kind='session' and s.status='ended'
 and f.complete_version and f.transcript_digest=p_version and p_version=public.learning_transcript_digest(p_session)
 and not exists(select 1 from public.analyses n where n.session_id=p_session and n.kind='session' and (n.created_at,n.id)>(a.created_at,a.id)))
$$;
alter function public.learning_source_valid(uuid,uuid) rename to learning_source_valid_v12;
create function public.learning_source_valid(p_item uuid,p_analysis uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select public.learning_source_valid_v12(p_item,p_analysis) or exists(select 1 from public.learning_reviews r
 join public.learning_sources s on s.item_id=r.accepted_item_id and s.analysis_id=r.source_analysis_id
 where r.status='accepted' and r.accepted_item_id=p_item and r.source_analysis_id=p_analysis
 and s.evidence_ids <@ array(select x::uuid from jsonb_array_elements_text(r.proposal->'evidence_ids') x)
 and s.evidence_ids @> array(select x::uuid from jsonb_array_elements_text(r.proposal->'evidence_ids') x)
 and s.original=(select original from public.learning_sources original_source where original_source.item_id=r.item_id and original_source.analysis_id=r.source_analysis_id)
 and loop_private.learning_current(r.user_id,r.source_session_id,r.source_analysis_id,r.source_version)
 -- A later hold is a new dispute and cannot be bypassed by an old acceptance.
 and not exists(select 1 from public.learning_source_holds h where h.user_id=r.user_id and h.session_id=r.source_session_id
 and h.created_at>r.updated_at and ((h.reason='intent' and h.item_id=p_item) or (h.reason='wrong_transcript' and (cardinality(h.evidence_ids)=0 or h.evidence_ids&&s.evidence_ids)))))
$$;
create function loop_private.learning_action_start(p_operation text,p_action uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old public.learning_enhancement_actions%rowtype;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501'; end if;
 if p_action is null then raise exception 'Action ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_action::text,0));
 select * into old from public.learning_enhancement_actions where user_id=auth.uid() and action_id=p_action;
 if found then
 if old.operation<>p_operation or old.payload<>p_payload then raise exception 'Action ID reused with different content'; end if;
 return old.result;
 end if;
 return null;
end $$;
create function loop_private.learning_action_finish(p_operation text,p_action uuid,p_payload jsonb,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin insert into public.learning_enhancement_actions(user_id,action_id,operation,payload,result) values(auth.uid(),p_action,p_operation,p_payload,p_result);return p_result;end $$;

create function public.learning_review_submit(p_item_id uuid,p_expected_revision integer,p_action_id uuid,p_source_analysis_id uuid,p_explanation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.learning_state_items%rowtype;s public.learning_sources%rowtype;r public.learning_reviews%rowtype;args jsonb:=jsonb_build_array(p_item_id,p_expected_revision,p_source_analysis_id,p_explanation);outcome jsonb;
begin
 outcome:=loop_private.learning_action_start('review_submit',p_action_id,args);if outcome is not null then return outcome;end if;if p_expected_revision is null or p_expected_revision<0 then raise exception 'Expected revision required';end if;
 select * into i from public.learning_state_items where id=p_item_id and user_id=auth.uid() for update;
 if not found then raise exception 'Item not found' using errcode='42501';end if;
 perform loop_private.memory_guard(auth.uid(),i.companion_id);
 if i.revision<>p_expected_revision then outcome:=jsonb_build_object('outcome','conflict','item',public.learning_item_json(i.id));
 else
 select * into s from public.learning_sources where item_id=i.id and analysis_id=p_source_analysis_id;
 if not found or not loop_private.learning_current(auth.uid(),s.session_id,s.analysis_id,public.learning_transcript_digest(s.session_id)) then raise exception 'Current source required';end if;
 if not exists(select 1 from public.learning_source_holds h where h.user_id=auth.uid() and h.session_id=s.session_id and (h.item_id=i.id or h.reason='wrong_transcript' and (cardinality(h.evidence_ids)=0 or h.evidence_ids&&s.evidence_ids))) then raise exception 'Held source required';end if;
 if p_explanation is null or length(btrim(p_explanation)) not between 1 and 2000 then raise exception 'Explanation must be 1 to 2000 characters';end if;
 insert into public.learning_reviews(user_id,item_id,source_session_id,source_analysis_id,source_version,explanation) values(auth.uid(),i.id,s.session_id,s.analysis_id,public.learning_transcript_digest(s.session_id),btrim(p_explanation)) returning * into r;
 update public.learning_state_items set revision=revision+1,updated_at=now() where id=i.id;
 outcome:=jsonb_build_object('outcome','applied','review',to_jsonb(r)-'user_id','item',public.learning_item_json(i.id));
 end if;
 return loop_private.learning_action_finish('review_submit',p_action_id,args,outcome);
end $$;
create function public.learning_review_context(p_user_id uuid,p_review_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.learning_reviews%rowtype;s public.learning_sources%rowtype;i public.learning_state_items%rowtype;
begin
 select * into r from public.learning_reviews where id=p_review_id and user_id=p_user_id;
 if not found then raise exception 'Review not found' using errcode='42501';end if;
 select * into i from public.learning_state_items where id=r.item_id;perform loop_private.memory_guard(p_user_id,i.companion_id);
 if r.status not in('pending','proposed') or i.status='excluded' or not loop_private.learning_current(p_user_id,r.source_session_id,r.source_analysis_id,r.source_version) then raise exception 'Review source is unavailable';end if;
 select * into s from public.learning_sources where item_id=r.item_id and analysis_id=r.source_analysis_id;
 return jsonb_build_object('review',to_jsonb(r)-'user_id','expression',i.expression,'original',s.original,'companion_id',i.companion_id,
 'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'session_id',t.session_id,'speaker',t.speaker,'text',t.text,'timestamp',t.timestamp) order by t.timestamp,t.id) from public.transcript_events t where t.id=any(s.evidence_ids) and t.speaker='user'),'[]'::jsonb));
end $$;
create function public.learning_review_complete(p_user_id uuid,p_review_id uuid,p_expected_revision integer,p_source_version text,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.learning_reviews%rowtype;i public.learning_state_items%rowtype;s public.learning_sources%rowtype;ids uuid[];
begin
 select * into r from public.learning_reviews where id=p_review_id and user_id=p_user_id for update;
 if not found then raise exception 'Review not found' using errcode='42501';end if;
 select * into i from public.learning_state_items where id=r.item_id;perform loop_private.memory_guard(p_user_id,i.companion_id);
 if p_expected_revision is null then raise exception 'Expected revision required';end if;
 if r.revision<>p_expected_revision or r.status<>'pending' then return jsonb_build_object('outcome','conflict','review',to_jsonb(r)-'user_id');end if;
 if i.status='excluded' or r.source_version is distinct from p_source_version or not loop_private.learning_current(p_user_id,r.source_session_id,r.source_analysis_id,r.source_version) then raise exception 'Review source is unavailable';end if;
 if p_proposal is null or jsonb_typeof(p_proposal)<>'object' or exists(select 1 from jsonb_object_keys(p_proposal) k where k not in('expression','reason','category','evidence_ids'))
 or jsonb_typeof(p_proposal->'expression') is distinct from 'string' or length(btrim(p_proposal->>'expression')) not between 1 and 500
 or jsonb_typeof(p_proposal->'reason') is distinct from 'string' or length(p_proposal->>'reason')>1500 or p_proposal->>'category' is null or p_proposal->>'category' not in('error','alternative')
 or jsonb_typeof(p_proposal->'evidence_ids') is distinct from 'array' or jsonb_array_length(p_proposal->'evidence_ids') not between 1 and 12 then raise exception 'Invalid bounded proposal';end if;
 select * into s from public.learning_sources where item_id=r.item_id and analysis_id=r.source_analysis_id;
 select array_agg(x::uuid) into ids from jsonb_array_elements_text(p_proposal->'evidence_ids') x;
 if not ids<@s.evidence_ids or exists(select 1 from unnest(ids) x where not exists(select 1 from public.transcript_events t where t.id=x and t.session_id=r.source_session_id and t.user_id=p_user_id and t.speaker='user')) then raise exception 'Proposal evidence must cite original user speech';end if;
 update public.learning_reviews set proposal=p_proposal,status='proposed',revision=revision+1,updated_at=now() where id=r.id returning * into r;
 return jsonb_build_object('outcome','applied','review',to_jsonb(r)-'user_id');
end $$;
create function public.learning_review_decide(p_review_id uuid,p_expected_revision integer,p_action_id uuid,p_decision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.learning_reviews%rowtype;i public.learning_state_items%rowtype;s public.learning_sources%rowtype;accepted uuid;ids uuid[];args jsonb:=jsonb_build_array(p_review_id,p_expected_revision,p_decision);outcome jsonb;
begin
 outcome:=loop_private.learning_action_start('review_decide',p_action_id,args);if outcome is not null then return outcome;end if;if p_expected_revision is null or p_expected_revision<0 then raise exception 'Expected revision required';end if;
 select * into r from public.learning_reviews where id=p_review_id and user_id=auth.uid() for update;
 if not found then raise exception 'Review not found' using errcode='42501';end if;
 select * into i from public.learning_state_items where id=r.item_id for update;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 if p_decision is null or p_decision not in('accept','dismiss') then raise exception 'Invalid decision';end if;
 if r.revision<>p_expected_revision then outcome:=jsonb_build_object('outcome','conflict','review',to_jsonb(r)-'user_id');
 else
 if r.status<>'proposed' then raise exception 'Proposed review required';end if;
 if p_decision='accept' then
 if i.status='excluded' or not loop_private.learning_current(auth.uid(),r.source_session_id,r.source_analysis_id,r.source_version) then raise exception 'Current source required';end if;
 select * into s from public.learning_sources where item_id=r.item_id and analysis_id=r.source_analysis_id;
 insert into public.learning_state_items(user_id,companion_id,expression,canonical_key,status,enrolled) values(auth.uid(),i.companion_id,r.proposal->>'expression',public.learning_key(r.proposal->>'expression'),'active',true)
 on conflict(user_id,companion_id,canonical_key) do nothing returning id into accepted;
 if accepted is null then select id into accepted from public.learning_state_items where user_id=auth.uid() and companion_id=i.companion_id and canonical_key=public.learning_key(r.proposal->>'expression') for update;end if;
 if exists(select 1 from public.learning_state_items where id=accepted and status='excluded') then raise exception 'Restore excluded proposal item first';end if;
 select array_agg(x::uuid) into ids from jsonb_array_elements_text(r.proposal->'evidence_ids') x;
 if exists(select 1 from public.learning_sources existing where existing.item_id=accepted and existing.analysis_id=s.analysis_id
 and (existing.original<>s.original or not existing.evidence_ids<@ids or not existing.evidence_ids@>ids)) then
 raise exception 'Proposal conflicts with existing source provenance';
 end if;
 insert into public.learning_sources(item_id,user_id,analysis_id,session_id,original,reason,category,evidence_ids,next_scenario,rank) values(accepted,auth.uid(),s.analysis_id,s.session_id,s.original,r.proposal->>'reason',r.proposal->>'category',ids,s.next_scenario,s.rank) on conflict do nothing;
 update public.learning_state_items set enrolled=true,status='active',revision=revision+1,priority_at=now(),updated_at=now() where id=accepted;
 end if;
 update public.learning_reviews set status=case when p_decision='accept' then 'accepted' else 'dismissed' end,accepted_item_id=accepted,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 outcome:=jsonb_build_object('outcome','applied','review',to_jsonb(r)-'user_id','item',case when accepted is not null then public.learning_item_json(accepted) end);
 end if;
 return loop_private.learning_action_finish('review_decide',p_action_id,args,outcome);
end $$;

create function public.learning_schedule_config(p_item_id uuid,p_expected_revision integer,p_action_id uuid,p_days integer default null,p_goal text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.learning_state_items%rowtype;s public.learning_schedules%rowtype;args jsonb:=jsonb_build_array(p_item_id,p_expected_revision,p_days,p_goal);result jsonb;
begin
 result:=loop_private.learning_action_start('schedule_config',p_action_id,args);if result is not null then return result;end if;if p_expected_revision is null or p_expected_revision<0 then raise exception 'Expected revision required';end if;
 select * into i from public.learning_state_items where id=p_item_id and user_id=auth.uid() for update;
 if not found then raise exception 'Item not found' using errcode='42501';end if;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 select * into s from public.learning_schedules where item_id=i.id for update;
 if coalesce(s.revision,0)<>p_expected_revision then result:=jsonb_build_object('outcome','conflict','schedule',to_jsonb(s)-'user_id');
 else
 if p_days is not null and p_days not in(1,3,7) or p_goal is null or length(p_goal)>240 then raise exception 'Invalid schedule';end if;
 if p_days is not null and (i.status='excluded' or not exists(select 1 from public.learning_sources src where src.item_id=i.id and public.learning_source_valid(src.item_id,src.analysis_id))) then raise exception 'Valid source required';end if;
 insert into public.learning_schedules(item_id,user_id,enabled,days,goal,due_at) values(i.id,auth.uid(),p_days is not null,coalesce(p_days,1),p_goal,case when p_days is not null then (((now() at time zone 'Asia/Seoul')::date+p_days)::timestamp at time zone 'Asia/Seoul') end)
 on conflict(item_id) do update set enabled=excluded.enabled,days=excluded.days,goal=excluded.goal,due_at=excluded.due_at,revision=public.learning_schedules.revision+1,updated_at=now() returning * into s;
 result:=jsonb_build_object('outcome','applied','schedule',to_jsonb(s)-'user_id');
 end if;
 return loop_private.learning_action_finish('schedule_config',p_action_id,args,result);
end $$;
create function public.learning_recall(p_item_id uuid,p_expected_revision integer,p_action_id uuid,p_rating text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.learning_state_items%rowtype;s public.learning_schedules%rowtype;r public.learning_recalls%rowtype;args jsonb:=jsonb_build_array(p_item_id,p_expected_revision,p_rating);result jsonb;v_days integer;v_src public.learning_sources%rowtype;
begin
 result:=loop_private.learning_action_start('recall',p_action_id,args);if result is not null then return result;end if;if p_expected_revision is null or p_expected_revision<0 then raise exception 'Expected revision required';end if;
 select * into i from public.learning_state_items where id=p_item_id and user_id=auth.uid() for update;
 if not found then raise exception 'Item not found' using errcode='42501';end if;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 select * into s from public.learning_schedules where item_id=i.id for update;
 if not found then raise exception 'Recall schedule required';end if;
 if s.revision<>p_expected_revision then result:=jsonb_build_object('outcome','conflict','schedule',to_jsonb(s)-'user_id');
 else
 if p_rating is null or p_rating not in('hard','assisted','independent') then raise exception 'Invalid recall rating';end if;
 if not s.enabled or s.due_at is null or s.due_at>now() then raise exception 'Delayed recall is not due';end if;
 if i.status='excluded' or not exists(select 1 from public.learning_sources src where src.item_id=i.id and public.learning_source_valid(src.item_id,src.analysis_id)) then raise exception 'Valid source required';end if;
 select src.* into v_src from public.learning_sources src join public.analyses a on a.id=src.analysis_id where src.item_id=i.id and public.learning_source_valid(src.item_id,src.analysis_id) order by a.created_at desc,a.id desc limit 1;
 insert into public.learning_recalls(id,user_id,item_id,rating,scheduled_for,source_session_id,source_analysis_id,source_version) values(p_action_id,auth.uid(),i.id,p_rating,s.due_at,v_src.session_id,v_src.analysis_id,public.learning_transcript_digest(v_src.session_id)) returning * into r;
 v_days:=case p_rating when 'hard' then 1 when 'assisted' then 3 else 7 end;
 update public.learning_schedules set days=v_days,due_at=(((now() at time zone 'Asia/Seoul')::date+v_days)::timestamp at time zone 'Asia/Seoul'),last_rating=p_rating,revision=revision+1,updated_at=now() where item_id=i.id returning * into s;
 update public.learning_weekly_goals g set recall_id=r.id where g.user_id=auth.uid() and g.item_id=i.id and g.call_session_id is not null and exists(select 1 from public.sessions c where c.id=g.call_session_id and c.ended_at<=r.scheduled_for);
 result:=jsonb_build_object('outcome','applied','schedule',to_jsonb(s)-'user_id','recall',to_jsonb(r)-'user_id');
 end if;
 return loop_private.learning_action_finish('recall',p_action_id,args,result);
end $$;

-- Preserve the daily ledger: personalization fills only unused daily slots.
-- Nothing already shown is swapped, and the existing explicit maximum of 3 is
-- still authoritative. A long-return recent-only day keeps its original order.
alter function public.learning_snapshot(text) rename to learning_snapshot_v12;
create function public.learning_snapshot(p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d date:=(now() at time zone 'Asia/Seoul')::date;ids uuid[];more uuid[];cap integer;recent boolean;base jsonb;
begin
 perform loop_private.memory_guard(auth.uid(),p_companion_id);
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_companion_id,0));
 insert into public.learning_daily(user_id,companion_id,day,recent_only) values(auth.uid(),p_companion_id,d,exists(select 1 from public.learning_visits where user_id=auth.uid() and companion_id=p_companion_id and last_seen_at<now()-interval '14 days')) on conflict do nothing;
 select item_ids,allowance,recent_only into ids,cap,recent from public.learning_daily where user_id=auth.uid() and companion_id=p_companion_id and day=d for update;
 if not recent then
 select coalesce(array_agg(id),'{}'::uuid[]) into more from(
 select i.id from public.learning_state_items i left join public.learning_schedules sch on sch.item_id=i.id
 where i.user_id=auth.uid() and i.companion_id=p_companion_id and i.enrolled and (i.status in('active','deferred') or i.status='practiced' and sch.enabled and sch.due_at<=now()) and (i.next_eligible_at is null or i.next_eligible_at<=now()) and not(i.id=any(ids))
 and exists(select 1 from public.learning_sources s where s.item_id=i.id and public.learning_source_valid(i.id,s.analysis_id))
 order by (sch.enabled and sch.due_at<=now()) desc nulls last,
 (length(coalesce(sch.goal,''))>0) desc,
 (select count(distinct src.session_id) from public.learning_sources src where src.item_id=i.id and public.learning_source_valid(i.id,src.analysis_id)) desc,
 i.priority_at desc nulls last,i.updated_at desc,i.id limit greatest(0,cap-cardinality(ids))) q;
 update public.learning_daily set item_ids=ids||more where user_id=auth.uid() and companion_id=p_companion_id and day=d;
 end if;
 base:=public.learning_snapshot_v12(p_companion_id);
 select item_ids into ids from public.learning_daily where user_id=auth.uid() and companion_id=p_companion_id and day=d;
 return jsonb_set(base,'{recommended_item_ids}',coalesce((select jsonb_agg(i.id order by array_position(ids,i.id)) from public.learning_state_items i left join public.learning_schedules s on s.item_id=i.id where i.id=any(ids) and (i.status in('active','deferred') or i.status='practiced' and s.enabled and s.due_at<=now()) and (i.next_eligible_at is null or i.next_eligible_at<=now()) and exists(select 1 from public.learning_sources src where src.item_id=i.id and public.learning_source_valid(src.item_id,src.analysis_id))),'[]'::jsonb));
end $$;

create function public.learning_usage_prepare(p_user_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.sessions%rowtype;p public.learning_next_plans%rowtype;
begin
 select * into c from public.sessions where id=p_session_id and user_id=p_user_id;
 if not found then raise exception 'Session not found' using errcode='42501';end if;perform loop_private.memory_guard(p_user_id,c.companion_id);
 if c.status<>'active' or not loop_private.learning_observation_session_visible(p_user_id,c.id) then raise exception 'Active visible session required';end if;
 select * into p from public.learning_next_plans where user_id=p_user_id and companion_id=c.companion_id;
 if found and exists(select 1 from public.learning_state_items i where i.id=p.item_id and i.status<>'excluded' and length(i.expression)<=500 and octet_length(i.expression)<=2000) and public.learning_source_valid(p.item_id,p.source_analysis_id) then
 insert into public.learning_usage_targets(user_id,item_id,session_id,plan_id,source_session_id,source_analysis_id,source_version,expression)
 select p_user_id,p.item_id,c.id,p.id,p.source_session_id,p.source_analysis_id,public.learning_transcript_digest(p.source_session_id),i.expression from public.learning_state_items i where i.id=p.item_id on conflict(user_id,session_id) do nothing;
 end if;
 return jsonb_build_object('targets',coalesce((select jsonb_agg((to_jsonb(t)-'user_id')||jsonb_build_object('valid',true)) from public.learning_usage_targets t join public.learning_state_items i on i.id=t.item_id where t.user_id=p_user_id and t.session_id=c.id and i.status<>'excluded' and public.learning_source_valid(t.item_id,t.source_analysis_id) and t.source_version=public.learning_transcript_digest(t.source_session_id)),'[]'::jsonb),'source_version',public.learning_transcript_digest(c.id));
end $$;
create function loop_private.learning_connected() returns trigger language plpgsql security definer set search_path='' as $$
declare c public.sessions%rowtype;p public.learning_next_plans%rowtype;t public.learning_usage_targets%rowtype;
begin
 if new.name<>'call_connected' then return new;end if;
 select * into c from public.sessions where id=new.session_id and user_id=new.user_id;
 select * into t from public.learning_usage_targets where user_id=new.user_id and session_id=c.id for update;
 if t.id is not null and loop_private.learning_observation_session_visible(new.user_id,c.id) and public.learning_source_valid(t.item_id,t.source_analysis_id) and t.source_version=public.learning_transcript_digest(t.source_session_id) and exists(select 1 from public.learning_state_items where id=t.item_id and status<>'excluded') then
 update public.learning_usage_targets set connected_at=coalesce(connected_at,new.occurred_at) where id=t.id;
 -- First server-acknowledged qualifying call wins until explicit preparation
 -- or selection changes. Offline arrivals never rewrite a completed chain.
 update public.learning_weekly_goals g set call_session_id=c.id where g.user_id=new.user_id and g.item_id=t.item_id and g.prepared_at is not null and g.prepared_at<=new.occurred_at and g.call_session_id is null and exists(select 1 from public.learning_next_plans q where q.id=t.plan_id and q.user_id=g.user_id);
 end if;
 return new;
end $$;
create trigger learning_connected after insert on public.learning_events for each row execute function loop_private.learning_connected();
create function loop_private.learning_goal_prepared() returns trigger language plpgsql security definer set search_path='' as $$
begin update public.learning_weekly_goals set prepared_at=new.prepared_at,call_session_id=null,recall_id=null where user_id=new.user_id and companion_id=new.companion_id and item_id=new.item_id and selected_at<=new.prepared_at;return new;end $$;
create trigger learning_goal_prepared after insert or update on public.learning_next_plans for each row execute function loop_private.learning_goal_prepared();
create function public.learning_usage_context(p_user_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.sessions%rowtype;
begin
 select * into c from public.sessions where id=p_session_id and user_id=p_user_id;
 if not found then raise exception 'Session not found' using errcode='42501';end if;perform loop_private.memory_guard(p_user_id,c.companion_id);
 if c.status<>'ended' or not loop_private.learning_observation_session_visible(p_user_id,c.id) then raise exception 'Ended visible session required';end if;
 return jsonb_build_object('targets',coalesce((select jsonb_agg(to_jsonb(t)-'user_id') from public.learning_usage_targets t join public.learning_state_items i on i.id=t.item_id where t.user_id=p_user_id and t.session_id=c.id and t.connected_at is not null and i.status<>'excluded' and public.learning_source_valid(t.item_id,t.source_analysis_id) and t.source_version=public.learning_transcript_digest(t.source_session_id)),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'speaker',e.speaker,'text',e.text,'timestamp',e.timestamp,'session_id',e.session_id) order by e.timestamp,e.id) from public.transcript_events e where e.session_id=c.id),'[]'::jsonb),'source_version',public.learning_transcript_digest(c.id));
end $$;
create function public.learning_usage_capture(p_user_id uuid,p_target_id uuid,p_source_version text,p_observation jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.learning_usage_targets%rowtype;o public.learning_usage_observations%rowtype;c public.sessions%rowtype;ids uuid[];mids uuid[];v_mode text;
begin
 select * into t from public.learning_usage_targets where id=p_target_id and user_id=p_user_id for update;
 if not found then raise exception 'Target not found' using errcode='42501';end if;
 select * into c from public.sessions where id=t.session_id;perform loop_private.memory_guard(p_user_id,c.companion_id);
 if c.status<>'ended' or t.connected_at is null or not loop_private.learning_observation_session_visible(p_user_id,c.id) or not public.learning_source_valid(t.item_id,t.source_analysis_id) or t.source_version<>public.learning_transcript_digest(t.source_session_id) or p_source_version is distinct from public.learning_transcript_digest(c.id) or exists(select 1 from public.learning_state_items where id=t.item_id and status='excluded') then raise exception 'Current connected target required';end if;
 if p_observation is null or jsonb_typeof(p_observation)<>'object' or exists(select 1 from jsonb_object_keys(p_observation) k where k not in('kind','mode','evidence_ids','mode_evidence_ids')) or p_observation->>'kind' is null or p_observation->>'kind' not in('observed','undetermined') or coalesce(p_observation->>'mode','undetermined') not in('undetermined','repetition','after_hint','new_context') or jsonb_typeof(p_observation->'evidence_ids') is distinct from 'array' or jsonb_array_length(p_observation->'evidence_ids')>12 or p_observation ? 'mode_evidence_ids' and jsonb_typeof(p_observation->'mode_evidence_ids') is distinct from 'array' then raise exception 'Invalid usage observation';end if;
 select coalesce(array_agg(x::uuid),'{}'::uuid[]) into ids from jsonb_array_elements_text(p_observation->'evidence_ids') x;
 select coalesce(array_agg(x::uuid),'{}'::uuid[]) into mids from jsonb_array_elements_text(coalesce(p_observation->'mode_evidence_ids','[]'::jsonb)) x;v_mode:=coalesce(p_observation->>'mode','undetermined');
 if cardinality(mids)>12 or exists(select 1 from unnest(ids) x where not exists(select 1 from public.transcript_events e where e.id=x and e.session_id=c.id and e.user_id=p_user_id and e.speaker='user')) or exists(select 1 from unnest(mids) x where not exists(select 1 from public.transcript_events e where e.id=x and e.session_id=c.id and e.user_id=p_user_id and e.speaker='assistant')) then raise exception 'Usage evidence must belong to this call and speaker';end if;
 if p_observation->>'kind'='observed' and cardinality(ids)=0 or p_observation->>'kind'='undetermined' and (cardinality(ids)>0 or v_mode<>'undetermined') or v_mode<>'undetermined' and cardinality(mids)=0 then raise exception 'Insufficient usage evidence';end if;
 -- Classification is conservative: each cited user utterance contains the
 -- target words, and contextual modes need preceding assistant evidence.
 if p_observation->>'kind'='observed' and not exists(select 1 from public.transcript_events e where e.id=any(ids) and strpos(public.learning_key(e.text),public.learning_key(t.expression))>0) then raise exception 'Target expression is absent from cited speech';end if;
 if v_mode<>'undetermined' and not exists(select 1 from public.transcript_events a join public.transcript_events u on u.id=any(ids) and a.timestamp<=u.timestamp where a.id=any(mids)) then raise exception 'Mode evidence must precede user speech';end if;
 if v_mode='repetition' and not exists(select 1 from public.transcript_events a where a.id=any(mids) and strpos(public.learning_key(a.text),public.learning_key(t.expression))>0) then raise exception 'Repetition requires preceding example';end if;
 select * into o from public.learning_usage_observations where target_id=t.id;
 if found and o.source_version=p_source_version then return jsonb_build_object('outcome','duplicate','usage',to_jsonb(o)-'user_id');end if;
 insert into public.learning_usage_observations(user_id,target_id,item_id,session_id,source_version,kind,mode,evidence_ids,mode_evidence_ids) values(p_user_id,t.id,t.item_id,c.id,p_source_version,p_observation->>'kind',v_mode,ids,mids)
 on conflict(target_id) do update set source_version=excluded.source_version,kind=excluded.kind,mode=excluded.mode,evidence_ids=excluded.evidence_ids,mode_evidence_ids=excluded.mode_evidence_ids,review_status='unreviewed',revision=public.learning_usage_observations.revision+1,created_at=now() returning * into o;
 return jsonb_build_object('outcome','applied','usage',to_jsonb(o)-'user_id');
end $$;
create function public.learning_usage_review(p_usage_id uuid,p_expected_revision integer,p_action_id uuid,p_status text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.learning_usage_observations%rowtype;i public.learning_state_items%rowtype;args jsonb:=jsonb_build_array(p_usage_id,p_expected_revision,p_status);result jsonb;
begin
 result:=loop_private.learning_action_start('usage_review',p_action_id,args);if result is not null then return result;end if;if p_expected_revision is null or p_expected_revision<0 then raise exception 'Expected revision required';end if;
 select * into o from public.learning_usage_observations where id=p_usage_id and user_id=auth.uid() for update;
 if not found then raise exception 'Usage not found' using errcode='42501';end if;
 select * into i from public.learning_state_items where id=o.item_id;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 if o.revision<>p_expected_revision then result:=jsonb_build_object('outcome','conflict','usage',to_jsonb(o)-'user_id');
 else
 if p_status is null or p_status not in('unreviewed','confirmed','rejected') then raise exception 'Invalid review status';end if;
 if not loop_private.learning_observation_session_visible(auth.uid(),o.session_id) or o.source_version<>public.learning_transcript_digest(o.session_id) or i.status='excluded' or not exists(select 1 from public.learning_usage_targets t where t.id=o.target_id and public.learning_source_valid(t.item_id,t.source_analysis_id)) then raise exception 'Current usage source required';end if;
 update public.learning_usage_observations set review_status=p_status,revision=revision+1 where id=o.id returning * into o;result:=jsonb_build_object('outcome','applied','usage',to_jsonb(o)-'user_id');
 end if;
 return loop_private.learning_action_finish('usage_review',p_action_id,args,result);
end $$;

create table public.learning_weekly_versions (
 analysis_id uuid not null references public.analyses(id) on delete cascade,user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null,transcript_digest text not null,analysis_digest text not null,primary key(analysis_id,session_id),
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
create function loop_private.learning_weekly_version_capture() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.kind='weekly' then
 insert into public.learning_weekly_versions(analysis_id,user_id,session_id,transcript_digest,analysis_digest)
 select distinct new.id,new.user_id,e.session_id,public.learning_transcript_digest(e.session_id),md5(new.content::text||new.source_event_ids::text) from public.transcript_events e where e.id=any(new.source_event_ids) and e.user_id=new.user_id;
 end if;return new;
end $$;
create trigger learning_weekly_version_capture after insert on public.analyses for each row execute function loop_private.learning_weekly_version_capture();

create function loop_private.learning_weekly_valid(p_user uuid,p_analysis uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare a public.analyses%rowtype;v_start timestamptz;v_end timestamptz;c text;
begin
 select * into a from public.analyses where id=p_analysis and user_id=p_user and kind='weekly';if not found then return false;end if;
 begin v_start:=(a.content#>>'{scope,period_start}')::timestamptz;v_end:=(a.content#>>'{scope,period_end}')::timestamptz;exception when others then return false;end;
 c:=a.content#>>'{scope,companionId}';
 if c is null or v_start is null or v_end is null or v_end-v_start<>interval '168 hours' or v_end>a.created_at+interval '5 minutes' or cardinality(a.source_event_ids)=0 then return false;end if;
 return not exists(select 1 from unnest(a.source_event_ids) source_id(id) left join public.transcript_events e on e.id=source_id.id left join public.sessions s on s.id=e.session_id
 where e.id is null or e.user_id<>p_user or s.companion_id<>c or s.status<>'ended' or s.ended_at<v_start or s.ended_at>v_end or not loop_private.learning_session_visible(p_user,s.id)
 or not exists(select 1 from public.learning_weekly_versions v where v.analysis_id=a.id and v.session_id=s.id and v.transcript_digest=public.learning_transcript_digest(s.id) and v.analysis_digest=md5(a.content::text||a.source_event_ids::text))
 or exists(select 1 from public.learning_source_holds h where h.user_id=p_user and h.session_id=s.id and (cardinality(h.evidence_ids)=0 or h.evidence_ids&&a.source_event_ids))
 or exists(select 1 from public.learning_sources src join public.learning_state_items i on i.id=src.item_id where src.session_id=s.id and i.status='excluded' and src.evidence_ids&&a.source_event_ids))
 -- Late transcript edits/uploads invalidate the original fixed source set.
 and not exists(select 1 from public.transcript_events e where e.session_id in(select t.session_id from public.transcript_events t where t.id=any(a.source_event_ids)) and not(e.id=any(a.source_event_ids)));
end $$;
create function public.learning_weekly_goal_select(p_analysis_id uuid,p_kind text,p_expected_revision integer,p_action_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.analyses%rowtype;g public.learning_weekly_goals%rowtype;i public.learning_state_items%rowtype;proposal jsonb;c text;args jsonb:=jsonb_build_array(p_analysis_id,p_kind,p_expected_revision);result jsonb;
begin
 result:=loop_private.learning_action_start('weekly_select',p_action_id,args);if result is not null then return result;end if;if p_expected_revision is null or p_expected_revision<0 then raise exception 'Expected revision required';end if;
 select * into a from public.analyses where id=p_analysis_id and user_id=auth.uid() and kind='weekly';
 if not found then raise exception 'Weekly analysis not found' using errcode='42501';end if;c:=a.content#>>'{scope,companionId}';perform loop_private.memory_guard(auth.uid(),c);perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':weekly-goal:'||c,0));
 select * into g from public.learning_weekly_goals where user_id=auth.uid() and companion_id=c for update;
 if coalesce(g.revision,0)<>p_expected_revision then result:=jsonb_build_object('outcome','conflict','goal',to_jsonb(g)-'user_id');
 else
 if p_kind is null or p_kind not in('keep','try') or not loop_private.learning_weekly_valid(auth.uid(),a.id) then raise exception 'Current exact 168-hour weekly analysis required';end if;
 proposal:=a.content->'learning_plan'->p_kind;
 if jsonb_typeof(proposal) is distinct from 'object' or jsonb_typeof(proposal->'goal') is distinct from 'string' or length(btrim(proposal->>'goal')) not between 1 and 500 then raise exception 'Weekly goal proposal required';end if;
 select * into i from public.learning_state_items where id=(proposal->>'item_id')::uuid and user_id=auth.uid() and companion_id=c and status<>'excluded';
 if not found or not exists(select 1 from public.learning_sources src where src.item_id=i.id and src.evidence_ids<@a.source_event_ids and public.learning_source_valid(src.item_id,src.analysis_id)) then raise exception 'Weekly goal needs a current cited item';end if;
 insert into public.learning_weekly_goals(id,user_id,companion_id,analysis_id,item_id,kind,goal,period_start,period_end,source_version)
 values(p_action_id,auth.uid(),c,a.id,i.id,p_kind,proposal->>'goal',(a.content#>>'{scope,period_start}')::timestamptz,(a.content#>>'{scope,period_end}')::timestamptz,md5(a.content::text||a.source_event_ids::text))
 on conflict(user_id,companion_id) do update set id=excluded.id,analysis_id=excluded.analysis_id,item_id=excluded.item_id,kind=excluded.kind,goal=excluded.goal,period_start=excluded.period_start,period_end=excluded.period_end,source_version=excluded.source_version,selected_at=now(),revision=public.learning_weekly_goals.revision+1,prepared_at=null,call_session_id=null,recall_id=null returning * into g;
 result:=jsonb_build_object('outcome','applied','goal',to_jsonb(g)-'user_id');
 end if;
 return loop_private.learning_action_finish('weekly_select',p_action_id,args,result);
end $$;
create function public.learning_weekly_context(p_user_id uuid,p_companion_id text,p_start timestamptz,p_end timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_start is null or p_end is null or p_end-p_start<>interval '168 hours' or p_end>now()+interval '5 minutes' then raise exception 'Exact 168-hour scope required';end if;
 return jsonb_build_object(
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'expression',i.expression,'source_session_id',src.session_id,'source_analysis_id',src.analysis_id,'evidence_ids',src.evidence_ids,'source_version',public.learning_transcript_digest(src.session_id)))
 from public.learning_state_items i join lateral(select s.* from public.learning_sources s join public.sessions c on c.id=s.session_id where s.item_id=i.id and public.learning_source_valid(s.item_id,s.analysis_id) and c.ended_at between p_start and p_end order by c.ended_at desc,s.analysis_id limit 1) src on true where i.user_id=p_user_id and i.companion_id=p_companion_id and i.status<>'excluded'),'[]'::jsonb),
 'recalls',coalesce((select jsonb_agg(to_jsonb(r)-'user_id') from public.learning_recalls r join public.learning_state_items i on i.id=r.item_id where r.user_id=p_user_id and i.companion_id=p_companion_id and i.status<>'excluded' and r.occurred_at between p_start and p_end and r.source_version=public.learning_transcript_digest(r.source_session_id) and public.learning_source_valid(r.item_id,r.source_analysis_id)),'[]'::jsonb),
 'usage',coalesce((select jsonb_agg(to_jsonb(o)-'user_id') from public.learning_usage_observations o join public.learning_usage_targets t on t.id=o.target_id join public.learning_state_items i on i.id=o.item_id join public.sessions c on c.id=o.session_id where o.user_id=p_user_id and i.companion_id=p_companion_id and i.status<>'excluded' and o.review_status='confirmed' and o.created_at between p_start and p_end and c.ended_at between p_start and p_end and loop_private.learning_observation_session_visible(p_user_id,c.id) and o.source_version=public.learning_transcript_digest(c.id) and public.learning_source_valid(i.id,t.source_analysis_id) and t.source_version=public.learning_transcript_digest(t.source_session_id)),'[]'::jsonb));
end $$;

create function public.learning_enhancement_snapshot(p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb;
begin
 perform loop_private.memory_guard(auth.uid(),p_companion_id);base:=public.learning_snapshot(p_companion_id);
 return jsonb_build_object(
 'reviews',coalesce((select jsonb_agg((to_jsonb(r)-'user_id')||jsonb_build_object('item_expression',i.expression,'source_current',loop_private.learning_current(r.user_id,r.source_session_id,r.source_analysis_id,r.source_version))) from public.learning_reviews r join public.learning_state_items i on i.id=r.item_id where r.user_id=auth.uid() and i.companion_id=p_companion_id and loop_private.learning_session_visible(auth.uid(),r.source_session_id)),'[]'::jsonb),
 'schedules',coalesce((select jsonb_agg((to_jsonb(s)-'user_id')||jsonb_build_object('item_expression',i.expression,'source_session_id',coalesce((public.learning_item_json(i.id)->>'source_session_id')::uuid,i.restored_session_id))) from public.learning_schedules s join public.learning_state_items i on i.id=s.item_id where s.user_id=auth.uid() and i.companion_id=p_companion_id),'[]'::jsonb),
 'recalls',coalesce((select jsonb_agg((to_jsonb(r)-'user_id')||jsonb_build_object('item_expression',i.expression,'source_session_id',(public.learning_item_json(i.id)->>'source_session_id')::uuid)) from public.learning_recalls r join public.learning_state_items i on i.id=r.item_id where r.user_id=auth.uid() and i.companion_id=p_companion_id),'[]'::jsonb),
 'usage',coalesce((select jsonb_agg((to_jsonb(o)-'user_id')||jsonb_build_object('item_expression',i.expression,'source_session_id',t.source_session_id,'expression',t.expression,'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'speaker',e.speaker,'text',e.text,'timestamp',e.timestamp)) from public.transcript_events e where e.id=any(o.evidence_ids||o.mode_evidence_ids)),'[]'::jsonb))) from public.learning_usage_observations o join public.learning_usage_targets t on t.id=o.target_id join public.learning_state_items i on i.id=o.item_id where o.user_id=auth.uid() and i.companion_id=p_companion_id and i.status<>'excluded' and loop_private.learning_observation_session_visible(auth.uid(),o.session_id) and o.source_version=public.learning_transcript_digest(o.session_id) and public.learning_source_valid(t.item_id,t.source_analysis_id) and t.source_version=public.learning_transcript_digest(t.source_session_id)),'[]'::jsonb),
 'weekly_goals',coalesce((select jsonb_agg((to_jsonb(g)-'user_id')||jsonb_build_object('item_expression',i.expression,'source_session_id',(public.learning_item_json(i.id)->>'source_session_id')::uuid,'source_current',loop_private.learning_weekly_valid(auth.uid(),g.analysis_id))) from public.learning_weekly_goals g join public.learning_state_items i on i.id=g.item_id where g.user_id=auth.uid() and g.companion_id=p_companion_id and i.status<>'excluded' and loop_private.learning_weekly_valid(auth.uid(),g.analysis_id)),'[]'::jsonb),
 'imports',coalesce((select jsonb_agg((to_jsonb(x)-'user_id'-'import_key')||jsonb_build_object('item_expression',i.expression,'restored_unverified',true)) from public.learning_enhancement_imports x join public.learning_state_items i on i.id=x.item_id where x.user_id=auth.uid() and i.companion_id=p_companion_id and loop_private.learning_session_visible(auth.uid(),x.source_session_id)),'[]'::jsonb),
 'personalized_item_ids',base->'recommended_item_ids',
 'recommendation_reasons',coalesce((select jsonb_object_agg(i.id::text,case when s.enabled and s.due_at<=now() then 'delayed_recall' when length(coalesce(s.goal,''))>0 then 'selected_goal' when (select count(distinct x.session_id) from public.learning_sources x where x.item_id=i.id and public.learning_source_valid(i.id,x.analysis_id))>1 then 'repeated_source' else 'recent_source' end) from public.learning_state_items i left join public.learning_schedules s on s.item_id=i.id where i.user_id=auth.uid() and i.companion_id=p_companion_id and base->'recommended_item_ids' ? i.id::text),'{}'::jsonb));
end $$;

-- Restores only user-controlled reports and preferences. AI results/accepted
-- eligibility must be regenerated against local evidence after import.
create function public.learning_enhancement_restore(p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e jsonb;i public.learning_state_items%rowtype;sid uuid;count_saved integer:=0;v_days integer;v_stamp timestamptz;r public.learning_reviews%rowtype;section text;archived integer:=0;v_payload jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not public.is_approved_user() then raise exception 'Account not approved' using errcode='42501';end if;
 if p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('reviews','schedules','recalls','usage','weekly_goals','personalized_item_ids','recommendation_reasons','imports')) then raise exception 'Invalid enhancement backup';end if;
 foreach section in array array['reviews','schedules','recalls','usage','weekly_goals','imports'] loop
 if jsonb_typeof(coalesce(p_data->section,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_data->section,'[]'::jsonb))>500 then raise exception 'At most 500 records per enhancement section';end if;
 for e in select value from jsonb_array_elements(coalesce(p_data->section,'[]'::jsonb)) loop
 if jsonb_typeof(e)<>'object' or octet_length(e::text)>32768 then raise exception 'Invalid imported record';end if;
 if e ? 'user_id' and (e->>'user_id')::uuid is distinct from auth.uid() then raise exception 'Backup belongs to another user' using errcode='42501';end if;
 sid:=(e->>'source_session_id')::uuid;
 select x.* into i from public.learning_state_items x join public.sessions source on source.id=sid and source.user_id=x.user_id and source.companion_id=x.companion_id where x.user_id=auth.uid() and x.canonical_key=public.learning_key(e->>'item_expression');
 if not found then raise exception 'Owned matching restored item required' using errcode='42501';end if;
 perform loop_private.memory_guard(auth.uid(),i.companion_id);
 v_payload:=case when section='imports' then e->'payload' else e-'user_id' end;
 if v_payload is null or jsonb_typeof(v_payload)<>'object' then raise exception 'Invalid imported payload';end if;
 insert into public.learning_enhancement_imports(user_id,item_id,source_session_id,kind,payload,import_key)
 values(auth.uid(),i.id,sid,case when section='imports' then e->>'kind' else section end,v_payload,md5(i.id::text||case when section='imports' then e->>'kind' else section end||v_payload::text)) on conflict do nothing;
 if found then archived:=archived+1;end if;
 end loop;
 end loop;
 for e in select value from jsonb_array_elements(coalesce(p_data->'schedules','[]'::jsonb)) loop
 if e ? 'user_id' and (e->>'user_id')::uuid<>auth.uid() then raise exception 'Backup belongs to another user' using errcode='42501';end if;
 sid:=(e->>'source_session_id')::uuid;
 select x.* into i from public.learning_state_items x join public.sessions s on s.id=sid and s.user_id=x.user_id and s.companion_id=x.companion_id where x.user_id=auth.uid() and x.canonical_key=public.learning_key(e->>'item_expression');
 if not found then raise exception 'Owned matching restored item required' using errcode='42501';end if;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 v_days:=(e->>'days')::integer;if v_days is null or v_days not in(1,3,7) or length(coalesce(e->>'goal',''))>240 then raise exception 'Invalid restored schedule';end if;
 v_stamp:=(e->>'due_at')::timestamptz;
 insert into public.learning_schedules(item_id,user_id,enabled,days,goal,due_at,last_rating) values(i.id,auth.uid(),coalesce((e->>'enabled')::boolean,false),v_days,coalesce(e->>'goal',''),v_stamp,case when e->>'last_rating' in('hard','assisted','independent') then e->>'last_rating' end) on conflict do nothing;
 if found then count_saved:=count_saved+1;end if;
 end loop;
 for e in select value from jsonb_array_elements(coalesce(p_data->'recalls','[]'::jsonb)) loop
 sid:=(e->>'source_session_id')::uuid;
 select x.* into i from public.learning_state_items x join public.sessions s on s.id=sid and s.user_id=x.user_id and s.companion_id=x.companion_id where x.user_id=auth.uid() and x.canonical_key=public.learning_key(e->>'item_expression');
 if not found then raise exception 'Owned matching restored item required' using errcode='42501';end if;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 v_stamp:=(e->>'occurred_at')::timestamptz;
 if v_stamp is null or v_stamp>now()+interval '5 minutes' or (e->>'scheduled_for')::timestamptz>v_stamp or e->>'rating' is null or e->>'rating' not in('hard','assisted','independent') then raise exception 'Invalid restored recall';end if;
 insert into public.learning_recalls(id,user_id,item_id,rating,scheduled_for,occurred_at) values((e->>'id')::uuid,auth.uid(),i.id,e->>'rating',(e->>'scheduled_for')::timestamptz,v_stamp) on conflict do nothing;
 if found then count_saved:=count_saved+1;end if;
 end loop;
 for e in select value from jsonb_array_elements(coalesce(p_data->'reviews','[]'::jsonb)) loop
 sid:=(e->>'source_session_id')::uuid;
 select x.* into i from public.learning_state_items x join public.sessions s on s.id=sid and s.user_id=x.user_id and s.companion_id=x.companion_id where x.user_id=auth.uid() and x.canonical_key=public.learning_key(e->>'item_expression');
 if not found then raise exception 'Owned matching restored item required' using errcode='42501';end if;perform loop_private.memory_guard(auth.uid(),i.companion_id);
 -- Imported explanations remain separate and pending, never imported acceptance.
 if exists(select 1 from public.learning_sources s where s.item_id=i.id and s.analysis_id=(e->>'source_analysis_id')::uuid and s.session_id=sid) and length(btrim(coalesce(e->>'explanation',''))) between 1 and 2000 then
 insert into public.learning_reviews(id,user_id,item_id,source_session_id,source_analysis_id,source_version,explanation)
 values((e->>'id')::uuid,auth.uid(),i.id,sid,(e->>'source_analysis_id')::uuid,coalesce(e->>'source_version','untrusted-import'),e->>'explanation') on conflict do nothing;if found then count_saved:=count_saved+1;end if;
 end if;
 end loop;
 -- Usage and goal AI provenance remains in the backup, but importing it never
 -- invents an actual connection or source-valid weekly analysis. If these
 -- existing owned records survived, their current server state already wins.
 return jsonb_build_object('restored',count_saved,'archived',archived,'evidence_imported',false,'requires_revalidation',true);
end $$;

-- Preserve manual/profile cutoff policy while preventing automatic facts from
-- held, excluded, incomplete, or stale transcript sources entering any context.
create or replace function loop_private.memory_facts(p_user_id uuid,p_companion_id text) returns jsonb
language sql stable security definer set search_path='' as $$
 with latest as materialized (
 select distinct on(a.session_id) a.* from public.analyses a join public.sessions s on s.id=a.session_id and s.user_id=a.user_id
 where a.user_id=p_user_id and a.kind='session' and s.companion_id=p_companion_id
 and not exists(select 1 from public.memory_session_exclusions e where e.user_id=p_user_id and e.companion_id=p_companion_id and e.session_id=s.id)
 and exists(select 1 from public.learning_feedback f where f.analysis_id=a.id and f.complete_version and f.transcript_digest=public.learning_transcript_digest(s.id))
 and not exists(select 1 from public.analyses newer where newer.session_id=a.session_id and newer.kind='session' and (newer.created_at,newer.id)>(a.created_at,a.id))
 and not exists(select 1 from public.learning_source_holds h where h.user_id=p_user_id and h.session_id=s.id)
 and not exists(select 1 from public.learning_sources src join public.learning_state_items item on item.id=src.item_id where src.user_id=p_user_id and src.session_id=s.id and item.status='excluded')
 order by a.session_id,a.created_at desc,a.id desc
 ), facts as (
 select f.item,a.id analysis_id,a.session_id,max(e.timestamp) spoken_at from latest a
 cross join lateral jsonb_array_elements(case when jsonb_typeof(a.content->'memory_facts')='array' then a.content->'memory_facts' else '[]'::jsonb end) f(item)
 join public.transcript_events e on e.user_id=p_user_id and e.session_id=a.session_id and e.speaker='user' and e.id=any(a.source_event_ids)
 and (f.item->'evidence_ids') ? e.id::text and char_length(f.item->>'quote')>0 and position(f.item->>'quote' in e.text)>0
 where f.item->>'key' in ('name','occupation','location','goal','interest','preference') and jsonb_typeof(f.item->'value')='string' and char_length(f.item->>'value')<=240
 group by f.item,a.id,a.session_id
 ), slots as (select distinct on(item->>'key') * from facts order by item->>'key',spoken_at desc,analysis_id desc), combined as (
 select item->>'key' key,jsonb_build_object('key',item->>'key','value',item->>'value','forgotten',item->>'value'='','quote',item->>'quote','evidence_ids',item->'evidence_ids','session_id',session_id,'spoken_at',spoken_at) fact
 from slots where not exists(select 1 from public.memory_fact_overrides o where o.user_id=p_user_id and o.companion_id=p_companion_id and o.key=item->>'key')
 union all select o.key,jsonb_build_object('key',o.key,'value',o.value,'forgotten',o.value='','manual',true,'updated_at',o.updated_at) from public.memory_fact_overrides o where o.user_id=p_user_id and o.companion_id=p_companion_id
 ) select coalesce(jsonb_agg(fact order by key),'[]'::jsonb) from combined
$$;

do $$ declare t text;f record;begin
 foreach t in array array['learning_reviews','learning_schedules','learning_recalls','learning_usage_targets','learning_usage_observations','learning_weekly_goals','learning_enhancement_actions','learning_enhancement_imports','learning_weekly_versions'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy %I on public.%I for select to authenticated using(user_id=(select auth.uid()) and public.is_approved_user())',t||'_read_own',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname=any(array['learning_source_valid','learning_source_valid_v12','learning_snapshot','learning_snapshot_v12','learning_review_submit','learning_review_decide','learning_review_context','learning_review_complete','learning_schedule_config','learning_recall','learning_usage_prepare','learning_usage_context','learning_usage_capture','learning_usage_review','learning_weekly_context','learning_weekly_goal_select','learning_enhancement_snapshot','learning_enhancement_restore']) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='loop_private'::regnamespace and proname like 'learning_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);end loop;
end $$;
grant execute on function public.learning_snapshot(text),public.learning_enhancement_snapshot(text),public.learning_review_submit(uuid,integer,uuid,uuid,text),public.learning_review_decide(uuid,integer,uuid,text),public.learning_schedule_config(uuid,integer,uuid,integer,text),public.learning_recall(uuid,integer,uuid,text),public.learning_usage_review(uuid,integer,uuid,text),public.learning_weekly_goal_select(uuid,text,integer,uuid),public.learning_enhancement_restore(jsonb) to authenticated;
grant execute on function public.learning_review_context(uuid,uuid),public.learning_review_complete(uuid,uuid,integer,text,jsonb),public.learning_usage_prepare(uuid,uuid),public.learning_usage_context(uuid,uuid),public.learning_usage_capture(uuid,uuid,text,jsonb),public.learning_weekly_context(uuid,text,timestamptz,timestamptz) to service_role;
