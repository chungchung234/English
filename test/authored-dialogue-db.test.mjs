// The real PostgreSQL state machine, with synthetic text/PCM attestations only.
// SQL trusts service-side lexical verification; this never claims human hearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {renderVoiceInstructions} from '../supabase/functions/coach/index.ts';
import {buildOpeningContext} from '../supabase/functions/coach/opening-policy.ts';
import {companionProfile} from '../supabase/functions/coach/core.ts';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',hash='a'.repeat(64);
const sha=x=>createHash('sha256').update(x).digest('hex');
async function setup(t){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 for(const name of(await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
 await db.query("insert into auth.users values($1,'owner@example.com',now()),($2,'other@example.com',now())",[owner,other]);
 await db.exec("insert into loop_private.approved_emails values('owner@example.com'),('other@example.com')");return db;
}
async function role(db,name,work){await db.exec('set role '+name);try{return await work();}finally{await db.exec('reset role');}}
async function rpc(db,name,args){if(['authored_dialogue_begin','authored_dialogue_checkpoint'].includes(name)&&!Object.hasOwn(args,'p_source_event_digests'))args={...args,p_source_event_digests:(await db.query('select loop_private.authored_event_digests($1,$2,$3) result',[args.p_user_id,args.p_session_id,name==='authored_dialogue_begin'?[...args.p_history_ids,...args.p_current_user_ids]:args.p_covered_event_ids])).rows[0].result,...(name==='authored_dialogue_checkpoint'?{p_turn_nonce:randomUUID()}:{})};return role(db,'service_role',async()=>(await db.query('select public.'+name+'('+Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')+') result',Object.values(args))).rows[0].result);}
async function session(db,omitted=true){const s=(await db.query("insert into public.sessions(user_id,companion_id,scenario,time_zone) values($1,'alex','Natural English conversation about everyday life','Asia/Seoul') returning *",[owner])).rows[0];
 const c=await rpc(db,'authored_dialogue_context',{p_user_id:owner,p_session_id:s.id,p_omit_memory:omitted,p_call_epoch:1,p_reset:false});return{s,c};}
async function event(db,s,text='A crooked paper moon made me laugh.'){return(await db.query("insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,'user',$4,clock_timestamp()) returning *",[owner,s.id,randomUUID(),text])).rows[0];}
function context(c){return{companionId:'alex',scenario:'Natural English conversation about everyday life',memory:{facts:[],recent_conversation:null,conversation_memories:[],memories:[],suppress_memory:c.memory_mode==='omitted',shared_exchanges:[]},checkpoint:null};}
const opening={version:'opening-context-v2',purpose:'call_opening',current_utterance:null,role:'optional_conversation_context',context_kind:'none',prepared_topic:null,continuity:null,recent_openings:[],reason:'suppressed'};
function beginArgs(x,users=[],history=[],extra={}){return{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:x.c.call_epoch,p_authority_generation:x.c.authority_generation,p_expected_generation:x.c.turn_generation,p_turn_nonce:randomUUID(),p_purpose:users.length?'reply':'startup',p_current_user_ids:users,p_history_ids:history,p_expected_memory_revision:x.c.memory_revision,p_playback_epoch:x.c.turn_generation+1,p_context:context(x.c),p_opening:users.length?null:opening,p_policy_fingerprint:hash,p_hint:null,p_pending_playbacks:[],p_checkpoint_covered_ids:[],p_speech_speed:.85,...extra};}
const tuple=t=>({p_user_id:owner,p_turn_id:t.id,p_call_epoch:t.call_epoch,p_authority_generation:t.authority_generation,p_turn_generation:t.turn_generation});
async function reserve(db,x,kind){return rpc(db,'reserve_run',{p_user_id:owner,p_kind:kind,p_request_key:randomUUID(),p_session_id:x.s.id,p_lease_seconds:120});}
async function complete(db,x,begun,text='I would stay for a small object with a story.'){
 const run=await reserve(db,x,'dialogue');assert(run.reserved);
 await rpc(db,'reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'gpt-6-luna',p_policy:{synthetic:true},p_reserved_usd:.000001});
 await rpc(db,'record_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_usage:{test:true},p_estimated_usd:.000001,p_outcome:'generated'});
 const output=[{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text,annotations:[]}]}];
 const result=await rpc(db,'authored_dialogue_complete_text',{...tuple(begun.turn),p_job_id:run.job_id,p_lease_token:run.lease_token,p_text:text,p_opaque_output:null});
 assert.equal(result.turn.written_text_sha256,sha(text));assert.equal(result.assistant_event.text,text);return result;
}
async function publish(db,x,completed){
 const run=await reserve(db,x,'dialogue_synthesis');assert(run.reserved);
 const ready=await rpc(db,'authored_dialogue_synthesis_begin',{...tuple(completed.turn),p_playback_epoch:completed.turn.playback_epoch,p_job_id:run.job_id,p_lease_token:run.lease_token,p_settings:{model:'gpt-realtime-2.1-mini',verification_policy:'lexical-fidelity-v1'}});
 assert.equal(ready.voice,'cedar');assert.equal(Number(ready.speed),.85);assert.equal(ready.settings.approved_text_sha256,sha(completed.assistant_event.text));
 await rpc(db,'reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'gpt-realtime-2.1-mini',p_policy:{synthetic:true},p_reserved_usd:.000001});
 await rpc(db,'record_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_usage:{test:true},p_estimated_usd:.000001,p_outcome:'generated_audio'});
 const result=await rpc(db,'authored_dialogue_publish',{...tuple(ready.turn),p_playback_epoch:ready.turn.playback_epoch,p_job_id:run.job_id,p_lease_token:run.lease_token,p_transcript:ready.text,p_audio_sha256:'b'.repeat(64),p_audio_bytes:4800,p_audio_frames:2400,p_pcm_rate:24000,p_settings:ready.settings});assert.equal(result.published,true);return ready;
}
function playbackArgs(t,users=[]){return{...tuple(t),p_playback_epoch:t.playback_epoch,p_receipt_id:t.assistant_event_id,p_qualified_user_ids:users,p_assistant_event_id:t.assistant_event_id,p_expected_memory_revision:t.memory_revision,p_companion_id:t.companion_id};}


function realContext(x,memory={},scenario=x.s.scenario){
 const session=JSON.parse(JSON.stringify({...x.s,scenario}));
 const defaults={companionId:'alex',revision:x.c.memory_revision??0,facts:[],memories:[],recent_conversation:null,conversation_memories:[],shared_exchanges:[],suppress_memory:x.c.memory_mode==='omitted',retrieval:'omitted'};
 const rendered=renderVoiceInstructions(companionProfile('alex'),session,{...defaults,...memory});
 return JSON.parse(rendered.split('UNTRUSTED_CONTEXT_JSON:\n').at(-1));
}
const historyArgs=(x,users=[],history=[])=>({p_user_id:owner,p_session_id:x.s.id,p_call_epoch:x.c.call_epoch,p_authority_generation:x.c.authority_generation,p_expected_generation:x.c.turn_generation,p_current_user_ids:users,p_history_ids:history,p_expected_memory_revision:x.c.memory_revision});
const batchReport=(turn,users=[])=>({turn_id:turn.id,turn_generation:turn.turn_generation,playback_epoch:turn.playback_epoch,receipt_id:turn.assistant_event_id,qualified_user_ids:users,call_epoch:turn.call_epoch,authority_generation:turn.authority_generation,assistant_event_id:turn.assistant_event_id,expected_memory_revision:turn.memory_revision,companion_id:turn.companion_id});

test('authored dialogue SQL enforces source, playback, authority and independent stage budgets',async t=>{
 const db=await setup(t);
 await t.test('service RPCs and state tables are denied to browser roles',async()=>{
  const x=await session(db);
  for(const name of['anon','authenticated'])await role(db,name,async()=>{
   for(const table of['authored_dialogue_authority','authored_dialogue_calls','authored_dialogue_turns','authored_dialogue_cancellations'])await assert.rejects(db.query('select * from public.'+table),/permission denied/);
   await assert.rejects(db.query('select public.authored_dialogue_context($1,$2,true,1,false)',[owner,x.s.id]),/permission denied/);
  });
  await assert.rejects(rpc(db,'authored_dialogue_context',{p_user_id:other,p_session_id:x.s.id,p_omit_memory:true,p_call_epoch:1,p_reset:false}),/SESSION_ENDED/);
 });
 await t.test('cancel-before-begin persists a tombstone and forbids late resurrection',async()=>{
  const x=await session(db),args=beginArgs(x);
  const ack=await rpc(db,'authored_dialogue_cancel',{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:x.c.authority_generation,p_turn_nonce:args.p_turn_nonce,p_turn_generation:null});assert.equal(ack.cancelled,true);
  await assert.rejects(rpc(db,'authored_dialogue_begin',args),/DIALOGUE_CANCELLED/);
  const good=await rpc(db,'authored_dialogue_begin',beginArgs(x));assert.equal(good.turn.turn_generation,1);
 });
 await t.test('raw user speech, written assistant text, and played history remain separate',async()=>{
  const x=await session(db),u=await event(db,x.s),args=beginArgs(x,[u.id]);
  const first=await rpc(db,'authored_dialogue_begin',args);x.c.turn_generation=1;
  await assert.rejects(rpc(db,'authored_dialogue_begin',{...args,p_current_user_ids:[],p_purpose:'startup',p_opening:opening}),/NONCE_CHANGED/);
  const completed=await complete(db,x,first);await publish(db,x,completed);
  await assert.rejects(rpc(db,'authored_dialogue_begin',beginArgs(x,[],[u.id,completed.assistant_event.id])),/UNPLAYED_HISTORY/);
  const ack=await rpc(db,'authored_dialogue_playback',playbackArgs(completed.turn,[u.id]));assert.equal(ack.status,'recorded');
  const next=await rpc(db,'authored_dialogue_begin',beginArgs(x,[],[u.id,completed.assistant_event.id]));assert.equal(next.turn.turn_generation,2);
  // Startup and normal instruction contexts differ, so opaque replay must not
  // cross that developer-context boundary merely because the assistant played.
  assert.deepEqual(next.opaque_history,{});
 });
 await t.test('cancelled text cannot publish or enter accepted history',async()=>{
  const x=await session(db),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id]));x.c.turn_generation=1;
  const c=await complete(db,x,b);await rpc(db,'authored_dialogue_cancel',{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_turn_nonce:b.turn.turn_nonce,p_turn_generation:1});
  await assert.rejects(publish(db,x,c),/CANCELLED/);
  await assert.rejects(rpc(db,'authored_dialogue_begin',beginArgs(x,[],[u.id,c.assistant_event.id])),/UNPLAYED_HISTORY/);
 });
 await t.test('late exact playback works after a newer generation, but cannot change owner or payload',async()=>{
  const x=await session(db),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id]));x.c.turn_generation=1;const c=await complete(db,x,b);await publish(db,x,c);
  const u2=await event(db,x.s,'I mean the paper moon.'),newer=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u2.id],[u.id]));assert.equal(newer.turn.turn_generation,2);
  const a=playbackArgs(c.turn,[u.id]);assert.equal((await rpc(db,'authored_dialogue_playback',a)).status,'recorded');
  assert.equal((await rpc(db,'authored_dialogue_playback',a)).status,'recorded');
  await assert.rejects(rpc(db,'authored_dialogue_playback',{...a,p_qualified_user_ids:[]}),/PLAYBACK_CHANGED/);
  await assert.rejects(rpc(db,'authored_dialogue_playback',{...a,p_assistant_event_id:randomUUID()}),/OWNER_CHANGED/);
 });
 await t.test('source edits and privacy recovery cannot revive old raw assistant content',async()=>{
  const x=await session(db),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id]));x.c.turn_generation=1;const c=await complete(db,x,b);
  await db.query('update public.transcript_events set text=$1 where id=$2',['A different source now.',u.id]);
  await assert.rejects(publish(db,x,c),/SOURCE_CHANGED/);
  assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='authored_dialogue_turns' and column_name like 'opaque%'")).rows[0].n,0,'provider reasoning is never persisted');
  const fresh=await rpc(db,'authored_dialogue_context',{p_user_id:owner,p_session_id:x.s.id,p_omit_memory:true,p_call_epoch:1,p_reset:true});assert.equal(fresh.authority_generation,2);
  x.c=fresh;await assert.rejects(rpc(db,'authored_dialogue_begin',beginArgs(x,[],[u.id,c.assistant_event.id])),/RETIRED_HISTORY/);
  assert.equal((await db.query('select text from public.transcript_events where id=$1',[c.assistant_event.id])).rows[0].text,c.assistant_event.text,'raw transcript remains truthful');
 });
 await t.test('legitimate contiguous middle quotes pass, paraphrases and foreign IDs fail',async()=>{
  const x=await session(db),u=await event(db,x.s,'Before this: the paper moon was crooked. After this.');
  const q={id:u.id,speaker:'user',text:'the paper moon was crooked.',timestamp:u.timestamp};
  await db.query("select loop_private.authored_quote($1,$2,$3::jsonb,'user','text')",[owner,x.s.id,JSON.stringify(q)]);
  await assert.rejects(db.query("select loop_private.authored_quote($1,$2,$3::jsonb,'user','text')",[owner,x.s.id,JSON.stringify({...q,text:'the paper moon was uneven.'})]),/INVALID_QUOTE/);
  await assert.rejects(db.query("select loop_private.authored_quote($1,$2,$3::jsonb,'user','text')",[other,x.s.id,JSON.stringify(q)]),/INVALID_QUOTE/);
 });
 await t.test('pre-provider history admission and batch playback are atomic',async()=>{
  const x=await session(db),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id]));x.c.turn_generation=1;const c=await complete(db,x,b);await publish(db,x,c);
  await assert.rejects(rpc(db,'authored_dialogue_history',historyArgs(x,[],[u.id,c.assistant_event.id])),/UNPLAYED_HISTORY/);
  const report=batchReport(c.turn,[u.id]);
  await assert.rejects(rpc(db,'authored_dialogue_batchplaybacks',{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_reports:[report,{...report,assistant_event_id:randomUUID()}]}),/OWNER_CHANGED/);
  assert.equal((await db.query('select status from public.authored_dialogue_turns where id=$1',[c.turn.id])).rows[0].status,'published','later malformed report rolls back earlier admission');
  const ack=await rpc(db,'authored_dialogue_batchplaybacks',{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_reports:[report]});assert.equal(ack.processed,1);
  const admitted=await rpc(db,'authored_dialogue_history',historyArgs(x,[],[u.id,c.assistant_event.id]));assert.deepEqual(admitted.history_ids,[u.id,c.assistant_event.id]);
 });
 await t.test('actual production renderer agrees with ordinary, omitted and canonical prepared scenarios',async()=>{
  for(const [omitted,scenario] of[[false,'Natural English conversation about everyday life'],[false,'User-prepared conversation:   The paper moon  '],[true,'User-prepared conversation: The paper moon']]){
   const x=await session(db,omitted);await db.query('update public.sessions set scenario=$1 where id=$2',[scenario,x.s.id]);x.s.scenario=scenario;
   const actual=realContext(x,{},omitted?'':scenario),u=await event(db,x.s);
   const b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id],[],{p_context:actual}));assert.equal(b.turn.status,'reserved');
   assert.equal(actual.scenario,omitted?'Natural English conversation about everyday life':scenario.startsWith('User-prepared')?'User-prepared conversation: The paper moon':scenario);
  }
 });
 await t.test('included strong playback produces source-backed shared memory and unrelated sources do not invalidate it',async()=>{
  const old=await session(db,false),u=await event(db,old.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(old,[u.id],[],{p_context:realContext(old)}));old.c.turn_generation=1;const c=await complete(db,old,b);await publish(db,old,c);
  await rpc(db,'authored_dialogue_playback',playbackArgs(c.turn,[u.id]));await db.query("update public.sessions set status='ended',ended_at=clock_timestamp() where id=$1",[old.s.id]);
  const exchanges=await rpc(db,'conversation_exchange_context',{p_user_id:owner,p_companion_id:'alex'});assert(exchanges.exchanges.some(e=>e.source_session_id===old.s.id));
  const x=await session(db,false),actual=realContext(x,{shared_exchanges:exchanges.exchanges,revision:x.c.memory_revision});assert(actual.memory.shared_exchanges?.length);
  const nu=await event(db,x.s),first=await rpc(db,'authored_dialogue_begin',beginArgs(x,[nu.id],[],{p_context:actual}));
  const unrelated=await session(db,false);await event(db,unrelated.s,'A wholly unrelated topic.');await db.query("update public.sessions set status='ended',ended_at=clock_timestamp() where id=$1",[unrelated.s.id]);
  const written=await complete(db,x,first);assert.equal(written.turn.status,'text_complete','new unused history is not a source mutation of the selected exchange');
  await db.query('update public.transcript_events set text=$1 where id=$2',['Edited historical caller source.',u.id]);
  await assert.rejects(publish(db,x,written),/SOURCE_CHANGED/);
 });
 await t.test('actual handoff projection accepts exact middle quotations and rejects altered history',async()=>{
  const old=await session(db,false),u=await event(db,old.s,'Before this: the paper moon was crooked. After this.');await db.query("update public.sessions set status='ended',ended_at=clock_timestamp() where id=$1",[old.s.id]);
  const content={threads:[{note:'The paper moon was crooked.',state:'stated',when:null,follow_up:null,quote:'the paper moon was crooked.',evidence_ids:[u.id]}]};
  await db.query("insert into public.conversation_memories(user_id,session_id,companion_id,revision,source_version,policy,model,content) values($1,$2,'alex',0,public.learning_transcript_digest($2),'synthetic','synthetic',$3)",[owner,old.s.id,JSON.stringify(content)]);
  const payload=(await db.query('select loop_private.conversation_payload(id) payload from public.conversation_memories where session_id=$1',[old.s.id])).rows[0].payload;
  const x=await session(db,false),actual=realContext(x,{recent_conversation:payload});assert.equal(actual.memory.recent_conversation.turns[0].text,'the paper moon was crooked.');
  const nu=await event(db,x.s);assert.equal((await rpc(db,'authored_dialogue_begin',beginArgs(x,[nu.id],[],{p_context:actual}))).turn.status,'reserved');
  const z=await session(db,false),clock={server_now_utc:new Date().toISOString(),time_zone:'Asia/Seoul',session_created_at:new Date(z.s.created_at).toISOString()};
  const op=buildOpeningContext({context:actual,clock,exchangeRevision:0});assert(op.continuity,'real opening context retains the source-backed middle quote');
  assert.equal((await rpc(db,'authored_dialogue_begin',beginArgs(z,[],[],{p_context:actual,p_opening:op}))).turn.status,'reserved');
  const y=await session(db,false),bad=structuredClone(actual);bad.memory.recent_conversation.turns[0].text='the paper moon was uneven.';const yu=await event(db,y.s);
  await assert.rejects(rpc(db,'authored_dialogue_begin',beginArgs(y,[yu.id],[],{p_context:bad})),/INVALID_QUOTE/);
 });
 await t.test('checkpoint is source-bound and stale summaries are retired before provider use',async()=>{
  const x=await session(db),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id]));x.c.turn_generation=1;const c=await complete(db,x,b);await publish(db,x,c);await rpc(db,'authored_dialogue_playback',playbackArgs(c.turn,[u.id]));
  const args={p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_expected_generation:1,p_covered_event_ids:[u.id,c.assistant_event.id],p_summary:'They discussed the paper moon, with the caller undecided.',p_expected_memory_revision:null,p_policy_fingerprint:hash};
  const saved=await rpc(db,'authored_dialogue_checkpoint',args);assert.deepEqual(saved.checkpoint.covered_ids,[u.id,c.assistant_event.id]);
  await db.query('update public.transcript_events set text=$1 where id=$2',['Changed user evidence.',u.id]);
  const fresh=await rpc(db,'authored_dialogue_context',{p_user_id:owner,p_session_id:x.s.id,p_omit_memory:true,p_call_epoch:1,p_reset:false});assert.equal(fresh.checkpoint,null);assert.equal(fresh.authority_generation,2);
  await assert.rejects(rpc(db,'authored_dialogue_history',historyArgs(x,[],[u.id,c.assistant_event.id])),/STALE_AUTHORITY/);
 });
 await t.test('missing receipt sources terminate exactly and wrong scope stays denied',async()=>{
  const x=await session(db),b=await rpc(db,'authored_dialogue_begin',beginArgs(x));
  const args={p_user_id:owner,p_session_id:x.s.id,p_turn_id:b.turn.id,p_companion_id:'alex'};assert.deepEqual(await rpc(db,'authored_dialogue_receipt_source',args),{missing:false});
  await assert.rejects(rpc(db,'authored_dialogue_receipt_source',{...args,p_companion_id:'mia'}),/SCOPE_DENIED/);
  assert.deepEqual(await rpc(db,'authored_dialogue_receipt_source',{...args,p_turn_id:randomUUID()}),{missing:true,reason:'source_missing'});
  await db.query('delete from public.sessions where id=$1',[x.s.id]);assert.deepEqual(await rpc(db,'authored_dialogue_receipt_source',args),{missing:true,reason:'session_missing'});
 });
 await t.test('read-only state cannot change memory mode and rejects an early cancellation before models',async()=>{
  const x=await session(db),args=beginArgs(x),stateArgs={p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_expected_generation:0,p_expected_memory_revision:null,p_turn_nonce:args.p_turn_nonce};
  assert.equal((await rpc(db,'authored_dialogue_state',stateArgs)).memory_mode,'omitted');
  await assert.rejects(rpc(db,'authored_dialogue_state',{...stateArgs,p_expected_memory_revision:0}),/STALE_AUTHORITY/);
  assert.equal((await db.query('select memory_mode from public.authored_dialogue_calls where session_id=$1',[x.s.id])).rows[0].memory_mode,'omitted');
  await rpc(db,'authored_dialogue_cancel',{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_turn_nonce:args.p_turn_nonce,p_turn_generation:null});
  await assert.rejects(rpc(db,'authored_dialogue_state',stateArgs),/CANCELLED/);
 });
 await t.test('real projected manual and forgotten facts retain exact normalized timestamps',async()=>{
  await db.query("insert into public.memory_fact_overrides(user_id,companion_id,key,value) values($1,'alex','interest','Tea'),($1,'alex','name','') on conflict(user_id,companion_id,key) do update set value=excluded.value,updated_at=now()",[owner]);
  const x=await session(db,false),raw=await rpc(db,'memory_context',{p_user_id:owner,p_companion_id:'alex',p_query:'',p_embedding:null,p_embedding_model:'text-embedding-3-small',p_limit:12});
  const actual=realContext(x,{facts:raw.facts});assert.equal(actual.memory.facts.length,2);assert(actual.memory.facts.every(f=>typeof f.updated_at==='string'));
  const u=await event(db,x.s);assert.equal((await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id],[],{p_context:actual}))).turn.status,'reserved');
  await db.query("delete from public.memory_fact_overrides where user_id=$1 and companion_id='alex'",[owner]);
 });
 await t.test('writer completion requires a settled matching cost reservation',async()=>{
  const x=await session(db),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id])),run=await reserve(db,x,'dialogue');
  const args={...tuple(b.turn),p_job_id:run.job_id,p_lease_token:run.lease_token,p_text:'A source-backed reply.',p_opaque_output:null};
  await assert.rejects(rpc(db,'authored_dialogue_complete_text',args),/SPEND_UNSETTLED/);
  await rpc(db,'reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'gpt-6-luna',p_policy:{synthetic:true},p_reserved_usd:.000001});
  await assert.rejects(rpc(db,'authored_dialogue_complete_text',args),/SPEND_UNSETTLED/);
  await rpc(db,'record_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_usage:null,p_estimated_usd:null,p_outcome:'generated'});
  assert.equal((await rpc(db,'authored_dialogue_complete_text',args)).turn.status,'text_complete','unknown usage stays reserved but a real finalized generated outcome can complete');
 });
 await t.test('current-session CALL locks precede AUTHORITY locks in both refresh and publication guards',async()=>{
  for(const signature of['public.authored_dialogue_context(uuid,uuid,boolean,bigint,boolean)','loop_private.authored_lock_call(uuid,uuid,boolean)']){
   const definition=(await db.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;
   const callLock=definition.indexOf('from public.authored_dialogue_calls'),authorityLock=definition.indexOf('perform 1 from public.authored_dialogue_authority');
   assert(callLock>=0&&authorityLock>callLock,'consistent lock ordering prevents the identified refresh/publisher inversion');
  }
 });
 await t.test('many completed replies settle actual new-stage usage while unknown and legacy holds remain conservative',async()=>{
  const sid=(await db.query("insert into public.sessions(user_id,companion_id,scenario) values($1,'alex','Natural English conversation about everyday life') returning id",[other])).rows[0].id;
  async function spend(kind,amount,outcome,estimated,usage={input_tokens:20,output_tokens:40}){
   const run=await rpc(db,'reserve_run',{p_user_id:other,p_kind:kind,p_request_key:randomUUID(),p_session_id:kind==='weekly'?null:sid,p_lease_seconds:120});assert(run.reserved);
   const ok=await rpc(db,'reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'synthetic',p_policy:{synthetic:true},p_reserved_usd:amount});
   if(ok&&outcome)await rpc(db,'record_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_usage:usage,p_estimated_usd:estimated,p_outcome:outcome});return ok;
  }
  for(let n=0;n<20;n++)assert.equal(await spend('dialogue_synthesis',.09,'generated_audio',.002),true,'short completed audio uses actual cost rather than locking a whole worst-case hold forever');
  assert.equal(await spend('dialogue',.4,'transport_unknown',null,null),true);
  assert.equal(await spend('dialogue',.7,null,null),false,'unknown transport retains the full hold');
  assert.equal(await spend('dialogue_synthesis',.4,'generated_audio',0,{}),true);
  assert.equal(await spend('weekly',.1,'generated',.00001),true,'legacy kinds keep reserved-sum accounting');
  assert.equal(await spend('dialogue',.07,null,null),false,'malformed usage and legacy reservation are not treated as free');
  assert.equal(await spend('dialogue_synthesis',.02,'generated_audio',0,{input_tokens:20,output_tokens:0}),true);
  assert.equal(await spend('dialogue',.05,null,null),false,'zero-output audio usage retains a hold rather than qualifying as known free audio');
 });
 await t.test('edited assistant raw text cannot be blessed by a later playback receipt',async()=>{
  const x=await session(db,false),u=await event(db,x.s),b=await rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id]));x.c.turn_generation=1;const c=await complete(db,x,b);await publish(db,x,c);
  await db.query('update public.transcript_events set text=$1 where id=$2',['A changed assistant statement that was not the clip.',c.assistant_event.id]);
  const ack=await rpc(db,'authored_dialogue_playback',playbackArgs(c.turn,[u.id]));assert.equal(ack.status,'discarded');assert.equal(ack.reason,'source_changed');
  assert.equal((await db.query('select count(*)::int n from public.conversation_playback_receipts where event_id=$1',[c.assistant_event.id])).rows[0].n,0);
 });
 await t.test('an exact server snapshot is bound across prepare awaits and the final dispatch gate',async()=>{
  const x=await session(db),u=await event(db,x.s),admitted=await rpc(db,'authored_dialogue_history',historyArgs(x,[u.id],[]));
  assert.equal(admitted.events[0].text,u.text);assert.equal(typeof admitted.source_event_digests[u.id],'string');
  await db.query('update public.transcript_events set text=$1 where id=$2',['Changed between reading the snapshot and preparing the prompt.',u.id]);
  await assert.rejects(rpc(db,'authored_dialogue_begin',beginArgs(x,[u.id],[],{p_source_event_digests:admitted.source_event_digests})),/SOURCE_CHANGED/);
  const fresh=await rpc(db,'authored_dialogue_history',historyArgs(x,[u.id],[])),args=beginArgs(x,[u.id],[],{p_source_event_digests:fresh.source_event_digests}),b=await rpc(db,'authored_dialogue_begin',args);x.c.turn_generation=1;
  const run=await reserve(db,x,'dialogue'),dispatch={p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_expected_generation:1,p_expected_memory_revision:null,p_turn_nonce:b.turn.turn_nonce,p_turn_id:b.turn.id,p_stage:'dialogue',p_job_id:run.job_id,p_lease_token:run.lease_token,p_source_event_digests:fresh.source_event_digests};
  await assert.rejects(rpc(db,'authored_dialogue_dispatch',dispatch),/SPEND_UNSETTLED/);
  await rpc(db,'reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'gpt-6-luna',p_policy:{synthetic:true},p_reserved_usd:.000001});
  assert.equal(await rpc(db,'authored_dialogue_dispatch',dispatch),true);
  await rpc(db,'authored_dialogue_cancel',{p_user_id:owner,p_session_id:x.s.id,p_call_epoch:1,p_authority_generation:1,p_turn_nonce:b.turn.turn_nonce,p_turn_generation:1});
  await assert.rejects(rpc(db,'authored_dialogue_dispatch',dispatch),/CANCELLED/);
 });
 await t.test('new stage reservations are independent, uncertain failures stay spent and never auto-retry',async()=>{
  const x=await session(db),key=randomUUID(),a={p_user_id:owner,p_kind:'dialogue',p_request_key:key,p_session_id:x.s.id,p_lease_seconds:120};
  const run=await rpc(db,'reserve_run',a);assert(run.reserved);
  await rpc(db,'reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'gpt-6-luna',p_policy:{test:true},p_reserved_usd:.001});
  await rpc(db,'record_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_usage:null,p_estimated_usd:null,p_outcome:'transport_unknown'});
  await rpc(db,'fail_run',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_error:'TRANSPORT_UNKNOWN'});
  assert.equal((await rpc(db,'reserve_run',a)).reason,'retry_blocked');
  const spend=(await db.query('select outcome,estimated_usd,reserved_usd from public.model_spend where job_id=$1',[run.job_id])).rows[0];assert.equal(spend.outcome,'transport_unknown');assert.equal(spend.estimated_usd,null);assert.equal(Number(spend.reserved_usd),.001);
  const usage=(await db.query('select kind,reservations from public.api_daily_usage where user_id=$1',[owner])).rows;assert(!usage.some(x=>x.kind==='voice'),'dialogue does not consume connection budget');
 });
});
