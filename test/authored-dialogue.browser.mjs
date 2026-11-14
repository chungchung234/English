// Full application with real Chromium AudioContext/AudioWorklet and local VAD
// WASM. Auth, database, writer, synthesis, RTC and ASR packets are synthetic.
// Fixture PCM is a tone, not speech; this cannot establish model or acoustic quality.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
const port=49447,base=`http://127.0.0.1:${port}`,project='https://authored-test.supabase.co',uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const protocol='authored_dialogue_v1',policy={type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false};
const instructions='ASR connection only. Never create a response. Caller dialogue authority is maintained separately.';
const wav=await readFile(new URL('./fixtures/live-smoke-utterance.wav',import.meta.url));
let speechRate,speechData;
for(let offset=12;offset+8<=wav.length;){const size=wav.readUInt32LE(offset+4),name=wav.toString('ascii',offset,offset+4),start=offset+8;if(name==='fmt ')speechRate=wav.readUInt32LE(start+4);if(name==='data')speechData=wav.subarray(start,start+size);offset=start+size+size%2;}
const speech=Array.from({length:speechData.length/2},(_,i)=>speechData.readInt16LE(i*2)/32768);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const outputPcm=Buffer.alloc(24000*15*2);for(let i=0;i<outputPcm.length/2;i++)outputPcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/24000)*1200),i*2);
const shortPcm=outputPcm.subarray(0,24000*2);
const root=fileURLToPath(new URL('../',import.meta.url)),directory=await mkdtemp(path.join(tmpdir(),'authored-browser-'));
await Promise.all(['web','src','scripts'].map(name=>cp(path.join(root,name),path.join(directory,name),{recursive:true})));
await cp(path.join(root,'package.json'),path.join(directory,'package.json'));await symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'),'dir');
execFileSync('npm',['run','build','--','--require-config'],{cwd:directory,stdio:'pipe',env:{...process.env,BUILD_SITE_URL:base+'/authored-built/',PUBLIC_SUPABASE_URL:project,PUBLIC_SUPABASE_KEY:'sb_publishable_fixture',GITHUB_SHA:'',CI_COMMIT_SHA:'',VERCEL_GIT_COMMIT_SHA:'',BUILD_SOURCEVERSION:''}});
const html=await readFile(path.join(directory,'dist/index.html'),'utf8'),script=html.match(/src="(assets\/app\.[a-f0-9]{12}\.js)" integrity="sha256-([^"]+)"/);
assert(script);assert.equal(createHash('sha256').update(await readFile(path.join(directory,'dist',script[1]))).digest('base64'),script[2]);
// AudioWorklet module fetches must reach a real HTTP server. Page.route does
// not reliably intercept this execution context and would hide asset failures.
const server=createServer(async(request,response)=>{
 const pathname=new URL(request.url,base).pathname;
 if(!pathname.startsWith('/authored-built/')){response.writeHead(404);response.end();return;}
 const name=decodeURIComponent(pathname.slice('/authored-built/'.length))||'index.html';
 if(name.includes('..')){response.writeHead(404);response.end();return;}
 try{const bytes=await readFile(path.join(directory,'dist',name));response.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.webp':'image/webp','.svg':'image/svg+xml','.png':'image/png'}[path.extname(name)]||'application/octet-stream'});response.end(bytes);}
 catch{response.writeHead(404);response.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--enable-unsafe-swiftshader','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required']});
const eventually=async(check,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail(label);};
const results=[],screens=[];const documentHeight=height=>height-105;
async function layout(page,state){
 const viewport=page.viewportSize();
 await page.evaluate(()=>{window.fixture.fonts=[...document.querySelectorAll('#live-call h1,#live-call h2,#live-call h3,#live-call p,#live-call button,#live-call span,#live-call small,#live-call label')].map(node=>({node,inline:node.style.fontSize}));});
 for(const size of [{width:390,height:844},{width:320,height:568}]){
  await page.setViewportSize(size);await page.evaluate(()=>{for(const {node,inline}of window.fixture.fonts)node.style.fontSize=inline;const sizes=window.fixture.fonts.map(({node})=>({node,size:parseFloat(getComputedStyle(node).fontSize)}));for(const{node,size}of sizes)node.style.fontSize=size*1.25+'px';document.querySelector('#live-call').scrollTop=0;});
  const file=`test-results/authored-${state}-${size.width}.png`;await page.screenshot({path:file,fullPage:true});
  const value=await page.evaluate(()=>{const box=id=>{const node=document.getElementById(id),r=node.getBoundingClientRect();return {y:r.y,bottom:r.bottom,visible:!!node.getClientRects().length,text:node.textContent};};const node=document.getElementById('manual-reply'),r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);const live=document.getElementById('live-call');return{overflow:document.documentElement.scrollWidth>innerWidth,reply:box('manual-reply'),stop:box('stop-response'),end:box('end-call'),replyHit:hit===node||node.contains(hit),scrollable:live.scrollHeight>live.clientHeight};});
  screens.push({state,...size,textScale:1.25,screenshot:file,...value});assert.equal(value.overflow,false);assert(value.reply.visible&&value.reply.y>=0&&value.reply.bottom<=size.height&&value.replyHit,`${state} primary action visible ${size.width}`);assert(value.stop.visible&&value.stop.bottom<=value.end.y,'stop remains above hangup');
  if(size.width===320){
   if(await page.locator('.notice-dismiss').isVisible())await page.locator('.notice-dismiss').click();
   await page.evaluate(()=>{const live=document.getElementById('live-call');live.scrollTop=live.scrollHeight;});
   const secondary=await page.evaluate(()=>['#call-quick-help summary','.transcript-details summary'].map(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {selector,y:r.y,bottom:r.bottom,hit:hit===node||node.contains(hit)};}));
   for(const item of secondary)assert(item.y>=0&&item.bottom<documentHeight(size.height)&&item.hit,'help and transcript must be reachable by scrolling');
   const scrolled=`test-results/authored-${state}-scroll-320.png`;await page.screenshot({path:scrolled,fullPage:true});screens.push({state:'resume-scrolled',...size,textScale:1.25,screenshot:scrolled,secondary});
  }
 }
 await page.evaluate(()=>{for(const{node,inline}of window.fixture.fonts)node.style.fontSize=inline;});await page.setViewportSize(viewport);
}
async function budgetLayout(page){
 const originalViewport=page.viewportSize();
 const selectors='#live-call h1,#live-call p,#live-call button,#live-call span,#live-call small,#notice .notice-message';
 await page.evaluate(selectors=>{window.fixture.budgetFonts=[...document.querySelectorAll(selectors)].map(node=>({node,inline:node.style.fontSize}));},selectors);
 for(const size of [{width:390,height:844},{width:320,height:568}]){
  await page.setViewportSize(size);await page.evaluate(()=>{for(const{node,inline}of window.fixture.budgetFonts)node.style.fontSize=inline;const values=window.fixture.budgetFonts.map(({node})=>({node,size:parseFloat(getComputedStyle(node).fontSize)}));for(const{node,size}of values)node.style.fontSize=size*1.25+'px';document.getElementById('live-call').scrollTop=0;});
  const file=`test-results/authored-budget-${size.width}.png`;await page.screenshot({path:file,fullPage:true});
  const value=await page.evaluate(()=>{const node=document.getElementById('end-call'),r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),notice=document.getElementById('notice').getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth,end:{y:r.y,bottom:r.bottom,hit:hit===node||node.contains(hit),disabled:node.disabled},notice:{y:notice.y,bottom:notice.bottom,visible:!!document.getElementById('notice').getClientRects().length},status:document.getElementById('call-status').textContent};});
  assert.equal(value.overflow,false);assert(value.end.y>=0&&value.end.bottom<=size.height&&value.end.hit&&!value.end.disabled,'budget hangup remains visible');assert(value.notice.visible&&value.notice.y>=0&&value.notice.bottom<=value.end.y,'visible budget notice stays above hangup');screens.push({state:'budget',...size,textScale:1.25,screenshot:file,...value});
 }
 await page.evaluate(()=>{for(const{node,inline}of window.fixture.budgetFonts)node.style.fontSize=inline;});await page.setViewportSize(originalViewport);
}
async function setup({holdPolicy=false,holdRaw=false,badManifest=false,short=false,weak=false,failPrune=0,budgetCode=null}={}){
 const context=await browser.newContext({permissions:['microphone'],viewport:{width:390,height:844},reducedMotion:'reduce'});
 await context.addInitScript(({speech,speechRate,holdPolicy,instructions,weak,failPrune})=>{
  window.fixture={nodes:[],pcmEvents:[],detectors:[],messages:[],holdPolicy,instructions,weak,failPrune,nodeErrors:[],moduleErrors:[],audioContexts:[]};
  const NativeContext=window.AudioContext;window.AudioContext=new Proxy(NativeContext,{construct(Target,args){const context=Reflect.construct(Target,args);window.fixture.audioContexts.push(context);const close=context.close.bind(context);context.close=()=>{if(window.fixture.trackAuthClose&&window.fixture.nodes.some(node=>node.context===context))sessionStorage.setItem('authored-auth-close-count',String(Number(sessionStorage.getItem('authored-auth-close-count')||0)+1));return close();};const add=context.audioWorklet.addModule.bind(context.audioWorklet);context.audioWorklet.addModule=(...params)=>add(...params).catch(error=>{window.fixture.moduleErrors.push({name:error.name,message:error.message,params});throw error;});return context;}});
  const NativeNode=window.AudioWorkletNode;window.AudioWorkletNode=new Proxy(NativeNode,{construct(Target,args){let node;try{node=Reflect.construct(Target,args);}catch(error){window.fixture.nodeErrors.push({name:error.name,message:error.message});throw error;}window.fixture.nodes.push(node);node.port.addEventListener('message',event=>window.fixture.pcmEvents.push(event.data));node.port.start();return node;}});
  if(weak)AudioContext.prototype.getOutputTimestamp=undefined;
  const create=AudioContext.prototype.createScriptProcessor;AudioContext.prototype.createScriptProcessor=function(...args){const node=create.apply(this,args);let callback;Object.defineProperty(node,'onaudioprocess',{configurable:true,get:()=>callback,set:value=>{callback=value;}});window.fixture.detectors.push(node);return node;};
  window.feedLocalAudio=async()=>{const node=[...window.fixture.detectors].reverse().find(node=>typeof node.onaudioprocess==='function'&&node.context.state==='running');if(!node)throw Error('Missing local analyzer');const rate=node.context.sampleRate,size=1024;for(let offset=0;offset<rate*.7;offset+=size){const mic=new Float32Array(size),ref=new Float32Array(size),out=new Float32Array(size);for(let i=0;i<size;i++){const pos=(offset+i)*speechRate/rate,left=Math.floor(pos),fraction=pos-left;mic[i]=(speech[left]||0)+((speech[left+1]||0)-(speech[left]||0))*fraction;}node.onaudioprocess({inputBuffer:{numberOfChannels:2,getChannelData:index=>index===0?mic:ref},outputBuffer:{numberOfChannels:1,getChannelData:()=>out}});await new Promise(resolve=>setTimeout(resolve,20));}};
  window.RTCPeerConnection=class{
   constructor(){window.fixture.peer=this;this.connectionState='new';this.tracks=[];}
   addTrack(track){this.tracks.push(track);}
   emit(event){this.dc.onmessage?.({data:JSON.stringify(event)});}
   createDataChannel(){return this.dc={readyState:'open',send:raw=>{const event=JSON.parse(raw);window.fixture.messages.push(event);if(event.type==='session.update'&&event.session?.audio?.input?.turn_detection){const ack={type:'session.updated',session:{audio:{input:{turn_detection:event.session.audio.input.turn_detection}}}};if(window.fixture.holdPolicy)window.fixture.releasePolicy=()=>{window.fixture.holdPolicy=false;this.emit(ack);};else queueMicrotask(()=>this.emit(ack));}if(event.type==='conversation.item.delete')queueMicrotask(()=>{if(window.fixture.failPrune>0){window.fixture.failPrune--;this.emit({type:'error',error:{event_id:event.event_id,code:'delete_unavailable'}});}else this.emit({type:'conversation.item.deleted',item_id:event.item_id});});}};}
   async createOffer(){return{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}async setLocalDescription(){}
   async setRemoteDescription(){this.remote=new MediaStream([this.tracks[0].clone()]);this.ontrack?.({streams:[this.remote],track:this.remote.getAudioTracks()[0]});this.emit({type:'session.created',session:{instructions:window.fixture.instructions,audio:{input:{turn_detection:{type:'server_vad',create_response:true,interrupt_response:true}}}}});this.connectionState='connected';this.onconnectionstatechange?.();this.dc.onopen?.();}
   close(){this.connectionState='closed';this.dc.readyState='closed';this.remote?.getTracks().forEach(track=>track.stop());}
  };
 },{speech,speechRate,holdPolicy,instructions,weak,failPrune});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const sessions=[],saved=new Map(),turns=[],syntheses=[],cancels=[],reports=[],contexts=[],errors=[],routeErrors=[],diagnostics=[],consoleErrors=[];let generation=0,authorityGeneration=1,memoryRevision=0,releaseRaw;
 const rawAck=new Promise(resolve=>{releaseRaw=resolve;});if(!holdRaw)releaseRaw();
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 await page.route(project+'/**',async route=>{const request=route.request(),url=new URL(request.url()),body=request.postData()?request.postDataJSON():{};let data=[];
  try{
   if(url.pathname==='/auth/v1/user')data={id:uid};else if(url.pathname==='/auth/v1/settings')data={external:{google:false,kakao:false}};
   else if(url.pathname.endsWith('/coach/config'))data={capabilities:{manual_turns_v1:true,authored_dialogue_v1:true}};
   else if(url.pathname.endsWith('/coach/memory'))data={memories:[]};else if(url.pathname.endsWith('/coach/memory-prepare'))data={status:'unavailable'};
   else if(url.pathname.endsWith('/coach/dialogue-context')){contexts.push(body);if(body.omitLearningContext){authorityGeneration++;memoryRevision=null;}data={protocol,callEpoch:body.callEpoch,authorityGeneration,generation,memoryRevision,memoryMode:body.omitLearningContext?'omitted':'included',companionId:sessions[0].companion_id};}
   else if(url.pathname.endsWith('/coach/dialogue-voice')){assert.equal(body.protocol,protocol);data={sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',voice_instructions:instructions,opening_instructions:instructions,memory_revision:null,voice_policy_version:'asr-fixture',audio_policy:{turn_control:'manual_turns_v1',turn_detection:policy,expected_noise_reduction:'far_field',microphone_mode:'unknown'}};}
   else if(url.pathname.endsWith('/coach/dialogue-turn')){assert.equal(body.expectedGeneration,generation);for(const id of [...body.currentUserEventIds,...body.acceptedHistoryEventIds])assert(saved.has(id));turns.push(structuredClone(body));if(budgetCode&&turns.length>=2)return route.fulfill({status:429,json:{error:{code:budgetCode,message:'Synthetic budget exhausted.'}}});generation++;const id=randomUUID(),text='Synthetic authored reply with its own perspective.';const owner={scope:project+'|'+uid,sessionId:body.sessionId,companionId:sessions[0].companion_id,callEpoch:body.callEpoch,turnNonce:body.turnNonce,turnId:randomUUID(),assistantEventId:id,authorityGeneration:body.authorityGeneration,expectedMemoryRevision:body.expectedMemoryRevision,playbackEpoch:body.playbackEpoch};const assistantEvent={id,session_id:body.sessionId,event_key:'authored:'+body.turnNonce,speaker:'assistant',text,occurred_at:new Date().toISOString(),storage:'server'};saved.set(id,assistantEvent);data={protocol,owner,generation,text,textSha256:digest(text),assistantEvent};}
   else if(url.pathname.endsWith('/coach/dialogue-synthesis')){syntheses.push(structuredClone(body));const pcm=short?shortPcm:outputPcm;data={manifest:{version:'verified-pcm-candidate-v1',owner:body.owner,textSha256:digest('Synthetic authored reply with its own perspective.'),pcmSha256:badManifest?'0'.repeat(64):digest(pcm),format:'pcm_s16le',sampleRate:24000,channels:1,sourceFrames:pcm.length/2,byteLength:pcm.length,synthesisId:randomUUID(),transcriptVerification:{status:'matched',policyVersion:'lexical-fidelity-v1',approvedTextSha256:digest('Synthetic authored reply with its own perspective.')},synthesisSpeed:.85},pcmBase64:pcm.toString('base64')};}
   else if(url.pathname.endsWith('/coach/dialogue-cancel')){cancels.push(body);generation++;data={protocol,...body,cancelled:true,status:'cancelled',generation};}
   else if(url.pathname.endsWith('/coach/dialogue-playback')){const written=turns.find(turn=>turn.turnNonce===body.owner.turnNonce);assert(written);const sources=new Set([...written.currentUserEventIds,...written.acceptedHistoryEventIds]);assert(body.qualifiedUserEventIds.every(id=>sources.has(id)),'playback caller IDs must belong to the writer source tuple');reports.push(structuredClone(body));data={protocol,owner:body.owner,generation:body.generation,receiptId:body.receiptId,status:'recorded',reason:null};}
   else if(url.pathname.endsWith('/rpc/finish_session')){data=sessions.find(session=>session.id===body.p_session_id);data.status='ended';data.ended_at=new Date().toISOString();}
   else if(url.pathname.endsWith('/coach/review'))return route.fulfill({status:503,json:{error:{code:'UPSTREAM_UNAVAILABLE',message:'No model output in fixture.'}}});
   else if(url.pathname.endsWith('/rpc/append_events')){await rawAck;for(const event of body.p_events)saved.set(event.id,{...event,session_id:body.p_session_id});data={inserted:body.p_events.length,event_ids:body.p_events.map(event=>event.id)};}
   else if(url.pathname.endsWith('/rpc/record_call_diagnostics')){diagnostics.push(...body.p_events);data={event_ids:(body.p_events||[]).map(row=>row.event_id)};}
   else if(url.pathname.endsWith('/rpc/learning_snapshot'))data={items:[],recommended_item_ids:[],next_plan:null,feedback:[]};
   else if(url.pathname.endsWith('/rpc/learning_enhancement_snapshot'))data={reviews:[],schedules:[],recalls:[],usage:[],weekly_goals:[],imports:[],personalized_item_ids:[],recommendation_reasons:{}};
   else if(url.pathname.endsWith('/rpc/learning_record_event'))data={saved:true};
   else if(url.pathname==='/rest/v1/sessions'){if(request.method()==='POST'){const row={...body,status:'active',created_at:new Date().toISOString()};sessions.unshift(row);data=[row];}else data=sessions;}
   else if(url.pathname==='/rest/v1/transcript_events')data=[...saved.values()].map(row=>({...row,timestamp:row.occurred_at}));
   await route.fulfill({json:data,headers:Array.isArray(data)?{'Content-Range':`0-${Math.max(0,data.length-1)}/${data.length}`,'Access-Control-Expose-Headers':'Content-Range'}:{}});
  }catch(error){routeErrors.push(error.stack);await route.fulfill({status:500,json:{message:'Fixture failed'}});}
 });
 await page.goto(base+'/authored-built/',{waitUntil:'domcontentloaded'});await page.evaluate(({project,uid})=>localStorage.setItem('loop.auth:'+project,JSON.stringify({access_token:'fixture-jwt',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}})),{project,uid});await page.reload({waitUntil:'domcontentloaded'});await page.locator('#workspace').waitFor({state:'visible'});await page.locator('#start-call').click();
 const emit=event=>page.evaluate(event=>window.fixture.peer.emit(event),event),local=()=>page.evaluate(()=>window.feedLocalAudio());
 const input=async(id,transcript,failed=false)=>{await emit({type:'input_audio_buffer.speech_stopped',item_id:id});await emit({type:'input_audio_buffer.committed',item_id:id});await emit(failed?{type:'conversation.item.input_audio_transcription.failed',item_id:id,error:{code:'fixture_failure'}}:{type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript});};
 return {context,page,sessions,saved,turns,syntheses,cancels,reports,contexts,errors,routeErrors,diagnostics,consoleErrors,releaseRaw,emit,local,input};
}
try{
 await mkdir('test-results',{recursive:true});
 const f=await setup({holdPolicy:true,holdRaw:true,failPrune:1});
 await eventually(()=>f.page.evaluate(()=>!!window.fixture.releasePolicy),'policy command sent');assert.equal(f.turns.length,0);assert.equal(await f.page.locator('#call-timer').textContent(),'00:00');
 await f.page.evaluate(()=>window.fixture.releasePolicy());try{await eventually(()=>f.page.evaluate(()=>window.fixture.pcmEvents.some(event=>event.kind==='started')),'native authored PCM starts');}catch(error){console.error(JSON.stringify({turns:f.turns,syntheses:f.syntheses,cancels:f.cancels,contexts:f.contexts,errors:f.errors,routeErrors:f.routeErrors,diagnostics:f.diagnostics,consoleErrors:f.consoleErrors,view:await f.page.evaluate(()=>({status:document.getElementById('call-status').textContent,notice:document.getElementById('notice').textContent,events:window.fixture.pcmEvents,messages:window.fixture.messages,contexts:window.fixture.audioContexts.map(context=>context.state),nodeErrors:window.fixture.nodeErrors,moduleErrors:window.fixture.moduleErrors,body:document.body.dataset}))},null,2));throw error;}
 assert.equal(f.turns.length,1);assert.equal(f.turns[0].purpose,'startup');assert.deepEqual(f.turns[0].currentUserEventIds,[]);
 assert.equal(await f.page.evaluate(()=>window.fixture.messages.filter(event=>event.type==='response.create').length),0);assert.equal(await f.page.evaluate(()=>document.getElementById('remote-audio').srcObject),null);
 results.push({case:'policy-ACK and authored-only startup',passed:true});
 await f.emit({type:'input_audio_buffer.speech_started',item_id:'noise'});await f.local();await eventually(()=>f.page.evaluate(()=>window.fixture.pcmEvents.some(event=>event.kind==='pause_applied')),'qualified candidate pauses');
 const before=await f.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='pause_applied').at(-1).cursor);
 await f.input('noise','');await eventually(()=>f.page.evaluate(()=>window.fixture.pcmEvents.some(event=>event.kind==='resume_applied')),'empty ASR resumes same PCM');
 const resumed=await f.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='resume_applied').at(-1).cursor);assert.equal(resumed.sourceFrame,before.sourceFrame);assert.equal(resumed.phaseNumerator,before.phaseNumerator);assert.equal(f.syntheses.length,1);assert.equal(f.cancels.length,0);assert(!/다시 연결|확인하지 못/.test(await f.page.locator('#call-status').textContent()),'optional ASR buffer cleanup failure cannot block the reply');
 results.push({case:'empty ASR resumes exact cursor without generation',passed:true});
 await f.emit({type:'input_audio_buffer.speech_started',item_id:'uncertain'});await f.local();await f.input('uncertain','',true);await eventually(async()=>await f.page.locator('#manual-reply').textContent()==='이어 듣기','uncertain ASR explicit resume');await layout(f.page,'resume');
 await f.page.locator('#manual-reply').click();await eventually(()=>f.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='resume_applied').length>=2),'gesture resumes same buffer');assert.equal(f.syntheses.length,1);
 results.push({case:'ASR failure explicit same-buffer resume',passed:true});
 await f.emit({type:'input_audio_buffer.speech_started',item_id:'real-user'});await f.local();await f.input('real-user','A current synthetic caller thought.');await eventually(()=>f.cancels.length===1,'real speech cancels old output');await new Promise(resolve=>setTimeout(resolve,150));assert.equal(f.turns.length,1,'raw server ACK must precede writer');f.releaseRaw();await eventually(()=>f.turns.length===2,'saved current speech receives a new reply');assert.equal(f.turns[1].purpose,'reply');assert.equal(f.turns[1].currentUserEventIds.length,1);assert.equal(f.turns[1].acceptedHistoryEventIds.length,0,'cancelled AI text cannot enter writer history');
 await eventually(()=>f.page.evaluate(()=>window.fixture.messages.some(event=>event.type==='conversation.item.delete'&&event.item_id==='real-user')),'saved caller provider buffer pruned');
 const priorUser=f.turns[1].currentUserEventIds[0];
 await f.emit({type:'input_audio_buffer.speech_started',item_id:'after-prune'});await f.local();await f.input('after-prune','Another current caller thought after transient buffer pruning.');await eventually(()=>f.turns.length===3,'later writer can use saved source after provider pruning');assert(f.turns[2].acceptedHistoryEventIds.includes(priorUser),'server-backed qualified caller survives transient provider deletion');
 assert.equal(f.reports.length,0,'interrupted output has no completed playback report');
 results.push({case:'accepted speech cancellation, raw ACK and transient provider pruning',passed:true});assert.deepEqual(f.errors,[]);assert.deepEqual(f.routeErrors,[]);
 const starts=await f.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='started').length);
 await f.page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
 assert.equal(await f.page.locator('#mute-call').isDisabled(),true);assert.equal(await f.page.locator('#manual-reply').textContent(),'대화 다시 연결');assert.equal(await f.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='started').length),starts);
 results.push({case:'page lifecycle cannot revive old playback or microphone',passed:true});
 await Promise.all([f.page.waitForEvent('domcontentloaded'),f.page.evaluate(project=>{sessionStorage.setItem('authored-auth-close-count','0');window.fixture.trackAuthClose=true;localStorage.removeItem('loop.auth:'+project);const channel=new BroadcastChannel('loop.auth:'+project);channel.postMessage({event:'SIGNED_OUT',session:null});setTimeout(()=>channel.close(),1000);},project)]);
 assert(Number(await f.page.evaluate(()=>sessionStorage.getItem('authored-auth-close-count')))>=1,'account transition closes native playback before reload');
 results.push({case:'real SDK cross-tab signout closes owned audio before reload',passed:true});await f.context.close();
 const bad=await setup({badManifest:true});await eventually(async()=>await bad.page.locator('#manual-reply').textContent()==='대화 다시 연결','manifest mismatch recovery');assert.equal(await bad.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='started').length),0);assert.equal(bad.reports.length,0);await bad.page.locator('#manual-reply').click();await eventually(()=>bad.contexts.length===2,'explicit authority refresh');assert.equal(bad.contexts[1].omitLearningContext,true);assert.equal(bad.contexts[1].reset,true);assert.equal(Object.hasOwn(bad.contexts[0],'reset'),false);assert.equal(bad.turns.length,1,'refresh cannot automatically re-generate greeting');
 await bad.page.evaluate(()=>{const peer=window.fixture.peer;peer.connectionState='disconnected';peer.onconnectionstatechange();peer.connectionState='connected';peer.onconnectionstatechange();});
 assert.equal(await bad.page.evaluate(()=>window.fixture.peer.tracks.every(track=>!track.enabled)),true,'RTC reconnect cannot bypass retired writer authority');
 assert.equal(await bad.page.locator('#mute-call').isDisabled(),true,'mute cannot bypass writer recovery');
 assert.equal(bad.turns.length,1);assert.deepEqual(bad.errors,[]);assert.deepEqual(bad.routeErrors,[]);await bad.context.close();results.push({case:'bad PCM rejected before playback and authority refresh',passed:true});
 const strong=await setup({short:true});await eventually(()=>strong.reports.length===1,'real output-position playback report',20000);assert.equal(strong.reports[0].qualifiedUserEventIds.length,0);assert.equal(strong.turns.length,1);assert.deepEqual(strong.errors,[]);assert.deepEqual(strong.routeErrors,[]);await strong.context.close();results.push({case:'native output timestamp permits strong report',passed:true});
 const privacy=await setup({short:true});
 await eventually(()=>privacy.reports.length===1,'privacy startup playback');
 const reset=async()=>{const count=privacy.contexts.length,turnCount=privacy.turns.length;await privacy.page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});await privacy.page.locator('#manual-reply').click();await eventually(()=>privacy.contexts.length===count+1&&privacy.page.evaluate(()=>window.fixture.peer.tracks.every(track=>track.enabled)),'fresh memory-free authority');assert.equal(privacy.contexts.at(-1).reset,true);assert.equal(privacy.turns.length,turnCount,'authority reset never re-greets');};
 await reset();
 await privacy.emit({type:'input_audio_buffer.speech_started',item_id:'before-private-reset'});await privacy.local();await privacy.input('before-private-reset','A synthetic caller detail before the next reset.');await eventually(()=>privacy.reports.length===2,'pre-reset strong playback');const retired=privacy.turns.at(-1).currentUserEventIds[0];assert.equal(privacy.turns.at(-1).omitLearningContext,true);
 await reset();
 await privacy.emit({type:'input_audio_buffer.speech_started',item_id:'after-private-reset'});await privacy.local();await privacy.input('after-private-reset','A new synthetic caller detail after reset.');await eventually(()=>privacy.reports.length===3,'post-reset strong playback accepted');const fresh=privacy.turns.at(-1).currentUserEventIds[0];assert.deepEqual(privacy.reports.at(-1).qualifiedUserEventIds,[fresh]);assert(!privacy.turns.at(-1).acceptedHistoryEventIds.includes(retired));assert(privacy.saved.has(retired),'privacy retirement keeps raw source');assert.deepEqual(privacy.routeErrors,[]);assert.deepEqual(privacy.errors,[]);await privacy.context.close();results.push({case:'already-omitted reset reports only the current writer caller sources',passed:true});
 for(const code of ['BUDGET_EXCEEDED','COST_BUDGET_EXCEEDED']){
  const limited=await setup({budgetCode:code});
  await eventually(()=>limited.page.evaluate(()=>window.fixture.pcmEvents.some(event=>event.kind==='started')),'budget fixture begins real PCM');
  await limited.page.evaluate(()=>{window.fixture.notices=[];new MutationObserver(()=>{const value=document.querySelector('#notice .notice-message')?.textContent;if(value&&window.fixture.notices.at(-1)!==value)window.fixture.notices.push(value);}).observe(document.getElementById('notice'),{childList:true,subtree:true});});
  await limited.emit({type:'input_audio_buffer.speech_started',item_id:'budget-user'});await limited.local();await limited.input('budget-user','My synthetic thought before the daily limit.');
  await eventually(async()=>await limited.page.locator('#call-status').textContent()==='오늘 이용 한도에 도달했어요','midcall budget status');
  assert.equal(await limited.page.locator('#notice .notice-message').textContent(),'오늘 이용 한도에 도달했어요. 통화를 마친 뒤 대화 기록을 확인해 주세요.');
  if(code==='BUDGET_EXCEEDED')await budgetLayout(limited.page);
  assert.equal(await limited.page.locator('#manual-reply').isVisible(),false);assert.equal(await limited.page.locator('#mute-call').isDisabled(),true);assert.equal(await limited.page.locator('#hint-call').isDisabled(),true);assert.equal(await limited.page.locator('#speed-call').isDisabled(),true);assert.equal(await limited.page.locator('#end-call').isDisabled(),false);
  assert.equal(await limited.page.evaluate(()=>window.fixture.peer.tracks.every(track=>!track.enabled)),true);
  const starts=await limited.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='started').length),contexts=limited.contexts.length;
  // Exercise handlers directly too: disabled presentation cannot be the only gate.
  await limited.page.evaluate(async()=>{document.getElementById('manual-reply').onclick();document.getElementById('mute-call').onclick();await document.getElementById('hint-call').onclick();document.getElementById('speed-call').onclick();const peer=window.fixture.peer;peer.connectionState='disconnected';peer.onconnectionstatechange();peer.connectionState='connected';peer.onconnectionstatechange();});
  await limited.emit({type:'input_audio_buffer.speech_started',item_id:'late-budget-asr'});await limited.input('late-budget-asr','A final queued transcript that must still be saved.');
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(limited.turns.length,2,'budget failure cannot re-create a turn or greeting');assert.equal(limited.syntheses.length,1);assert.equal(limited.contexts.length,contexts,'reconnect cannot retry exhausted budget');assert.equal(await limited.page.evaluate(()=>window.fixture.pcmEvents.filter(event=>event.kind==='started').length),starts,'old PCM cannot replay');assert.deepEqual(await limited.page.evaluate(()=>window.fixture.notices),['오늘 이용 한도에 도달했어요. 통화를 마친 뒤 대화 기록을 확인해 주세요.']);
  assert(limited.saved.size>=3);assert([...limited.saved.values()].some(row=>row.text==='A final queued transcript that must still be saved.'));
  await limited.page.locator('#end-call').click();await eventually(()=>limited.sessions[0].status==='ended','budget call normal finish ACK');await eventually(()=>limited.page.evaluate(()=>window.fixture.peer.connectionState==='closed'),'budget call closes after saving');assert.match(await limited.page.locator('#save-status').textContent(),/^(저장 완료|대화 저장을 확인했어요)$/);assert([...limited.saved.values()].some(row=>row.text==='My synthetic thought before the daily limit.'));assert.deepEqual(limited.errors,[]);assert.deepEqual(limited.routeErrors,[]);await limited.context.close();results.push({case:code+' is terminal for generation but preserves raw save and hangup',passed:true});
 }
 const weak=await setup({short:true,weak:true});await eventually(()=>weak.page.evaluate(()=>window.fixture.pcmEvents.some(event=>event.kind==='render_drained')),'weak source renders');await new Promise(resolve=>setTimeout(resolve,5500));assert.equal(weak.reports.length,0,'estimated drain must not produce a receipt');assert.deepEqual(weak.errors,[]);assert.deepEqual(weak.routeErrors,[]);await weak.context.close();results.push({case:'missing output timestamp never reports strong completion',passed:true});
 await writeFile('test-results/authored-dialogue-layout.json',JSON.stringify(screens,null,2));await writeFile('test-results/authored-dialogue-results.json',JSON.stringify({buildScript:script[1],scriptSri:script[2],limits:'Synthetic auth/DB/models/ASR/RTC. Native Chromium AudioWorklet and WASM. Tone PCM; no real microphone, model, speech fidelity or physical acoustics proven.',results},null,2));
 console.log(`Authored dialogue browser: ${results.length}/${results.length} passed`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
