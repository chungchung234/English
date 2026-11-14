// Real Chromium UI, microphone tracks and IndexedDB; auth/backend/provider/RTC
// transports are fixed fixtures. These checks do not measure live call quality.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const port=Number(process.env.CALL_CONNECTION_TEST_PORT||49458),base=`http://127.0.0.1:${port}`;
const project='https://call-connection-fixture.supabase.co',uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const voiceInstructions='Synthetic approved normal conversation instructions.';
const openingInstructions='Synthetic approved call opening instructions; no caller utterance is present.';
const policy={type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false};
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const eventually=async(check,label)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail(label);};
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:String(port),PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''},stdio:'pipe'});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error('Fixture server exited: '+code)));});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--enable-unsafe-swiftshader','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required']});
const results=[];

async function setup(mode,{missingAbortHelpers=false,vadPending=false,playbackBlocked=false,initialPolicy='good',policyAck='good',initialEventAfterOpen=false}={}){
 const context=await browser.newContext({permissions:['microphone'],viewport:{width:390,height:844},reducedMotion:'reduce'});
 await context.addInitScript(({mode,missingAbortHelpers,vadPending,playbackBlocked,initialPolicy,policyAck,initialEventAfterOpen,voiceInstructions,policy})=>{
  window.connectionFixture={mode,vadPending,playbackBlocked,initialPolicy,policyAck,initialEventAfterOpen,peers:[],streams:[],sent:[],playAttempts:0};
  if(missingAbortHelpers){Object.defineProperty(AbortSignal,'any',{configurable:true,value:undefined});Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});Object.defineProperty(Map,'groupBy',{configurable:true,value:undefined});}
  if(vadPending)WebAssembly.instantiate=()=>new Promise(()=>{});
  const realCapture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await realCapture(constraints);window.connectionFixture.streams.push(stream);return stream;};
  const realPlay=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(...args){
   if(this.id==='remote-audio'){window.connectionFixture.playAttempts++;if(window.connectionFixture.playbackBlocked)return Promise.reject(new DOMException('Synthetic autoplay denial','NotAllowedError'));return Promise.resolve();}
   return realPlay.apply(this,args);
  };
  window.RTCPeerConnection=class{
   constructor(){this.mode=window.connectionFixture.mode;this.connectionState='new';this.tracks=[];this.index=window.connectionFixture.peers.length;this.providerPolicy=window.connectionFixture.initialPolicy==='absent'?null:window.connectionFixture.initialPolicy==='wrong'?{type:'server_vad',threshold:.5,create_response:true,interrupt_response:true}:{...policy};window.connectionFixture.peers.push(this);window.testPeer=this;}
   addTrack(track){this.tracks.push(track);}
   emit(event){this.dc?.onmessage?.({data:JSON.stringify(event)});}
   createDataChannel(){return this.dc={readyState:'connecting',send:raw=>{
    const event=JSON.parse(raw);window.connectionFixture.sent.push({peer:this.index,event});
    if(event.type==='response.create')queueMicrotask(()=>{
     const id='fixture-response-'+this.index+'-'+window.connectionFixture.sent.length,item='assistant-'+id;
     this.emit({type:'response.created',response:{id,metadata:event.response?.metadata}});
     this.emit({type:'response.output_item.added',response_id:id,item:{id:item,type:'message',role:'assistant'}});
     this.emit({type:'output_audio_buffer.started',response_id:id});
     this.emit({type:'response.output_audio_transcript.done',response_id:id,item_id:item,transcript:'A fixed synthetic greeting.'});
     this.emit({type:'response.done',response:{id,status:'completed',metadata:event.response?.metadata,usage:{input_tokens:10},output:[{id:item,type:'message',role:'assistant',content:[{type:'output_audio',transcript:'A fixed synthetic greeting.'}]}]}});
     this.emit({type:'output_audio_buffer.stopped',response_id:id});
    });
    if(event.type==='session.update'){
     const requested=event.session?.audio?.input?.turn_detection;
     const acknowledge=()=>{if(requested)this.providerPolicy=window.connectionFixture.policyAck==='wrong'?{...requested,create_response:true,interrupt_response:true}:{...requested};this.emit({type:'session.updated',session:{instructions:voiceInstructions,audio:{input:this.providerPolicy?{turn_detection:this.providerPolicy}:{},output:{speed:event.session?.audio?.output?.speed||.85}}}});};
     if(!requested||window.connectionFixture.policyAck==='good')queueMicrotask(acknowledge);
     else if(window.connectionFixture.policyAck==='held')this.releasePolicy=()=>{window.connectionFixture.policyAck='good';acknowledge();};
     else if(window.connectionFixture.policyAck==='wrong')queueMicrotask(acknowledge);
    }
   }};}
   async createOffer(){this.offerStarted=true;if(this.mode==='offer-hang')await new Promise(resolve=>{this.releaseOffer=resolve;});return{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}
   async setLocalDescription(){this.localStarted=true;if(this.mode==='local-hang')await new Promise(resolve=>{this.releaseLocal=resolve;});}
   async setRemoteDescription(){
    this.remoteStarted=true;if(this.mode==='remote-hang')await new Promise(resolve=>{this.releaseRemote=resolve;});this.descriptionApplied=true;
    this.remote=new MediaStream(this.tracks.map(track=>{const clone=track.clone();clone.enabled=true;return clone;}));
    this.ontrack?.({streams:[this.remote],track:this.remote.getTracks()[0]});
    const initial=()=>this.emit({type:'session.created',session:{instructions:voiceInstructions,audio:{input:this.providerPolicy?{turn_detection:this.providerPolicy}:{},output:{speed:.85}}}});
    if(!window.connectionFixture.initialEventAfterOpen)initial();
    if(this.mode==='ice-hang')this.connectionState='connecting';
    else if(this.mode==='data-hang'){this.connectionState='connected';this.onconnectionstatechange?.();}
    else if(this.mode==='rtc-hang'){this.connectionState='connecting';this.dc.readyState='open';this.dc.onopen?.();}
    else{this.connectionState='connected';this.onconnectionstatechange?.();this.dc.readyState='open';this.dc.onopen?.();}
    if(window.connectionFixture.initialEventAfterOpen)initial();
   }
   close(){this.closed=true;this.connectionState='closed';if(this.dc)this.dc.readyState='closed';this.remote?.getTracks().forEach(track=>track.stop());}
  };
 },{mode,missingAbortHelpers,vadPending,playbackBlocked,initialPolicy,policyAck,initialEventAfterOpen,voiceInstructions,policy});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const errors=[],routeErrors=[],sessions=[],saved=new Map(),voiceRequests=[],diagnostics=[],finishes=[],pending={},failedRequests=new WeakSet();
 page.on('pageerror',error=>errors.push(error.message));page.on('requestfailed',request=>failedRequests.add(request));
 await page.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:`globalThis.LOOP_PUBLIC_CONFIG=${JSON.stringify({url:project,key:'sb_publishable_fixture'})};`}));
 await page.route(project+'/**',async route=>{
  const request=route.request(),url=new URL(request.url()),body=request.postData()?request.postDataJSON():{};
  try{
   let data=[];
   if(url.pathname==='/auth/v1/settings')data={external:{google:false,kakao:false}};
   else if(url.pathname==='/auth/v1/user')data={id:uid};
   else if(url.pathname.endsWith('/coach/config'))data={models:{voice:'fixture'},capabilities:{manual_turns_v1:true}};
   else if(url.pathname.endsWith('/coach/memory-manage'))data={revision:0,facts:[],excluded_sessions:[],history_suppressed:false};
   else if(url.pathname.endsWith('/coach/memory'))data={memories:[]};
   else if(url.pathname.endsWith('/coach/memory-prepare'))data={status:'unavailable'};
   else if(url.pathname.endsWith('/coach/voice')){
    voiceRequests.push(body);if(mode==='voice-hang'&&!pending.voice){pending.voice=defer();await pending.voice.promise;}
    data={sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',voice_instructions:voiceInstructions,opening_instructions:openingInstructions,audio_policy:{version:'fixture',turn_control:'manual_turns_v1',expected_noise_reduction:'far_field',turn_detection:policy}};
   }else if(url.pathname.endsWith('/coach/review'))return route.fulfill({status:503,json:{error:{code:'UPSTREAM_UNAVAILABLE',message:'Synthetic feedback unavailable.'}}});
   else if(url.pathname.endsWith('/rpc/learning_snapshot'))data={items:[],recommended_item_ids:[],next_plan:null,feedback:[]};
   else if(url.pathname.endsWith('/rpc/learning_enhancement_snapshot'))data={reviews:[],schedules:[],recalls:[],usage:[],weekly_goals:[],imports:[],personalized_item_ids:[],recommendation_reasons:{}};
   else if(url.pathname.endsWith('/rpc/learning_record_event'))data={saved:true};
   else if(url.pathname.endsWith('/rpc/record_call_diagnostics')){diagnostics.push(...(body.p_events||[]));data={event_ids:(body.p_events||[]).map(event=>event.event_id),dropped_event_ids:[]};}
   else if(url.pathname.endsWith('/rpc/append_events')){for(const event of body.p_events)saved.set(event.id,{...event,session_id:body.p_session_id});data={inserted:body.p_events.length,event_ids:body.p_events.map(event=>event.id)};}
   else if(url.pathname.endsWith('/rpc/finish_session')){finishes.push(body.p_session_id);data=sessions.find(session=>session.id===body.p_session_id);if(data){data.status='ended';data.ended_at=new Date().toISOString();}else return route.fulfill({status:404,json:{message:'Synthetic session does not exist.'}});}
   else if(url.pathname==='/rest/v1/sessions'){
    if(request.method()==='POST'){
     const row={...body,status:'active',created_at:new Date().toISOString()};sessions.unshift(row);
     if(mode==='session-hang'&&!pending.session){pending.session=defer();await pending.session.promise;}data=[row];
    }else data=sessions.filter(session=>(!url.searchParams.get('id')||session.id===url.searchParams.get('id').slice(3))&&(!url.searchParams.get('companion_id')||session.companion_id===url.searchParams.get('companion_id').slice(3))&&(!url.searchParams.get('status')||session.status===url.searchParams.get('status').slice(3)));
   }else if(url.pathname==='/rest/v1/transcript_events')data=[...saved.values()].filter(event=>!url.searchParams.get('session_id')||event.session_id===url.searchParams.get('session_id').slice(3)).map(event=>({...event,timestamp:event.occurred_at}));
   await route.fulfill({json:data,headers:Array.isArray(data)?{'Content-Range':`0-${Math.max(0,data.length-1)}/${data.length}`,'Access-Control-Expose-Headers':'Content-Range'}:{}});
  }catch(error){if(!page.isClosed()&&!failedRequests.has(request)){routeErrors.push(error.message);await route.fulfill({status:500,json:{message:'Synthetic route failed.'}}).catch(()=>{});}}
 });
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.evaluate(({project,uid})=>localStorage.setItem('loop.auth:'+project,JSON.stringify({access_token:'fixture-jwt',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}})),{project,uid});
 await page.reload({waitUntil:'domcontentloaded'});await page.locator('#workspace').waitFor({state:'visible'});await page.clock.install();
 const state=()=>page.evaluate(()=>({phase:document.body.dataset.callPhase,clock:document.querySelector('#call-timer').textContent,peers:window.connectionFixture.peers.map(peer=>({closed:peer.closed||false,state:peer.connectionState,dc:peer.dc?.readyState,offer:peer.offerStarted||false,local:peer.localStarted||false,remote:peer.remoteStarted||false,description:peer.descriptionApplied||false})),tracks:window.connectionFixture.streams.flatMap(stream=>stream.getTracks()).map(track=>({enabled:track.enabled,state:track.readyState})),greetings:window.connectionFixture.sent.filter(({event})=>event.type==='response.create').length}));
 const start=async()=>{await page.locator('#start-call').click();await eventually(async()=>{const s=await state();return s.tracks.length>0;},'the fixture should receive a real microphone stream');};
 const release=async()=>{for(const gate of Object.values(pending))gate.resolve();await page.evaluate(()=>{for(const peer of window.connectionFixture.peers){peer.releaseOffer?.();peer.releaseLocal?.();peer.releaseRemote?.();}});};
 const dispose=async()=>{await release();await context.close();assert.deepEqual(errors,[]);assert.deepEqual(routeErrors,[]);};
 return{context,page,state,start,release,dispose,sessions,voiceRequests,diagnostics,finishes};
}

