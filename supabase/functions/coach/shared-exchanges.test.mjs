import test from 'node:test';
import assert from 'node:assert/strict';
import {bytes,companionProfile} from './core.ts';
import {projectSharedExchanges,SHARED_EXCHANGE_VERSION} from './shared-exchanges.ts';
import {projectLiveConversationContext} from './live-context.ts';
import {boundVoiceContext} from './temporal-context.ts';
import {buildOpeningContext,OPENING_BOUNDS} from './opening-policy.ts';
import {renderVoiceInstructions,renderOpeningInstructions} from './index.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clock={server_now_utc:'2026-11-14T03:00:00.000Z',time_zone:'Asia/Seoul',session_created_at:'2026-11-14T02:59:00.000Z'};
const pair=(overrides={})=>({version:SHARED_EXCHANGE_VERSION,source_session_id:id(1),companion_id:'alex',memory_revision:7,
 session_created_at:'2026-11-13T03:00:00.000Z',session_ended_at:'2026-11-13T03:10:00.000Z',session_time_zone:'Asia/Seoul',admission:'client_reported_playback_completed',
 caller:{id:id(2),speaker:'user',quote:'I found a small bakery on a side street.',timestamp:'2026-11-13T03:01:00.000Z',truncated:false},
 companion:{id:id(3),speaker:'assistant',quote:'I would notice the window first. A small detail makes a place interesting to me.',timestamp:'2026-11-13T03:02:00.000Z',truncated:false},...overrides});
const options={companionId:'alex',revision:7,now:clock.server_now_utc,currentSessionId:id(10)};
const memory=(overrides={})=>({companionId:'alex',revision:7,suppress_memory:false,facts:[],memories:[],conversation_memories:[],recent_conversation:null,practiced:[],focus:[],limited:false,retrieval:'keyword',selection:'synthetic receipt-backed source',shared_exchanges:[pair()],...overrides});

test('shared exchanges preserve exact separate speakers and remove untrusted extra fields',()=>{
 const raw=pair({next_scenario:'Teach the caller',corrections:[{improved:'Invented correction'}]});raw.companion.user_fact='The caller likes what I like.';
 const before=structuredClone(raw),result=projectSharedExchanges([raw],options);
 assert.equal(result.length,1);assert.equal(result[0].caller.speaker,'user');assert.equal(result[0].companion.speaker,'assistant');
 assert.equal(result[0].caller.quote,raw.caller.quote);assert.equal(result[0].companion.quote,raw.companion.quote);
 assert.equal(result[0].admission,'client_reported_playback_completed');assert(!JSON.stringify(result).includes('Teach the caller'));assert(!JSON.stringify(result).includes('user_fact'));
 assert.deepEqual(raw,before);
 const projected=projectLiveConversationContext({companionId:'alex',scenario:'Natural English conversation about everyday life',memory:memory({shared_exchanges:[raw]}),checkpoint:null},clock);
 assert.deepEqual(projected.memory.facts,[],'the AI quotation cannot become a user profile fact');assert.deepEqual(projected.memory.shared_exchanges,result);
});

test('missing receipt authority, stale revision, wrong speaker/companion, current or future sources are omitted',()=>{
 for(const change of [{version:'old'},{admission:'generated_only'},{memory_revision:6},{companion_id:'mia'},{source_session_id:id(10)},
  {session_ended_at:'2026-11-15T03:10:00.000Z'},{companion:{...pair().companion,speaker:'user'}},{caller:{...pair().caller,timestamp:'2026-11-13T03:03:00.000Z'}}]){
  assert.deepEqual(projectSharedExchanges([pair(change)],options),[]);
 }
 assert.deepEqual(projectSharedExchanges([pair()],{...options,revision:null}),[]);assert.deepEqual(projectSharedExchanges([pair()],{...options,suppressed:true}),[]);
 assert.equal(projectLiveConversationContext({companionId:'alex',memory:memory()},undefined).memory.shared_exchanges,undefined,'no trusted clock means no dated shared source');
});

test('forget boundaries and byte bounds cannot reintroduce a prior quote or force a memory payload failure',()=>{
 assert.deepEqual(projectSharedExchanges([pair()],{...options,facts:[{key:'location',value:'',forgotten:true}]}),[]);
 assert.deepEqual(projectSharedExchanges([pair()],{...options,facts:[{key:'location',value:'',spoken_at:'2026-11-13T03:05:00.000Z'}]}),[]);
 assert.equal(projectSharedExchanges([pair()],{...options,facts:[{key:'location',value:'',spoken_at:'2026-11-12T03:05:00.000Z'}]}).length,1);
 const many=Array.from({length:12},(_,i)=>pair({source_session_id:id(20+Math.floor(i/2)),companion:{...pair().companion,id:id(100+i),quote:'한글🙂'.repeat(100)}}));
 const selected=projectSharedExchanges(many,options);assert(selected.length>0);assert(selected.length<=4);assert(new Set(selected.map(x=>x.source_session_id)).size<=2);assert(bytes(JSON.stringify(selected))<=4200);
 for(const entry of selected){assert(many[0].companion.quote.startsWith(entry.companion.quote));assert.equal(entry.companion.truncated,true);assert(!entry.companion.quote.includes('…'));}
});

