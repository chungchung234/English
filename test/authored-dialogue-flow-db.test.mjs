// Product orchestration + named real PostgreSQL RPCs. Only the provider text
// and PCM are fabricated; this does not evaluate speech or conversational quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {handleAuthoredDialogue} from '../supabase/functions/coach/authored-dialogue.ts';
import {renderVoiceInstructions,renderOpeningInstructions} from '../supabase/functions/coach/index.ts';
import {companionProfile} from '../supabase/functions/coach/core.ts';
import {buildOpeningContext} from '../supabase/functions/coach/opening-policy.ts';

const user='bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa',protocol='authored_dialogue_v1';
const json=value=>JSON.parse(JSON.stringify(value));
async function setup(t){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to public;`);
 for(const name of(await readdir('supabase/migrations')).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
 await db.query("insert into auth.users values($1,'flow@example.com',now())",[user]);
 await db.exec("insert into loop_private.approved_emails values('flow@example.com')");return db;
}
async function rpc(db,name,body){
 await db.exec('set role service_role');
 try{return(await db.query('select public.'+name+'('+Object.keys(body).map((key,index)=>key+'=> $'+(index+1)).join(',')+') result',Object.values(body))).rows[0].result;}
 finally{await db.exec('reset role');}
}
async function fixture(db,options={}){
 const session=json((await db.query("insert into public.sessions(user_id,companion_id,scenario,time_zone) values($1,'alex','Natural English conversation about everyday life','Asia/Seoul') returning *",[user])).rows[0]);
 const calls=[],authors=[],readers=[],summaries=[];
 const config={AUTHORED_DIALOGUE_ENABLED:'true',AUTHORED_DIALOGUE_FIDELITY_VERIFIED:'true'};
 const deps={get:name=>config[name],supabase:'https://synthetic.supabase.co',key:'unused-local-key',
  rpc:async(name,body)=>{calls.push({name,body});const result=await rpc(db,name,body);await options.afterRpc?.(name,body,result);return result;},
  session:async(uid,sid)=>{assert.equal(uid,user);const found=json((await db.query('select * from public.sessions where id=$1 and user_id=$2',[sid,uid])).rows[0]);if(!found)throw Object.assign(Error('missing'),{code:'SESSION_NOT_FOUND'});return found;},
  events:async()=>{throw Error('Raw rows must come from the attested history RPC snapshot.');},
  prepare:async(uid,s,omitted,purpose,checkpoint)=>{
   const revision=(await db.query("select revision from public.memory_state where user_id=$1 and companion_id='alex'",[uid])).rows[0]?.revision??0;
   const memory={companionId:'alex',revision,facts:[],memories:[],recent_conversation:null,conversation_memories:[],shared_exchanges:[],suppress_memory:omitted,retrieval:omitted?'omitted':'keyword'};
   const clock={server_now_utc:new Date().toISOString(),session_created_at:s.created_at,time_zone:s.time_zone};
   const normal=renderVoiceInstructions(companionProfile('alex'),{...s,scenario:omitted?'':s.scenario},memory,undefined,clock,checkpoint);
   const context=JSON.parse(normal.split('UNTRUSTED_CONTEXT_JSON:\n').at(-1));
   const opening=purpose==='startup'?buildOpeningContext({context,clock,exchangeRevision:revision}):null;
   await options.inPrepare?.(s);
   return{instructions:opening?renderOpeningInstructions(companionProfile('alex'),s,opening,clock):normal,context,opening,verify:async()=>{}};
  },
  summarize:async(uid,s,fresh,prior,run,preDispatch)=>{
   // Mirrors the product checkpoint's post-reservation dispatch hook, without
   // making a real provider request.
   await deps.rpc('reserve_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_model:'gpt-6-luna',p_policy:{synthetic:true},p_reserved_usd:.001});
   await preDispatch();summaries.push({fresh,prior});
   await deps.rpc('record_model_spend',{p_job_id:run.job_id,p_lease_token:run.lease_token,p_usage:{input_tokens:10,output_tokens:10},p_estimated_usd:.00001,p_outcome:'generated'});
   return 'The caller described a paper moon. The character wondered about its crooked edge.';
  },
  author:async body=>{authors.push(body);const text=authors.length===1?'A crooked paper moon would keep my attention.':'I like that its odd edge mattered to you.';
   return{ok:true,status:200,payload:{id:'synthetic-response',store:false,status:'completed',model:body.model,metadata:body.metadata,text:{format:{type:'text'}},usage:{input_tokens:100,output_tokens:20},output:[{type:'reasoning',encrypted_content:'PRIVATE_IGNORED_STATE'},{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}]}};
  },
  synthesize:async body=>{readers.push(body);return{pcm:new Uint8Array([1,0,2,0]),transcript:body.text,finalTranscript:body.text,usage:{input_tokens:100,output_tokens:100,total_tokens:200},protocolVerified:true};},
  bootstrapVoice:async()=>{throw Error('No real voice bootstrap in local DB test.');},
 };
 const invoke=(endpoint,body)=>handleAuthoredDialogue(endpoint,user,{protocol,...body},deps);
 const context=await invoke('dialogue-context',{sessionId:session.id,callEpoch:1,omitLearningContext:false});
 const body=(context,extra={})=>({sessionId:session.id,callEpoch:context.callEpoch,authorityGeneration:context.authorityGeneration,expectedGeneration:context.generation,expectedMemoryRevision:context.memoryRevision,omitLearningContext:context.memoryMode==='omitted',turnNonce:randomUUID(),playbackEpoch:context.generation+1,purpose:'startup',speechSpeed:.85,currentUserEventIds:[],acceptedHistoryEventIds:[],...extra});
 const addUser=async(text='The crooked paper moon was my favorite.')=>json((await db.query("insert into public.transcript_events(user_id,session_id,event_key,speaker,text,timestamp) values($1,$2,$3,'user',$4,clock_timestamp()) returning *",[user,session.id,randomUUID(),text])).rows[0]);
 return{session,context,deps,invoke,body,addUser,calls,authors,readers,summaries};
}

test('actual authored handler and canonical SQL enforce the complete two-stage lifecycle',async t=>{
 const db=await setup(t);
 await t.test('startup, batch playback, raw reply, cancellation and already-omitted reset preserve authority',async()=>{
  const f=await fixture(db),start=await f.invoke('dialogue-turn',f.body(f.context));
  assert.equal(start.generation,1);assert.equal(start.assistantEvent.storage,'server');assert.equal(f.authors[0].input.length,1);assert(f.authors[0].input[0].content[0].text.includes('Current caller utterance: null'));
  const clip=await f.invoke('dialogue-synthesis',{owner:start.owner,generation:start.generation});assert.equal(clip.manifest.textSha256,start.textSha256);assert.equal(clip.manifest.byteLength,4);
  const caller=await f.addUser('난 비뚤어진 모서리가 마음에 들었어.');
  const report={protocol,owner:start.owner,generation:1,receiptId:start.owner.assistantEventId,qualifiedUserEventIds:[]};
  const reply=await f.invoke('dialogue-turn',f.body({...f.context,generation:1},{purpose:'reply',currentUserEventIds:[caller.id],acceptedHistoryEventIds:[start.assistantEvent.id],pendingPlaybackReports:[report]}));
  assert.equal(reply.generation,2);assert.equal(f.authors[1].input.at(-1).content[0].text,caller.text);assert.equal(f.authors[1].input[1].content[0].text,start.text);
  assert.equal((await db.query('select status from public.authored_dialogue_turns where id=$1',[start.owner.turnId])).rows[0].status,'played');
  await f.invoke('dialogue-synthesis',{owner:reply.owner,generation:reply.generation});
  const cancel=await f.invoke('dialogue-cancel',{sessionId:f.session.id,callEpoch:1,authorityGeneration:1,turnNonce:reply.owner.turnNonce,generation:2,reason:'user_speech'});assert.equal(cancel.status,'cancelled');assert.equal(cancel.generation,2);
  const discard=await f.invoke('dialogue-playback',{owner:reply.owner,generation:2,receiptId:reply.owner.assistantEventId,qualifiedUserEventIds:[caller.id]});assert.equal(discard.status,'discarded');assert.equal(discard.reason,'cancelled');
  const reset=await f.invoke('dialogue-context',{sessionId:f.session.id,callEpoch:1,omitLearningContext:true,reset:true});assert.equal(reset.authorityGeneration,2);assert.equal(reset.memoryRevision,null);
  const again=await f.invoke('dialogue-context',{sessionId:f.session.id,callEpoch:1,omitLearningContext:true,reset:true});assert.equal(again.authorityGeneration,3,'already omitted recovery also retires earlier authority');
  const late=await f.invoke('dialogue-playback',{owner:start.owner,generation:1,receiptId:start.owner.assistantEventId,qualifiedUserEventIds:[]});assert.equal(late.status,'discarded');assert.equal(late.reason,'stale_authority');
  const fresh=await f.addUser('Can we start from the paper moon again?'),newBody=f.body(again,{purpose:'reply',currentUserEventIds:[fresh.id]});
  const pendingCancel=await f.invoke('dialogue-cancel',{sessionId:f.session.id,callEpoch:1,authorityGeneration:again.authorityGeneration,turnNonce:newBody.turnNonce,reason:'user_speech'});assert.equal(pendingCancel.generation,2);
  await assert.rejects(f.invoke('dialogue-turn',newBody),/DIALOGUE_CANCELLED/);assert.equal(f.authors.length,2,'late reserve cannot revive a cancelled nonce');
  const saved=(await db.query('select text from public.transcript_events where id=$1',[caller.id])).rows[0];assert.equal(saved.text,caller.text);assert(!JSON.stringify(await db.query('select * from public.authored_dialogue_turns')).includes('PRIVATE_IGNORED_STATE'));
  const ordering=f.calls.map(call=>call.name);assert(ordering.indexOf('authored_dialogue_batchplaybacks')<ordering.lastIndexOf('authored_dialogue_history'));
 });
 await t.test('a changed saved source between history snapshot and begin rejects before the writer',async()=>{
  let current;const f=await fixture(db,{inPrepare:async()=>{if(current)await db.query('update public.transcript_events set text=$1 where id=$2',['Changed after the exact accepted snapshot.',current.id]);}});
  current=await f.addUser('SOURCE_SNAPSHOT_CANARY');
  await assert.rejects(f.invoke('dialogue-turn',f.body(f.context,{purpose:'reply',currentUserEventIds:[current.id]})),/SOURCE_CHANGED/);assert.equal(f.authors.length,0);assert.equal(f.readers.length,0);
 });
 await t.test('cost-await cancellation and source mutation fail the final writer and reader dispatch guards',async()=>{
  for(const [stage,mutation] of [['dialogue','cancel'],['dialogue_synthesis','cancel'],['dialogue','edit'],['dialogue_synthesis','edit']]){
   let caller;
   let injected=false;const f=await fixture(db,{afterRpc:async(name,args)=>{
    if(name==='reserve_model_spend'&&!injected&&args.p_model===(stage==='dialogue'?'gpt-6-luna':'gpt-realtime-2.1-mini')){
     injected=true;const turn=(await db.query('select * from public.authored_dialogue_turns where session_id=$1 order by turn_generation desc limit 1',[f.session.id])).rows[0];
     if(mutation==='cancel')await rpc(db,'authored_dialogue_cancel',{p_user_id:user,p_session_id:f.session.id,p_call_epoch:1,p_authority_generation:1,p_turn_nonce:turn.turn_nonce,p_turn_generation:turn.turn_generation});
     else await db.query('update public.transcript_events set text=$1 where id=$2',['The source changed during cost reservation.',caller.id]);
    }
   }});
   caller=await f.addUser('DISPATCH_SOURCE_CANARY');const request=f.body(f.context,{purpose:'reply',currentUserEventIds:[caller.id]}),expected=mutation==='cancel'?/DIALOGUE_CANCELLED/:/SOURCE_CHANGED/;
   if(stage==='dialogue')await assert.rejects(f.invoke('dialogue-turn',request),expected);
   else{const text=await f.invoke('dialogue-turn',request);await assert.rejects(f.invoke('dialogue-synthesis',{owner:text.owner,generation:text.generation}),expected);}
   assert.equal(f.readers.length,0);assert.equal(f.authors.length,stage==='dialogue'?0:1);
  }
 });
 await t.test('long-call checkpoint dispatch rejects cancellation and edited covered speech after its own cost await',async()=>{
  for(const mutation of ['cancel','edit']){
   let request,history;
   const f=await fixture(db,{afterRpc:async(name,args)=>{
    if(name==='reserve_model_spend'&&args.p_policy.synthetic&&request){
     if(mutation==='cancel')await rpc(db,'authored_dialogue_cancel',{p_user_id:user,p_session_id:f.session.id,p_call_epoch:1,p_authority_generation:1,p_turn_nonce:request.turnNonce,p_turn_generation:null});
     else await db.query('update public.transcript_events set text=$1 where id=$2',['Edited before the checkpoint provider dispatch.',history[0].id]);
    }
   }});
   history=[];for(let i=0;i<24;i++)history.push(await f.addUser('The paper moon had a crooked edge and a quiet room around it. '.repeat(28)+i));
   const first=await f.invoke('dialogue-turn',f.body(f.context,{purpose:'reply',currentUserEventIds:history.map(event=>event.id)}));assert.equal(first.generation,1);
   const current=await f.addUser('I still remember the crooked edge.');
   request=f.body({...f.context,generation:1},{purpose:'reply',currentUserEventIds:[current.id],acceptedHistoryEventIds:history.map(event=>event.id)});
   await assert.rejects(f.invoke('dialogue-turn',request),mutation==='cancel'?/DIALOGUE_CANCELLED/:/SOURCE_CHANGED/);
   assert.equal(f.summaries.length,0,'no stale text reaches even the checkpoint provider');assert.equal(f.authors.length,1);assert.equal(f.readers.length,0);
   assert.equal(f.calls.filter(call=>call.name==='authored_dialogue_checkpoint').length,0);
  }
 });
});
