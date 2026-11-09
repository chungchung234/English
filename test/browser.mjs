import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const port=4187, base=`http://127.0.0.1:${port}`;
async function assertVisibleImagesLoaded(page){
 await page.waitForFunction(()=>[...document.images].filter(image=>{const box=image.getBoundingClientRect();return box.width>0&&box.height>0&&getComputedStyle(image).visibility!=='hidden';}).every(image=>image.complete&&image.naturalWidth>0));
 const broken=await page.locator('img').evaluateAll(images=>images.filter(image=>{const box=image.getBoundingClientRect(),style=getComputedStyle(image);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&(!image.complete||image.naturalWidth===0);}).map(image=>image.currentSrc||image.src));
 assert.deepEqual(broken,[],'visible image assets must load with nonzero naturalWidth');
}
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:String(port),PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''},stdio:'pipe'});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--enable-unsafe-swiftshader','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required']});
try{
 const context=await browser.newContext({permissions:['microphone']});
 const page=await context.newPage();let offline=true;const saved=new Map();const savedSession=new Map();let reviews=0,checkpoints=0,checkpointFail=false,historyFailure=false,voiceFailure=false;const finishes=new Map();
 const openContact=async id=>{await page.locator('[data-view="contacts"]').click();await page.locator(`[data-companion="${id}"]`).click();await page.locator('#detail-panel').waitFor({state:'visible'});};
 const memoryAction=action=>page.waitForResponse(response=>response.url().endsWith('/coach/memory-manage')&&response.request().postDataJSON()?.action===action);
 const artRequests=[];page.on('request',request=>{if(/assets\/ai-.*\.webp/.test(request.url()))artRequests.push(request.url());});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const session='11111111-1111-4111-8111-111111111111';
 const analyses=[];
 const sessions=[{id:session,user_id:uid,scenario:'Coffee',companion_id:'alex',status:'ended',created_at:new Date().toISOString(),ended_at:new Date().toISOString()}];
 const memoryQueries=[];const controlCalls=[],indexCalls=[];const memoryFacts={alex:[],mia:[],juno:[]},memoryExcluded={alex:[],mia:[],juno:[]};let indexRemaining=true,indexFailure=false,releaseSlowMemorySearch,slowMemorySearchStarted,slowMemorySearchDone;const slowMemorySearchWaiting=new Promise(resolve=>slowMemorySearchStarted=resolve);const slowMemorySearchFinished=new Promise(resolve=>slowMemorySearchDone=resolve);
 const companionMemory={alex:[{summary:'Alex memory fixture',practice:[{expression:'Could you repeat that?'}]}],mia:[{summary:'Mia memory fixture',practice:[]}],juno:[{summary:'Juno memory fixture',practice:[]}]};
 await page.route('https://test-project.supabase.co/**',async route=>{
  const url=new URL(route.request().url());const body=route.request().postDataJSON?.();let data=[];
  if(url.pathname==='/auth/v1/user')data={id:uid};
  else if(url.pathname.endsWith('/rpc/append_events')){
   if(offline)return route.fulfill({status:503,json:{message:'temporary offline'}});
   for(const e of body.p_events){const old=saved.get(e.id);if(old)assert.deepEqual(old,e);saved.set(e.id,e);savedSession.set(e.id,body.p_session_id);}data={inserted:body.p_events.length,event_ids:body.p_events.map(e=>e.id)};
  }else if(url.pathname.endsWith('/rpc/finish_session')){finishes.set(body.p_session_id,(finishes.get(body.p_session_id)||0)+1);data=sessions.find(x=>x.id===body.p_session_id);data.status='ended';data.ended_at=new Date().toISOString();}
  else if(url.pathname==='/rest/v1/sessions'){
   if(route.request().method()==='POST'){data=[{...body,status:'active',created_at:new Date().toISOString()}];sessions.unshift(data[0]);}else {if(historyFailure){historyFailure=false;return route.fulfill({status:503,json:{message:'History fixture unavailable'}});}const companion=url.searchParams.get('companion_id')?.replace('eq.','');data=companion?sessions.filter(s=>s.companion_id===companion):sessions;}
  }else if(url.pathname==='/rest/v1/analyses')data=analyses;
  else if(['/rest/v1/memory_state','/rest/v1/memory_fact_overrides','/rest/v1/memory_session_exclusions'].includes(url.pathname)){data=[];}
  else if(url.pathname.endsWith('/coach/config'))data={models:{voice:'gpt-realtime-mini',coach:'gpt-4.1-mini',analysis:'gpt-4.1'}};
  else if(url.pathname.endsWith('/coach/memory-manage')){controlCalls.push(body);const c=body.companionId;const facts=memoryFacts[c],excluded=memoryExcluded[c];if(body.action==='setFact'){const old=facts.find(f=>f.key===body.key);if(old)Object.assign(old,{value:body.value,forgotten:false,source:'직접 입력',updated_at:new Date().toISOString()});else facts.push({key:body.key,value:body.value,forgotten:false,source:'직접 입력',updated_at:new Date().toISOString()});}else if(body.action==='forgetFact'){const old=facts.find(f=>f.key===body.key);if(old)old.forgotten=true;}else if(body.action==='excludeSession'&&!excluded.some(x=>x.session_id===body.sessionId))excluded.push({session_id:body.sessionId,scenario:'Coffee',ended_at:new Date().toISOString()});else if(body.action==='restoreSession'){const i=excluded.findIndex(x=>x.session_id===body.sessionId);if(i>=0)excluded.splice(i,1);}data={revision:1,facts:[...facts],excluded_sessions:[...excluded],history_suppressed:facts.some(f=>!f.forgotten)};}
  else if(url.pathname.endsWith('/coach/memory-index')){indexCalls.push(body);if(indexFailure)return route.fulfill({status:503,json:{error:{message:'Index fixture unavailable'}}});data={indexed:2,remaining:indexRemaining,model:'fixture'};}
  else if(url.pathname.endsWith('/coach/memory')){memoryQueries.push(body);if(body?.query==='slow'){slowMemorySearchStarted();await new Promise(resolve=>releaseSlowMemorySearch=resolve);slowMemorySearchDone();}const memories=companionMemory[body?.companionId]||[];data={memories:body?.query?memories.filter(m=>m.summary.toLowerCase().includes(body.query.toLowerCase())):memories};}
  else if(url.pathname.endsWith('/coach/voice')){if(voiceFailure){voiceFailure=false;return route.fulfill({status:503,json:{message:'Voice fixture unavailable'}});}data={sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}
  else if(url.pathname.endsWith('/coach/checkpoint')){checkpoints++;if(checkpointFail)return route.fulfill({status:503,json:{error:{code:'UPSTREAM_UNAVAILABLE',message:'Checkpoint fixture unavailable'}}});data={instructions:'Trusted rolling conversation summary'};}
  else if(url.pathname.endsWith('/coach/review')){reviews++;const session=sessions.find(item=>item.id===body.sessionId);const analysis={id:crypto.randomUUID(),session_id:body.sessionId,kind:'session',created_at:new Date().toISOString(),content:{summary:session.companion_id+'의 통화 피드백',strengths:[],corrections:[],practice:[],scope:{companionId:session.companion_id,session_count:1,user_event_count:1}}};analyses.unshift(analysis);data={analysis};}
  else if(url.pathname==='/rest/v1/transcript_events'){let all=[...saved.values()].map(e=>({...e,timestamp:e.occurred_at,session_id:savedSession.get(e.id)}));const sid=url.searchParams.get('session_id'),ids=url.searchParams.get('id');if(sid?.startsWith('eq.'))all=all.filter(e=>e.session_id===sid.slice(3));if(ids?.startsWith('in.('))all=all.filter(e=>ids.slice(4,-1).split(',').includes(e.id));const offset=Number(url.searchParams.get('offset')||0);return route.fulfill({status:200,json:all.slice(offset,offset+1),headers:{'Content-Range':`${offset}-${offset}/${all.length}`,'Access-Control-Expose-Headers':'Content-Range'}});}
  else throw Error('Unexpected route '+url.pathname);
  await route.fulfill({status:200,json:data,headers:Array.isArray(data)?{'Content-Range':`0-${Math.max(data.length-1,0)}/${data.length}`,'Access-Control-Expose-Headers':'Content-Range'}:{}});
 });
 await page.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:'globalThis.LOOP_PUBLIC_CONFIG={url:"https://test-project.supabase.co",key:"sb_publishable_test"};'}));
 await page.goto(base);
 await page.locator('#login-form').waitFor({state:'visible'});assert.equal(await page.locator('#public-key').count(),0);assert.equal(await page.locator('#project-url').count(),0);
 assert.equal(artRequests.length,0,'hidden pre-login characters must not be fetched eagerly');
 await page.evaluate(({uid})=>{localStorage.setItem('loop.auth:https://test-project.supabase.co',JSON.stringify({access_token:'test-jwt',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}}));},{uid});
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
 await page.evaluate(async({session,uid})=>{const {createOutbox}=await import('/src/outbox.js');await createOutbox().put({id:'22222222-2222-4222-8222-222222222222',scope:'https://test-project.supabase.co|'+uid,sessionId:session,event:{id:'22222222-2222-4222-8222-222222222222',event_key:'recovered',speaker:'user',text:'Recovered after browser restart',occurred_at:new Date().toISOString()}});},{session,uid});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('1개 발화 전송 대기'));assert.equal(saved.size,0);
 offline=false;await page.locator('[data-view="history"]').click();await page.locator('#refresh-history').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='클라우드 저장 확인됨');assert.equal(saved.size,1);assert.equal(savedSession.get('22222222-2222-4222-8222-222222222222'),session);
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(saved.size,1);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('img[src*="companion-"]').count(),0,'AI companions must have no portrait assets');
 assert.equal(await page.locator('#orb').getAttribute('data-ai-profile'),'current');
 assert.equal(await page.locator('#contacts-panel').isVisible(),true);assert.equal(await page.locator('[data-contact]').count(),3);assert.equal(await page.locator('#topic-open,#scenario,[data-cue*="simpler"]').count(),0);
 await page.locator('#contact-search').fill('미아');assert.equal(await page.locator('[data-contact]:visible').count(),1);await page.locator('#contact-search').fill('없는친구');assert.equal(await page.locator('#contacts-empty').isVisible(),true);await page.locator('#contact-search').fill('');await page.getByRole('heading',{name:'연락처',exact:true}).click();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await assertVisibleImagesLoaded(page);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/mobile.png',fullPage:true});
 await openContact('mia');
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Mia');await assertVisibleImagesLoaded(page);await page.screenshot({path:'test-results/mobile-detail.png',fullPage:true});
 await page.setViewportSize({width:320,height:568});assert(await page.locator('#start-call').evaluate(button=>button.getBoundingClientRect().bottom<document.querySelector('.glass-dock').getBoundingClientRect().top),'call action fits compact detail');await page.screenshot({path:'test-results/mobile-detail-compact.png',fullPage:true});await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>localStorage.getItem('loop.companion:https://test-project.supabase.co|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),'mia');
 await openContact('juno');
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Juno');
 await openContact('alex');
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Alex');
 await openContact('mia');
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Mia');
 // Simulate upstream WebRTC events; this validates app wiring, not real OpenAI voice.
 await page.evaluate(()=>{
  const NativeAudio=window.AudioContext;window.__NativeAudio=NativeAudio;window.audioProbe=[];window.presenceContexts=[];
  window.AudioContext=class extends NativeAudio{constructor(...args){super(...args);window.presenceContexts.push(this);}createMediaStreamSource(stream){window.audioProbe.push({stream:stream.id,context:window.presenceContexts.indexOf(this)});return super.createMediaStreamSource(stream);}};
  window.testPeers=[];
  window.RTCPeerConnection=class{
   constructor(){window.testPeer=this;window.testPeers.push(this);this.connectionState='new';}
   addTrack(track){this.track=track;}
   createDataChannel(){return this.dc={readyState:'open',send:raw=>{const message=JSON.parse(raw);(window.testMessages ||= []).push(message);if(message.type==='session.update'&&message.session.instructions)setTimeout(()=>this.dc.onmessage({data:JSON.stringify({type:'session.updated',session:{instructions:message.session.instructions}})}),10);if(message.type==='input_audio_buffer.commit'){this.dc.onmessage({data:JSON.stringify({type:'input_audio_buffer.committed',item_id:'last-item'})});setTimeout(()=>this.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'last-item',transcript:'One last thing before we end.'})}),30);}}};}
   async createOffer(){return{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}
   async setLocalDescription(){}
   async setRemoteDescription(){this.audio=new NativeAudio();this.osc=this.audio.createOscillator();this.gain=this.audio.createGain();this.gain.gain.value=.1;this.destination=this.audio.createMediaStreamDestination();this.osc.connect(this.gain).connect(this.destination);this.osc.start();this.ontrack?.({streams:[this.destination.stream],track:this.destination.stream.getAudioTracks()[0]});this.connectionState='connected';this.onconnectionstatechange?.();this.dc.onopen?.();}
   close(){if(this.connectionState==='closed')return;this.connectionState='closed';this.dc.readyState='closed';this.osc?.stop();this.destination?.stream.getTracks().forEach(t=>t.stop());this.audio?.close();}
  };
 });
 await page.locator('[data-view="history"]').click();await page.locator('#memory-manage-open').click();await page.locator('[data-close="memory-dialog"]').click();await openContact('mia');await page.locator('#start-call').click();await page.locator('#end-call').waitFor({state:'visible'});await page.evaluate(()=>document.getElementById('memory-dialog').showModal());assert.equal(await page.locator('#memory-index').isDisabled(),true);assert.equal(await page.locator('#memory-facts input').first().isDisabled(),true);await page.evaluate(()=>document.getElementById('memory-dialog').close());
 assert.equal(sessions[0].companion_id,'mia','new sessions must be assigned to the selected companion');
 assert.equal(sessions[0].scenario,'Natural English conversation about everyday life');
 assert.match(await page.locator('#call-timer').textContent(),/^\d{2}:\d{2}$/);assert.match(await page.locator('#call-remaining').textContent(),/남음/);
 await page.waitForFunction(()=>window.audioProbe.length>=2&&window.presenceContexts.some(context=>context.state==='running'));
 const beforeReconnect=await page.evaluate(()=>window.audioProbe.length);
 await page.evaluate(()=>{window.testPeer.connectionState='disconnected';window.testPeer.onconnectionstatechange();});
 await page.waitForFunction(()=>window.presenceContexts.every(context=>context.state==='closed'));
 await page.evaluate(()=>{window.testPeer.connectionState='connected';window.testPeer.onconnectionstatechange();});
 await page.waitForFunction(count=>window.audioProbe.length>=count+2,beforeReconnect);
 assert.equal(await page.evaluate(()=>window.presenceContexts.at(-1).state),'running','reconnection recreates live analysis');
 await page.setViewportSize({width:320,height:568});assert(await page.locator('#end-call').evaluate(button=>{const box=button.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}),'hangup must stay reachable on compact phones');
 await page.evaluate(()=>{window.scaledText=[...document.querySelectorAll('#live-call h1,#live-call p,#live-call button,#live-call summary,#live-call summary span')].map(element=>({element,original:element.style.fontSize,size:parseFloat(getComputedStyle(element).fontSize)}));window.scaledText.forEach(({element,size})=>element.style.fontSize=`${size*1.25}px`);});
 assert(await page.locator('.transcript-details').evaluate(details=>details.getBoundingClientRect().top>=document.querySelector('.live-actions').getBoundingClientRect().bottom),'larger text must not place the transcript over call controls');
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
 assert(await page.locator('.transcript-details').evaluate(details=>details.getBoundingClientRect().bottom<=document.querySelector('#end-call').getBoundingClientRect().top-8),'scrolling enlarged text must expose the transcript above the fixed hangup');
 await page.screenshot({path:'test-results/mobile-call-compact-large-text.png'});
 await page.evaluate(()=>{window.scaledText.forEach(({element,original})=>element.style.fontSize=original);window.scrollTo(0,0);});await page.setViewportSize({width:390,height:844});

 await page.waitForFunction(()=>document.querySelector('#live-avatar').dataset.profile==='mia');
 for(const [type,state] of [['response.created','thinking'],['output_audio_buffer.started','speaking'],['output_audio_buffer.stopped','listening']]){
  await page.evaluate(type=>window.testPeer.dc.onmessage({data:JSON.stringify({type})}),type);
  await page.waitForFunction(state=>document.querySelector('#live-avatar').dataset.state===state,state);
 }
 assert.equal(await page.locator('#hint-call').isDisabled(),true,'hint waits for the active response');
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'response.done',response:{status:'completed',usage:{input_tokens:100}}})}));
 await page.locator('#hint-call').click();assert.equal(await page.locator('#hint-call').isDisabled(),true,'hint reserves a response immediately');
 const hintMessage=await page.evaluate(()=>window.testMessages.at(-1));assert.equal(hintMessage.type,'response.create');assert.match(hintMessage.response.instructions,/sentence/);
 await assertVisibleImagesLoaded(page);await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/mobile-call.png',fullPage:true});
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'item1',content_index:0,transcript:'I am thinking of visiting a friend.'})}));
 await page.waitForFunction(()=>document.querySelector('#turn-count').textContent==='1개 발화');await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='클라우드 저장 확인됨');assert.equal(saved.size,2);
 // A completed long turn triggers a durable checkpoint before old items delete.
 await page.evaluate(()=>{for(let i=0;i<10;i++)window.testPeer.dc.onmessage({data:JSON.stringify({type:'conversation.item.created',item:{id:'context-'+i}})});window.testPeer.dc.onmessage({data:JSON.stringify({type:'response.done',response:{usage:{input_tokens:19000}}})});});
 await page.waitForFunction(()=>window.testMessages?.filter(message=>message.type==='conversation.item.delete').length===4);
 assert.equal(checkpoints,1);
 const compactMessages=await page.evaluate(()=>window.testMessages);
 assert(compactMessages.findIndex(message=>message.session?.instructions)>-1);
 assert(compactMessages.findIndex(message=>message.session?.instructions)<compactMessages.findIndex(message=>message.type==='conversation.item.delete'));
 assert.deepEqual(compactMessages.filter(message=>message.type==='conversation.item.delete').map(message=>message.item_id),['context-0','context-1','context-2','context-3']);
 checkpointFail=true;
 await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+61000;window.testPeer.dc.onmessage({data:JSON.stringify({type:'response.done',response:{usage:{input_tokens:19000}}})});Date.now=now;});
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Checkpoint fixture unavailable'));
 await page.waitForFunction(()=>window.testPeer.track.enabled===true);
 assert.equal(checkpoints,2);assert.equal((await page.evaluate(()=>window.testMessages.filter(message=>message.type==='conversation.item.delete'))).length,4,'failed checkpoint must preserve every remaining live item');
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'last-item'})}));
 await page.locator('#end-call').click();await page.waitForFunction(()=>document.querySelector('#call-status').textContent==='통화와 피드백 저장 완료');assert.equal(reviews,1);assert.equal(sessions[0].status,'ended');assert.equal(saved.size,3);
 await assertVisibleImagesLoaded(page);await page.screenshot({path:'test-results/mobile-review.png',fullPage:true});
 await page.locator('[data-view="history"]').click();await page.locator('#memory-query').fill('coffee');await page.locator('#memory-search button').click();await page.waitForFunction(()=>document.querySelector('#memory-results').textContent.includes('관련 학습 기록이 없습니다.'));await assertVisibleImagesLoaded(page);await page.screenshot({path:'test-results/mobile-history.png',fullPage:true});
 const memoryCompanions=new Set(memoryQueries.map(q=>q?.companionId));assert.deepEqual([...memoryCompanions].sort(),['alex','juno','mia']);
 await page.locator('#memory-query').fill('slow');await page.locator('#memory-search button').click();await slowMemorySearchWaiting;await page.locator('#memory-manage-open').click();await page.locator('#memory-dialog').waitFor({state:'visible'});assert((await page.locator('#memory-companion').textContent()).includes('Mia'));await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/mobile-memory.png',fullPage:true});
 const goal=page.locator('#memory-facts .memory-fact').filter({has:page.locator('strong', {hasText:'목표'})}).locator('input');await goal.fill('<img src=x onerror=alert(1)>');await page.locator('#memory-facts .memory-fact').filter({has:page.locator('strong', {hasText:'목표'})}).getByRole('button',{name:'저장'}).click();await page.waitForFunction(()=>document.querySelector('#memory-suppressed').hidden===false);assert.equal(await page.locator('#memory-facts img').count(),0);assert.equal([...controlCalls].reverse().find(call=>call.action==='setFact')?.companionId,'mia');assert.equal([...controlCalls].reverse().find(call=>call.action==='setFact')?.value,'<img src=x onerror=alert(1)>');releaseSlowMemorySearch();await slowMemorySearchFinished;assert.equal(await page.locator('#memory-results').textContent(),'','stale search response must not repopulate results after a fact edit');
 await Promise.all([memoryAction('forgetFact'),page.locator('#memory-facts .memory-fact').filter({has:page.locator('strong', {hasText:'목표'})}).getByRole('button',{name:'잊기'}).click()]);assert.equal([...controlCalls].reverse().find(call=>call.action==='forgetFact')?.action,'forgetFact');
 await page.locator('#memory-index').click();await page.waitForFunction(()=>document.querySelector('#memory-index-more').hidden===false);assert.equal(indexCalls.length,1);await Promise.all([page.waitForResponse(response=>response.url().endsWith('/coach/memory-index')),page.locator('#memory-index-more').click()]);assert.equal(indexCalls.length,2,'each click runs exactly one bounded index batch');indexFailure=true;await page.locator('#memory-index').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Index fixture unavailable'));indexFailure=false;
 await page.locator('[data-close="memory-dialog"]').click();const miaSession=sessions.find(s=>s.companion_id==='mia'&&s.status==='ended');assert(miaSession);const miaEntry=page.locator('#history .history-entry').first();await Promise.all([memoryAction('excludeSession'),miaEntry.getByRole('button',{name:'기억에서 제외'}).click()]);assert.equal(controlCalls.at(-1).action,'excludeSession');assert.equal(controlCalls.at(-1).sessionId,miaSession.id);await page.locator('#memory-manage-open').click();await Promise.all([memoryAction('restoreSession'),page.locator('#memory-exclusions').getByRole('button',{name:'기억에 다시 포함'}).click()]);assert.equal(controlCalls.at(-1).action,'restoreSession');
 await page.locator('[data-close="memory-dialog"]').click();await page.locator('#account-open').click();const downloading=page.waitForEvent('download');await page.locator('#export').click();const download=await downloading.catch(async error=>{throw Error(error.message+'; app notice: '+await page.locator('#notice').textContent());});const file=await download.path();const backup=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));assert.equal(backup.events.length,3);assert.equal(backup.sessions.length,2);assert.deepEqual(Object.keys(backup.memory_controls).sort(),['exclusions','facts','state']);assert.deepEqual(new Set(backup.sessions.map(s=>s.companion_id)),new Set(['alex','mia']));assert.equal(new Set(backup.events.map(e=>e.id)).size,3);
 await page.locator('[data-close="account-dialog"]').click();
 await openContact('mia');await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const navTargets=await page.locator('.glass-dock button').evaluateAll(buttons=>buttons.map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height})));assert(navTargets.every(box=>box.width>=44&&box.height>=44));
 assert.doesNotMatch(await page.locator('#call-home').innerText(),/lorem|todo|placeholder/i,'home must not show placeholder copy');
 // Advance browser time: the call stays open at 19 minutes, then reaches the
 // real duration deadline and follows the normal final-transcription/save path.
 await page.clock.install();
 await page.locator('#start-call').click();await page.locator('#end-call').waitFor({state:'visible'});
 const timedSession=sessions[0],sessionCount=sessions.length;
 await page.clock.fastForward(10*60*1000);
 await page.evaluate(()=>{const old=window.testPeers[0];old.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'stale',transcript:'Must not enter the new call.'})});window.testPeer.connectionState='disconnected';window.testPeer.onconnectionstatechange();});
 await page.clock.fastForward(2*60*1000);await page.evaluate(()=>{window.testPeer.connectionState='connected';window.testPeer.onconnectionstatechange();});
 await page.clock.fastForward(7*60*1000);
 assert.equal(timedSession.status,'active');assert.equal(await page.evaluate(()=>window.testPeer.track.readyState),'live');assert.equal(reviews,1);
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'last-item'})}));
 await page.clock.fastForward(60*1000);
 assert.equal(await page.evaluate(()=>window.testPeer.track.readyState),'ended','microphone stops at the 20-minute deadline');
 await page.clock.fastForward(2000);
 await page.waitForFunction(()=>document.querySelector('#call-status').textContent==='통화와 피드백 저장 완료');
 assert.equal(timedSession.status,'ended');assert.equal(reviews,2);assert.equal(saved.size,4,'deadline preserves final spoken turn');
 assert.match(await page.locator('#notice').textContent(),/20분/);
 await page.clock.fastForward(60*1000);assert.equal(sessions.length,sessionCount,'deadline never starts another call automatically');
 console.log('PASS: 20-minute deadline stops microphone, saves the final turn, and creates feedback without automatically restarting.');
 // Direct call, terminal failure, and a post-save refresh failure keep identity
 // and saved status correct. These are distinct from the transient reconnect.
 await page.locator('[data-view="contacts"]').click();await page.locator('[data-call-companion="juno"]').click();await page.locator('#end-call').waitFor({state:'visible'});
 const junoSession=sessions[0];assert.equal(junoSession.companion_id,'juno');
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'juno-final',transcript:'I enjoyed our conversation.'})}));
 await page.waitForFunction(()=>document.querySelector('#turn-count').textContent==='1개 발화');
 historyFailure=true;await page.evaluate(()=>{window.testPeer.connectionState='failed';window.testPeer.onconnectionstatechange();});await page.clock.fastForward(2000);
 await page.waitForFunction(()=>document.querySelector('#call-status').textContent==='통화와 피드백 저장 완료');
 assert.equal(junoSession.status,'ended');assert.equal(finishes.get(junoSession.id),1);assert.match(await page.locator('#review-content').textContent(),/juno의 통화 피드백/);assert.equal(await page.evaluate(()=>window.testPeer.track.readyState),'ended');
 // A failed start returns to the selected contact and can retry. Its incomplete
 // attempt stays in history instead of being falsely represented as a call.
 await openContact('alex');voiceFailure=true;await page.locator('#start-call').click();await page.locator('#detail-panel').waitFor({state:'visible'});assert.equal(await page.locator('#start-call').isEnabled(),true);
 await page.locator('#start-call').click();await page.locator('#end-call').waitFor({state:'visible'});assert.equal(sessions[0].companion_id,'alex');
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'alex-turn',transcript:'I am ready to speak again.'})}));await page.waitForFunction(()=>document.querySelector('#turn-count').textContent==='1개 발화');await page.locator('#end-call').click();await page.clock.fastForward(2000);await page.waitForFunction(()=>document.querySelector('#call-status').textContent==='통화와 피드백 저장 완료');
 // Redial a Mia row while Alex was selected. The new session and final review
 // must follow the row, and duplicate end requests must create one finish only.
 await openContact('alex');await page.locator('[data-view="history"]').click();await page.locator('#refresh-history').click();await page.locator(`#history [data-session-id="${miaSession.id}"]`).getByRole('button',{name:'Mia에게 다시 전화',exact:true}).click();await page.locator('#end-call').waitFor({state:'visible'});
 const redialSession=sessions[0];assert.equal(redialSession.companion_id,'mia');assert.equal(await page.locator('#live-name').textContent(),'Mia');
 await page.evaluate(()=>window.testPeer.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'redial-turn',transcript:'It is nice to talk again.'})}));await page.waitForFunction(()=>document.querySelector('#turn-count').textContent==='1개 발화');await page.evaluate(()=>{document.getElementById('end-call').onclick();document.getElementById('end-call').onclick();});await page.clock.fastForward(2000);await page.waitForFunction(()=>document.querySelector('#call-status').textContent==='통화와 피드백 저장 완료');assert.equal(finishes.get(redialSession.id),1);assert.match(await page.locator('#review-content').textContent(),/mia의 통화 피드백/);
 await page.locator('#review-panel').waitFor({state:'visible'});
 console.log('PASS: direct contact calls, failed starts/retry, terminal failures, refresh failures, row-bound redial and idempotent end preserve saved state and companion identity.');
 assert.deepEqual(errors,[]);
 console.log('PASS: browser reload retains offline records; retry syncs exact IDs; voice-event wiring saves and reviews; mobile layout fits. Full export handles a lower DB page cap. Voice upstream is simulated, not validated.');
 await page.route('**/functions/v1/coach/config', route=>route.fulfill({status:403,json:{error:{code:'ACCOUNT_NOT_ALLOWED',message:'승인된 이메일 계정만 이용할 수 있습니다.'}}}));
 const deniedRequests=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/rest/v1/'))deniedRequests.push(request.url());});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('승인된 이메일'));
 assert.equal(await page.locator('#workspace').isVisible(),false);assert.deepEqual(deniedRequests,[]);
 console.log('PASS: unapproved accounts stay on login and never attempt history reads or queued uploads.');
 await context.close();
 const fresh=await browser.newPage();await fresh.goto(base);await fresh.waitForFunction(()=>document.querySelector('#service-state').textContent.includes('서비스 연결을 준비'));assert.equal(await fresh.locator('#public-key').count(),0);assert.equal(await fresh.locator('#config-form').count(),0);
 console.log('PASS: visitors see a ready-to-use email login, no backend setup or API key fields; unconfigured deployment shows preparation status.');
 const buildEnv={...process.env,PUBLIC_SUPABASE_URL:'https://test-project.supabase.co',PUBLIC_SUPABASE_KEY:'sb_publishable_test'};
 try{
  execFileSync(process.execPath,['scripts/build-web.mjs','--require-config'],{env:buildEnv});
  const html=await readFile('dist/index.html','utf8');assert(!html.includes('src="app.js"'));assert(html.includes("script-src 'sha256-"));
  const hosted=await browser.newPage();const hostedErrors=[];hosted.on('pageerror',e=>hostedErrors.push(e.message));
  await hosted.route('https://test-project.supabase.co/**',async route=>{const pathname=new URL(route.request().url()).pathname;const data=pathname==='/auth/v1/user'?{id:uid}:pathname.endsWith('/coach/config')?{models:{voice:'gpt-realtime-mini',coach:'gpt-4.1-mini',analysis:'gpt-4.1'}}:pathname.endsWith('/coach/memory')?{memories:[]}:[];await route.fulfill({status:200,json:data,headers:Array.isArray(data)?{'Content-Range':'0-0/0','Access-Control-Expose-Headers':'Content-Range'}:{}});});
  assert(html.includes('assets/ai-alex.'));assert(!html.includes('data:image/png;base64,'));
  await hosted.goto(base+'/built/');await hosted.locator('#login-form').waitFor({state:'visible'});
  await hosted.evaluate(({uid})=>localStorage.setItem('loop.auth:https://test-project.supabase.co',JSON.stringify({access_token:'test-jwt',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}})),{uid});
  await hosted.reload();await hosted.locator('#workspace').waitFor({state:'visible'});assert.equal(await hosted.locator('#public-key').count(),0);await assertVisibleImagesLoaded(hosted);await hosted.screenshot({path:'test-results/mobile-built.png',fullPage:true});assert.deepEqual(hostedErrors,[]);
  console.log('PASS: production HTML runs under hashed CSP; visitors can start without configuring a backend.');
 }finally{execFileSync(process.execPath,['scripts/build-web.mjs'],{env:{...process.env,PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''}});}

}finally{await browser.close();server.kill('SIGTERM');}
