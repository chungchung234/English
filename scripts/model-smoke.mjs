import {isolatedCoach} from './isolated-coach-check.mjs';
// Server integration check. Test accounts and all related learning records are deleted.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const ref=process.env.SUPABASE_PROJECT_REF, base=`https://${ref}.supabase.co`, origin='https://chungchung234.github.io';
let userId,admin,isolated,browser; let phase='provider keys';
async function json(url,options={}) {
 const r=await fetch(url,{...options,signal:AbortSignal.timeout(120000)});
 const data=await r.json().catch(()=>null);
 if(!r.ok)throw Error(`${phase}: HTTP ${r.status}, code ${data?.error?.code || data?.code || 'unknown'}`);
 return data;
}
try {
 const keys=await json(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,{headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`}});
 const publicKey=keys.find(k=>k.name==='anon')?.api_key || keys.find(k=>k.type==='publishable')?.api_key;
 const serviceKey=keys.find(k=>k.name==='service_role')?.api_key;
 admin={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'};
 const email=`model-smoke-${randomUUID()}@example.invalid`,password=randomUUID()+randomUUID();
 phase='test account';userId=(await json(base+'/auth/v1/admin/users',{method:'POST',headers:admin,body:JSON.stringify({email,password,email_confirm:true})})).id;
 const login=await json(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:publicKey,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
 isolated=await isolatedCoach(ref,[userId]);
 const headers={apikey:publicKey,Authorization:`Bearer ${login.access_token}`,'Content-Type':'application/json',Origin:origin};
 const call=(path,body)=>json(base+path.replace('/functions/v1/coach/','/functions/v1/'+isolated.slug+'/'),{method:body===undefined?'GET':'POST',headers, ...(body===undefined?{}:{body:JSON.stringify(body)})});
 phase='model configuration';const config=await call('/functions/v1/coach/config');assert.equal(config.models.coach,'gpt-6-luna');assert.equal(config.models.analysis,'gpt-6.1-sol');

 phase='test transcript';const sid=randomUUID();await call('/rest/v1/sessions',{id:sid,user_id:userId,scenario:'Describe yesterday',companion_id:'alex'});
 await call('/rest/v1/rpc/append_events',{p_session_id:sid,p_events:[{event_key:randomUUID(),speaker:'user',text:'Yesterday I go to the cafe. I drinked a coffee with my friend.',timestamp:new Date().toISOString()}]});
 phase='Luna checkpoint';const checkpoint=await call('/functions/v1/coach/checkpoint',{sessionId:sid});assert.ok(checkpoint.instructions?.length);
 await call('/rest/v1/rpc/finish_session',{p_session_id:sid});
 phase='Luna review';const review=await call('/functions/v1/coach/review',{sessionId:sid});assert.equal(review.analysis.model,'gpt-6-luna');
 phase='result cache';const cached=await call('/functions/v1/coach/review',{sessionId:sid});assert.equal(cached.analysis.id,review.analysis.id);
 phase='Sol weekly';const weekly=await call('/functions/v1/coach/weekly',{companionId:'alex'});assert.equal(weekly.analysis.model,'gpt-6.1-sol');
 phase='embedding index';const indexed=await call('/functions/v1/coach/memory-index',{companionId:'alex'});assert.ok(indexed.indexed>0);
 phase='embedding search';await call('/functions/v1/coach/memory',{companionId:'alex',query:'coffee with a friend'});await call('/functions/v1/coach/memory',{companionId:'alex',query:'coffee with a friend'});
 phase='usage ledger';const rows=await json(base+`/rest/v1/model_spend?user_id=eq.${userId}&select=model,usage,estimated_usd,outcome`,{headers:admin});
 assert.equal(rows.length,5);assert.ok(rows.every(r=>r.usage?.input_tokens>0 && r.estimated_usd>0));
 console.log('PASS: deployed Luna correction/checkpoint, Sol weekly, embedding index/search, repeated review/search cache, and durable usage records.');
 for(const row of rows)console.log(JSON.stringify({model:row.model,...row.usage,estimated_usd:row.estimated_usd,outcome:row.outcome}));
 if(process.env.SMOKE_AUDIO){
  const {chromium}=await import('playwright');
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,...(process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY}}:{}),args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${process.env.SMOKE_AUDIO}`]});
  for(const [companion,voice] of [['alex','cedar'],['mia','marin'],['juno','verse']]){
   phase='voice '+companion;
   const context=await browser.newContext({permissions:['microphone']});const page=await context.newPage();
   await page.goto(origin+'/English/',{waitUntil:'domcontentloaded'});
   const voiceId=randomUUID();await call('/rest/v1/sessions',{id:voiceId,user_id:userId,scenario:'Everyday conversation',companion_id:companion});
   const offer=await page.evaluate(async()=>{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true}),pc=new RTCPeerConnection();
    globalThis.voiceCheck={pc,stream,user:0,assistant:0,voices:[],errors:0};
    stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    const dc=pc.createDataChannel('oai-events');
    dc.addEventListener('message',message=>{let e;try{e=JSON.parse(message.data);}catch{return;}
     if(e.type==='session.created'||e.type==='session.updated')globalThis.voiceCheck.voices.push(e.session?.audio?.output?.voice);
     if(e.type==='conversation.item.input_audio_transcription.completed'&&e.transcript?.trim())globalThis.voiceCheck.user++;
     if(e.type==='response.output_audio_transcript.done'&&e.transcript?.trim())globalThis.voiceCheck.assistant++;
     if(e.type==='error'||e.type==='conversation.item.input_audio_transcription.failed')globalThis.voiceCheck.errors++;
    });
    dc.onopen=()=>dc.send(JSON.stringify({type:'response.create'}));
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);return offer.sdp;
   });
   const answer=await call('/functions/v1/coach/voice',{sessionId:voiceId,sdp:offer});
   await page.evaluate(async sdp=>{await globalThis.voiceCheck.pc.setRemoteDescription({type:'answer',sdp});},answer.sdp);
   try {await page.waitForFunction(()=>globalThis.voiceCheck.user>0&&globalThis.voiceCheck.assistant>0,undefined,{timeout:45000});} catch(error) { const state=await page.evaluate(()=>({connection:voiceCheck.pc.connectionState,ice:voiceCheck.pc.iceConnectionState,user:voiceCheck.user,assistant:voiceCheck.assistant,errors:voiceCheck.errors,voices:voiceCheck.voices}));throw Error(phase+': '+JSON.stringify(state)); }
   const observed=await page.evaluate(()=>({user:globalThis.voiceCheck.user,assistant:globalThis.voiceCheck.assistant,voices:globalThis.voiceCheck.voices,errors:globalThis.voiceCheck.errors}));
   assert.ok(observed.voices.includes(voice));assert.equal(observed.errors,0);console.log('PASS: live WebRTC',companion,voice,'user/assistant transcription.');
   await page.evaluate(()=>{globalThis.voiceCheck.pc.close();globalThis.voiceCheck.stream.getTracks().forEach(t=>t.stop());});await context.close();
  }
 }

} catch(e) { console.error('FAIL:',e.message);process.exitCode=1; }
finally {if(browser)await browser.close().catch(()=>{});if(isolated)await isolated.cleanup().then(()=>console.log('Isolated check function deleted.')).catch(()=>{console.error('Check function cleanup failed.');process.exitCode=1;});if(userId&&admin)await json(base+'/auth/v1/admin/users/'+userId,{method:'DELETE',headers:admin}).then(()=>console.log('Temporary model-check account deleted.')).catch(()=>{console.error('Test account cleanup failed.');process.exitCode=1;});}
