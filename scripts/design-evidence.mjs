// Capture only public pages and isolated synthetic application states.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const out='docs/design-evidence';await mkdir(out,{recursive:true});
const ref=process.env.SUPABASE_PROJECT_REF||'domkmxmwmihcfadophfg',base=`https://${ref}.supabase.co`,site='https://chungchung234.github.io/English/';
const manifest={captured_at:new Date().toISOString(),viewport:{width:390,height:844},sources:[],app_states:[],limits:['Public competitor marketing/docs only; no competitor private app audit.','App states after login use an isolated synthetic test account.']};
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const context=await browser.newContext({viewport:manifest.viewport,deviceScaleFactor:1,permissions:['microphone']});
let testUser,serviceKey;
async function request(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(90000)});if(!r.ok)throw Error(`${new URL(url).pathname}: HTTP ${r.status}`);return r.json();}
const references=[
 ['apple-ios','https://developer.apple.com/design/human-interface-guidelines/designing-for-ios'],
 ['apple-layout','https://developer.apple.com/design/human-interface-guidelines/layout'],
 ['apple-buttons','https://developer.apple.com/design/human-interface-guidelines/buttons'],
 ['speak','https://www.speak.com/'],
 ['elsa','https://elsaspeak.com/'],
 ['praktika','https://praktika.ai/'],
 ['speak-store','https://apps.apple.com/us/app/speak-language-learning/id1286609883'],
 ['elsa-store','https://apps.apple.com/us/app/elsa-speak-english-learning/id1083804886']
];
try{
 const page=await context.newPage();
 await page.goto(site,{waitUntil:'networkidle',timeout:45000});await page.locator('#login-form').waitFor({state:'visible'});
 await page.screenshot({path:`${out}/01-current-login.png`});
 manifest.app_states.push({step:1,state:'login',file:'01-current-login.png',source:site});
 const keys=await request(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,{headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`}});
 serviceKey=keys.find(k=>k.name==='service_role')?.api_key;const publicKey=keys.find(k=>k.name==='anon')?.api_key;
 if(!serviceKey||!publicKey)throw Error('Isolated capture requires provider auth.');
 const admin={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'};
 const email=`loop-design-${randomUUID()}@example.invalid`,password=randomUUID()+randomUUID();
 testUser=await request(base+'/auth/v1/admin/users',{method:'POST',headers:admin,body:JSON.stringify({email,password,email_confirm:true})});
 const session=await request(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:publicKey,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
 await page.evaluate(({base,session})=>localStorage.setItem('loop.auth:'+base,JSON.stringify({...session,expires_at:Math.floor(Date.now()/1000)+session.expires_in})),{base,session});
 await page.reload({waitUntil:'networkidle'});await page.locator('#workspace').waitFor({state:'visible'});
 await page.screenshot({path:`${out}/02-current-home.png`});await page.screenshot({path:`${out}/02-current-home-full.png`,fullPage:true});
 const controls=await page.locator('button,input,select').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height).map(n=>({label:n.innerText||n.getAttribute('aria-label')||n.id,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,font:getComputedStyle(n).fontSize})));
 manifest.app_states.push({step:2,state:'signed-in home; no fabricated learner history',file:'02-current-home.png',full_file:'02-current-home-full.png',controls});
 await page.locator('#start-call').click();await page.waitForFunction(()=>document.querySelector('#call-status')?.textContent.includes('통화 중'),{},{timeout:60000});
 await page.screenshot({path:`${out}/03-current-call.png`});manifest.app_states.push({step:3,state:'connected call; synthetic account/device',file:'03-current-call.png'});
 await page.close();
 for(const [name,url] of references){
  const p=await context.newPage();const record={name,url};
  try{
   const response=await p.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await p.waitForTimeout(2500);
   record.status=response?.status();record.final_url=p.url();record.title=await p.title();
   const text=await p.locator('body').innerText();
   record.blocked=record.status>=400||/Just a moment|Access Denied|Verify you are human|Forbidden/i.test(record.title);
   if(!record.blocked){
    record.headings=await p.locator('h1,h2,h3').allTextContents();
    const main=(await p.locator('main').innerText().catch(()=>text)).replace(/\s+/g,' ').trim();record.short_excerpt=main.split(' ').slice(0,65).join(' ');
    record.file=`ref-${name}.png`;await p.screenshot({path:`${out}/${record.file}`});
    if(name.endsWith('-store')){
     const images=p.locator('img');let captured=0;
     for(let i=0;i<await images.count()&&captured<2;i++){
      const img=images.nth(i);const dimensions=await img.evaluate(n=>({w:n.naturalWidth,h:n.naturalHeight,alt:n.alt}));
      if(dimensions.h>400&&dimensions.w/dimensions.h>.35&&dimensions.w/dimensions.h<.7){
       await img.scrollIntoViewIfNeeded();await img.screenshot({path:`${out}/ref-${name}-screen-${++captured}.png`}).catch(()=>{});
      }
     }
     record.mobile_screenshot_count=captured;
    }
   }
  }catch{record.error='Navigation/capture unavailable';}
  manifest.sources.push(record);await p.close();
 }
}catch(error){manifest.error=error.message;process.exitCode=1;}
finally{
 await browser.close();
 if(testUser?.id&&serviceKey){try{await request(base+'/auth/v1/admin/users/'+testUser.id,{method:'DELETE',headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}});manifest.test_account_deleted=true;}catch{manifest.test_account_deleted=false;process.exitCode=1;}}
 await writeFile(`${out}/manifest.json`,JSON.stringify(manifest,null,2));
 console.log('Public design evidence saved; credentials and user identity excluded.');
}
