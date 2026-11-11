-- Review browsing and explicit bookmarks are independent of recommendation,
-- practice, mastery and companion memory. Reading never enrolls a learner.
create table public.review_bookmarks (
 user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null, expression_key text not null,
 saved boolean not null default false, revision integer not null default 1,
 updated_at timestamptz not null default now(),
 primary key(user_id,session_id,expression_key),
 foreign key(session_id,user_id) references public.sessions(id,user_id) on delete cascade
);
alter table public.review_bookmarks enable row level security;
create policy review_bookmarks_owner on public.review_bookmarks for select to authenticated
 using(user_id=auth.uid() and public.is_approved_user());
revoke all on public.review_bookmarks from public,anon,authenticated;
grant select on public.review_bookmarks to authenticated;
grant all on public.review_bookmarks to service_role;

create function loop_private.review_note(p_user uuid,p_session uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.sessions%rowtype;a public.analyses%rowtype;f public.learning_feedback%rowtype;
 e jsonb;entries jsonb:='[]';strengths jsonb:='[]';seen text[]:='{}';
 k text;ids uuid[];item public.learning_state_items%rowtype;mark public.review_bookmarks%rowtype;
 eligible boolean;phase text;digest text;
begin
 select * into s from public.sessions where id=p_session and user_id=p_user;
 if not found then raise exception 'Session not found' using errcode='42501';end if;
 select * into a from public.analyses where user_id=p_user and session_id=s.id and kind='session' order by created_at desc,id desc limit 1;
 select * into f from public.learning_feedback where analysis_id=a.id;
 digest:=public.learning_transcript_digest(s.id);
 eligible:=s.status='ended' and not s.record_incomplete and coalesce(f.complete_version and f.transcript_digest=digest,false)
 and not exists(select 1 from public.memory_state m where m.user_id=p_user and m.companion_id=s.companion_id and s.created_at<=m.history_cutoff)
 and not exists(select 1 from public.memory_session_exclusions m where m.user_id=p_user and m.session_id=s.id);
 phase:=case when s.status<>'ended' or s.record_incomplete then 'partial'
 when eligible then 'ready'
 when not exists(select 1 from public.transcript_events t where t.session_id=s.id and t.speaker='user' and btrim(t.text)<>'') then 'empty'
 when exists(select 1 from public.post_call_tasks q where q.session_id=s.id and q.kind='session' and q.state in('queued','running','retry_wait')) then 'pending'
 else 'unavailable' end;
 if eligible then
  -- The complete analysis is used, not the daily recommendation or ingest's
  -- first-three subset. Keep zero/many of each kind; deduplicate within a call.
  for e in select value from jsonb_array_elements(
   coalesce(a.content->'corrections','[]') || coalesce(a.content->'practice','[]') ||
   coalesce((select jsonb_agg(jsonb_build_object('improved',i.expression,'original',src.original,'reason',r.proposal->>'reason','category',r.proposal->>'category','evidence_ids',r.proposal->'evidence_ids','reconsidered',true))
    from public.learning_reviews r join public.learning_state_items i on i.id=r.accepted_item_id
    join public.learning_sources src on src.item_id=i.id and src.analysis_id=a.id
    where r.user_id=p_user and r.source_analysis_id=a.id and r.status='accepted' and r.source_version=digest and public.learning_source_valid(i.id,a.id)),'[]')) loop
   if jsonb_typeof(e)<>'object' or length(btrim(coalesce(e->>'improved',e->>'expression',''))) not between 1 and 3000
    or jsonb_typeof(e->'evidence_ids') is distinct from 'array' or jsonb_array_length(e->'evidence_ids') not between 1 and 12 then continue;end if;
   if exists(select 1 from jsonb_array_elements_text(e->'evidence_ids') x where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then continue;end if;
   select array_agg(x::uuid) into ids from jsonb_array_elements_text(e->'evidence_ids') x;
   if exists(select 1 from unnest(ids) x left join public.transcript_events t on t.id=x where t.id is null or t.user_id<>p_user or t.session_id<>s.id or t.speaker<>'user') then continue;end if;
   if length(coalesce(e->>'original',''))>0 and not exists(select 1 from public.transcript_events t where t.id=any(ids) and strpos(t.text,e->>'original')>0) then continue;end if;
   k:=public.learning_key(coalesce(e->>'improved',e->>'expression'));
   if k='' or k=any(seen) then continue;end if;
   select * into item from public.learning_state_items i where i.user_id=p_user and i.companion_id=s.companion_id and i.canonical_key=k;
   if item.status='excluded' or exists(select 1 from public.learning_source_holds h where h.user_id=p_user and h.session_id=s.id and
    ((h.reason='intent' and h.item_id=item.id) or (h.reason='wrong_transcript' and (cardinality(h.evidence_ids)=0 or h.evidence_ids && ids)))) then continue;end if;
   select * into mark from public.review_bookmarks b where b.user_id=p_user and b.session_id=s.id and b.expression_key=k;
   seen:=array_append(seen,k);
   entries:=entries||jsonb_build_array(jsonb_build_object('key',k,'expression',coalesce(e->>'improved',e->>'expression'),
    'kind',case when e ? 'improved' then case when e->>'category'='error' then 'error' else 'alternative' end else 'reusable' end,
    'original',coalesce(e->>'original',''),'meaning',coalesce(e->>'meaning',''),'reason',coalesce(e->>'reason',''),
    'evidence_ids',to_jsonb(ids),'saved',coalesce(mark.saved,false),'bookmark_revision',coalesce(mark.revision,0)));
  end loop;
  for e in select value from jsonb_array_elements(coalesce(a.content->'strengths','[]')) loop
   if jsonb_typeof(e->'evidence_ids') is distinct from 'array' or jsonb_array_length(e->'evidence_ids') not between 1 and 12 then continue;end if;
   if exists(select 1 from jsonb_array_elements_text(e->'evidence_ids') x where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then continue;end if;
   select array_agg(x::uuid) into ids from jsonb_array_elements_text(e->'evidence_ids') x;
   if exists(select 1 from unnest(ids) x left join public.transcript_events t on t.id=x where t.id is null or t.user_id<>p_user or t.session_id<>s.id or t.speaker<>'user')
    or exists(select 1 from public.learning_source_holds h where h.user_id=p_user and h.session_id=s.id and h.reason='wrong_transcript' and (cardinality(h.evidence_ids)=0 or h.evidence_ids && ids)) then continue;end if;
   strengths:=strengths||jsonb_build_array(e);
  end loop;
 end if;
 return jsonb_build_object('session',jsonb_build_object('id',s.id,'companion_id',s.companion_id,'created_at',s.created_at,'ended_at',s.ended_at,'time_zone',s.time_zone,'status',s.status,'record_incomplete',s.record_incomplete,'scenario',s.scenario),
  'analysis_id',case when eligible then a.id else null end,'status',phase,'summary',case when eligible then a.content->>'summary' else null end,'strengths',strengths,'expressions',entries);
end $$;

create function public.review_note(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not public.is_approved_user() or auth.uid() is null then raise exception 'Account not approved' using errcode='42501';end if;
 return loop_private.review_note(auth.uid(),p_session_id);
end $$;

create function public.review_journal(p_before timestamptz default null,p_before_id uuid default null,p_through date default null,p_time_zone text default 'UTC',p_saved boolean default false,p_limit integer default 12) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s record;note jsonb;calls jsonb:='[]';cursor jsonb:=null;n integer:=0;
begin
 if not public.is_approved_user() or auth.uid() is null then raise exception 'Account not approved' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 20 or p_saved is null or (p_before is null)<>(p_before_id is null)
 or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_time_zone) then raise exception 'Invalid review pagination';end if;
 for s in select c.* from public.sessions c where c.user_id=auth.uid() and c.status='ended'
 and (p_before is null or (c.created_at,c.id)<(p_before,p_before_id))
 and (p_through is null or (c.created_at at time zone case when exists(select 1 from pg_catalog.pg_timezone_names where name=c.time_zone) then c.time_zone else p_time_zone end)::date<=p_through)
 and (not p_saved or exists(select 1 from public.review_bookmarks b where b.user_id=auth.uid() and b.session_id=c.id and b.saved))
 order by c.created_at desc,c.id desc limit p_limit+1 loop
  if n=p_limit then exit;end if;n:=n+1;
  note:=loop_private.review_note(auth.uid(),s.id);
  if p_saved then note:=jsonb_set(note,'{expressions}',coalesce((select jsonb_agg(x) from jsonb_array_elements(note->'expressions') x where (x->>'saved')::boolean),'[]'));end if;
  calls:=calls||jsonb_build_array(note);
  cursor:=jsonb_build_object('before',s.created_at,'before_id',s.id);
 end loop;
 if not exists(select 1 from public.sessions c where c.user_id=auth.uid() and c.status='ended' and (c.created_at,c.id)<((cursor->>'before')::timestamptz,(cursor->>'before_id')::uuid)
 and (p_through is null or (c.created_at at time zone case when exists(select 1 from pg_catalog.pg_timezone_names where name=c.time_zone) then c.time_zone else p_time_zone end)::date<=p_through)
 and (not p_saved or exists(select 1 from public.review_bookmarks b where b.user_id=auth.uid() and b.session_id=c.id and b.saved))) then cursor:=null;end if;
 return jsonb_build_object('calls',calls,'next',cursor);
end $$;

create function public.review_bookmark(p_session_id uuid,p_expression_key text,p_saved boolean,p_expected_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare note jsonb;entry jsonb;b public.review_bookmarks%rowtype;
begin
 if not public.is_approved_user() or auth.uid() is null then raise exception 'Account not approved' using errcode='42501';end if;
 if p_saved is null or p_expected_revision is null or p_expected_revision<0 then raise exception 'Invalid bookmark';end if;
 -- Lock session first, as transcript append does. A changed source cannot be
 -- bookmarked between validation and publication. Concurrent tabs use CAS.
 perform 1 from public.sessions where id=p_session_id and user_id=auth.uid() for update;
 if not found then raise exception 'Session not found' using errcode='42501';end if;
 note:=loop_private.review_note(auth.uid(),p_session_id);
 select x into entry from jsonb_array_elements(note->'expressions') x where x->>'key'=p_expression_key;
 if entry is null then raise exception 'Expression is no longer available' using errcode='40001';end if;
 select * into b from public.review_bookmarks where user_id=auth.uid() and session_id=p_session_id and expression_key=p_expression_key for update;
 if coalesce(b.revision,0)<>p_expected_revision then
  if b.saved is not distinct from p_saved then return jsonb_build_object('saved',b.saved,'revision',b.revision);end if;
  raise exception 'Bookmark changed; reload before retrying' using errcode='40001';
 end if;
 insert into public.review_bookmarks(user_id,session_id,expression_key,saved) values(auth.uid(),p_session_id,p_expression_key,p_saved)
 on conflict(user_id,session_id,expression_key) do update set saved=excluded.saved,revision=public.review_bookmarks.revision+1,updated_at=now() returning * into b;
 return jsonb_build_object('saved',b.saved,'revision',b.revision);
end $$;
-- Backup restores pointers only. They cannot supply phrases, evidence or
-- mastery, and never overwrite a later explicit save/unsave choice.
create function public.review_bookmarks_restore(p_bookmarks jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare entry jsonb;sid uuid;k text;total integer:=0;added integer;
begin
 if not public.is_approved_user() or auth.uid() is null then raise exception 'Account not approved' using errcode='42501';end if;
 if jsonb_typeof(p_bookmarks) is distinct from 'array' or jsonb_array_length(p_bookmarks)>200 then raise exception 'Invalid bookmark backup';end if;
 for entry in select value from jsonb_array_elements(p_bookmarks) loop
  if entry->>'session_id' is null or entry->>'session_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(entry->'expression_key') is distinct from 'string' or length(btrim(entry->>'expression_key')) not between 1 and 3000
   or jsonb_typeof(entry->'saved') is distinct from 'boolean' then raise exception 'Invalid bookmark backup';end if;
  sid:=(entry->>'session_id')::uuid;k:=entry->>'expression_key';
  if not exists(select 1 from public.sessions where id=sid and user_id=auth.uid()) then raise exception 'Session not found' using errcode='42501';end if;
  if not (entry->>'saved')::boolean then continue;end if;
  insert into public.review_bookmarks(user_id,session_id,expression_key,saved) values(auth.uid(),sid,k,true) on conflict do nothing;
  get diagnostics added=row_count;total:=total+added;
 end loop;
 return total;
end $$;
revoke all on function loop_private.review_note(uuid,uuid) from public,anon,authenticated;
revoke all on function public.review_note(uuid),public.review_journal(timestamptz,uuid,date,text,boolean,integer),public.review_bookmark(uuid,text,boolean,integer),public.review_bookmarks_restore(jsonb) from public,anon;
grant execute on function public.review_note(uuid),public.review_journal(timestamptz,uuid,date,text,boolean,integer),public.review_bookmark(uuid,text,boolean,integer),public.review_bookmarks_restore(jsonb) to authenticated;
notify pgrst,'reload schema';
