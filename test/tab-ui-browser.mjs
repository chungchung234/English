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
 const content={next_scenario:'가벼운 주말 계획 이야기',summary:'친구와 다녀온 카페에 관해 이야기했어요.',scope:{companionId:'alex',session_count:1,user_event_count:1},corrections:[{original:'Yesterday I go to a cafe with my friend.',improved:'Yesterday I went to a cafe with my friend.',reason:'과거의 일이므로 went로 말해요.',evidence_ids:[eid]}],practice:[{expression:'I have been meaning to try that place.',evidence_ids:[eid]}],strengths:[{text:'경험을 구체적으로 이야기했어요.',evidence_ids:[eid]}]};
 const analysis={id:'55555555-5555-4555-8555-555555555555',session_id:sid,kind:'session',content};
 const transcriptText=Array(80).fill(content.corrections[0].original).join('\n');
 const learningItem={id:'66666666-6666-4666-8666-666666666666',analysis_id:analysis.id,session_id:sid,expression:content.corrections[0].improved,original:content.corrections[0].original,reason:'과거형으로 말해요.',state:'unpracticed',status:'active',revision:1,enrolled:true,practice_count:0,companion_id:'alex',category:'error',has_valid_source:true,source_session_id:sid,source_analysis_id:analysis.id,evidence_ids:[eid],sources:[{session_id:sid,analysis_id:analysis.id,valid:true}]};let learningSeeded=false,learningFailure=false;const plans={};
 let mode='populated',weeklyCalls=0,reviewCalls=0,holdWeekly=false,releaseWeekly,weeklyArrived,slowTranscript=false,transcriptStarted,releaseTranscript;
 let holdHistory=false,historyArrived,releaseHistory;
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:'globalThis.LOOP_PUBLIC_CONFIG={url:"https://test-project.supabase.co",key:"sb_publishable_test"};'}));
 await page.route('https://test-project.supabase.co/**',async route=>{
    if(new URL(route.request().url()).pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}});
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
  else if(url.pathname.endsWith('/rpc/review_journal'))data={calls:mode==='populated'?[{session:sessions[0],analysis_id:analysis.id,status:'ready',strengths:content.strengths,expressions:[{key:'cafe',kind:'error',expression:content.corrections[0].improved,original:content.corrections[0].original,reason:content.corrections[0].reason,evidence_ids:[eid],saved:false,bookmark_revision:0},{key:'try',kind:'reusable',expression:content.practice[0].expression,evidence_ids:[eid],saved:false,bookmark_revision:0}]}]:[],next:null};
  else if(url.pathname.endsWith('/rpc/review_note'))data={session:sessions[0],analysis_id:analysis.id,status:'ready',strengths:content.strengths,expressions:[{key:'cafe',kind:'error',expression:content.corrections[0].improved,original:content.corrections[0].original,reason:content.corrections[0].reason,evidence_ids:[eid],saved:false,bookmark_revision:0},{key:'try',kind:'reusable',expression:content.practice[0].expression,evidence_ids:[eid],saved:false,bookmark_revision:0}]};
  else if(url.pathname.endsWith('/rpc/learning_snapshot')||url.pathname.endsWith('/rpc/learning_recommend_more'))data={items:mode==='populated'&&body.p_companion_id==='alex'?[learningItem]:[],recommended_item_ids:mode==='populated'&&learningItem.status==='active'?[learningItem.id]:[],feedback:mode==='populated'&&body.p_companion_id==='alex'?[{session_id:sid,analysis_id:analysis.id,current:true,job_state:'completed',has_user_speech:true,exposed_at:null}]:[],next_plan:plans[body.p_companion_id]?{id:'77777777-7777-4777-8777-777777777777',item_id:learningItem.id,source_session_id:sid,source_analysis_id:analysis.id,scenario:plans[body.p_companion_id]}:null};
  else if(url.pathname.endsWith('/rpc/learning_record_event'))data={saved:true};
  else if(url.pathname.endsWith('/rpc/learning_enhancement_snapshot'))data={reviews:[],schedules:[],recalls:[],usage:[],weekly_goals:[],personalized_item_ids:[],recommendation_reasons:{}};
  else if(url.pathname.endsWith('/rpc/learning_action')){
   if(learningFailure)return route.fulfill({status:503,json:{message:'Practice save unavailable'}});
   learningItem.revision++;
   if(body.p_action==='practice'){learningItem.status='practiced';learningItem.state='practiced';learningItem.practice_count=1;}
   if(body.p_action==='defer'){learningItem.status='deferred';learningItem.state='deferred';}
   if(body.p_action==='prepare_next')plans.alex=content.next_scenario;
   data={outcome:'applied',item:{...learningItem},...(body.p_action==='prepare_next'?{next_plan:{id:body.p_action_id,item_id:learningItem.id,source_session_id:sid,source_analysis_id:analysis.id,scenario:plans.alex}}:{})};
  }
  else if(url.pathname.endsWith('/rpc/learning_plan')){if(body.p_scenario)plans[body.p_companion_id]=body.p_scenario;data={scenario:plans[body.p_companion_id]||null};}
  else if(url.pathname.endsWith('/rpc/learning_review')){if(body.p_analysis_id)learningSeeded=true;if(body.p_item_id){if(learningFailure)return route.fulfill({status:503,json:{message:'Practice save unavailable'}});learningItem.state=body.p_state;}data=mode==='populated'&&body.p_companion_id==='alex'&&learningSeeded?[learningItem]:[];}
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
  assert(await page.locator('#call-detail-content .call-transcript').evaluate(node=>node.open),'history detail opens its transcript immediately');
  await page.waitForFunction(()=>document.querySelector('#call-detail-content .call-transcript pre')?.textContent.includes('Yesterday'));
  assert.equal(await page.locator('#call-detail-content .call-transcript pre').textContent(),'나: '+transcriptText);
  await page.locator('#call-detail-content').evaluate(node=>node.scrollTop=node.scrollHeight);
  assert(await page.locator('[data-close="call-detail-dialog"]').evaluate(node=>{const box=node.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}),'the close control remains visible while a long transcript scrolls');
  await page.screenshot({path:'test-results/call-detail-long.png'});
  assert.equal(await page.locator('.call-management').getAttribute('open'),null);
  await page.locator('.call-feedback').click();await page.locator('#review-panel').waitFor({state:'visible'});
  await page.locator('#post-call-transcript').waitFor({state:'visible'});
  assert.equal(await page.locator('#review-panel').getAttribute('data-session-view'),'transcript');
  assert.equal(await page.locator('#practice-preview').isVisible(),false);
  await page.locator('#session-feedback-open').click();
  const feedback=page.locator('#session-feedback-content');
  await feedback.waitFor({state:'visible'});
  assert.match(await feedback.innerText(),/경험을 구체적으로/);
  assert.match(await feedback.innerText(),/Yesterday I went/);
  assert.equal(await page.locator('[data-action="practice"]').count(),0,'solo practice is not offered');
  const contrast=await feedback.locator('.original').first().evaluate(node=>{
    const values=getComputedStyle(node).color.match(/\d+/g).slice(0,3).map(Number);
    const linear=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
    const l=values.map(linear).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);return 1.05/(l+.05);
  });assert(contrast>=4.5,'normal correction text meets AA contrast on white');
  await feedback.locator('[data-feedback-source]').first().click();
  assert(await page.locator('#post-call-transcript').isVisible());
  await page.locator('#session-feedback-open').click();
  assert.equal(reviewCalls,0,'opening saved feedback never regenerates analysis');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/post-call-feedback.png'});
  await page.setViewportSize({width:320,height:568});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#session-review-exit').click();
  assert.equal(learningItem.status,'active','finishing the view records no practice or defer');
  assert.deepEqual(plans,{},'finishing does not prepare another call');

  await page.locator('[data-view="history"]').click();
  slowTranscript=true;const transcriptWaiting=new Promise(resolve=>transcriptStarted=resolve);
  await page.locator('#history .history-open').first().click();await transcriptWaiting;
  await page.locator('[data-close="call-detail-dialog"]').click();await page.locator('#history .history-open').nth(1).click();
  const transcriptDone=page.waitForResponse(response=>new URL(response.url()).pathname==='/rest/v1/transcript_events');releaseTranscript();await transcriptDone;
  assert.equal(await page.locator('#call-detail-title').textContent(),'Juno와의 통화');assert(!(await page.locator('#call-detail-content').textContent()).includes(content.corrections[0].original),'a closed call detail cannot inject a late transcript into another call');
  assert.equal(await page.locator('#companion-name').textContent(),'Alex','reading another call does not change the selected companion');
  await page.locator('[data-close="call-detail-dialog"]').click();await page.locator('[data-view="contacts"]').click();
  await page.locator('[data-companion="juno"]').click();assert.equal(await page.locator('#weekly').isEnabled(),false,'calls older than seven days cannot start weekly analysis');
  await page.locator('[data-companion="alex"]').click();await page.locator('[data-view="history"]').click();await page.locator('#weekly').waitFor({state:'visible'});
  holdWeekly=true;const weeklyWaiting=new Promise(resolve=>weeklyArrived=resolve);
  await page.locator('#weekly').evaluate(button=>{button.onclick();button.onclick();});await weeklyWaiting;
  assert.equal(weeklyCalls,1,'weekly requests are deduplicated while pending');assert.equal(await page.locator('#weekly').isDisabled(),true);
  const weeklyDone=page.waitForResponse(response=>response.url().endsWith('/coach/weekly'));releaseWeekly();await weeklyDone;
  await page.waitForFunction(()=>document.querySelector('#review-content [data-analysis-kind=weekly]')&&document.querySelector('#review-context').textContent==='Alex와의 대화');
  await page.locator('#review-back').click();
  assert.equal(await page.locator('#weekly').isEnabled(),true);
  await page.locator('[data-view="review"]').click();
  await page.locator('#review-journal [data-expression-key]').first().click();
  await page.locator('#review-journal [data-note-expression="cafe"]').waitFor();
  assert.equal(await page.locator('#review-journal [data-note-expression]').count(),1,'real app integration opens only the selected expression');
  await page.locator('#review-journal [data-note-expression="cafe"]').getByRole('button',{name:'대화에서 보기',exact:true}).click();
  await page.locator('#review-journal [data-source-highlight]').waitFor();
  await page.getByRole('button',{name:'표현 상세',exact:true}).click();
  await page.locator('#review-back').click();
  await page.locator('#review-journal .journal-expression').first().waitFor();
  assert.equal(reviewCalls,0,'journal browsing and source jumps reuse stored analysis');
  mode='empty';await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#history').textContent.includes('아직 통화 기록'));
  await page.locator('[data-view="review"]').click();assert.equal(await page.locator('#weekly').isVisible(),false);assert.equal(await page.locator('#weekly').isDisabled(),true);assert.equal(await page.locator('#practice-preview').isVisible(),false);
  await page.locator('#weekly').evaluate(button=>button.onclick());assert.equal(weeklyCalls,1,'even a programmatic click cannot request weekly analysis without eligible calls');
  await page.locator('[data-view="history"]').click();assert.equal(await page.locator('#memory-search').isVisible(),false);assert.equal(await page.locator('#history-tools').isVisible(),false);
  await page.locator('[data-view="contacts"]').click();await page.locator('[data-companion="mia"]').click();mode='older-page';
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelectorAll('#history .history-entry').length===30);
  await page.locator('[data-view="history"]').click();assert.equal(await page.locator('#weekly').isEnabled(),true,'an eligible call outside the recent 30 must still permit weekly analysis');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }finally{releaseHistory?.();releaseWeekly?.();releaseTranscript?.();await context.close();}
 assert.deepEqual(errors,[]);
 console.log('PASS: call details preserve cached feedback and isolate delayed transcripts; separate feedback has readable contrast; weekly availability, result display and request deduplication follow eligible calls.');
}
