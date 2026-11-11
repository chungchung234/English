-- Extend review projection without rewriting deployed migrations or older notes.
create function loop_private.review_learning(v jsonb,ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if jsonb_typeof(v) is distinct from 'object'
 or coalesce(v->>'focus','') not in('lexical','grammar','pattern','pragmatics','interaction','discourse')
 or coalesce(v->>'form','') not in('general','collocation','phrasal_verb','idiom','colloquial','slang','reduction')
 or coalesce(v->>'register','') not in('unspecified','neutral','informal','formal')
 or jsonb_typeof(v->'source_is_question') is distinct from 'boolean'
 or jsonb_typeof(v->'source_quote') is distinct from 'string' or length(v->>'source_quote')>1000
 or jsonb_typeof(v->'usage') is distinct from 'string' or length(v->>'usage')>500
 or jsonb_typeof(v->'alternative') is distinct from 'string' or length(v->>'alternative')>300
 or jsonb_typeof(v->'example') is distinct from 'object'
 or jsonb_typeof(v->'example'->'prompt') is distinct from 'string' or length(v->'example'->>'prompt')>300
 or jsonb_typeof(v->'example'->'response') is distinct from 'string' or length(v->'example'->>'response')>300
 or ((length(btrim(v->'example'->>'prompt'))>0)<>(length(btrim(v->'example'->>'response'))>0)) then return '{}';end if;
 if (v->>'source_is_question')::boolean and length(btrim(v->>'source_quote'))=0 then return '{}';end if;
 if length(v->>'source_quote')>0 and not exists(select 1 from public.transcript_events t where t.id=any(ids) and t.speaker='user' and strpos(t.text,v->>'source_quote')>0) then return '{}';end if;
 return jsonb_build_object('focus',v->>'focus','form',v->>'form','source_quote',v->>'source_quote','source_is_question',v->'source_is_question',
  'usage',v->>'usage','register',v->>'register','example',jsonb_build_object('prompt',v->'example'->>'prompt','response',v->'example'->>'response'),'alternative',v->>'alternative');
end $$;
revoke all on function loop_private.review_learning(jsonb,uuid[]) from public,anon,authenticated;

create or replace function loop_private.review_note(p_user uuid,p_session uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.sessions%rowtype;a public.analyses%rowtype;f public.learning_feedback%rowtype;
 e jsonb;entries jsonb:='[]';strengths jsonb:='[]';seen text[]:='{}';
 k text;ids uuid[];item public.learning_state_items%rowtype;mark public.review_bookmarks%rowtype;
 eligible boolean;phase text;digest text;learning jsonb;
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
   coalesce(a.content->'corrections','[]') || coalesce((select jsonb_agg(x || jsonb_build_object('_review_kind','reusable')) from jsonb_array_elements(coalesce(a.content->'practice','[]')) x),'[]') ||
   coalesce((select jsonb_agg(x || jsonb_build_object('_review_kind','positive','original',x->>'expression','reason',x->>'text')) from jsonb_array_elements(coalesce(a.content->'strengths','[]')) x where length(btrim(coalesce(x->>'expression','')))>0),'[]') ||
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
   learning:=loop_private.review_learning(e->'learning',ids);
   seen:=array_append(seen,k);
   entries:=entries||jsonb_build_array(jsonb_build_object('key',k,'expression',coalesce(e->>'improved',e->>'expression'),
    'kind',case when e->>'_review_kind'='positive' then 'positive' when e ? 'improved' then case when e->>'category'='error' then 'error' else 'alternative' end else 'reusable' end,
    'original',coalesce(e->>'original',''),'meaning',coalesce(e->>'meaning',''),'reason',coalesce(e->>'reason',''),
    'learning',learning,'evidence_ids',to_jsonb(ids),'saved',coalesce(mark.saved,false),'bookmark_revision',coalesce(mark.revision,0)));
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

revoke all on function loop_private.review_note(uuid,uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
