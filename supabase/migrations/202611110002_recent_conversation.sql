-- A failed post-call analysis must not erase the previous conversation from
-- the next call. Only a bounded excerpt of an eligible, completed same-scope
-- conversation is exposed; existing privacy suppression remains authoritative.
create function loop_private.recent_conversation(p_user_id uuid,p_companion_id text)
returns jsonb language sql stable security definer set search_path='' as $$
 with previous as (
  select s.* from public.sessions s
  where s.user_id=p_user_id and s.companion_id=p_companion_id and s.status='ended' and not s.record_incomplete
   and s.created_at<=now() and s.ended_at<=now()
   and exists(select 1 from public.transcript_events e where e.user_id=p_user_id and e.session_id=s.id and e.speaker='user')
   and not exists(select 1 from public.memory_session_exclusions x where x.user_id=p_user_id and x.companion_id=p_companion_id and x.session_id=s.id)
   and not exists(select 1 from public.memory_state m where m.user_id=p_user_id and m.companion_id=p_companion_id and s.created_at<=m.history_cutoff)
   and not exists(select 1 from public.learning_source_holds h where h.user_id=p_user_id and h.session_id=s.id)
   and not exists(select 1 from public.learning_sources src join public.learning_state_items i on i.id=src.item_id where src.user_id=p_user_id and src.session_id=s.id and i.status='excluded')
  order by s.created_at desc,s.id desc limit 1
 ), latest_analysis as (
  select a.* from public.analyses a join previous p on p.id=a.session_id
  where a.user_id=p_user_id and a.kind='session' order by a.created_at desc,a.id desc limit 1
 )
 select jsonb_build_object('session_id',p.id,'session_created_at',p.created_at,'session_ended_at',p.ended_at,'session_time_zone',p.time_zone,
  'analysis_status',case when a.id is not null then 'ready' when j.state='failed' then 'failed' when j.state='running' then 'pending' else 'unavailable' end,
  'summary',case when a.id is not null then left(a.content->>'summary',1000) else null end,
  'turns',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'speaker',e.speaker,'text',left(e.text,500),'timestamp',e.timestamp) order by e.timestamp,e.id),'[]'::jsonb)
    from (select t.* from public.transcript_events t where t.user_id=p_user_id and t.session_id=p.id order by t.timestamp desc,t.id desc limit 12)e))
 from previous p left join latest_analysis a on true
 left join lateral(select state from public.analysis_jobs where user_id=p_user_id and session_id=p.id and kind='session' order by updated_at desc,id desc limit 1)j on true
$$;
revoke all on function loop_private.recent_conversation(uuid,text) from public,anon,authenticated,service_role;

create or replace function public.memory_context(p_user_id uuid,p_companion_id text,p_query text default '',p_embedding real[] default null,p_embedding_model text default 'text-embedding-3-small',p_limit integer default 12) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_hybrid boolean:=false; v_query tsquery; v_revision bigint; v_limited boolean;
begin
 perform loop_private.memory_guard(p_user_id,p_companion_id);
 if p_limit is null or p_limit<1 or char_length(coalesce(p_query,''))>2000 or p_embedding_model is null or char_length(p_embedding_model) not between 1 and 200 then raise exception 'Invalid memory query' using errcode='22023'; end if;
 if p_embedding is not null and not loop_private.memory_vector_valid(p_embedding) then raise exception 'Invalid memory vector' using errcode='22023'; end if;
 v_query:=websearch_to_tsquery('simple'::regconfig,coalesce(p_query,''));
 select coalesce((select revision from public.memory_state where user_id=p_user_id and companion_id=p_companion_id),0) into v_revision;
 with eligible as materialized(
  select a.*,s.created_at as conversation_created_at
  from loop_private.memory_eligible(p_user_id,p_companion_id) a
  join public.sessions s on s.id=a.session_id and s.user_id=a.user_id and s.companion_id=p_companion_id
 ), bounded as materialized(select * from eligible order by conversation_created_at desc,session_id desc,id desc limit 2000),
 vectors as (
 select a.id, (select sum(x::double precision*y::double precision)/sqrt(sum(x::double precision*x::double precision)*sum(y::double precision*y::double precision)) from unnest(e.embedding,p_embedding) z(x,y)) similarity
 from bounded a join public.memory_embeddings e on e.analysis_id=a.id and e.model=p_embedding_model and e.content_hash=md5(loop_private.memory_document(a.content))
 where p_embedding is not null
 ), vrank as (select id,row_number() over(order by similarity desc,id) rank from vectors),
 krank as (select id,row_number() over(order by ts_rank_cd(to_tsvector('simple'::regconfig,loop_private.memory_document(content)),v_query) desc,id) rank from bounded where to_tsvector('simple'::regconfig,loop_private.memory_document(content))@@v_query),
 scored as (select a.*,coalesce(1.0/(60+v.rank),0)+coalesce(1.0/(60+k.rank),0) score from bounded a left join vrank v on v.id=a.id left join krank k on k.id=a.id),
 recent as(select id from bounded order by conversation_created_at desc,session_id desc,id desc limit least(4,greatest(0,least(p_limit,12)-1))),
 ranked as(select id from scored where id not in(select id from recent) order by score desc,conversation_created_at desc,session_id desc,id desc limit least(p_limit,12)-least(4,greatest(0,least(p_limit,12)-1))),
 chosen as(select * from scored where id in(select id from recent union all select id from ranked))
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'user_id',c.user_id,'session_id',c.session_id,'kind',c.kind,
  'model',c.model,'content',c.content,'source_event_ids',c.source_event_ids,
  'created_at',c.created_at,'session_created_at',s.created_at,
  'session_ended_at',s.ended_at,'session_time_zone',s.time_zone,
  'evidence',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'text',e.text,'timestamp',e.timestamp) order by e.timestamp,e.id),'[]'::jsonb)
    from (select t.id,left(t.text,500) as text,t.timestamp
      from public.transcript_events t
      where t.user_id=p_user_id and t.session_id=c.session_id
      and t.speaker='user' and t.id=any(c.source_event_ids)
      order by t.timestamp,t.id limit 6) e)
  ) order by c.score desc,c.conversation_created_at desc,c.session_id desc,c.id desc),'[]'::jsonb),
  exists(select 1 from vectors),(select count(*)>2000 from eligible)
 into v_result,v_hybrid,v_limited
 from chosen c join public.sessions s on s.id=c.session_id and s.user_id=c.user_id and s.companion_id=p_companion_id;
 return jsonb_build_object('revision',v_revision,'facts',loop_private.memory_facts(p_user_id,p_companion_id),'memories',v_result,'limited',v_limited,'retrieval',case when v_hybrid then 'hybrid' else 'keyword' end,'recent_conversation',case when (public.learning_voice_context(p_user_id,p_companion_id)->>'suppress_memory')::boolean then null else loop_private.recent_conversation(p_user_id,p_companion_id) end);
end; $$;
revoke all on function public.memory_context(uuid,text,text,real[],text,integer) from public,anon,authenticated;
grant execute on function public.memory_context(uuid,text,text,real[],text,integer) to service_role;
