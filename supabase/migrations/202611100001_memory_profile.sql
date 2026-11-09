-- Keep a small factual profile independently of relevance-ranked search hits.
-- No second copy of user data: latest validated analyses are the source of truth.
alter function public.memory_search(uuid,text,integer,text) rename to memory_search_hits;
revoke all on function public.memory_search_hits(uuid,text,integer,text) from public, anon, authenticated;

create function public.memory_search(
  p_user_id uuid, p_query text, p_limit integer default 12,
  p_companion_id text default 'alex'
) returns setof public.analyses language plpgsql security definer set search_path = '' as $$
declare v_profile jsonb;
begin
  if p_user_id is null or p_companion_id not in ('mia','alex','juno') then
    raise exception 'Invalid memory search' using errcode = '22023';
  end if;
  with latest as materialized (
    select distinct on (a.session_id) a.* from public.analyses a
    join public.sessions s on s.id = a.session_id and s.user_id = a.user_id
    where a.user_id = p_user_id and a.kind = 'session' and s.companion_id = p_companion_id
    order by a.session_id, a.created_at desc, a.id desc
  ), facts as (
    select f.item, a.id analysis_id, a.session_id, max(e.timestamp) spoken_at
    from latest a
    cross join lateral jsonb_array_elements(case when jsonb_typeof(a.content->'memory_facts') = 'array' then a.content->'memory_facts' else '[]'::jsonb end) f(item)
    join public.transcript_events e on e.user_id = p_user_id and e.session_id = a.session_id
      and e.speaker = 'user' and e.id = any(a.source_event_ids)
      and (f.item->'evidence_ids') ? e.id::text
      and position(f.item->>'quote' in e.text) > 0
    where f.item->>'key' in ('name','occupation','location','goal','interest','preference')
      and jsonb_typeof(f.item->'value') = 'string' and char_length(f.item->>'value') <= 240
    group by f.item, a.id, a.session_id
  ), slots as (
    select distinct on (item->>'key') * from facts
    order by item->>'key', spoken_at desc, analysis_id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object('key',item->>'key','value',item->>'value',
    'quote',item->>'quote','evidence_ids',item->'evidence_ids','session_id',session_id,'spoken_at',spoken_at)
    order by item->>'key'), '[]'::jsonb)
  into v_profile from slots where item->>'value' <> '';

  return query select populated.*
  from public.memory_search_hits(p_user_id,p_query,p_limit,p_companion_id) a
  cross join lateral jsonb_populate_record(null::public.analyses,
    to_jsonb(a) || jsonb_build_object('content',a.content || jsonb_build_object('memory_profile',v_profile))) populated;
end;
$$;
revoke all on function public.memory_search(uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.memory_search(uuid,text,integer,text) to service_role;
