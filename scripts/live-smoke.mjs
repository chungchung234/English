// End-to-end release check. Uses only temporary confirmed test accounts and
// synthetic speech; deletes those accounts and their rows when finished.
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const ref=process.env.SUPABASE_PROJECT_REF||'domkmxmwmihcfadophfg';
const base=`https://${ref}.supabase.co`;
const site=process.env.SITE_URL;
if(!site||!process.env.SUPABASE_ACCESS_TOKEN||!process.env.SMOKE_AUDIO)throw Error('Live smoke needs site URL, provider authorization and synthetic audio.');
const origin=new URL(site).origin;
async function json(url,options={}){
 let response;try{response=await fetch(url,{...options,signal:AbortSignal.timeout(120000)});}catch{throw Error(`Could not reach ${new URL(url).hostname}.`);}
 const data=await response.json().catch(()=>null);
 if(!response.ok){const code=typeof data?.error?.code==='string'?data.error.code:'';throw Error(`${options.method||'GET'} ${new URL(url).pathname}: HTTP ${response.status} ${code}`);}
 return data;
}
const keys=await json(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,{headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`}});
const publicKey=keys.find(k=>k.name==='anon')?.api_key||keys.find(k=>k.type==='publishable')?.api_key;
const serviceKey=keys.find(k=>k.name==='service_role')?.api_key;
if(!publicKey||!serviceKey)throw Error('Provider public/admin keys are required for isolated release tests.');
const adminHeaders={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'};
const created=[];let browser;
const userRequest=(user,path,body)=>json(base+path,{method:body===undefined?'GET':'POST',headers:{apikey:publicKey,Authorization:`Bearer ${user.access_token}`,Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
try{
 for(let i=0;i<2;i++){
  const email=`loop-smoke-${randomUUID()}@example.invalid`,password=randomUUID()+randomUUID();
  const user=await json(base+'/auth/v1/admin/users',{method:'POST',headers:adminHeaders,body:JSON.stringify({email,password,email_confirm:true})});
  created.push({id:user.id});
  const session=await json(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:publicKey,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  created[i]=session;
 }
 console.log('PASS: temporary test accounts authenticated against live Supabase.');
 const [learner,other]=created;
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${process.env.SMOKE_AUDIO}`]});
 const context=await browser.newContext({permissions:['microphone'],viewport:{width:390,height:844}});
 await context.addInitScript(({base,session})=>localStorage.setItem('loop.auth:'+base,JSON.stringify({...session,expires_at:Math.floor(Date.now()/1000)+session.expires_in})),{base,session:learner});
 const page=await context.newPage();page.setDefaultTimeout(90000);
 await page.goto(site,{waitUntil:'networkidle'});
 await page.locator('#workspace').waitFor({state:'visible'});
 await page.locator('#start-call').click();
 await page.waitForFunction(()=>document.querySelector('#call-status')?.textContent.includes('통화 중'),{},{timeout:60000});
 console.log('PASS: real WebRTC voice connection established on published site.');
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('#transcript li')).some(li=>li.querySelector('b')?.textContent==='YOU'&&/friend|park|caf[eé]|yesterday|alex/i.test(li.textContent)),{},{timeout:90000});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('#transcript li')).some(li=>li.querySelector('b')?.textContent==='ALEX'),{},{timeout:90000});
 await page.locator('#end-call').click();
 await page.waitForFunction(()=>document.querySelector('#call-status')?.textContent==='통화와 피드백 저장 완료',{},{timeout:120000});
 console.log('PASS: synthetic speech transcribed, model replied, cloud transcript and evidence-backed feedback saved.');
 const sessions=await userRequest(learner,'/rest/v1/sessions?select=id,status');
 if(sessions.length!==1||sessions[0].status!=='ended')throw Error('Live session did not finish exactly once.');
 const id=sessions[0].id;
 const events=await userRequest(learner,`/rest/v1/transcript_events?select=id,speaker&session_id=eq.${id}`);
 if(!events.some(e=>e.speaker==='user')||!events.some(e=>e.speaker==='assistant'))throw Error('Both speakers were not saved.');
 const hidden=await userRequest(other,`/rest/v1/transcript_events?select=id&session_id=eq.${id}`);
 if(hidden.length)throw Error('Cross-account transcript access was allowed.');
 const hiddenAnalyses=await userRequest(other,`/rest/v1/analyses?select=id&session_id=eq.${id}`);
 if(hiddenAnalyses.length)throw Error('Cross-account analysis access was allowed.');
 const memory=await userRequest(learner,'/functions/v1/coach/memory',{});
 if(!memory.memories?.length)throw Error('Saved learning memory was not retrieved.');
 await page.reload({waitUntil:'networkidle'});
 await page.locator('.history-entry').first().waitFor({state:'visible'});
 if(await page.locator('.analysis').count()===0)throw Error('Feedback did not reload.');
 console.log('PASS: reload restores history and feedback; other account cannot read transcripts or analyses.');
 const weekly=await userRequest(learner,'/functions/v1/coach/weekly',{});
 if(weekly.analysis?.kind!=='weekly'||!weekly.analysis?.source_event_ids?.length)throw Error('Weekly analysis did not preserve evidence.');
 console.log('PASS: upper-tier weekly analysis completed with source references.');
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/live-mobile.png',fullPage:true});
 console.log('Live release checks passed. Email delivery and managed backup restore are separate acceptance checks.');
}catch(error){
 // Never serialize request bodies, credentials, browser storage or provider data.
 console.error('::error title=Live release check::'+error.message.replaceAll('%','%25').replaceAll('\n','%0A'));
 process.exitCode=1;
}finally{
 await browser?.close();
 for(const session of created){const id=session.user?.id||session.id;if(!id)continue;try{await json(base+'/auth/v1/admin/users/'+id,{method:'DELETE',headers:adminHeaders});}catch{console.error('::warning::Temporary test account cleanup failed; inspect the test account names in Supabase Auth.');process.exitCode=1;}}
 console.log('Temporary account cleanup attempted.');
}