try{
 await mkdir('test-results',{recursive:true});
 for(const mode of ['session-hang','offer-hang','local-hang','voice-hang','remote-hang','ice-hang','data-hang','rtc-hang']){
  const test=await setup(mode);await test.start();
  await eventually(async()=>mode==='session-hang'?test.sessions.length===1:mode==='voice-hang'?test.voiceRequests.length===1:(await test.state()).peers.some(peer=>mode==='offer-hang'?peer.offer:mode==='local-hang'?peer.local:mode==='remote-hang'?peer.remote:peer.description),'the controlled setup stage should be reached');
  let before=await test.state();assert.equal(before.phase,'connecting');assert.equal(before.clock,'00:00');assert.equal(before.greetings,0);
  await test.page.clock.runFor(46000);
  await eventually(async()=>await test.page.locator('#call-help').isVisible(),'a stalled initial connection must leave dialing and show recovery help');
  await eventually(async()=>(await test.state()).tracks.every(track=>track.state==='ended'),'initial timeout releases every captured microphone track');
  await eventually(()=>Promise.resolve(test.sessions.every(session=>session.status==='ended')),'a server-created session must be closed even if its POST response never arrived');
  let failed=await test.state();assert.notEqual(failed.phase,'connecting');assert.equal(failed.clock,'00:00');assert.equal(failed.greetings,0);assert(failed.peers.every(peer=>peer.closed));assert.equal(await test.page.locator('#start-call').isDisabled(),false);
  if(mode!=='session-hang')await eventually(()=>Promise.resolve(test.diagnostics.some(issue=>issue.code==='CALL_CONNECT_TIMEOUT')),'the timeout reaches account-scoped diagnostics');
  if(mode==='ice-hang')await test.page.screenshot({path:'test-results/call-connection-timeout-390.png',fullPage:true});
  await test.page.evaluate(()=>{window.connectionFixture.mode='ready';});
  await test.page.locator('#call-help-retry').click();await eventually(async()=>(await test.state()).phase==='connected','retry should create a fresh usable connection');
  await test.release();await test.page.clock.runFor(500);
  await eventually(async()=>(await test.state()).greetings===1,'late completion from a failed attempt must not duplicate the fresh greeting');
  await test.page.clock.runFor(46000);
  const retried=await test.state();assert.equal(retried.phase,'connected','the setup deadline is permanently disarmed after usable readiness');assert.equal(retried.greetings,1);assert(retried.tracks.some(track=>track.state==='live'));assert.equal(await test.page.locator('#call-help').isVisible(),false);
  assert(test.voiceRequests.every(request=>request.turnControl==='manual_turns_v1'),'this regression must actually exercise the supported manual path');
  results.push({case:mode,timeout:true,microphoneReleased:true,serverSessionClosed:true,lateCompletionIgnored:true,retryConnected:true});await test.dispose();
 }
 for(const initialPolicy of ['absent','wrong']){
  const test=await setup('ready',{initialPolicy,policyAck:'held',initialEventAfterOpen:true});await test.start();
  await eventually(()=>test.page.evaluate(()=>typeof window.testPeer?.releasePolicy==='function'),'an explicit manual-policy update should be sent after opening the data channel');
  const waiting=await test.state();assert.equal(waiting.peers[0].state,'connected');assert.equal(waiting.peers[0].dc,'open');assert.equal(waiting.phase,'connecting');assert.equal(waiting.clock,'00:00');assert.equal(waiting.greetings,0,'initial settings alone cannot start the call');
  await test.page.clock.runFor(2000);assert.equal((await test.state()).phase,'connecting');assert.equal((await test.state()).greetings,0);
  await test.page.evaluate(()=>window.testPeer.releasePolicy());await eventually(async()=>(await test.state()).phase==='connected','a matching manual-policy ACK should unlock usable readiness');await test.page.clock.runFor(500);assert.equal((await test.state()).greetings,1);assert(!test.diagnostics.some(issue=>issue.code==='VOICE_POLICY_UNCONFIRMED'));
  results.push({case:'initial-policy-'+initialPolicy,initialPolicyAfterDataOpen:true,explicitPolicyRequested:true,clockAndGreetingWaitForAck:true,matchingAckConnected:true});await test.dispose();
 }
 for(const policyAck of ['wrong','absent']){
  const test=await setup('ready',{policyAck});await test.start();
  await eventually(()=>test.page.evaluate(()=>window.connectionFixture.sent.some(({event})=>event.type==='session.update'&&event.session?.audio?.input?.turn_detection)),'the explicit policy confirmation request must be observed');
  const waiting=await test.state();assert.equal(waiting.peers[0].state,'connected');assert.equal(waiting.peers[0].dc,'open');assert.equal(waiting.phase,'connecting');assert.equal(waiting.clock,'00:00');assert.equal(waiting.greetings,0);
  await test.page.clock.runFor(8100);await eventually(async()=>await test.page.locator('#call-help').isVisible(),'a wrong or absent policy ACK should recover before the overall connection deadline');
  await eventually(async()=>(await test.state()).tracks.every(track=>track.state==='ended'),'failed initial policy negotiation releases the captured microphone');
  await eventually(()=>Promise.resolve(test.sessions.every(session=>session.status==='ended')),'failed initial policy negotiation closes the owned setup session');
  await eventually(()=>Promise.resolve(test.diagnostics.some(issue=>issue.code==='VOICE_POLICY_UNCONFIRMED')),'the policy failure is distinguishable from an RTC connection timeout');
  assert(!test.diagnostics.some(issue=>issue.code==='CALL_CONNECT_TIMEOUT'));assert.equal((await test.state()).clock,'00:00');assert.equal((await test.state()).greetings,0);assert((await test.state()).peers.every(peer=>peer.closed));
  await test.page.evaluate(()=>{window.connectionFixture.policyAck='good';window.connectionFixture.initialPolicy='good';});await test.page.locator('#call-help-retry').click();await eventually(async()=>(await test.state()).phase==='connected','a fresh attempt can confirm the policy and connect');await test.page.clock.runFor(500);assert.equal((await test.state()).greetings,1);
  results.push({case:'policy-ack-'+policyAck,policyTimeout:true,microphoneReleased:true,serverSessionClosed:true,noPrematureGreetingOrClock:true,retryConnected:true});await test.dispose();
 }
 const cancelled=await setup('remote-hang');await cancelled.start();await eventually(async()=>(await cancelled.state()).peers.some(peer=>peer.remote),'remote description should be held before user cancellation');
 await cancelled.page.locator('#cancel-connection').click();await eventually(async()=>(await cancelled.state()).tracks.every(track=>track.state==='ended'),'user cancellation releases capture synchronously');
 await cancelled.release();await cancelled.page.clock.runFor(46000);assert.notEqual((await cancelled.state()).phase,'connecting');assert.equal((await cancelled.state()).greetings,0);assert.equal(await cancelled.page.locator('#call-help').isVisible(),false,'cancel must not turn into a later timeout warning');results.push({case:'cancel-late-remote',cancelled:true,lateCompletionIgnored:true});await cancelled.dispose();
 const compatibility=await setup('ready',{missingAbortHelpers:true,vadPending:true});await compatibility.start();await eventually(async()=>(await compatibility.state()).phase==='connected','missing optional AbortSignal helpers and pending VAD must not block RTC readiness');await compatibility.page.clock.runFor(500);assert.equal((await compatibility.state()).greetings,1);await compatibility.page.clock.runFor(46000);assert.equal((await compatibility.state()).phase,'connected');results.push({case:'missing-abort-helpers-and-pending-vad',connected:true});await compatibility.dispose();
 const playback=await setup('ready',{playbackBlocked:true});await playback.start();await eventually(async()=>(await playback.state()).phase==='connected','autoplay denial must not undo actual connection');await eventually(()=>playback.page.evaluate(()=>window.connectionFixture.playAttempts>=1),'the real application should attempt to play the remote stream');await playback.page.evaluate(()=>{window.connectionFixture.playbackBlocked=false;});await playback.page.locator('#call-status').click();await eventually(()=>playback.page.evaluate(()=>window.connectionFixture.playAttempts>=2),'a user gesture retries the same stream after autoplay denial');await eventually(async()=>!await playback.page.locator('#notice').isVisible(),'successful playback recovery clears the blocked-playback advice');await playback.page.clock.runFor(500);assert.equal(playback.voiceRequests.length,1);assert.equal((await playback.state()).greetings,1);await playback.page.screenshot({path:'test-results/call-connection-playback-recovered-390.png',fullPage:true});results.push({case:'autoplay-denied-then-tap',retriedSameStream:true,newVoiceRequest:false,recoveryNoticeCleared:true});await playback.dispose();
 await writeFile('test-results/call-connection-result.json',JSON.stringify({fixture:true,manualCapability:true,realMicrophoneTracks:true,actualProvider:false,actualWebRtc:false,modelQualityVerified:false,cases:results},null,2)+'\n');
 console.log('PASS: 15 initial-connection lifecycle scenarios cover bounded setup, explicit policy acknowledgement, owned cleanup, stale completions, retry, missing optional signal helpers, pending VAD and user-gesture playback recovery. Auth/backend/provider/RTC are fixtures.');
}finally{await browser.close();server.kill('SIGTERM');}
