-- Self-reported practice is separate from evidence of later expression reuse.
create table public.learning_items (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 companion_id text not null check(companion_id in ('alex','mia','juno')),
 session_id uuid not null references public.sessions(id) on delete cascade,
 analysis_id uuid not null references public.analyses(id) on delete cascade,
 position integer not null check(position between 1 and 3),
 original text not null, expression text not null, reason text not null,
 state text not null default 'unpracticed' check(state in ('unpracticed','later','practiced')),
 practiced_at timestamptz, updated_at timestamptz not null default now(),
 unique(user_id,analysis_id,position)
);
alter table public.learning_items enable row level security;
create policy learning_read on public.learning_items for select to authenticated
 using(user_id=auth.uid() and public.is_approved_user());
revoke all on public.learning_items from public,anon,authenticated;
grant select on public.learning_items to authenticated;
grant all on public.learning_items to service_role;

-- Hide superseded feedback and feedback whose transcript has changed.
create function loop_private.learning_current(p_analysis_id uuid,p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.analyses a join public.sessions s on s.id=a.session_id
 where a.id=p_analysis_id and a.user_id=p_user_id and s.user_id=p_user_id and s.status='ended' and a.kind='session'
 and not exists(select 1 from public.analyses newer where newer.session_id=a.session_id and newer.kind='session'
   and (newer.created_at,newer.id)>(a.created_at,a.id))
 and exists(select 1 from public.transcript_events e where e.session_id=s.id and e.speaker='user')
 and not exists(select 1 from public.transcript_events e where e.session_id=s.id and not(e.id=any(a.source_event_ids)))
 and not exists(select 1 from unnest(a.source_event_ids) eid where not exists(select 1 from public.transcript_events e where e.id=eid and e.session_id=s.id)))
$$;
revoke all on function loop_private.learning_current(uuid,uuid) from public,anon,authenticated;

create function public.learning_review(p_companion_id text,p_analysis_id uuid default null,p_item_id uuid default null,p_state text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_analysis public.analyses%rowtype; v_item jsonb; v_pos integer:=0; v_expression text; v_seen text[]:='{}';
begin
 perform loop_private.memory_guard(v_user,p_companion_id);
 if p_analysis_id is not null then
  select a.* into v_analysis from public.analyses a join public.sessions s on s.id=a.session_id
   where a.id=p_analysis_id and a.user_id=v_user and s.companion_id=p_companion_id;
  if not found or not loop_private.learning_current(p_analysis_id,v_user) then
   raise exception 'Feedback changed; refresh from the current transcript' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(v_analysis.content->'corrections','[]') || coalesce(v_analysis.content->'practice','[]')) loop
   v_expression:=btrim(coalesce(v_item->>'improved',v_item->>'expression',''));
   if char_length(v_expression) not between 1 and 3000 or jsonb_array_length(coalesce(v_item->'evidence_ids','[]'))=0 then continue; end if;
   if exists(select 1 from jsonb_array_elements_text(v_item->'evidence_ids') eid where not exists(
    select 1 from public.transcript_events e where e.id::text=eid and e.session_id=v_analysis.session_id and e.speaker='user')) then continue; end if;
   if v_expression=any(v_seen) then continue; end if;
   v_seen:=array_append(v_seen,v_expression);
   v_pos:=v_pos+1;
   insert into public.learning_items(user_id,companion_id,session_id,analysis_id,position,original,expression,reason)
    values(v_user,p_companion_id,v_analysis.session_id,p_analysis_id,v_pos,coalesce(v_item->>'original',''),v_expression,coalesce(v_item->>'reason',''))
    on conflict(user_id,analysis_id,position) do nothing;
   exit when v_pos=3;
  end loop;
 end if;
 if p_item_id is not null then
  if p_state is null or p_state not in ('unpracticed','later','practiced') then raise exception 'Invalid practice state' using errcode='22023'; end if;
  update public.learning_items set state=p_state,
   practiced_at=case when p_state='practiced' then coalesce(practiced_at,now()) else null end,
   updated_at=case when state=p_state then updated_at else now() end
   where id=p_item_id and user_id=v_user and companion_id=p_companion_id and loop_private.learning_current(analysis_id,v_user);
  if not found then raise exception 'Practice item unavailable' using errcode='42501'; end if;
 elsif p_state is not null then raise exception 'Practice item required' using errcode='22023'; end if;
 return coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('reuse',(
   select jsonb_build_object('event_id',e.id,'session_id',e.session_id,'text',e.text,'timestamp',e.timestamp)
   from public.transcript_events e join public.sessions s on s.id=e.session_id
   where i.practiced_at is not null and e.user_id=v_user and s.companion_id=p_companion_id and s.status='ended'
   and e.session_id<>i.session_id and e.speaker='user' and s.created_at>=i.practiced_at
   and position(' '||btrim(regexp_replace(lower(i.expression),'[^[:alnum:]]+',' ','g'))||' '
    in ' '||btrim(regexp_replace(lower(e.text),'[^[:alnum:]]+',' ','g'))||' ')>0 order by e.created_at limit 1))
   order by (i.state='practiced'),i.updated_at desc,i.position)
  from (select * from public.learning_items where user_id=v_user and companion_id=p_companion_id
   and loop_private.learning_current(analysis_id,v_user) order by updated_at desc,position limit 100) i),'[]'::jsonb);