test('normal and selected opening instructions deliver shared context without converting it to current speech',()=>{
 const m=memory({recent_conversation:{mode:'handoff',session_id:id(1),session_created_at:pair().session_created_at,session_ended_at:pair().session_ended_at,session_time_zone:'Asia/Seoul',
  threads:[{note:'Found a small bakery on a side street.',state:'stated',when:null,follow_up:null,evidence_ids:[id(2)]}],turns:[{id:id(2),speaker:'user',text:pair().caller.quote,timestamp:pair().caller.timestamp}]}});
 const session={id:id(10),user_id:id(11),companion_id:'alex',scenario:'Natural English conversation about everyday life',status:'active',ended_at:null,created_at:clock.session_created_at,time_zone:'Asia/Seoul'};
 const normal=renderVoiceInstructions(companionProfile('alex'),session,m,undefined,clock);
 assert(normal.indexOf('CHARACTER_POINT_OF_VIEW:')<normal.indexOf('CONVERSATION_POLICY:'));
 const context=JSON.parse(normal.split('UNTRUSTED_CONTEXT_JSON:\n')[1]);assert.deepEqual(context.memory.shared_exchanges,[pair()]);assert.deepEqual(context.memory.facts,[]);
 const opening=buildOpeningContext({context,clock,exchangeRevision:7});assert.equal(opening.current_utterance,null);assert.deepEqual(opening.shared_exchange,pair());assert(bytes(JSON.stringify(opening))<=OPENING_BOUNDS.maxBytes);
 const rendered=renderOpeningInstructions(companionProfile('alex'),session,opening,clock);
 const data=JSON.parse(rendered.split('UNTRUSTED_OPENING_CONTEXT_JSON:\n')[1].split('\nCURRENT_RESPONSE_PURPOSE:')[0]);assert.equal(data.shared_exchange.companion.speaker,'assistant');assert.equal(data.continuity.role,'historical_background');
 assert.equal(buildOpeningContext({context,clock,exchangeRevision:6}).shared_exchange,undefined);
 assert.equal(buildOpeningContext({context:{...context,scenario:'User-prepared conversation: A topic I chose'},clock,exchangeRevision:7}).shared_exchange,undefined);
});

test('direct and bound live/opening projections enforce forget cutoffs while preserving newer unrelated exchanges',()=>{
 const recent={mode:'handoff',session_id:id(1),session_created_at:pair().session_created_at,session_ended_at:pair().session_ended_at,session_time_zone:'Asia/Seoul',
  threads:[{note:'Found a small bakery on a side street.',state:'stated',when:null,follow_up:null,evidence_ids:[id(2)]}],turns:[{id:id(2),speaker:'user',text:pair().caller.quote,timestamp:pair().caller.timestamp}]};
 const session={id:id(10),user_id:id(11),companion_id:'alex',scenario:'Natural English conversation about everyday life',status:'active',ended_at:null,created_at:clock.session_created_at,time_zone:'Asia/Seoul'};
 for(const [times,keep] of [
  [{spoken_at:'2026-11-12T03:05:00Z',updated_at:'2026-11-14T01:00:00Z'},true],
  [{spoken_at:'2026-11-13T03:05:00Z'},false],
  [{spoken_at:'2026-11-13T03:00:00Z'},false],
  [{spoken_at:'invalid',updated_at:'2026-11-12T03:05:00Z'},true],
  [{updated_at:'2026-11-13T03:05:00Z'},false],
  [{},false],
 ]){
  const facts=[{key:'location',value:'PRIVATE_OLD_VALUE',forgotten:true,quote:'PRIVATE_OLD_QUOTE',session_id:id(80),evidence_ids:[id(81)],...times}];
  const m=memory({facts,recent_conversation:recent}),raw={companionId:'alex',scenario:session.scenario,memory:m,checkpoint:null};
  const before=structuredClone(raw),bounded=boundVoiceContext(raw,clock).context;
  for(const source of [raw,bounded]){
   const live=projectLiveConversationContext(source,clock);
   assert.equal(Boolean(live.memory.shared_exchanges?.length),keep,JSON.stringify(times));
   assert.equal(Boolean(buildOpeningContext({context:source,clock,exchangeRevision:7}).shared_exchange),keep,'direct opening must check its own facts');
   assert.equal(Boolean(buildOpeningContext({context:live,clock,exchangeRevision:7}).shared_exchange),keep,'bound/live/opening must preserve the same cutoff');
   assert.equal(JSON.stringify(live).includes('PRIVATE_'),false);
   assert.equal(Object.hasOwn(live.memory.facts[0],'evidence_ids'),false);
   assert.equal(Object.hasOwn(live.memory.facts[0],'session_id'),false);
  }
  const rendered=renderVoiceInstructions(companionProfile('alex'),session,m,undefined,clock);
  assert.equal(rendered.includes(pair().companion.quote),keep,'actual normal render must use the same cutoff');
  assert.equal(rendered.includes('PRIVATE_'),false);
  assert.deepEqual(raw,before);
 }
});
