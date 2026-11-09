import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const port=4187, base=`http://127.0.0.1:${port}`;
async function assertVisibleImagesLoaded(page){
 const broken=await page.locator('img').evaluateAll(images=>images.filter(image=>{const box=image.getBoundingClientRect(),style=getComputedStyle(image);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&(!image.complete||image.naturalWidth===0);}).map(image=>image.currentSrc||image.src));
 assert.deepEqual(broken,[],'visible image assets must load with nonzero naturalWidth');
}
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:String(port),PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''},stdio:'pipe'});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
try{
 const context=await browser.newContext({permissions:['microphone']});
 const page=await context.newPage();let offline=true;const saved=new Map();const savedSession=new Map();let reviews=0,checkpoints=0,checkpointFail=false;
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const session='11111111-1111-4111-8111-111111111111';
 const sessions=[{id:session,user_id:uid,scenario:'Coffee',companion_id:'alex',status:'ended',created_at:new Date().toISOString(),ended_at:new Date().toISOString()}];
 const memoryQueries=[];
 const companionMemory={alex:[{summary:'Alex memory fixture',practice:[{expression:'Could you repeat that?'}]}],mia:[{summary:'Mia memory fixture',practice:[]}],juno:[{summary:'Juno memory fixture',practice:[]}]};
 await page.route('https://test-project.supabase.co/**',async route=>{
  const url=new URL(route.request().url());const body=route.request().postDataJSON?.();let data=[];
  if(url.pathname==='/auth/v1/user')data={id:uid};
  else if(url.pathname.endsWith('/rpc/append_events')){
   if(offline)return route.fulfill({status:503,json:{message:'temporary offline'}});
   for(const e of body.p_events){const old=saved.get(e.id);if(old)assert.deepEqual(old,e);saved.set(e.id,e);savedSession.set(e.id,body.p_session_id);}data={inserted:body.p_events.length,event_ids:body.p_events.map(e=>e.id)};
  }else if(url.pathname.endsWith('/rpc/finish_session')){data=sessions.find(x=>x.id===body.p_session_id);data.status='ended';data.ended_at=new Date().toISOString();}
  else if(url.pathname==='/rest/v1/sessions'){
   if(route.request().method()==='POST'){data=[{...body,status:'active',created_at:new Date().toISOString()}];sessions.unshift(data[0]);}else {const companion=url.searchParams.get('companion_id')?.replace('eq.','');data=companion?sessions.filter(s=>s.companion_id===companion):sessions;}
  }else if(url.pathname==='/rest/v1/analyses')data=[];
  else if(url.pathname.endsWith('/coach/config'))data={models:{voice:'gpt-realtime-mini',coach:'gpt-4.1-mini',analysis:'gpt-4.1'}};
  else if(url.pathname.endsWith('/coach/memory')){memoryQueries.push(body);const memories=companionMemory[body?.companionId]||[];data={memories:body?.query?memories.filter(m=>m.summary.toLowerCase().includes(body.query.toLowerCase())):memories};}
  else if(url.pathname.endsWith('/coach/voice'))data={sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};
  else if(url.pathname.endsWith('/coach/checkpoint')){checkpoints++;if(checkpointFail)return route.fulfill({status:503,json:{error:{code:'UPSTREAM_UNAVAILABLE',message:'Checkpoint fixture unavailable'}}});data={instructions:'Trusted rolling conversation summary'};}
  else if(url.pathname.endsWith('/coach/review')){reviews++;data={analysis:{content:{summary:'test fixture'}}};}
  else if(url.pathname==='/rest/v1/transcript_events'){const all=[...saved.values()].map(e=>({...e,session_id:savedSession.get(e.id)}));const offset=Number(url.searchParams.get('offset')||0);return route.fulfill({status:200,json:all.slice(offset,offset+1),headers:{'Content-Range':`${offset}-${offset}/${all.length}`,'Access-Control-Expose-Headers':'Content-Range'}});}
  else throw Error('Unexpected route '+url.pathname);
  await route.fulfill({status:200,json:data,headers:Array.isArray(data)?{'Content-Range':`0-${Math.max(data.length-1,0)}/${data.length}`,'Access-Control-Expose-Headers':'Content-Range'}:{}});
 });
 await page.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:'globalThis.LOOP_PUBLIC_CONFIG={url:"https://test-project.supabase.co",key:"sb_publishable_test"};'}));
 await page.goto(base);
 await page.locator('#login-form').waitFor({state:'visible'});assert.equal(await page.locator('#public-key').count(),0);assert.equal(await page.locator('#project-url').count(),0);
 await page.evaluate(({uid})=>{localStorage.setItem('loop.auth:https://test-project.supabase.co',JSON.stringify({access_token:'test-jwt',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}}));},{uid});
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
 await page.evaluate(async({session,uid})=>{const {createOutbox}=await import('/src/outbox.js');await createOutbox().put({id:'22222222-2222-4222-8222-222222222222',scope:'https://test-project.supabase.co|'+uid,sessionId:session,event:{id:'22222222-2222-4222-8222-222222222222',event_key:'recovered',speaker:'user',text:'Recovered after browser restart',occurred_at:new Date().toISOString()}});},{session,uid});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('1개 발화 전송 대기'));assert.equal(saved.size,0);
 offline=false;await page.locator('[data-view="history"]').click();await page.locator('#refresh-history').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='클라우드 저장 확인됨');assert.equal(saved.size,1);assert.equal(savedSession.get('22222222-2222-4222-8222-222222222222'),session);
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(saved.size,1);
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await assertVisibleImagesLoaded(page);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/mobile.png',fullPage:true});
 await page.locator('#companion-open').click();await page.locator('[data-companion="mia"]').click();
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Mia');
 assert.equal(await page.evaluate(()=>localStorage.getItem('loop.companion:https://test-project.supabase.co|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),'mia');
 await page.locator('#companion-open').click();await page.locator('[data-companion="juno"]').click();
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Juno');
 await page.locator('#companion-open').click();await page.locator('[data-companion="alex"]').click();
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Alex');
 await page.locator('#companion-open').click();await page.locator('[data-companion="mia"]').click();
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#companion-name').textContent==='Mia');
 // Simulate upstream WebRTC events; this validates app wiring, not real OpenAI voice.
 await page.evaluate(()=>{window.RTCPeerConnection=class{constructor(){window.testPeer=this;this.connectionState='new';}addTrack(track){this.track=track;}createDataChannel(){return this.dc={readyState:'open',send:(raw)=>{const message=JSON.parse(raw);(window.testMessages ||= []).push(message);if(message.type==='session.update'&&message.session.instructions)setTimeout(()=>this.dc.onmessage({data:JSON.stringify({type:'session.updated',session:{instructions:message.session.instructions}})}),10);if(message.type==='input_audio_buffer.commit'){this.dc.onmessage({data:JSON.stringify({type:'input_audio_buffer.committed',item_id:'last-item'})});setTimeout(()=>this.dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'last-item',transcript:'One last thing before we end.'})}),30);}}};}async createOffer(){return{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}async setLocalDescription(){}async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange?.();this.dc.onopen?.();}close(){this.connectionState='closed';}};});
 await page.locator('[data-view="call"]').click();await page.locator('#start-call').click();await page.locator('#end-call').waitFor({state:'visible'});
 assert.equal(sessions[0].companion_id,'mia','new sessions must be assigned to the selected companion');
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
 await page.locator('#account-open').click();const downloading=page.waitForEvent('download');await page.locator('#export').click();const download=await downloading.catch(async error=>{throw Error(error.message+'; app notice: '+await page.locator('#notice').textContent());});const file=await download.path();const backup=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));assert.equal(backup.events.length,3);assert.equal(backup.sessions.length,2);assert.deepEqual(new Set(backup.sessions.map(s=>s.companion_id)),new Set(['alex','mia']));assert.equal(new Set(backup.events.map(e=>e.id)).size,3);
 await page.locator('[data-close="account-dialog"]').click();
 await page.locator('[data-view="call"]').click();await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const navTargets=await page.locator('.glass-dock button').evaluateAll(buttons=>buttons.map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height})));assert(navTargets.every(box=>box.width>=44&&box.height>=44));
 assert.doesNotMatch(await page.locator('#call-home').innerText(),/lorem|todo|placeholder/i,'home must not show placeholder copy');
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
  await hosted.route(base+'/built',route=>route.fulfill({contentType:'text/html',body:html}));
  await hosted.goto(base+'/built');await hosted.locator('#login-form').waitFor({state:'visible'});
  await hosted.evaluate(({uid})=>localStorage.setItem('loop.auth:https://test-project.supabase.co',JSON.stringify({access_token:'test-jwt',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}})),{uid});
  await hosted.reload();await hosted.locator('#workspace').waitFor({state:'visible'});assert.equal(await hosted.locator('#public-key').count(),0);await assertVisibleImagesLoaded(hosted);await hosted.screenshot({path:'test-results/mobile-built.png',fullPage:true});assert.deepEqual(hostedErrors,[]);
  console.log('PASS: production HTML runs under hashed CSP; visitors can start without configuring a backend.');
 }finally{execFileSync(process.execPath,['scripts/build-web.mjs'],{env:{...process.env,PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''}});}

}finally{await browser.close();server.kill('SIGTERM');}
