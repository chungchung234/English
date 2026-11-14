import test from 'node:test';
import assert from 'node:assert/strict';
import {handler} from './index.ts';

const uid='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222';
const config={ACCESS_MODE:'invite',ALLOWED_EMAILS:'owner@example.com',ALLOWED_ORIGINS:'https://example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'local-service-fixture',OPENAI_API_KEY:'local-unused-provider-fixture'};
globalThis.Deno={env:{get:name=>config[name]}};
const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const request=body=>new Request('https://project.supabase.co/functions/v1/coach/voice-context',{method:'POST',headers:{Origin:'https://example.com',Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify(body)});

test('memory-free recovery verifies active ownership and current DB authorization without history or model calls',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(value,options)=>{const url=new URL(value);calls.push(url.pathname);
  if(url.pathname==='/auth/v1/user')return response({id:uid,email:'owner@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'});
  if(url.pathname==='/rest/v1/sessions'){assert.equal(url.searchParams.get('user_id'),'eq.'+uid);assert.equal(url.searchParams.get('id'),'eq.'+sid);return response([{id:sid,user_id:uid,companion_id:'mia',scenario:'Historical data that must not be restored.',status:'active',created_at:'2026-11-14T00:00:00Z',ended_at:null,time_zone:'Asia/Seoul'}]);}
  if(url.pathname==='/rest/v1/rpc/conversation_context_authorized'){assert.deepEqual(JSON.parse(options.body),{p_user_id:uid,p_session_id:sid});return response(true);}
  throw Error('Unexpected history or provider access: '+url.pathname);
 };
 try{const result=await handler(request({sessionId:sid,omitLearningContext:true}));assert.equal(result.status,200);const data=await result.json();
  assert.equal(data.memory_revision,null);assert.equal(data.memory_mode,'omitted');assert.equal(data.voice_policy_version,'2026-11-14-companion-phone-v5');
  const context=JSON.parse(data.instructions.split('UNTRUSTED_CONTEXT_JSON:\n')[1]);assert.deepEqual(context.memory.facts,[]);assert.deepEqual(context.memory.memories,[]);assert.equal(context.memory.recent_conversation,null);assert.equal(context.memory.suppress_memory,true);assert.equal(context.checkpoint,null);
  assert(!data.instructions.includes('Historical data that must not be restored.'));assert(data.instructions.includes('CHARACTER_POINT_OF_VIEW:'));assert(data.instructions.includes('Your character is Mia.'));
  assert.deepEqual(calls,['/auth/v1/user','/rest/v1/sessions','/rest/v1/rpc/conversation_context_authorized']);
 }finally{globalThis.fetch=original;}
});

test('memory-free recovery rejects nonexplicit omission, ended sessions, missing ownership and revoked authorization',async()=>{
 const original=globalThis.fetch;
 try{for(const state of ['missing_omission','extra_field','missing_session','ended','revoked']){
  globalThis.fetch=async value=>{const url=new URL(value);
   if(url.pathname==='/auth/v1/user')return response({id:uid,email:'owner@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'});
   if(url.pathname==='/rest/v1/sessions')return response(state==='missing_session'?[]:[{id:sid,user_id:uid,companion_id:'alex',scenario:'',status:state==='ended'?'ended':'active',ended_at:state==='ended'?'2026-11-14T00:01:00Z':null}]);
   if(url.pathname==='/rest/v1/rpc/conversation_context_authorized')return new Response('{}',{status:403});
   throw Error('Unexpected historical/provider access');
  };
  const body={sessionId:sid,...(state==='missing_omission'?{}:{omitLearningContext:true}),...(state==='extra_field'?{instructions:'invented caller override'}:{})};
  const result=await handler(request(body));assert.equal(result.status,{missing_omission:400,extra_field:400,missing_session:404,ended:409,revoked:503}[state]);
  const data=await result.json();assert.equal(data.instructions,undefined);
 }}finally{globalThis.fetch=original;}
});

test('a spoken forget materialized during provider setup cannot publish the old shared AI quotation',async()=>{
 const original=globalThis.fetch;let forgotten=false,failedCode=null,completed=false;
 const source='33333333-3333-4333-8333-333333333333',userEvent='44444444-4444-4444-8444-444444444444',assistantEvent='55555555-5555-4555-8555-555555555555';
 const shared={version:'conversation-exchange-v1',source_session_id:source,companion_id:'alex',memory_revision:7,
  session_created_at:'2026-11-01T00:00:00Z',session_ended_at:'2026-11-01T00:10:00Z',session_time_zone:'Asia/Seoul',admission:'client_reported_playback_completed',
  caller:{id:userEvent,speaker:'user',quote:'I found a bakery near my home.',timestamp:'2026-11-01T00:01:00Z',truncated:false},
  companion:{id:assistantEvent,speaker:'assistant',quote:'Previously authorized shared quote.',timestamp:'2026-11-01T00:02:00Z',truncated:false}};
 const sdp='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
 globalThis.fetch=async(value,options)=>{const url=new URL(value),body=options?.body instanceof FormData?null:options?.body?JSON.parse(options.body):null;
  if(url.pathname==='/auth/v1/user')return response({id:uid,email:'owner@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'});
  if(url.pathname==='/rest/v1/sessions')return response([{id:sid,user_id:uid,companion_id:'alex',scenario:'Natural English conversation about everyday life',status:'active',created_at:'2026-11-14T00:00:00Z',ended_at:null,time_zone:'Asia/Seoul'}]);
  if(url.pathname==='/rest/v1/rpc/learning_voice_context')return response({focus:[],suppress_memory:false});
  if(url.pathname==='/rest/v1/rpc/memory_context')return response({revision:7,limited:false,retrieval:'keyword',memories:[],facts:forgotten?[{key:'location',value:'',forgotten:true,spoken_at:'2026-11-02T00:00:00Z'}]:[],shared_exchanges:forgotten?[]:[shared]});
  if(url.pathname==='/rest/v1/rpc/learning_usage_prepare')return response({targets:[],source_version:'fixture'});
  if(url.pathname==='/rest/v1/rpc/reserve_run')return response({reserved:true,job_id:sid,lease_token:userEvent});
  if(url.pathname==='/v1/realtime/calls'){assert(JSON.parse(options.body.get('session')).instructions.includes(shared.companion.quote));forgotten=true;return new Response(sdp);}
  if(url.pathname==='/rest/v1/rpc/fail_run'){failedCode=body.p_error;return response(null);}
  if(url.pathname==='/rest/v1/rpc/complete_run'){completed=true;return response(null);}
  throw Error('Unexpected request: '+url.pathname);
 };
 try{const req=new Request('https://project.supabase.co/functions/v1/coach/voice',{method:'POST',headers:{Origin:'https://example.com',Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,sdp})});
  const result=await handler(req);assert.equal(result.status,409);const data=await result.json();assert.equal(data.error.code,'MEMORY_CHANGED');assert.equal(data.voice_instructions,undefined);assert.equal(failedCode,'MEMORY_CHANGED');assert.equal(completed,false);
 }finally{globalThis.fetch=original;}
});

