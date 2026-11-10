import assert from 'node:assert/strict';
export async function testTabUI(browser,base){
 const context=await browser.newContext({viewport:{width:320,height:568},reducedMotion:'reduce'}),page=await context.newPage();
 const uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sid='11111111-1111-4111-8111-111111111111',eid='44444444-4444-4444-8444-444444444444';
 const now=Date.now(),stamp=days=>new Date(now-days*86400000).toISOString();
 const sessions=[
  {id:sid,user_id:uid,companion_id:'alex',status:'ended',created_at:stamp(.1),ended_at:stamp(.09)},
  {id:'22222222-2222-4222-8222-222222222222',user_id:uid,companion_id:'juno',status:'ended',created_at:stamp(8),ended_at:stamp(8)},
  {id:'33333333-3333-4333-8333-333333333333',user_id:uid,companion_id:'mia',status:'active',created_at:stamp(.2)},
 ];
 const content={summary:'친구와 다녀온 카페에 관해 이야기했어요.',scope:{companionId:'alex',session_count:1,user_event_count:1},corrections:[{original:'Yesterday I go to a cafe with my friend.',improved:'Yesterday I went to a cafe with my friend.',reason:'과거의 일이므로 went로 말해요.',evidence_ids:[eid]}],practice:[{expression:'I have been meaning to try that place.',evidence_ids:[eid]}],strengths:[{text:'경험을 구체적으로 이야기했어요.',evidence_ids:[eid]}]};
 const analysis={id:'55555555-5555-4555-8555-555555555555',session_id:sid,kind:'session',content};
 const transcriptText=Array(80).fill(content.corrections[0].original).join('\n');
 let mode='populated',weeklyCalls=0,reviewCalls=0,holdWeekly=false,releaseWeekly,weeklyArrived,slowTranscript=false,transcriptStarted,releaseTranscript;
 let holdHistory=false,historyArrived,releaseHistory;
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:'globalThis.LOOP_PUBLIC_CONFIG={url:"https://test-project.supabase.co",key:"sb_publishable_test"};'}));
 await page.route('https://test-project.supabase.co/**',async route=>{
  const url=new URL(route.request().url()),body=route.request().postDataJSON?.();let data=[];
  if(url.pathname==='/auth/v1/user')data={id:uid};
  else if(url.pathname==='/auth/v1/settings')data={external:{google:false,kakao:false}};
  else if(url.pathname.endsWith('/coach/config'))data={models:{voice:'fixture',coach:'fixture',analysis:'fixture'}};
  else if(url.pathname==='/rest/v1/sessions'){
   if(holdHistory&&url.searchParams.get('select')==='*'){holdHistory=false;const waiting=new Promise(resolve=>releaseHistory=resolve);historyArrived();await waiting;}
   if(mode==='empty')data=[];
   else if(mode==='older-page')data=url.searchParams.get('select')==='*'?Array.from({length:30},(_,i)=>({...sessions[1],id:'old-'+i})): [{companion_id:'mia',status:'ended',ended_at:stamp(1)}];
   else data=sessions;
  }
  else if(url.pathname==='/rest/v1/analyses')data=mode==='populated'?[analysis]:[];
  else if(url.pathname.endsWith('/coach/memory'))data={memories:mode==='populated'?[{...content,session_id:sid}]:[]};
  else if(url.pathname.endsWith('/coach/memory-manage'))data={revision:0,facts:[],excluded_sessions:[],history_suppressed:false};
  else if(url.pathname==='/rest/v1/transcript_events'){
   if(slowTranscript){slowTranscript=false;transcriptStarted();await new Promise(resolve=>releaseTranscript=resolve);}
   data=[{id:eid,session_id:sid,speaker:'user',text:transcriptText,timestamp:stamp(.1)}];
  }
  else if(url.pathname.endsWith('/coach/weekly')){
   weeklyCalls++;if(holdWeekly){const waiting=new Promise(resolve=>releaseWeekly=resolve);weeklyArrived();await waiting;}
   data={analysis:{id:'weekly',kind:'weekly',content:{...content,summary:'최근 7일의 영어 표현을 정리했어요.',scope:{...content.scope,companionId:body.companionId}}}};
  }
  else if(url.pathname.endsWith('/coach/review')){reviewCalls++;data={analysis};}
  else throw Error('Unexpected tab fixture route '+url.pathname);
  await route.fulfill({status:200,json:data,headers:Array.isArray(data)?{'Content-Range':'0-0/'+data.length,'Access-Control-Expose-Headers':'Content-Range'}:{}});
 });
 try{
  await page.goto(base);await page.locator('#login-form').waitFor({state:'visible'});
  await page.evaluate(uid=>localStorage.setItem('loop.auth:https://test-project.supabase.co',JSON.stringify({access_token:'test-jwt',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}})),uid);
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelectorAll('#history .history-entry').length===3);
  holdHistory=true;const historyWaiting=new Promise(resolve=>historyArrived=resolve);
  const previousRow=await page.locator('#history .history-entry').first().elementHandle();
  await page.locator('[data-view="history"]').click();await historyWaiting;
  assert.equal(await page.locator('#history .history-entry').first().getByRole('button').count(),2,'each call row exposes only detail and redial');
  await page.locator('#history .history-open').first().click();
  const historyDone=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/rest/v1/sessions'&&url.searchParams.get('select')==='*';});releaseHistory();await historyDone;
  await page.waitForFunction(row=>!row.isConnected,previousRow);await previousRow.dispose();
  await page.locator('.call-transcript summary').click();
  await page.waitForFunction(()=>document.querySelector('.call-transcript pre')?.textContent.includes('Yesterday'));
  assert.equal(await page.locator('.call-transcript pre').textContent(),'나: '+transcriptText);
  await page.locator('#call-detail-content').evaluate(node=>node.scrollTop=node.scrollHeight);
  assert(await page.locator('[data-close="call-detail-dialog"]').evaluate(node=>{const box=node.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}),'the close control remains visible while a long transcript scrolls');
  await page.screenshot({path:'test-results/call-detail-long.png'});
  assert.equal(await page.locator('.call-management').getAttribute('open'),null);
  await page.locator('.call-feedback').click();await page.locator('#review-panel').waitFor({state:'visible'});
  assert.equal(await page.locator('#review-content h4').first().textContent(),'더 자연스럽게 말하기');
  assert(await page.locator('.improved').first().evaluate(node=>node.getBoundingClientRect().top<document.querySelector('.glass-dock').getBoundingClientRect().top),'the correction must appear above the dock on a compact screen');
  assert.equal(await page.locator('.feedback-context').getAttribute('open'),null);assert.equal(await page.locator('#practice-preview').isVisible(),false);
  const contrast=await page.locator('.original').first().evaluate(node=>{
   const values=getComputedStyle(node).color.match(/\d+/g).slice(0,3).map(Number);
   const linear=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
   const l=values.map(linear).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);return 1.05/(l+.05);
  });assert(contrast>=4.5,'normal correction text must meet AA contrast on white');
  await page.locator('#review-content .feedback-item').first().getByRole('button',{name:'근거 발화'}).click();await page.locator('blockquote').waitFor({state:'visible'});
  assert.equal(reviewCalls,0,'opening saved feedback never regenerates analysis');
  await page.locator('[data-view="history"]').click();await page.locator('#history .history-open').first().click();
  slowTranscript=true;const transcriptWaiting=new Promise(resolve=>transcriptStarted=resolve);
  await page.locator('.call-transcript summary').click();await transcriptWaiting;
  await page.locator('[data-close="call-detail-dialog"]').click();await page.locator('#history .history-open').nth(1).click();
  const transcriptDone=page.waitForResponse(response=>new URL(response.url()).pathname==='/rest/v1/transcript_events');releaseTranscript();await transcriptDone;
  assert.equal(await page.locator('#call-detail-title').textContent(),'Juno와의 통화');assert(!(await page.locator('#call-detail-content').textContent()).includes(content.corrections[0].original),'a closed call detail cannot inject a late transcript into another call');
  assert.equal(await page.locator('#companion-name').textContent(),'Alex','reading another call does not change the selected companion');
  await page.locator('[data-close="call-detail-dialog"]').click();await page.locator('[data-view="contacts"]').click();
  await page.locator('[data-companion="juno"]').click();assert.equal(await page.locator('#weekly').isEnabled(),false,'calls older than seven days cannot start weekly analysis');
  await page.locator('[data-companion="alex"]').click();await page.locator('[data-view="review"]').click();await page.locator('#weekly').waitFor({state:'visible'});
  holdWeekly=true;const weeklyWaiting=new Promise(resolve=>weeklyArrived=resolve);
  await page.locator('#weekly').evaluate(button=>{button.onclick();button.onclick();});await weeklyWaiting;
  assert.equal(weeklyCalls,1,'weekly requests are deduplicated while pending');assert.equal(await page.locator('#weekly').isDisabled(),true);
  const weeklyDone=page.waitForResponse(response=>response.url().endsWith('/coach/weekly'));releaseWeekly();await weeklyDone;
  await page.waitForFunction(()=>document.querySelector('#review-content h3')?.textContent==='Alex · 최근 7일 분석');
  assert.equal(await page.locator('#weekly').isEnabled(),true);
  mode='empty';await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#history').textContent.includes('아직 통화 기록'));
  await page.locator('[data-view="review"]').click();assert.equal(await page.locator('#weekly').isVisible(),false);assert.equal(await page.locator('#weekly').isDisabled(),true);assert.equal(await page.locator('#practice-preview').isVisible(),false);
  await page.locator('#weekly').evaluate(button=>button.onclick());assert.equal(weeklyCalls,1,'even a programmatic click cannot request weekly analysis without eligible calls');
  await page.locator('[data-view="history"]').click();assert.equal(await page.locator('#memory-search').isVisible(),false);assert.equal(await page.locator('#history-tools').isVisible(),false);
  await page.locator('[data-view="contacts"]').click();await page.locator('[data-companion="mia"]').click();mode='older-page';
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelectorAll('#history .history-entry').length===30);
  await page.locator('[data-view="review"]').click();assert.equal(await page.locator('#weekly').isEnabled(),true,'an eligible call outside the recent 30 must still permit weekly analysis');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }finally{releaseHistory?.();releaseWeekly?.();releaseTranscript?.();await context.close();}
 assert.deepEqual(errors,[]);
 console.log('PASS: call details preserve cached feedback and isolate delayed transcripts; corrections lead with readable contrast; weekly availability, result display and request deduplication follow eligible calls.');
}
