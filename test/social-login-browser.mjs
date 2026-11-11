import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';

const endpoint='https://social-fixture.supabase.co',uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function token(id,label='fixture'){
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 return encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,exp:Math.floor(Date.now()/1000)+3600,jti:label})+'.'+Buffer.from('fixture-signature').toString('base64url');
}
async function fixture(browser,{approved=true,gates={},started={}}={}){
 const context=await browser.newContext({viewport:{width:390,height:844}});
 const state={authorizations:[],exchanges:[],refreshes:0,mails:0,history:0,linkRequests:0,errors:[],user:{id:uid,email:'existing@example.com',identities:[{provider:'google'}]}};
 await context.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:`globalThis.LOOP_PUBLIC_CONFIG={url:"${endpoint}",key:"sb_publishable_fixture"};`}));
 await context.route('https://kauth.kakao.com/**',route=>route.fulfill({contentType:'text/html',body:'Kakao consent fixture'}));
 await context.route(endpoint+'/**',async route=>{
    if(new URL(route.request().url()).pathname.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}});
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path.endsWith('/coach/memory-prepare'))return route.fulfill({json:{status:'unavailable'}}); // Background delivery is outside this fixture's scope.
  if(path==='/auth/v1/settings'){started.settings?.();await gates.settings;return route.fulfill({json:{external:{google:true,kakao:true}}});}
  if(path==='/auth/v1/authorize'){
   state.authorizations.push(url);
   assert.equal(url.searchParams.get('code_challenge_method'),'s256');assert(url.searchParams.get('code_challenge'));
    if(url.searchParams.get('provider')==='kakao')assert.equal(url.searchParams.get('scope'),'account_email');
   return route.fulfill({contentType:'text/html',body:'Google or Kakao consent fixture'});
  }
  if(path==='/auth/v1/user/identities/authorize'){
   state.linkRequests++;assert(request.headers().authorization?.startsWith('Bearer '));
    assert.equal(url.searchParams.get('scope'),'account_email');
   state.authorizations.push(url);
   return route.fulfill({json:{url:'https://kauth.kakao.com/oauth/authorize?fixture=link'}});
  }
  if(path==='/auth/v1/token'){
   const body=request.postDataJSON(),grant=url.searchParams.get('grant_type');
   if(grant==='pkce'){
    state.exchanges.push(body);
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'),state.authorizations.at(-1).searchParams.get('code_challenge'));
    if(body.auth_code==='link-kakao')state.user.identities.push({provider:'kakao'});
   }else{assert.equal(grant,'refresh_token');state.refreshes++;}
   return route.fulfill({json:{access_token:token(state.user.id,grant),refresh_token:'fixture-refresh-'+state.refreshes,expires_in:3600,token_type:'bearer',user:state.user,provider_token:'unneeded-provider-token',provider_refresh_token:'unneeded-provider-refresh'}});
  }
  if(path==='/auth/v1/user'){started.user?.();await gates.user;return route.fulfill({json:state.user});}
  if(path==='/auth/v1/logout')return route.fulfill({status:204});
  if(path==='/auth/v1/otp'){state.mails++;throw Error('Social login must not send mail');}
  if(path.endsWith('/coach/config')){started.config?.();await gates.config;return route.fulfill({status:approved?200:403,json:approved?{models:{voice:'fixture',coach:'fixture',analysis:'fixture'}}:{error:{code:'ACCOUNT_NOT_ALLOWED',message:'승인된 이메일 계정만 이용할 수 있습니다.'}}});}
  if(path.startsWith('/rest/v1/')){state.history++;return route.fulfill({json:[],headers:{'Content-Range':'0-0/0','Access-Control-Expose-Headers':'Content-Range'}});}
  if(path.endsWith('/coach/memory'))return route.fulfill({json:{memories:[]}});
  if(path.endsWith('/rpc/learning_snapshot'))return route.fulfill({json:{items:[],feedback:[],recommended_item_ids:[],next_plan:null}});
  if(path.endsWith('/rpc/learning_record_event'))return route.fulfill({json:{saved:true}});
  if(path.endsWith('/rpc/learning_enhancement_snapshot'))return route.fulfill({json:{reviews:[],schedules:[],recalls:[],usage:[],weekly_goals:[],personalized_item_ids:[],recommendation_reasons:{}}});
  if(path.endsWith('/rpc/learning_plan'))return route.fulfill({json:{scenario:null}});
  if(path.endsWith('/rpc/learning_review'))return route.fulfill({json:[]});
  throw Error('Unexpected social fixture path: '+path);
 });
 context.on('page',page=>page.on('pageerror',error=>state.errors.push(error.message)));
 return {context,state};
}

