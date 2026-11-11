// Shipped HTML/CSS/module, synthetic calls and controlled asynchronous RPCs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const port=Number(process.env.REVIEW_JOURNAL_PORT||49224),base=`http://127.0.0.1:${port}`;
const html=(await readFile('web/index.html','utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:String(port),PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''},stdio:'pipe'});
await new Promise((yes,no)=>{server.stdout.once('data',yes);server.once('error',no);server.once('exit',code=>no(Error('Server exited '+code)));});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
await mkdir('test-results/review-journal',{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,timezoneId:'Asia/Seoul'}),errors=[],consoleErrors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 await page.route(base+'/',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto(base);
 await page.evaluate(async()=>{
  const {createReviewJournal}=await import('/review-journal.js');
  const $=id=>document.getElementById(id);$('setup').hidden=true;$('workspace').hidden=false;
  document.querySelectorAll('[data-panel]').forEach(el=>el.hidden=el.id!=='review-panel');
  document.querySelectorAll('[data-view]').forEach(el=>{el.removeAttribute('aria-current');if(el.dataset.view==='review')el.setAttribute('aria-current','page');});
  $('review-panel').dataset.journal='on';$('review-context').hidden=true;$('weekly').hidden=true;
  const f=window.journalFixture={scope:'service|account-a',active:true,mode:'hub',requests:[],notices:[],gate:null};
  f.deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};
  const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
  f.rows=ids.map((id,i)=>({session:{id,companion_id:i===1?'mia':'alex',created_at:i===0?'2026-11-10T11:30:00Z':i===1?'2026-11-09T23:15:00Z':'2026-10-01T01:00:00Z',ended_at:'2026-11-10T11:40:00Z',time_zone:'Asia/Seoul',status:'ended',scenario:i===1?'주말 계획':'발표 준비'},analysis_id:'analysis-'+i,status:'ready',strengths:[{text:'생각할 시간을 요청했어요.',evidence_ids:['event-'+i]}],expressions:i===0?[{key:'a',expression:'Could you give me a moment?',kind:'alternative',original:'Give me a moment.',meaning:'잠시 시간을 주실 수 있나요?',reason:'뜻은 같고, 부탁하는 느낌이 더 부드러워져요.',evidence_ids:['event-0'],saved:false,bookmark_revision:0},{key:'b',expression:"I'm still working on it.",kind:'reusable',original:'',meaning:'아직 준비하고 있어요.',reason:'준비 중인 일을 이야기할 때 써요.',evidence_ids:['event-0'],saved:false,bookmark_revision:0}]:[{key:'c',expression:"I haven't decided yet.",kind:'reusable',original:'',meaning:'아직 정하지 않았어요.',reason:'계획이 정해지지 않았을 때 써요.',evidence_ids:['event-'+i],saved:false,bookmark_revision:0}]}));
  f.rpc=async(name,args)=>{
   f.requests.push({name,args});
   if(f.gate&&name===f.gate.name)return f.gate.promise;
   if(name==='review_journal'){
    const rows=args.p_before?f.rows.slice(2,3):f.rows.slice(0,2);return structuredClone({calls:args.p_saved?rows.filter(c=>c.expressions.some(e=>e.saved)):rows,next:args.p_before||args.p_saved||f.rows.length<3?null:{before:f.rows[1].session.created_at,before_id:ids[1]}});
   }
   if(name==='review_note')return structuredClone(f.rows.find(c=>c.session.id===args.p_session_id));
   if(name==='review_bookmark'){
    const item=f.rows.find(c=>c.session.id===args.p_session_id).expressions.find(e=>e.key===args.p_expression_key);item.saved=args.p_saved;item.bookmark_revision++;if(f.failBookmarkOnce){f.failBookmarkOnce=false;throw Error('Response lost after server commit');}return{saved:item.saved,revision:item.bookmark_revision};
   }
   throw Error('Unexpected RPC '+name);
  };
  f.modeTo=(value,{backLabel='복습 목록'}={})=>{$('review-back-label').textContent=backLabel;f.mode=value;$('review-panel').dataset.mode=value;$('review-back').hidden=value==='hub';};
  f.controller=createReviewJournal({root:$('review-journal'),context:()=>({scope:f.scope,active:f.active,mode:f.mode,busy:false}),rpc:f.rpc,edge:async()=>{throw Error('No generation expected');},allRows:async()=>f.transcript||[{id:'event-0',session_id:ids[0],speaker:'user',text:'Give me a moment.'}],setMode:f.modeTo,openView:()=>{f.active=true;},notice:text=>f.notices.push(text)});
  $('review-back').onclick=()=>f.controller.back();await f.controller.show();
 });
 const root=page.locator('#review-journal');
 assert.equal(await root.locator('.journal-expression').count(),3);assert.match(await root.innerText(),/11월 10일/);assert.equal(await root.locator('details').count(),0);assert.equal(await root.locator('.journal-day>h2').count(),1);assert.equal(await root.locator('.journal-day>h2').innerText(),'11월 10일');
 await page.screenshot({path:'test-results/review-journal/01-date-list.png'});
 assert.equal(await root.locator('.journal-expression').first().getByRole('button').count(),2,'one detail target and one separate bookmark');
 await root.getByRole('tab',{name:'날짜별',exact:true}).focus();await page.keyboard.press('End');
 await page.waitForFunction(()=>document.activeElement.id==='journal-tab-saved'&&document.querySelector('#journal-tab-saved').tabIndex===0);
 assert.equal(await root.locator('[role=tab][tabindex="0"]').count(),1);
 await page.keyboard.press('Home');await page.waitForFunction(()=>document.activeElement.id==='journal-tab-dates'&&document.querySelectorAll('.journal-expression').length===3);
 await root.locator('[data-expression-key]').nth(1).click();
 await root.locator('[data-note-expression="b"]').waitFor();
 assert.equal(await root.locator('[data-note-expression]').count(),1,'opening B shows only the selected expression');
 await page.waitForFunction(()=>document.activeElement.dataset.noteExpression==='b');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.noteExpression),'b');
 assert.equal(await root.locator('[data-note-expression="c"]').count(),0,'other calls are not merged into the note');
 await page.screenshot({path:'test-results/review-journal/02-call-note.png',fullPage:true});
 const save=root.locator('[data-note-expression="b"] .journal-save');await save.click();await page.waitForFunction(()=>window.journalFixture.rows[0].expressions[1].saved);
 assert.equal(await root.locator('[data-note-expression="b"] .journal-save').getAttribute('aria-pressed'),'true');
 await root.locator('[data-note-expression="b"]').getByRole('button',{name:'대화에서 보기',exact:true}).click();await root.locator('[data-source-highlight]').waitFor();
 assert.equal(await root.locator('[data-source-highlight]').innerText(),'나\n\nGive me a moment.');
 assert.equal(await page.locator('#review-back').innerText(),'표현 상세');
 assert.equal(await root.getByRole('button',{name:/돌아가기|복습 목록/}).count(),0,'source has one return action with its real destination');
 await page.getByRole('button',{name:'표현 상세',exact:true}).click();assert.equal(await root.locator('[data-note-expression]').count(),1);
 await page.waitForFunction(()=>document.activeElement.dataset.noteExpression==='b');
 await page.locator('#review-back').click();assert.equal(await root.locator('.journal-expression').count(),3);
 await page.waitForFunction(()=>document.activeElement.dataset.expressionKey==='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|b');
 await root.getByRole('tab',{name:'저장한 표현'}).click();await page.waitForFunction(()=>window.journalFixture.requests.at(-1).args.p_saved===true);
 assert.equal(await root.locator('.journal-expression').count(),1);await page.screenshot({path:'test-results/review-journal/03-saved.png'});
 await root.getByRole('tab',{name:'날짜별',exact:true}).click();await root.getByRole('button',{name:'이전 기록 더 보기'}).click();assert.equal(await root.locator('.journal-call').count(),3);
 await root.locator('input[type=date]').fill('2026-10-01');await root.locator('input[type=date]').dispatchEvent('change');
 await page.waitForFunction(()=>window.journalFixture.requests.at(-1).args.p_through==='2026-10-01');
 // A lost response must not claim a save or toggle it a second time on retry.
 await page.evaluate(()=>window.journalFixture.failBookmarkOnce=true);
 const uncertain=root.locator('.journal-expression').first().getByRole('button',{name:/표현 저장:/});await uncertain.click();
 await root.getByRole('button',{name:/저장 상태 다시 확인:/}).waitFor();
 assert.equal(await root.locator('.journal-bookmark').first().getAttribute('aria-pressed'),'false','unknown response is not a confirmed save');
 const writesBefore=await page.evaluate(()=>window.journalFixture.requests.filter(r=>r.name==='review_bookmark').length);
 await root.getByRole('button',{name:/저장 상태 다시 확인:/}).click();
 await page.waitForFunction(()=>document.querySelector('.journal-bookmark')?.getAttribute('aria-pressed')==='true');
 assert.equal(await page.evaluate(()=>window.journalFixture.requests.filter(r=>r.name==='review_bookmark').length),writesBefore,'recovery reads server state instead of duplicating user intent');
 // Five expressions, uneven types: no first-three or per-type quota in the UI.
 await page.evaluate(async()=>{const f=window.journalFixture;f.rows[0].expressions=Array.from({length:5},(_,i)=>({key:'many-'+i,expression:'Expression '+i,kind:i<3?'error':'reusable',original:i<3?'Original':'',meaning:'뜻',reason:'짧은 이유',evidence_ids:['event-0'],saved:false,bookmark_revision:0}));await f.controller.show();});
 assert.equal(await root.locator('[data-session-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] .journal-expression').count(),5);
 assert.equal(await root.locator('[data-session-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] .journal-kind').filter({hasText:'교정'}).count(),3);
 // Small screen, keyboard focus and large type do not overflow or cover controls.
 await page.setViewportSize({width:320,height:740});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await root.locator('.journal-expression').last().scrollIntoViewIfNeeded();assert(await root.locator('.journal-expression').last().evaluate(el=>el.getBoundingClientRect().bottom<document.querySelector('.glass-dock').getBoundingClientRect().top),'last expression can be fully read above the dock');await page.screenshot({path:'test-results/review-journal/04-small-large-text.png',fullPage:true});
 await page.setViewportSize({width:1024,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='16px');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'test-results/review-journal/05-desktop.png'});
 // The selected design: every row has one short type; detail is exactly one record.
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(async()=>{
  const f=window.journalFixture;f.rows=f.rows.slice(0,1);f.rows[0].session.scenario='주말 약속';
  const common={evidence_ids:['event-0'],saved:false,bookmark_revision:0};
  f.rows[0].expressions=[
   {...common,key:'error',kind:'error',expression:'I made a mistake.',original:'I did a mistake.',meaning:'실수했어요.',reason:'실수하다는 make a mistake로 표현해요.',learning:{focus:'lexical',form:'collocation'}},
   {...common,key:'colloquial',kind:'reusable',expression:"I'm down.",meaning:'좋아, 나도 할래.',reason:'참여 의사를 표현해요.',learning:{focus:'lexical',form:'colloquial',source_quote:'“나도 할래”를 영어로 어떻게 말해?',source_is_question:true,usage:'친구의 제안에 가볍게 동의할 때 써요.',register:'informal',example:{prompt:'Want to grab coffee?',response:"I'm down."},alternative:"Sure, I'd love to."}},
   {...common,key:'positive',kind:'positive',expression:'Let me put it another way.',original:'Let me put it another way.',meaning:'다르게 설명해 볼게요.',reason:'오해를 바로잡으며 설명을 이어갔어요.',learning:{focus:'interaction',form:'general'}}
  ];f.transcript=[{id:'event-0',session_id:f.rows[0].session.id,speaker:'user',text:'“나도 할래”를 영어로 어떻게 말해?'}];f.controller.clear();await f.controller.show();
 });
 assert.deepEqual(await root.locator('.journal-expression .journal-kind').allTextContents(),['교정','일상 구어','잘 쓴 표현']);
 await page.screenshot({path:'test-results/review-journal/06-selected-list.png'});
 await page.setViewportSize({width:390,height:1380});await page.screenshot({path:'test-results/review-journal/07-selected-list-tall.png'});
 await root.locator('[data-expression-key]').nth(1).click();await root.locator('[data-note-expression="colloquial"]').waitFor();
 await page.waitForFunction(()=>scrollY===0&&document.activeElement.dataset.noteExpression==='colloquial');
 assert.equal(await root.locator('[data-note-expression]').count(),1);assert.equal(await root.locator('.journal-expression-title').innerText(),"I'm down.");
 assert.equal(await root.locator('.journal-expression-type').innerText(),'일상 구어');assert.doesNotMatch(await root.innerText(),/I made a mistake|Let me put it another way|와의 학습 노트/);
 assert.match(await root.innerText(),/내가 물어본 말/);assert.match(await root.innerText(),/사용 예/);assert.match(await root.innerText(),/Sure, I'd love to/);
 await page.screenshot({path:'test-results/review-journal/08-single-expression-tall.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/review-journal/09-single-expression.png',fullPage:true});
 await root.getByRole('button',{name:'대화에서 보기',exact:true}).click();await root.locator('[data-source-highlight]').waitFor();
 await page.getByRole('button',{name:'표현 상세',exact:true}).click();await root.locator('[data-note-expression="colloquial"]').waitFor();assert.equal(await root.locator('[data-note-expression]').count(),1);
 await page.setViewportSize({width:320,height:740});await page.evaluate(()=>document.documentElement.style.fontSize='32px');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await root.locator('.journal-note-actions').scrollIntoViewIfNeeded();assert(await root.locator('.journal-note-actions').evaluate(el=>el.getBoundingClientRect().bottom<document.querySelector('.glass-dock').getBoundingClientRect().top));
 await page.screenshot({path:'test-results/review-journal/10-single-large-text.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='16px');
 await page.locator('#review-back').click();
 // A late response for B cannot replace A after navigation within the same call.
 await page.evaluate(()=>{const f=window.journalFixture;f.gate={name:'review_note',...f.deferred()};});
 await root.locator('[data-expression-key]').nth(1).click();
 await page.evaluate(()=>{const f=window.journalFixture;f.late=f.gate;f.gate=null;f.controller.back();});
 await root.locator('[data-expression-key]').first().click();await root.locator('[data-note-expression="error"]').waitFor();
 await page.evaluate(()=>{const f=window.journalFixture;f.late.resolve(structuredClone(f.rows[0]));});
 assert.equal(await root.locator('[data-note-expression]').count(),1);assert.equal(await root.locator('[data-note-expression="colloquial"]').count(),0);
 await page.locator('#review-back').click();
 // If the selected record disappears, do not substitute the remaining A/C.
 await page.evaluate(()=>{const f=window.journalFixture;f.gate={name:'review_note',...f.deferred()};});
 await root.locator('[data-expression-key]').nth(1).click();
 await page.evaluate(()=>{const f=window.journalFixture;const note=structuredClone(f.rows[0]);note.expressions=note.expressions.filter(e=>e.key!=='colloquial');f.gate.resolve(note);f.gate=null;});
 await root.getByRole('heading',{name:'표현을 확인할 수 없어요.'}).waitFor();assert.equal(await root.locator('[data-note-expression]').count(),0);assert.doesNotMatch(await root.innerText(),/I made a mistake|Let me put it another way/);
 await page.locator('#review-back').click();
 // Empty and unavailable notes keep a source route without fabricated phrases.
 await page.evaluate(async()=>{const f=window.journalFixture;f.privateRows=structuredClone(f.rows);f.rows=[];await f.controller.show();});
 assert.equal(await root.locator('.journal-expression').count(),0);assert.match(await root.innerText(),/통화를 마치면 날짜별로 복습할 수 있어요/);
 // Late reads from A cannot populate B, or a new sign-in to the same account.
 await page.evaluate(async()=>{const f=window.journalFixture;f.gate={name:'review_journal',...f.deferred()};f.pending=f.controller.load();f.scope='service|account-b';f.controller.clear();f.gate.resolve({calls:f.privateRows,next:null});await f.pending;});assert.equal(await root.locator('.journal-expression').count(),0);
 await page.evaluate(async()=>{const f=window.journalFixture;f.gate=null;f.rows=f.privateRows;await f.controller.show();f.gate={name:'review_bookmark',...f.deferred()};document.querySelector('.journal-bookmark').click();});
 await page.waitForFunction(()=>window.journalFixture.requests.at(-1).name==='review_bookmark');
 await page.evaluate(async()=>{const f=window.journalFixture;const old=f.gate;f.controller.clear();f.gate=null;await f.controller.show();old.resolve({saved:true,revision:99});await Promise.resolve();await Promise.resolve();});
 assert.equal(await root.locator('.journal-bookmark').first().getAttribute('aria-pressed'),'false','old save acknowledgements do not populate a new sign-in to the same account');
 assert.equal(await page.evaluate(()=>window.journalFixture.requests.some(r=>/practice|learning_action|enroll/.test(r.name))),false,'reading and bookmarks never count as practice');
 assert.deepEqual(errors,[]);
 assert.deepEqual(consoleErrors,[]);
 console.log('Review journal browser PASS: date/call groups, all expressions and uneven kinds, single-expression detail, source and back restoration, acknowledged bookmarks, saved tab, old-page/date navigation, 320px/large type, desktop, stale-account isolation; actual shipped HTML/CSS/module with synthetic inputs.');
}finally{await browser.close();server.kill('SIGTERM');}