test('provider setup rechecks exact shared source authority but accepts additional unused exchanges',async t=>{
 const source='33333333-3333-4333-8333-333333333333',userEvent='44444444-4444-4444-8444-444444444444',assistantEvent='55555555-5555-4555-8555-555555555555';
 const shared={version:'conversation-exchange-v1',source_session_id:source,companion_id:'alex',memory_revision:7,
  session_created_at:'2026-11-01T00:00:00Z',session_ended_at:'2026-11-01T00:10:00Z',session_time_zone:'Asia/Seoul',admission:'client_reported_playback_completed',
  caller:{id:userEvent,speaker:'user',quote:'I found a bakery near my home.',timestamp:'2026-11-01T00:01:00Z',truncated:false},
  companion:{id:assistantEvent,speaker:'assistant',quote:'Previously authorized shared quote.',timestamp:'2026-11-01T00:02:00Z',truncated:false}};
 const extra={...structuredClone(shared),source_session_id:'66666666-6666-4666-8666-666666666666',
  caller:{...shared.caller,id:'77777777-7777-4777-8777-777777777777',quote:'Another actual caller story.'},
  companion:{...shared.companion,id:'88888888-8888-4888-8888-888888888888',quote:'Another unused source response.'}};
 const sdp='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
 for(const change of ['incomplete_source','excluded_source','changed_source_digest','same_ids_different_quote','same_ids_different_clock','extra_unused_source'])await t.test(change,async()=>{
  const original=globalThis.fetch;let changed=false,failedCode=null,completed=false;
  globalThis.fetch=async(value,options)=>{const url=new URL(value),body=options?.body instanceof FormData?null:options?.body?JSON.parse(options.body):null;
   if(url.pathname==='/auth/v1/user')return response({id:uid,email:'owner@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'});
   if(url.pathname==='/rest/v1/sessions')return response([{id:sid,user_id:uid,companion_id:'alex',scenario:'Natural English conversation about everyday life',status:'active',created_at:'2026-11-14T00:00:00Z',ended_at:null,time_zone:'Asia/Seoul'}]);
   if(url.pathname==='/rest/v1/rpc/learning_voice_context')return response({focus:[],suppress_memory:changed&&change==='excluded_source'});
   if(url.pathname==='/rest/v1/rpc/memory_context'){
    let exchanges=[shared];
    if(changed){
     if(['incomplete_source','excluded_source','changed_source_digest'].includes(change))exchanges=[];
     if(change==='same_ids_different_quote')exchanges=[{...shared,companion:{...shared.companion,quote:'Different source content under the same IDs.'}}];
     if(change==='same_ids_different_clock')exchanges=[{...shared,session_ended_at:'2026-11-01T00:09:00Z'}];
     if(change==='extra_unused_source')exchanges=[extra,shared];
    }
    return response({revision:7,limited:false,retrieval:'keyword',memories:[],facts:[],shared_exchanges:exchanges});
   }
   if(url.pathname==='/rest/v1/rpc/learning_usage_prepare')return response({targets:[],source_version:'fixture'});
   if(url.pathname==='/rest/v1/rpc/reserve_run')return response({reserved:true,job_id:sid,lease_token:userEvent});
   if(url.pathname==='/v1/realtime/calls'){assert(JSON.parse(options.body.get('session')).instructions.includes(shared.companion.quote));changed=true;return new Response(sdp);}
   if(url.pathname==='/rest/v1/rpc/fail_run'){failedCode=body.p_error;return response(null);}
   if(url.pathname==='/rest/v1/rpc/complete_run'){completed=true;return response(null);}
   throw Error('Unexpected request: '+url.pathname);
  };
  try{const req=new Request('https://project.supabase.co/functions/v1/coach/voice',{method:'POST',headers:{Origin:'https://example.com',Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,sdp})});
   const result=await handler(req),data=await result.json();
   if(change==='extra_unused_source'){
    assert.equal(result.status,200);assert.equal(completed,true);assert.equal(failedCode,null);assert(data.voice_instructions.includes(shared.companion.quote));
    assert(!data.voice_instructions.includes(extra.companion.quote),'the frozen instruction set is not expanded during revalidation');
   }else{
    assert.equal(result.status,409);assert.equal(data.error.code,'MEMORY_CHANGED');assert.equal(data.voice_instructions,undefined);assert.equal(failedCode,'MEMORY_CHANGED');assert.equal(completed,false);
   }
  }finally{globalThis.fetch=original;}
 });
});