export async function testSocialLogin(browser,base){
 const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
 const settings=deferred(),user=deferred(),config=deferred(),userStarted=deferred(),configStarted=deferred();
 const delayed=await fixture(browser,{gates:{settings:settings.promise,user:user.promise,config:config.promise},started:{user:userStarted.resolve,config:configStarted.resolve}});
 try{
  await delayed.context.addInitScript(({endpoint,uid,accessToken,origin})=>{if(location.origin===origin)localStorage.setItem('loop.auth:'+endpoint,JSON.stringify({access_token:accessToken,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}}));},{endpoint,uid,accessToken:token(uid),origin:base});
  const page=await delayed.context.newPage();await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('#auth-transition').waitFor({state:'visible'});
  await Promise.all([userStarted.promise,configStarted.promise]);
  assert.equal(await page.locator('#setup').isVisible(),false,'a recovered session leaves login immediately');
  assert.equal(await page.locator('#workspace').isVisible(),false,'approval is still required before showing the app');
  assert.equal(delayed.state.history,0,'no private reads while approval is pending');
  await page.evaluate(()=>{const workspace=document.querySelector('#workspace'),panel=document.querySelector('#auth-transition');new MutationObserver(()=>{if(!workspace.hidden)window.authRevealProbe={fading:panel.getAnimations().some(animation=>animation.playState==='running'),blocksInput:getComputedStyle(panel).pointerEvents!=='none'};}).observe(workspace,{attributes:true,attributeFilter:['hidden']});});
  config.resolve();user.resolve();
  await page.locator('#workspace').waitFor({state:'visible'});
  assert.equal(await page.locator('#auth-transition').evaluate(node=>getComputedStyle(node).pointerEvents),'none','the outgoing transition must not block home input');
  await page.locator('#auth-transition').waitFor({state:'hidden'});
  assert.equal(await page.locator('#auth-transition').isVisible(),false);
  assert.equal(await page.locator('#setup').isVisible(),false,'slow provider settings must not block the authenticated screen');
  assert.deepEqual(await page.evaluate(()=>window.authRevealProbe),{fading:true,blocksInput:false},'home becomes active while the old screen crossfades without an input-blocking delay');
  settings.resolve();await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
  assert.equal(await page.locator('#auth-transition').isVisible(),false);assert.equal(await page.locator('#workspace').evaluate(node=>node.getAnimations().length),0,'reduced motion enters without a crossfade');
  assert.deepEqual(delayed.state.errors,[]);
  console.log('PASS: slow provider settings do not block entry; user/approval checks run concurrently with a visible transition and no private reads before approval.');
 }finally{settings.resolve();user.resolve();config.resolve();await delayed.context.close();}

 const {context,state}=await fixture(browser);
 try{
  let page=await context.newPage();await page.goto(base);
  await page.waitForFunction(()=>!document.querySelector('[data-oauth="google"]').disabled);
  assert.equal(await page.locator('#email-login').getAttribute('open'),null,'email fallback starts collapsed when social login is ready');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/social-login-ready.png',fullPage:true});
  await page.locator('[data-oauth="google"]').click();await page.waitForURL(endpoint+'/auth/v1/authorize?**');
  assert.equal(state.authorizations.length,1);assert.equal(state.authorizations[0].searchParams.get('provider'),'google');
  await page.goto(base+'/?code=google-signin');await page.locator('#workspace').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).search,'');assert.equal(state.exchanges.length,1);assert.equal(state.mails,0);
  const saved=await page.evaluate(endpoint=>localStorage.getItem('loop.auth:'+endpoint),endpoint);
  assert.equal(JSON.parse(saved).user.id,uid);assert(!saved.includes('unneeded-provider'));
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
  await page.close();page=await context.newPage();await page.goto(base);await page.locator('#workspace').waitFor({state:'visible'});
  assert.equal(state.authorizations.length,1);assert.equal(state.mails,0);
  // Expire the fixture while the SDK is unloaded. Otherwise reload can abort
  // an auto-refresh after the server counted it, making this assertion racy.
  await page.route(base+'/session-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Session fixture</title>'}));
  await page.goto(base+'/session-fixture');
  await page.evaluate(endpoint=>{const key='loop.auth:'+endpoint,session=JSON.parse(localStorage.getItem(key));session.expires_at=Math.floor(Date.now()/1000)-10;localStorage.setItem(key,JSON.stringify(session));},endpoint);
  await page.goto(base);await page.locator('#workspace').waitFor({state:'visible'});assert.equal(state.refreshes,1);
  await page.locator('#account-open').click();assert.match(await page.locator('[data-link-provider="google"]').textContent(),/연결됨/);
  await page.locator('[data-link-provider="kakao"]').click();await page.waitForURL('https://kauth.kakao.com/**');
  assert.equal(state.linkRequests,1);assert.equal(state.authorizations.at(-1).searchParams.get('provider'),'kakao');
  await page.goto(base+'/?code=link-kakao');await page.locator('#workspace').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('계정을 연결'));
  await page.locator('#account-open').click();assert.match(await page.locator('[data-link-provider="kakao"]').textContent(),/연결됨/);
  assert.equal(JSON.parse(await page.evaluate(endpoint=>localStorage.getItem('loop.auth:'+endpoint),endpoint)).user.id,uid);
  await page.screenshot({path:'test-results/social-account-linked.png',fullPage:true});
  const peer=await context.newPage();await peer.goto(base);await peer.locator('#workspace').waitFor({state:'visible'});
  await page.locator('#logout').click();await page.locator('#setup').waitFor({state:'visible'});await peer.locator('#setup').waitFor({state:'visible'});
  assert.equal(await peer.locator('#workspace').isVisible(),false);assert.equal(state.mails,0);assert.deepEqual(state.errors,[]);
  console.log('PASS: official SDK OAuth uses matching PKCE proof, scrubs callback URLs/provider tokens, keeps login across reloads/tabs/refresh, links Kakao to the same user, and propagates logout. Providers are simulated.');
 }finally{await context.close();}

 const denied=await fixture(browser,{approved:false});
 try{
  const page=await denied.context.newPage();await page.clock.install();await page.goto(base);await page.waitForFunction(()=>!document.querySelector('[data-oauth="kakao"]').disabled);
  await page.evaluate(async({endpoint,uid})=>{const {createOutbox}=await import('/src/outbox.js');const id='22222222-2222-4222-8222-222222222222';await createOutbox().put({id,scope:endpoint+'|'+uid,sessionId:'11111111-1111-4111-8111-111111111111',event:{id,event_key:'denied-fixture',speaker:'user',text:'Fixture pending record',occurred_at:new Date().toISOString()}});},{endpoint,uid});
  await page.locator('[data-oauth="kakao"]').click();await page.waitForURL(endpoint+'/auth/v1/authorize?**');
  await page.goto(base+'/?code=unapproved-account');await page.locator('#access-help').waitFor({state:'visible'});
  await page.clock.fastForward(6000);
  assert.equal(denied.state.history,0);assert.equal(await page.locator('#workspace').isVisible(),false);
  await page.locator('#auth-reset').click();await page.waitForFunction(()=>document.querySelector('#auth-reset').hidden);
  const before=denied.state.exchanges.length;
  await page.goto(base+'/?code=unsolicited-code');await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('만료'));
  assert.equal(denied.state.exchanges.length,before);assert.equal(new URL(page.url()).search,'');
  await page.locator('[data-oauth="google"]').click();await page.waitForURL(endpoint+'/auth/v1/authorize?**');
  await page.goto(base+'/?error=access_denied&error_description=untrusted-provider-detail');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('취소'));
  assert(!await page.locator('#notice').textContent().then(text=>text.includes('untrusted-provider-detail')));
  assert.equal(denied.state.history,0);assert.deepEqual(denied.state.errors,[]);
  console.log('PASS: unapproved OAuth accounts cannot read history; unsolicited and cancelled callbacks do not exchange codes or leak provider errors.');
 }finally{await denied.context.close();}
}
