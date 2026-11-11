import assert from 'node:assert/strict';

// Fixture-only: no messages, credentials, or real user sessions leave this test.
export async function testEmailLogin(browser, base) {
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let sendCount=0,verifyCount=0,mode='hold',verifyMode='hold',lastVerify;
  let releaseSend,releaseVerify;
  const sendGate=new Promise(resolve=>releaseSend=resolve),verifyGate=new Promise(resolve=>releaseVerify=resolve);
  let markSendStarted,markVerifyStarted;
  const sendStarted=new Promise(resolve=>markSendStarted=resolve),verifyStarted=new Promise(resolve=>markVerifyStarted=resolve);
  await context.route('**/public-config.js',route=>route.fulfill({contentType:'text/javascript',body:'globalThis.LOOP_PUBLIC_CONFIG={url:"https://login-fixture.supabase.co",key:"sb_publishable_fixture"};'}));
  await context.route('https://login-fixture.supabase.co/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/auth/v1/otp'){
      sendCount++;
      markSendStarted();
      if(mode==='hold')await sendGate;
      if(mode==='limit')return route.fulfill({status:429,json:{code:'over_email_send_rate_limit',msg:'Email rate limit exceeded'},headers:{'Retry-After':'120','Access-Control-Expose-Headers':'Retry-After'}});
      if(mode==='hourly')return route.fulfill({status:429,json:{code:'over_email_send_rate_limit',msg:'Email rate limit exceeded'}});
      if(mode==='interval')return route.fulfill({status:429,json:{code:'over_email_send_rate_limit',msg:'For security purposes, you can only request this after 42 seconds.'}});
      if(mode==='network')return route.abort();
      return route.fulfill({status:200,json:{}});
    }
    if(path==='/auth/v1/verify'){
      verifyCount++;lastVerify=route.request().postDataJSON();
      markVerifyStarted();
      if(verifyMode==='hold')await verifyGate;
      if(verifyMode==='limit')return route.fulfill({status:429,json:{code:'over_request_rate_limit'},headers:{'Retry-After':'20','Access-Control-Expose-Headers':'Retry-After'}});
      if(verifyMode==='success'){
        const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
        const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',exp:Math.floor(Date.now()/1000)+86400})+'.'+Buffer.from('fixture-signature').toString('base64url');
        return route.fulfill({status:200,json:{access_token:token,refresh_token:'fixture-refresh',expires_in:86400,token_type:'bearer'}});
      }
      return route.fulfill({status:403,json:{code:'otp_expired',msg:'Token has expired or is invalid'}});
    }
    if(path==='/auth/v1/user')return route.fulfill({json:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}});
    if(path==='/auth/v1/settings')return route.fulfill({json:{external:{google:false,kakao:false}}});
    if(path.endsWith('/coach/config'))return route.fulfill({status:403,json:{error:{code:'ACCOUNT_NOT_ALLOWED',message:'승인된 이메일 계정만 이용할 수 있습니다.'}}});
    if(path.endsWith('/rpc/learning_snapshot'))return route.fulfill({json:{items:[],feedback:[],recommended_item_ids:[],next_plan:null}});
    if(path.endsWith('/rpc/learning_record_event'))return route.fulfill({json:{saved:true}});
    if(path.endsWith('/rpc/learning_enhancement_snapshot'))return route.fulfill({json:{reviews:[],schedules:[],recalls:[],usage:[],weekly_goals:[],personalized_item_ids:[],recommendation_reasons:{}}});
    throw Error('Unexpected login fixture request: '+path);
  });
  try{
    await page.clock.install();await page.goto(base);
    await page.locator('#login-form').waitFor({state:'visible'});
    await page.locator('#email').fill('Fixture@Example.com');
    const pending=page.waitForRequest('**/auth/v1/otp');
    await page.evaluate(()=>{const form=document.querySelector('#login-form');form.requestSubmit();form.requestSubmit();});
    await pending;await sendStarted;
    assert.equal(sendCount,1);assert.equal(await page.locator('#send-code').isDisabled(),true);
    assert.equal(await page.locator('#email').getAttribute('readonly'),'');
    releaseSend();await page.locator('#verify-form').waitFor({state:'visible'});
    await page.waitForFunction(()=>/\d+초 후 다시 받기/.test(document.querySelector('#send-code').textContent));
    await page.locator('#otp').fill('123456');await page.reload();
    await page.locator('#verify-form').waitFor({state:'visible'});
    assert.equal(await page.locator('#email').inputValue(),'fixture@example.com');
    assert.equal(await page.locator('#otp').inputValue(),'');
    assert.equal(await page.locator('#send-code').isDisabled(),true);
    await page.clock.fastForward(61000);
    assert.equal(await page.locator('#send-code').isDisabled(),false);assert.equal(sendCount,1,'cooldown never sends automatically');
    await page.locator('#email').fill('other@example.com');
    assert.equal(await page.locator('#verify-form').isVisible(),false);
    await page.locator('#use-code').click();await page.locator('#otp').fill('654321');
    const verifyPending=page.waitForRequest('**/auth/v1/verify');
    await page.evaluate(()=>{const form=document.querySelector('#verify-form');form.requestSubmit();form.requestSubmit();});
    await verifyPending;await verifyStarted;assert.equal(verifyCount,1);assert.equal(sendCount,1,'existing-code login sends no mail');
    releaseVerify();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('만료'));
    assert.equal(lastVerify.email,'other@example.com');
    assert.equal(lastVerify.token,'654321');
    mode='limit';await page.locator('#send-code').click();
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('발송 한도'));
    assert.match(await page.locator('#send-code').textContent(),/2분/);
    assert.equal(await page.locator('#verify-code').isDisabled(),false);
    assert(await page.evaluate(()=>document.querySelector('#notice').getBoundingClientRect().top>=document.querySelector('#verify-code').getBoundingClientRect().bottom),'login errors must not cover the code verification button');
    await page.locator('#email').fill('another@example.com');
    assert.equal(await page.locator('#send-code').isDisabled(),true,'project email limit also covers changed addresses');
    await page.reload();await page.locator('#login-form').waitFor({state:'visible'});
    assert.equal(await page.locator('#send-code').isDisabled(),true);
    await page.clock.fastForward(121000);assert.equal(sendCount,2);
    mode='hourly';await page.locator('#send-code').click();
    await page.waitForFunction(()=>document.querySelector('#send-code').textContent.includes('60분'));
    await page.clock.fastForward(3601000);assert.equal(sendCount,3);
    mode='interval';await page.locator('#send-code').click();
    await page.waitForFunction(()=>/\d+초 후 다시 받기/.test(document.querySelector('#send-code').textContent));
    assert(await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('loop.email-login:https://login-fixture.supabase.co'));return state.reason==='request-limit'&&state.until-Date.now()<=42000;}));
    await page.clock.fastForward(43000);
    mode='network';await page.locator('#send-code').click();
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('발송 결과'));
    assert.equal(await page.locator('#send-code').isDisabled(),true);
    verifyMode='limit';await page.locator('#otp').fill('123456');await page.locator('#verify-code').click();
    await page.waitForFunction(()=>/\d+초 후 로그인/.test(document.querySelector('#verify-code').textContent));
    await page.clock.fastForward(21000);assert.equal(verifyCount,2);
    verifyMode='success';await page.locator('#verify-code').click();
    await page.locator('#access-help').waitFor({state:'visible'});
    assert.equal(await page.locator('#workspace').isVisible(),false,'authentication still enforces account approval');
    assert.equal(await page.locator('#otp').inputValue(),'');
    const stored=await page.evaluate(()=>localStorage.getItem('loop.email-login:https://login-fixture.supabase.co'));
    assert(!stored.includes('123456'));assert.deepEqual(errors,[]);
    console.log('PASS: login deduplicates sends/verifications, persists cooldowns without codes, respects Retry-After, permits existing codes, never retries automatically, and retains account approval.');
  } finally {await context.close();}
}