end; $$;
revoke all on function public.learning_review(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.learning_review(text,uuid,uuid,text) to authenticated;

create function public.learning_context(p_user_id uuid,p_companion_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 return coalesce((select jsonb_agg(jsonb_build_object('expression',i.expression,'session_id',i.session_id,'self_reported',true)) from (
 select l.* from public.learning_items l join public.sessions s on s.id=l.session_id
 left join public.memory_state m on m.user_id=l.user_id and m.companion_id=l.companion_id
 where l.user_id=p_user_id and l.companion_id=p_companion_id and l.state='practiced'
 and loop_private.learning_current(l.analysis_id,p_user_id)
 and (m.history_cutoff is null or s.created_at>m.history_cutoff)
 and not exists(select 1 from public.memory_session_exclusions x where x.user_id=l.user_id and x.session_id=l.session_id)
 order by l.practiced_at desc limit 2) i),'[]'::jsonb);
end; $$;
revoke all on function public.learning_context(uuid,text) from public,anon,authenticated;
grant execute on function public.learning_context(uuid,text) to service_role;

create table public.learning_plans (
 user_id uuid not null references auth.users(id) on delete cascade,
 companion_id text not null check(companion_id in ('alex','mia','juno')),
 scenario text not null check(char_length(scenario) between 1 and 400),
 primary key(user_id,companion_id)
);
alter table public.learning_plans enable row level security;
create policy learning_plans_read on public.learning_plans for select to authenticated
 using(user_id=auth.uid() and public.is_approved_user());
revoke all on public.learning_plans from public,anon,authenticated;
grant select on public.learning_plans to authenticated;
grant all on public.learning_plans to service_role;
create function public.learning_plan(p_companion_id text,p_scenario text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
 perform loop_private.memory_guard(v_user,p_companion_id);
 if p_scenario is not null then
  if char_length(btrim(p_scenario)) not between 1 and 400 then raise exception 'Invalid topic' using errcode='22023'; end if;
  insert into public.learning_plans values(v_user,p_companion_id,btrim(p_scenario))
   on conflict(user_id,companion_id) do update set scenario=excluded.scenario;
 end if;
 return jsonb_build_object('scenario',(select scenario from public.learning_plans where user_id=v_user and companion_id=p_companion_id));
end; $$;
revoke all on function public.learning_plan(text,text) from public,anon,authenticated;
grant execute on function public.learning_plan(text,text) to authenticated;
