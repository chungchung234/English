import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleAuthoredDialogue, authoredDialogueCapability, authoredOutput, synthesisReservation, synthesisUsage, authoringRequest } from './authored-dialogue.ts';
import { FIDELITY_POLICY_VERSION, textDigest } from './verified-speech.ts';
import { renderVoiceInstructions, renderOpeningInstructions, handler } from './index.ts';
import { companionProfile, fingerprint } from './core.ts';
import { buildOpeningContext } from './opening-policy.ts';
import { reviewPolicy } from './policy.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,uid=id(1),sid=id(2),nonce=id(3),tid=id(4),aid=id(5),currentId=id(6);
const protocol='authored_dialogue_v1',scope='https://project.supabase.co|'+uid;
const session={id:sid,user_id:uid,companion_id:'alex',scenario:'Natural English conversation about everyday life',status:'active',ended_at:null,created_at:'2026-11-14T10:00:00Z',time_zone:'Asia/Seoul'};
const clock={server_now_utc:'2026-11-14T10:01:00.000Z',session_created_at:'2026-11-14T10:00:00.000Z',time_zone:'Asia/Seoul'};
const input={id:currentId,session_id:sid,speaker:'user',text:'이 전시가 조금 어색해서 더 좋았어.',timestamp:'2026-11-14T10:00:30.000Z'};
const turnBody=(extra={})=>({protocol,sessionId:sid,callEpoch:1,authorityGeneration:1,turnNonce:nonce,expectedGeneration:0,playbackEpoch:1,purpose:'reply',currentUserEventIds:[currentId],acceptedHistoryEventIds:[],expectedMemoryRevision:7,omitLearningContext:false,speechSpeed:.85,...extra});
const expectedOwner={scope,sessionId:sid,companionId:'alex',callEpoch:1,turnNonce:nonce,turnId:tid,assistantEventId:aid,authorityGeneration:1,expectedMemoryRevision:7,playbackEpoch:1};
function fixture(options={}){
 const trace=[],provider=[],state={call_epoch:1,authority_generation:1,turn_generation:0,memory_mode:'included',memory_revision:7,checkpoint:null};
 let counter=100,turn={id:tid,assistant_event_id:aid,session_id:sid,user_id:uid,companion_id:'alex',call_epoch:1,authority_generation:1,turn_generation:1,playback_epoch:1,turn_nonce:nonce,memory_mode:'included',memory_revision:7,status:'reserved',speech_speed:.85},event;
 const config={AUTHORED_DIALOGUE_ENABLED:'true',AUTHORED_DIALOGUE_FIDELITY_VERIFIED:'true'};
 const deps={get:name=>config[name],supabase:'https://project.supabase.co',key:'never-export-mock',
 session:async(user,sessionId)=>{assert.equal(user,uid);assert.equal(sessionId,sid);return options.ended?{...session,status:'ended'}:session;},
 events:async()=>options.events??[input],
 prepare:async(user,s,omitted,purpose,checkpoint)=>{
  const m={companionId:'alex',revision:7,facts:[],memories:[],recent_conversation:null,conversation_memories:[],focus:[],practiced:[],suppress_memory:omitted,limited:false,retrieval:'keyword'},companion=companionProfile('alex');
  const note=checkpoint?{version:checkpoint.version,summary:checkpoint.summary}:undefined;
  const normal=renderVoiceInstructions(companion,s,m,undefined,clock,note),context=JSON.parse(normal.split('UNTRUSTED_CONTEXT_JSON:\n')[1]);
  const opening=purpose==='startup'?buildOpeningContext({context,clock,exchangeRevision:7}):null;
  const instructions=opening?renderOpeningInstructions(companion,s,opening,clock):normal;
  return{instructions,context,opening,verify:async()=>{trace.push({name:'verify'});if(options.revoked)throw Object.assign(Error('changed'),{code:'MEMORY_CHANGED'});}};
 },
 summarize:async(user,s,fresh,prior,run,preDispatch)=>{await preDispatch();trace.push({name:'summarize'});assert(trace.some(row=>row.name==='authored_dialogue_batchplaybacks'),'pending playback admission must precede checkpoint model work');return 'The caller is discussing an exhibition.';},
 bootstrapVoice:async(user,body)=>{trace.push({name:'bootstrap',body});return{audio_policy:{turn_control:'manual_turns_v1'},memory_revision:null,memory_mode:'omitted'};},
 author:async body=>{provider.push(body);return{ok:true,status:200,payload:{id:'response-private',status:'completed',model:body.model,store:false,metadata:body.metadata,text:{format:{type:'text'}},usage:{input_tokens:100,output_tokens:20},output:[{type:'reasoning',id:'reason-private',summary:[],encrypted_content:'ENCRYPTED_PRIVATE_CANARY'},{type:'message',id:'message-private',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'A prepared reply.'}]}]}};},
 synthesize:async request=>{trace.push({name:'synthesize',text:request.text});return{pcm:new Uint8Array([1,0,2,0]),protocolVerified:true,transcript:options.mismatch?'A different reply.':request.text,finalTranscript:request.text,usage:{input_tokens:100,output_tokens:100,total_tokens:200}};},
 rpc:async(name,body)=>{trace.push({name,body});if(options.rpc){const custom=await options.rpc(name,body,{turn,state,event,trace});if(custom!==undefined)return custom;}
  if(name==='conversation_context_authorized')return true;
  if(name==='authored_dialogue_context'||name==='authored_dialogue_state')return{...state};
  if(name==='authored_dialogue_history'){const selected=new Set([...body.p_current_user_ids,...body.p_history_ids]),events=(options.events??[input]).filter(event=>selected.has(event.id));return{current_user_ids:body.p_current_user_ids,history_ids:body.p_history_ids,events,source_event_digests:Object.fromEntries(events.map(event=>[event.id,'d'.repeat(32)]))};}
  if(name==='authored_dialogue_dispatch')return true;
  if(name==='authored_dialogue_receipt_source')return{missing:false};
  if(name==='reserve_run')return{reserved:true,job_id:id(counter++),lease_token:id(counter++)};
  if(name==='reserve_model_spend')return true;
  if(['record_model_spend','complete_run','fail_run'].includes(name))return null;
  if(name==='authored_dialogue_begin'){state.turn_generation++;turn={...turn,turn_generation:state.turn_generation,purpose:body.p_purpose,source_manifest:{event_digests:body.p_source_event_digests}};return{turn:{...turn},opaque_history:options.opaque??{}};}
  if(name==='authored_dialogue_complete_text'){turn={...turn,status:'text_complete',written_text_sha256:await textDigest(body.p_text)};event={id:aid,session_id:sid,event_key:'authored-dialogue:'+tid,speaker:'assistant',text:body.p_text,timestamp:clock.server_now_utc};return{turn:{...turn},assistant_event:{...event}};}
  if(name==='authored_dialogue_synthesis_begin'){turn={...turn,status:'synthesizing'};return{turn:{...turn},text:event.text,voice:'cedar',speed:.85,settings:{...body.p_settings,voice:'cedar',speed:.85,approved_text_sha256:turn.written_text_sha256}};}
  if(name==='authored_dialogue_publish')return{published:true,turn_id:tid,turn_generation:turn.turn_generation,synthesis_id:body.p_job_id};
  if(name==='authored_dialogue_cancel')return{cancelled:true,status:'cancelled',turn_nonce:body.p_turn_nonce,call_epoch:1,authority_generation:1,turn_generation:state.turn_generation};
  if(name==='authored_dialogue_playback')return{turn:{...turn},receipt_id:body.p_receipt_id,status:'recorded',reason:null};
  if(name==='authored_dialogue_batchplaybacks')return{processed:body.p_reports.length,results:body.p_reports.map(row=>({turn:{...turn,status:'published',id:row.turn_id,assistant_event_id:row.assistant_event_id,turn_generation:row.turn_generation,playback_epoch:row.playback_epoch},receipt_id:row.receipt_id,status:'recorded',reason:null}))};
  if(name==='authored_dialogue_checkpoint'){state.checkpoint={version:'conversation-checkpoint-v1',summary:body.p_summary,covered_ids:body.p_covered_event_ids,policy_fingerprint:body.p_policy_fingerprint};return{checkpoint:state.checkpoint};}
  throw Error('Unexpected RPC '+name);
 }};
 return{deps,config,trace,provider,state,get turn(){return turn;}};
}
test('explicit protocol and disabled-by-default capability prevent all new provider requests',async()=>{
 assert.equal(authoredDialogueCapability(()=>undefined),false);const f=fixture();delete f.config.AUTHORED_DIALOGUE_ENABLED;
 await assert.rejects(handleAuthoredDialogue('dialogue-turn',uid,turnBody(),f.deps),e=>e.code==='AUTHORED_DIALOGUE_DISABLED');assert.deepEqual(f.trace,[]);assert.deepEqual(f.provider,[]);
 await assert.rejects(handleAuthoredDialogue('dialogue-turn',uid,turnBody({protocol:'manual_turns_v1'}),f.deps));
});
test('context and ASR-only bootstrap expose no private checkpoint and preserve legacy manual wire',async()=>{
 const f=fixture();f.state.checkpoint={summary:'PRIVATE_SOURCE_SUMMARY',opaque:['PRIVATE_REASONING']};const context=await handleAuthoredDialogue('dialogue-context',uid,{protocol,sessionId:sid,callEpoch:1,omitLearningContext:false},f.deps);
 assert.deepEqual(context,{protocol,callEpoch:1,authorityGeneration:1,generation:0,memoryRevision:7,memoryMode:'included',companionId:'alex'});assert(!JSON.stringify(context).includes('PRIVATE_'));
 const voice=await handleAuthoredDialogue('dialogue-voice',uid,{protocol,sessionId:sid,sdp:'fixture',speechSpeed:.85},f.deps);assert.equal(voice.audio_policy.turn_control,'manual_turns_v1');assert.equal(voice.authored_dialogue.asr_only,true);assert.equal(f.trace.find(x=>x.name==='bootstrap').body.omitLearningContext,true);
});
test('exact v5 authoring keeps current raw speech, private phase/reasoning and immutable written source separate',async()=>{
 const f=fixture(),result=await handleAuthoredDialogue('dialogue-turn',uid,turnBody(),f.deps);
 assert.deepEqual(result.owner,expectedOwner);assert.equal(result.assistantEvent.storage,'server');assert.equal(result.assistantEvent.text,result.text);assert.equal(result.textSha256,createHash('sha256').update(result.text).digest('hex'));
 assert(f.provider[0].input[0].content[0].text.includes('Your character is Alex.'));assert.equal(f.provider[0].input.at(-1).content[0].text,input.text);
 assert.equal(f.provider[0].store,false);assert.deepEqual(f.provider[0].tools,[]);assert.equal(Object.hasOwn(f.provider[0],'include'),false);assert.equal(f.provider[0].max_output_tokens,reviewPolicy('session',f.deps.get).maxOutput);
 assert.equal(f.trace.find(x=>x.name==='authored_dialogue_complete_text').body.p_opaque_output,null);assert(!JSON.stringify(result).includes('PRIVATE_CANARY'));assert(!JSON.stringify(result).includes('response-private'));
 const startup=fixture();await handleAuthoredDialogue('dialogue-turn',uid,turnBody({purpose:'startup',currentUserEventIds:[]}),startup.deps);assert.equal(startup.provider[0].input.length,1);assert(startup.provider[0].input[0].content[0].text.includes('Current caller utterance: null'));
});
test('ended/forged-current/source-revoked requests fail before public reply or synthesis',async()=>{
 const ended=fixture({ended:true});await assert.rejects(handleAuthoredDialogue('dialogue-turn',uid,turnBody(),ended.deps));assert.equal(ended.provider.length,0);
 const forged=fixture({events:[{...input,speaker:'assistant'}]});await assert.rejects(handleAuthoredDialogue('dialogue-turn',uid,turnBody(),forged.deps));assert.equal(forged.provider.length,0);
 const revoked=fixture({revoked:true});await assert.rejects(handleAuthoredDialogue('dialogue-turn',uid,turnBody(),revoked.deps));assert.equal(revoked.trace.some(x=>x.name==='authored_dialogue_complete_text'),false);assert.equal(revoked.trace.some(x=>x.name==='synthesize'),false);
});
test('verified whole PCM manifests bind raw text hash, exact owner and separate settled synthesis job',async()=>{
 const f=fixture(),text=await handleAuthoredDialogue('dialogue-turn',uid,turnBody(),f.deps),audio=await handleAuthoredDialogue('dialogue-synthesis',uid,{protocol,owner:text.owner,generation:text.generation},f.deps);
 assert.deepEqual(audio.manifest.owner,text.owner);assert.equal(audio.manifest.textSha256,text.textSha256);assert.equal(audio.manifest.byteLength,4);assert.equal(audio.manifest.sourceFrames,2);assert.equal(audio.manifest.transcriptVerification.policyVersion,FIDELITY_POLICY_VERSION);
 const jobs=f.trace.filter(x=>x.name==='reserve_run');assert.deepEqual(jobs.map(x=>x.body.p_kind),['dialogue','dialogue_synthesis']);
 const spends=f.trace.filter(x=>x.name==='record_model_spend');assert.equal(spends[1].body.p_estimated_usd,(100*.6+100*20)/1e6);assert.equal(spends[1].body.p_outcome,'generated_audio');
 const bad=fixture({mismatch:true}),badText=await handleAuthoredDialogue('dialogue-turn',uid,turnBody(),bad.deps);await assert.rejects(handleAuthoredDialogue('dialogue-synthesis',uid,{protocol,owner:badText.owner,generation:badText.generation},bad.deps),e=>e.code==='SYNTHESIS_TEXT_MISMATCH');assert.equal(bad.trace.some(x=>x.name==='authored_dialogue_publish'),false);
});
test('malformed cancel/playback/publish acknowledgements cannot become successful or playable',async()=>{
 for(const endpoint of ['dialogue-cancel','dialogue-playback']){
  const name=endpoint==='dialogue-cancel'?'authored_dialogue_cancel':'authored_dialogue_playback',f=fixture({rpc:n=>n===name?{}:undefined});
  const body=endpoint==='dialogue-cancel'?{protocol,sessionId:sid,callEpoch:1,authorityGeneration:1,turnNonce:nonce}:{protocol,owner:expectedOwner,generation:1,receiptId:id(30),qualifiedUserEventIds:[currentId]};
  await assert.rejects(handleAuthoredDialogue(endpoint,uid,body,f.deps),e=>e.code==='DIALOGUE_RPC_INVALID');
 }
 const f=fixture({rpc:n=>n==='authored_dialogue_publish'?{}:undefined}),reply=await handleAuthoredDialogue('dialogue-turn',uid,turnBody(),f.deps);await assert.rejects(handleAuthoredDialogue('dialogue-synthesis',uid,{protocol,owner:reply.owner,generation:reply.generation},f.deps),e=>e.code==='DIALOGUE_RPC_INVALID');
});
test('pending played report is atomically admitted before any long-call checkpoint model work',async()=>{
 const history=Array.from({length:40},(_,i)=>({id:id(300+i),session_id:sid,speaker:i%2?'assistant':'user',text:'A concrete saved conversation detail. '.repeat(30),timestamp:new Date(Date.parse(clock.session_created_at)+i*1000).toISOString()}));
 const oldOwner={...expectedOwner,turnId:id(398),assistantEventId:history[1].id,turnNonce:id(399),playbackEpoch:0};
 const f=fixture({events:[...history,input]}),pending={protocol,owner:oldOwner,generation:1,receiptId:oldOwner.assistantEventId,qualifiedUserEventIds:[history[0].id]};
 // batch's stored row belongs to the immutable previous nonce rather than newturn.
 const original=f.deps.rpc;f.deps.rpc=async(name,body)=>{if(name==='authored_dialogue_batchplaybacks'){f.trace.push({name,body});return{processed:1,results:[{turn:{...f.turn,id:oldOwner.turnId,assistant_event_id:oldOwner.assistantEventId,turn_nonce:oldOwner.turnNonce,playback_epoch:0},receipt_id:pending.receiptId,status:'recorded',reason:null}]};}return original(name,body);};
 await handleAuthoredDialogue('dialogue-turn',uid,turnBody({acceptedHistoryEventIds:history.map(x=>x.id),pendingPlaybackReports:[pending]}),f.deps);
 assert(f.trace.findIndex(x=>x.name==='authored_dialogue_batchplaybacks')<f.trace.findIndex(x=>x.name==='summarize'));assert(f.trace.some(x=>x.name==='authored_dialogue_checkpoint'));assert(f.provider[0].input.length<history.length+2);
});
test('reader costs use all-text input/all-audio output and unknown usage retains an unknown estimate',()=>{
 const reservation=synthesisReservation('A prepared reply.','cedar',.85,nonce);assert(reservation>.08&&reservation<.1);assert.deepEqual(synthesisUsage({input_tokens:10,output_tokens:20,total_tokens:30}),{usage:{input_tokens:10,output_tokens:20,total_tokens:30},estimatedUsd:(10*.6+20*20)/1e6});
 for(const raw of [{},{input_tokens:0,output_tokens:0,total_tokens:0},{input_tokens:-1,output_tokens:1},{input_tokens:1,output_tokens:2,total_tokens:100},{input_tokens:1,output_tokens:2,input_token_details:{audio_tokens:1}}])assert.equal(synthesisUsage(raw).estimatedUsd,null);
});
test('actual HTTP handler maps sanitized DB source revocation and keeps unknown SQL errors private',async()=>{
 const oldDeno=globalThis.Deno,oldFetch=globalThis.fetch,config={AUTHORED_DIALOGUE_ENABLED:'true',AUTHORED_DIALOGUE_FIDELITY_VERIFIED:'true',ACCESS_MODE:'public',ALLOWED_ORIGINS:'https://example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'local-private-key',OPENAI_API_KEY:'local-unused'};
 globalThis.Deno={env:{get:name=>config[name]}};
 try{for(const message of ['DIALOGUE_SOURCE_CHANGED','PRIVATE SQL row with personal data']){
  globalThis.fetch=async url=>{const path=new URL(url).pathname;if(path==='/auth/v1/user')return Response.json({id:uid,email:'owner@example.com',email_confirmed_at:clock.server_now_utc});if(path==='/rest/v1/sessions')return Response.json([session]);if(path.endsWith('/conversation_context_authorized'))return Response.json(true);if(path.endsWith('/authored_dialogue_context'))return new Response(JSON.stringify({code:'40001',message}),{status:409,headers:{'content-type':'application/json'}});throw Error('Unexpected external call '+path);};
  const result=await handler(new Request('https://project.supabase.co/functions/v1/coach/dialogue-context',{method:'POST',headers:{Origin:'https://example.com',Authorization:'Bearer local-user','content-type':'application/json'},body:JSON.stringify({protocol,sessionId:sid,callEpoch:1,omitLearningContext:false})}));
  assert.equal(result.status,message.startsWith('DIALOGUE_')?409:503);const out=await result.json();assert.equal(out.error.code,message.startsWith('DIALOGUE_')?'MEMORY_SOURCE_CHANGED':'DATABASE_UNAVAILABLE');assert(!JSON.stringify(out).includes('personal data'));
 }}finally{globalThis.fetch=oldFetch;globalThis.Deno=oldDeno;}
});
