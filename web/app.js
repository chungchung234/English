import { createLearningReview } from '../src/learning-review.mjs';
import { createAIPresence } from './ai-presence.js';
import { createOutbox, flushOutbox } from '../src/outbox.js';
import { validatePublicConfig } from '../src/public-config.mjs';
import { mountEmailLogin } from '../src/email-login.mjs';
import { createAuthSession, LoginFlowError } from '../src/auth-session.mjs';
const $ = id => document.getElementById(id);
const outbox = createOutbox();
const presence = createAIPresence();
const config = globalThis.LOOP_PUBLIC_CONFIG ? validatePublicConfig(globalThis.LOOP_PUBLIC_CONFIG.url,globalThis.LOOP_PUBLIC_CONFIG.key) : null;
const authSession=config?createAuthSession(config):null;
let auth=null,loginReady=false,socialBusy=false,providers={google:false,kakao:false};
let flushing, call, scope, saving = Promise.resolve(), historyEpoch = 0, memoryEpoch = 0, cloudVerified = false;
const companions = {mia:{name:'Mia',trait:'다정하고 사려 깊은 대화'},alex:{name:'Alex',trait:'차분하고 명료한 대화'},juno:{name:'Juno',trait:'경쾌하고 호기심 많은 대화'}};
let companionId = 'alex', callStarting = false, callEnding = false, selectedReviewSessionId = null, practiceMemory = null;
let currentView = 'contacts', viewEpoch = 0, historyFilter = null;
let callDetailEpoch=0, weeklyCompanions=new Set(), weeklyRequest=null;
const learning=createLearningReview({document,rpc,getScope:()=>auth&&scope?{key:scope+'|'+companionId,companionId}:null,onNotice:message=>notice(message),onHome:()=>setView('contacts'),onStale:analysis=>{if(selectedReviewSessionId!==analysis.session_id)return;emptyReview('마지막 분석 이후 발화가 추가됐어요. 새 원문으로 피드백을 다시 확인해 주세요.');const retry=document.createElement('button');retry.className='glass-button';retry.textContent='새 원문으로 피드백 만들기';retry.onclick=protect(()=>prepareFeedback(analysis.session_id,companionId));$('review-content').append(retry);},onOpen:async item=>{
  if(memoryBusy())return;
  const requestScope=scope,selected=companionId;
  try{const rows=await api('/rest/v1/analyses?id=eq.'+item.analysis_id+'&select=*');
  if(scope!==requestScope||companionId!==selected||memoryBusy()||!rows[0])return;
  selectedReviewSessionId=item.session_id;$('review-content').replaceChildren();showAnalysis($('review-content'),{...rows[0],companion_id:selected});setView('review');
  }catch(error){notice(error.message);}
}});
const NATURAL_CONVERSATION = 'Natural English conversation about everyday life';
const CALL_DURATION = 20 * 60 * 1000;
const memorySlots=[['name','이름'],['occupation','직업'],['location','사는 곳'],['goal','목표'],['interest','관심사'],['preference','선호']];
let excludedMemorySessions=new Set();
const companionName = () => companions[companionId].name;
const companionStorageKey = () => 'loop.companion:' + config.url + '|' + auth.user.id;
function setView(view) {
  if(memoryBusy() || !['contacts','call','history','review'].includes(view)) return false;
  if(view!==currentView)window.scrollTo({top:0,behavior:'instant'});
  currentView=view;viewEpoch++;
  document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== view);
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    if(selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  presence.refresh();return true;
}
function navigationControls() {
  const busy=memoryBusy();
  document.querySelectorAll('[data-view], [data-companion], [data-open], .history-open, .history-recall, #account-memory, #account-open, #refresh-history').forEach(button=>button.disabled=busy);
  renderWeeklyAction();
  memoryControlsDisabled(false);
}
function selectCompanion(next, {refresh=true}={}) {
  if(memoryBusy())throw Error('통화를 마친 뒤 대화 상대를 바꿀 수 있어요.');
  if(!Object.hasOwn(companions,next))throw Error('대화 상대를 선택하세요.');
  if(next===companionId)return;
  historyEpoch++;memoryEpoch++;viewEpoch++;
  closeDialog('memory-dialog');$('memory-facts').replaceChildren();$('memory-exclusions').replaceChildren();excludedMemorySessions=new Set();
  companionId=next;practiceMemory=null;selectedReviewSessionId=null;learning.reset();$('next-plan').hidden=true;
  if(auth&&config)localStorage.setItem(companionStorageKey(),companionId);
  updateCompanion();$('memory-results').replaceChildren();$('memory-query').value='';emptyReview();
  if($('practice-preview-text'))$('practice-preview-text').textContent='지난 대화에서 표현을 찾고 있어요…';
  if($('practice-preview'))$('practice-preview').disabled=true;
  if(refresh&&auth){loadPlan().catch(error=>notice(error.message));learning.load();loadMemory().catch(e=>notice(e.message));loadHistory().catch(e=>notice(e.message));}
}
async function loadPlan(){
  if(!scope)return;const requestScope=scope,id=companionId;
  const plan=await rpc('learning_plan',{p_companion_id:id});
  if(scope!==requestScope||id!==companionId)return;
  $('next-plan').hidden=!plan?.scenario;$('next-plan').textContent=plan?.scenario?'준비한 이야기 · '+plan.scenario:'';
}
function updateCompanion() {
  if($('companion-name')) $('companion-name').textContent = companionName();
  if($('live-name')) $('live-name').textContent=companionName();
  presence.setProfile(companionId);
  if($('companion-trait'))$('companion-trait').textContent=companions[companionId].trait;
  for(const id of ['orb','live-avatar'])$(id)?.setAttribute('aria-label',companionName()+' AI 통화 상대');
  document.querySelectorAll('[data-companion]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.companion === companionId)));
  $('companion-selector').dataset.selected=companionId;
  $('start-call').setAttribute('aria-label',companionName()+'와 통화');
  $('memory-query').placeholder=companionName()+'와의 대화 검색';$('memory-query').setAttribute('aria-label',companionName()+'와의 대화 검색');
  renderWeeklyAction();
  if(!call && !callStarting && !callEnding) $('call-status').textContent = companionName()+'와 대화할 준비가 되었어요';
}
function updateCallControls() {
  const current=call, connected=current?.pc.connectionState==='connected';
  const locked=!current||current.ending||current.compacting||callStarting;
  if($('mute-call')){$('mute-call').disabled=locked;$('mute-call').setAttribute('aria-pressed',String(Boolean(current?.muted)));$('mute-call').setAttribute('aria-label','음소거');}
  document.querySelectorAll('[data-cue]').forEach(button=>button.disabled=locked||!connected||current.responding||current.speaking||current.aiSpeaking);
}
function setCallLayout(active) {
  document.body.dataset.callState = active ? 'live' : '';
  if($('live-call'))$('live-call').hidden=!active;
  $('start-call').hidden=active;$('start-call').disabled=memoryBusy();
  $('end-call').hidden=!active||callStarting;$('end-call').disabled=!active||callStarting||callEnding;
  presence.refresh();navigationControls();updateCallControls();
}
function clearCallClock(current) {clearTimeout(current.durationTimer);clearInterval(current.clockInterval);current.durationTimer=null;current.clockInterval=null;}
function callElapsed(current) {return current.startedAt===null?0:Math.max(0,performance.now()-current.startedMono,Date.now()-current.startedAt);}
const clockText=value=>`${String(Math.floor(value/60000)).padStart(2,'0')}:${String(Math.floor(value/1000)%60).padStart(2,'0')}`;
function updateCallClock(current) {
  if(call!==current||current.ending)return;
  const elapsed=Math.min(CALL_DURATION,callElapsed(current)),remaining=Math.max(0,CALL_DURATION-elapsed);
  if($('call-timer'))$('call-timer').textContent=clockText(elapsed);
  if($('call-remaining')){$('call-remaining').textContent=clockText(remaining)+' 남음';$('call-remaining').hidden=current.startedAt===null||remaining>60000;}
  if(current.startedAt!==null&&remaining<=0){notice('20분이 되어 통화를 종료하고 저장합니다.');endCall().catch(e=>notice(e.message));}
}
function startCallClock(current) {
  if(call!==current||current.ending)return;
  if(current.startedAt===null){current.startedAt=Date.now();current.startedMono=performance.now();current.deadline=current.startedAt+CALL_DURATION;}
  updateCallClock(current);
  if(current.ending)return;
  if(!current.durationTimer)current.durationTimer=setTimeout(()=>updateCallClock(current),Math.max(0,CALL_DURATION-callElapsed(current)));
  if(!current.clockInterval)current.clockInterval=setInterval(()=>updateCallClock(current),1000);
}
function attachCallAudio(current) {
  if(call!==current||current.ending)return;
  if(current.stream.getAudioTracks().some(track=>track.readyState!=='ended'))presence.attachAudio(current.stream,'input');
  if(current.remoteStream?.getAudioTracks().some(track=>track.readyState!=='ended'))presence.attachAudio(current.remoteStream,'output');
}
function openDialog(id) { const dialog=$(id); if(dialog && !dialog.open) {dialog.showModal();presence.refresh();} }
function closeDialog(id) { const dialog=$(id); if(dialog?.open) dialog.close();if(id==='call-detail-dialog'){callDetailEpoch++;$('call-detail-content').replaceChildren();} }
const memoryBusy=()=>Boolean(call||callStarting||callEnding);
function memoryControlsDisabled(disabled){const busy=disabled||memoryBusy();document.querySelectorAll('#memory-dialog button').forEach(button=>button.disabled=busy||button.dataset.memoryDisabled==='true');document.querySelectorAll('#memory-dialog input').forEach(input=>input.disabled=busy);}
function memorySource(fact){const details=[];const sourceLabels={user:'직접 수정',manual:'직접 수정',conversation:'대화에서 기억',transcript:'대화에서 기억',model:'대화에서 기억'};if(fact.manual===true)details.push('직접 수정');else if(sourceLabels[fact.source])details.push(sourceLabels[fact.source]);else if(fact.spoken_at)details.push('대화에서 기억');if(fact.spoken_at)details.push(formatDate(fact.spoken_at));else if(fact.updated_at)details.push(formatDate(fact.updated_at));return details.join(' · ');}
function renderMemoryControls(data){
  excludedMemorySessions=new Set((data.excluded_sessions||[]).map(item=>item.session_id));
  $('memory-companion').textContent=companionName()+'의 기억';$('memory-suppressed').hidden=!data.history_suppressed;
  const facts=$('memory-facts');facts.replaceChildren();
  for(const [key,label] of memorySlots){const fact=data.facts?.find(item=>item.key===key);const row=document.createElement('section');row.className='memory-fact';const heading=document.createElement('strong');heading.textContent=label;const value=document.createElement('input');value.maxLength=240;value.setAttribute('aria-label',label);value.placeholder='아직 기억하지 않아요';value.value=fact&&!fact.forgotten?fact.value||'':'';const meta=document.createElement('small');meta.textContent=fact&&!fact.forgotten?memorySource(fact):'저장된 사실이 없어요';row.append(heading,value,meta);const actions=document.createElement('div');actions.className='memory-fact-actions';const save=document.createElement('button');save.className='glass-button';save.textContent='저장';save.onclick=protect(async()=>{const text=value.value.trim();if(!text)throw Error('기억할 내용을 입력하세요.');if(text.length>240)throw Error('기억은 240자까지 입력할 수 있어요.');await mutateMemory({action:'setFact',key,value:text});});const forget=document.createElement('button');forget.className='text-button';forget.textContent='잊기';forget.dataset.memoryDisabled=String(!fact||fact.forgotten);forget.onclick=protect(async()=>mutateMemory({action:'forgetFact',key}));actions.append(save,forget);row.append(actions);facts.append(row);}
  const excluded=$('memory-exclusions');excluded.replaceChildren();const items=data.excluded_sessions||[];
  if(data.excluded_sessions_limited){const p=document.createElement('p');p.className='dialog-note';p.textContent='최근 30개를 표시하고 있어요.';excluded.append(p);}
  if(!items.length){const p=document.createElement('p');p.className='empty-state compact';p.textContent='기억에서 제외한 대화가 없어요.';excluded.append(p);}
  for(const session of items){const row=document.createElement('div');row.className='memory-excluded';const title=document.createElement('span');title.textContent=`${session.scenario||'대화'} · ${session.ended_at?formatDate(session.ended_at):''}`;const restore=document.createElement('button');restore.className='text-button';restore.textContent='기억에 다시 포함';restore.onclick=protect(async()=>mutateMemory({action:'restoreSession',sessionId:session.session_id}));row.append(title,restore);excluded.append(row);}
  memoryControlsDisabled(false);
}
async function loadMemoryControls(){const epoch=++memoryEpoch,selectedCompanion=companionId;const data=await edge('memory-manage',{companionId:selectedCompanion,action:'list'});if(epoch!==memoryEpoch||selectedCompanion!==companionId)return null;renderMemoryControls(data);return data;}
async function mutateMemory(change){if(memoryBusy())throw Error('통화를 마친 뒤 기억을 수정하세요.');const selectedCompanion=companionId,requestScope=scope;memoryControlsDisabled(true);try{const data=await edge('memory-manage',{companionId:selectedCompanion,...change});if(selectedCompanion!==companionId||requestScope!==scope||!auth)return;memoryEpoch++;practiceMemory=null;if($('memory-results'))$('memory-results').replaceChildren();if($('memory-summary'))$('memory-summary').textContent='기억을 새로 확인하고 있어요…';if($('practice-preview-text'))$('practice-preview-text').textContent='기억을 새로 확인하고 있어요…';if($('practice-preview'))$('practice-preview').disabled=true;renderMemoryControls(data);await Promise.all([loadMemory(),loadHistory()]);}finally{memoryControlsDisabled(false);}}
async function indexMemory(){if(memoryBusy())throw Error('통화를 마친 뒤 검색 기억을 업데이트하세요.');const selectedCompanion=companionId,epoch=memoryEpoch;memoryControlsDisabled(true);$('memory-index-status').textContent='업데이트 중…';try{const data=await edge('memory-index',{companionId:selectedCompanion});if(selectedCompanion!==companionId||epoch!==memoryEpoch)return;$('memory-index-status').textContent=`${data.indexed||0}개 대화를 업데이트했습니다.${data.remaining?' 더 업데이트할 대화가 있어요.':' 기억 업데이트가 끝났어요.'}`;$('memory-index-more').hidden=!data.remaining;}finally{memoryControlsDisabled(false);}}
function emptyReview(message = '통화를 마치면 이곳에서 피드백을 확인할 수 있어요.') {
  if(!$('review-content')) return;
  const p=document.createElement('p');p.className='empty-state';p.textContent=message;$('review-content').replaceChildren(p);
  updatePracticePreview();
}
function renderWeeklyAction(){
  const available=Boolean(auth&&scope&&weeklyCompanions.has(companionId));
  $('weekly').hidden=!available;$('weekly').disabled=!available||Boolean(weeklyRequest)||memoryBusy();
  $('weekly').textContent=weeklyRequest?'분석 중…':'주간 분석';
}
function updatePracticePreview(){
  const expression=practiceMemory?.practice.find(item=>typeof item.expression==='string'&&item.expression.trim())?.expression;
  const visible=Boolean(expression)&&!$('review-content').querySelector('.analysis');
  $('practice-preview-text').textContent=expression||'아직 표현이 없어요.';
  $('practice-preview').hidden=!visible;$('practice-preview').disabled=!visible;
}
function disclosure(label,className){
  const details=document.createElement('details');details.className=className;
  const summary=document.createElement('summary');summary.append(document.createTextNode(label));
  const icon=document.querySelector('.row-chevron').cloneNode();icon.className='disclosure-chevron';summary.append(icon);
  const body=document.createElement('div');details.append(summary,body);return {details,body};
}

const notice = message => { $('notice').textContent = message || ''; };
const protect = fn => async (...args) => { try { await fn(...args); } catch(e) { notice(e.message); } };
function setStatus(text) { $('save-status').textContent = text; }
async function request(path, {method='GET', body, token, headers={}}={}) {
  const response = await fetch(config.url + path, {method,headers:{apikey:config.key,...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
  const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data={message:text.slice(0,200)}; }
  if (!response.ok) {const error=Error(data.error?.message || data.msg || data.message || data.error_description || `요청 실패 (${response.status})`);error.code=data.error?.code||data.code||data.error_code;error.status=response.status;error.retryAfter=response.headers.get('Retry-After');throw error;}
  return {data,response};
}
async function accessToken() {
  if(!authSession)throw Error('로그인이 필요합니다.');
  return authSession.accessToken();
}
async function api(path, options={}) { const result=await request(path,{...options,token:await accessToken()});if(path.startsWith('/rest/v1/'))cloudVerified=true;return result.data; }
async function rpc(name, body) { return api('/rest/v1/rpc/'+name,{method:'POST',body}); }
async function edge(name, body) {
  for(let attempt=0;;attempt++)try{return await api('/functions/v1/coach/'+name,{method:body===undefined?'GET':'POST',body});}
  catch(error){if(error.code!=='ANALYSIS_CONTINUE'||attempt>=3)throw error;}
}
async function allRows(table, query='') {
  const result=[];let expectedTotal;
  for(let offset=0;;){
    const {data:rows,response}=await request(`/rest/v1/${table}?select=*&${query}${query?'&':''}limit=500&offset=${offset}`,{token:await accessToken(),headers:{Prefer:'count=exact'}});
    const match=response.headers.get('content-range')?.match(/\/(\d+)$/);
    if(!match||!Array.isArray(rows))throw Error('전체 기록 수를 확인하지 못했습니다. 일부 기록만 백업하지 않습니다.');
    const total=Number(match[1]);
    if(expectedTotal!==undefined&&expectedTotal!==total)throw Error('조회 중 기록이 변경됐습니다. 통화를 종료하고 다시 시도하세요.');
    expectedTotal=total;result.push(...rows);offset=result.length;
    if(offset===total)return result;
    if(!rows.length||offset>total)throw Error('전체 기록을 확인하지 못했습니다. 다시 시도하세요.');
  }
}
async function updatePending() {
  if(!scope)return;
  const n=(await outbox.list(scope)).length;
  setStatus(n?`${n}개 발화 전송 대기 · 이 기기에 보관됨`:(cloudVerified&&navigator.onLine?'클라우드 저장 확인됨':'미전송 발화 없음 · 연결 확인 필요'));
  document.querySelectorAll('#transcript li').forEach(li=>li.classList.remove('pending'));
  if(n){const pending=new Set((await outbox.list(scope)).map(x=>x.id));document.querySelectorAll('#transcript li').forEach(li=>li.classList.toggle('pending',pending.has(li.dataset.id)));}
}
async function sync() {
  if(!auth||!scope)return;
  if(flushing)return flushing;
  const current=scope;
  flushing=flushOutbox(outbox,current,(sessionId,events)=>rpc('append_events',{p_session_id:sessionId,p_events:events})).then(updatePending).catch(async e=>{await updatePending();throw e;}).finally(()=>{flushing=null;});
  return flushing;
}
function renderTurn(event,pending=false) {
  $('empty-transcript').hidden=true;
  const li=document.createElement('li');li.dataset.id=event.id;li.classList.toggle('pending',pending);
  const who=document.createElement('b');who.textContent=event.speaker==='user'?'YOU':companionName().toUpperCase();li.append(who,document.createTextNode(event.text));$('transcript').append(li);li.scrollIntoView({block:'nearest'});
  $('turn-count').textContent=`${$('transcript').children.length}개 발화`;
}
async function capture(event,current) {
  if(!current || (current.ending&&!current.acceptingFinalEvents))return;
  let speaker,text;
  if(event.type==='conversation.item.input_audio_transcription.completed') {speaker='user';text=event.transcript;current.transcribing.delete(event.item_id);}
  else if(event.type==='response.output_audio_transcript.done') {speaker='assistant';text=event.transcript;}
  else return;
  if(!text?.trim())return;
  const eventKey=`${speaker}:${event.item_id}:${event.content_index??0}`;
  if(current.seen.has(eventKey))return;
  const item={id:crypto.randomUUID(),event_key:eventKey,speaker,text:text.trim(),occurred_at:new Date().toISOString()};
  current.seen.add(eventKey);
  try{await outbox.put({id:item.id,scope:current.scope,sessionId:current.id,event:item});}catch(error){current.seen.delete(eventKey);throw error;}
  if(call===current){renderTurn(item,true);await updatePending();}
  sync().catch(e=>notice('클라우드 전송 대기: '+e.message));
}
// Compact only at a completed assistant turn. Pause input while taking the
// durable checkpoint, then delete old items only after the server acknowledges
// the replacement instructions. A failed checkpoint leaves the live context intact.
async function compactCall(current) {
  if(call!==current || current.ending || current.compacting || current.transcriptionError || current.pc.connectionState!=='connected') return;
  current.compacting=true;
  const enabled=current.stream.getAudioTracks().map(track=>track.enabled);current.compactionInput=enabled;
  const deleted=current.items.slice(0,-6);
  if($('mute-call'))$('mute-call').disabled=true;
  document.querySelectorAll('[data-cue]').forEach(button=>button.disabled=true);
  try {
    current.stream.getAudioTracks().forEach(track=>track.enabled=false);
    await new Promise(resolve=>setTimeout(resolve,350));
    if(call!==current || current.ending || current.speaking || current.responding || current.awaitingCommit || current.transcribing.size) return;
    $('call-status').textContent='대화 기억을 정리하고 있어요…';
    await saving;await sync();
    if(call!==current||current.ending||current.pc.connectionState!=='connected')return;
    const result=await edge('checkpoint',{sessionId:current.id});
    if(call!==current || current.ending || current.dc.readyState!=='open')return;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{current.checkpointAck=null;reject(Error('기억 갱신 확인이 지연됐습니다.'));},8000);
      current.checkpointInstructions=result.instructions;
      current.checkpointAck=()=>{clearTimeout(timer);current.checkpointAck=null;resolve();};
      current.dc.send(JSON.stringify({type:'session.update',session:{type:'realtime',instructions:result.instructions}}));
    });
    if(call!==current || current.ending)return;
    for(const id of deleted)current.dc.send(JSON.stringify({type:'conversation.item.delete',item_id:id}));
    current.items=current.items.filter(id=>!deleted.includes(id));
    current.lastCompactAttempt=Date.now();current.lastCompact=Date.now();current.needsCompact=false;current.compactFailures=0;
  } catch(e) {
    current.compactFailures++;
    current.lastCompactAttempt=Date.now();
    if(call===current&&!current.ending)notice('기억 정리를 완료하지 못했습니다. '+e.message);
    // Keep a conservative stop before context pressure can silently discard
    // conversation. The normal end path waits for transcription and saves it.
    if(current.compactFailures>=2) {current.stopForContext=true;}
  } finally {
    if(call===current&&!current.ending&&current.pc.connectionState==='connected'){current.stream.getAudioTracks().forEach((track,i)=>track.enabled=!current.muted&&enabled[i]);current.compactionInput=null;}
    current.compacting=false;
    if(call===current&&!current.ending)updateCallControls();
    if(call===current&&!current.ending&&current.pc.connectionState==='connected')$('call-status').textContent=companionName()+'와 통화 중 · 편하게 말씀하세요';
    if(current.stopForContext && call===current && !current.ending) {
      notice('대화를 안전하게 저장하기 위해 통화를 마칩니다. 새 통화로 이어가 주세요.');
      endCall().catch(e=>notice(e.message));
    }
  }
}
async function startCall() {
  notice('');
  if(memoryBusy())throw Error('진행 중인 통화를 먼저 종료하세요.');
  if(!auth)throw Error('로그인이 필요합니다.');
  if(!isSecureContext || !navigator.mediaDevices?.getUserMedia)throw Error('마이크를 사용할 수 없습니다. 보안 연결(HTTPS)과 브라우저 마이크 권한을 확인하세요.');
  closeDialog('memory-dialog');closeDialog('account-dialog');closeDialog('privacy-dialog');closeDialog('call-detail-dialog');
  setView('call');callStarting=true;historyEpoch++;memoryEpoch++;selectedReviewSessionId=null;emptyReview(companionName()+'와의 통화를 마치면 피드백을 확인할 수 있어요.');setCallLayout(true);
  $('transcript').replaceChildren();$('turn-count').textContent='0개 발화';$('empty-transcript').hidden=false;
  if($('call-timer'))$('call-timer').textContent='00:00';if($('call-remaining'))$('call-remaining').hidden=true;
  $('call-status').textContent=companionName()+'와 연결하고 있어요…';presence.setState('connecting');
  const callScope=scope, selectedCompanion=companionId;
  let stream,current;
  try {
    await sync();
    const prepared=await rpc('learning_plan',{p_companion_id:selectedCompanion});
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    if(!callStarting||scope!==callScope||companionId!==selectedCompanion)throw Error('통화 연결이 취소되었습니다.');
    const [session]=await api('/rest/v1/sessions',{method:'POST',headers:{Prefer:'return=representation'},body:{id:crypto.randomUUID(),user_id:auth.user.id,scenario:prepared?.scenario?'User-prepared conversation: '+prepared.scenario:NATURAL_CONVERSATION,companion_id:selectedCompanion}});
    if(!callStarting||scope!==callScope||companionId!==selectedCompanion)throw Error('통화 연결이 취소되었습니다.');
    const pc=new RTCPeerConnection();
    current={id:session.id,companionId:selectedCompanion,scope:callScope,pc,stream,remoteStream:null,seen:new Set(),transcribing:new Set(),transcriptionError:false,ending:false,acceptingFinalEvents:false,speaking:false,responding:false,aiSpeaking:false,muted:false,awaitingCommit:false,items:[],lastCompact:Date.now(),lastCompactAttempt:0,needsCompact:false,compacting:false,compactFailures:0,startedAt:null,startedMono:null,deadline:null,durationTimer:null,clockInterval:null};
    call=current;
    stream.getTracks().forEach(track=>pc.addTrack(track,stream));
    pc.ontrack=e=>{
      if(call!==current||current.ending)return;
      const remote=e.streams[0]||new MediaStream([e.track]);current.remoteStream=remote;
      presence.attachAudio(remote,'output');
      if($('remote-audio').srcObject!==remote){$('remote-audio').srcObject=remote;$('remote-audio').play().catch(()=>{if(call===current&&!current.ending)notice('음성 재생이 차단되었습니다. 화면을 눌러 다시 재생해 주세요.');});}
    };
    const dc=pc.createDataChannel('oai-events');current.dc=dc;
    dc.onmessage=e=>{
      if(call!==current || (current.ending&&!current.acceptingFinalEvents))return;
      let event;try{event=JSON.parse(e.data);}catch{return;}
      if(!current.ending) {
        if(event.type==='input_audio_buffer.speech_started'){presence.setState('listening');$('call-status').textContent='듣고 있어요 · 편하게 말씀하세요';}
        if(event.type==='input_audio_buffer.speech_stopped' || event.type==='response.created'){presence.setState('thinking');$('call-status').textContent='답변을 준비하고 있어요';}
        if(event.type==='output_audio_buffer.started'){current.aiSpeaking=true;presence.setState('speaking');$('call-status').textContent=companionName()+'가 말하고 있어요';}
        if(event.type==='output_audio_buffer.stopped' || event.type==='output_audio_buffer.cleared'){current.aiSpeaking=false;presence.setState('listening');$('call-status').textContent='듣고 있어요 · 편하게 말씀하세요';}
        if(event.type==='response.done' && event.response?.status && event.response.status!=='completed'){presence.setState('listening');$('call-status').textContent='듣고 있어요 · 편하게 말씀하세요';}
      }
      if(event.type==='conversation.item.created' || event.type==='conversation.item.added') {
        if(event.item?.id && !current.items.includes(event.item.id))current.items.push(event.item.id);
      }
      if(!current.ending&&event.type==='session.updated'&&current.checkpointAck&&event.session?.instructions===current.checkpointInstructions)current.checkpointAck();
      if(event.type==='response.created')current.responding=true;
      if(event.type==='response.done') {
        current.responding=false;
        const tokens=event.response?.usage?.input_tokens||0;
        current.needsCompact ||= /context.*(length|limit)|too_many_tokens/i.test(event.response?.status_details?.error?.code||'') || tokens>=18000 || Date.now()-current.lastCompact>=10*60*1000;
        if(!current.ending&&current.needsCompact&&Date.now()-current.lastCompactAttempt>=60000)setTimeout(()=>compactCall(current),250);
      }
      if(event.type==='input_audio_buffer.speech_started')current.speaking=true;
      if(event.type==='input_audio_buffer.speech_stopped'){current.speaking=false;if(!current.ending)current.responding=true;}
      if(event.type==='input_audio_buffer.committed'){current.awaitingCommit=false;current.transcribing.add(event.item_id);}
      if(event.type==='conversation.item.input_audio_transcription.failed'){current.transcriptionError=true;current.transcribing.delete(event.item_id);notice('일부 발화의 전사에 실패했습니다. 해당 발화는 기록되지 않았습니다.');}
      if(event.type==='error'&&!['response_cancel_not_active','conversation_already_has_active_response'].includes(event.error?.code)) {current.transcriptionError=true;notice('음성 연결 오류: '+(event.error?.message||'알 수 없는 오류'));}
      if(!current.ending)updateCallControls();
      saving=saving.then(()=>capture(event,current)).catch(error=>{current.transcriptionError=true;if(call===current){notice('저장 실패: '+error.message);setStatus('저장 실패 · 통화를 중단하고 확인하세요');current.stream.getTracks().forEach(track=>track.enabled=false);}});
    };
    dc.onopen=()=>{if(call!==current||current.ending)return;current.responding=true;updateCallControls();dc.send(JSON.stringify({type:'response.create',response:{instructions:'Start a natural English conversation as a friendly AI companion. Give a short warm greeting and one easy everyday question. Follow what the learner shares; no selected topic, roleplay setup, or invented shared memories.'}}));};
    pc.onconnectionstatechange=()=>{
      if(call!==current||current.ending)return;
      if(pc.connectionState==='connected') {
        startCallClock(current);if(current.ending)return;
        if(current.compactionInput&&!current.compacting){current.stream.getAudioTracks().forEach((track,i)=>track.enabled=!current.muted&&current.compactionInput[i]);current.compactionInput=null;}
        attachCallAudio(current);notice('');presence.setState(current.aiSpeaking?'speaking':current.responding?'thinking':'listening');$('call-status').textContent=companionName()+'와 통화 중 · 편하게 말씀하세요';
      }
      if(pc.connectionState==='disconnected') {notice('연결을 다시 확인하고 있어요. 통화 시간과 기록은 이어집니다.');$('call-status').textContent='연결을 다시 확인하고 있어요…';presence.detachAudio();presence.setState('connecting');}
      if(pc.connectionState==='failed') {notice('음성 연결을 복구하지 못해 수신된 대화를 저장합니다.');presence.setState('error');endCall().catch(e=>notice(e.message));}
      updateCallControls();
    };
    const offer=await pc.createOffer();if(call!==current||current.ending)return;await pc.setLocalDescription(offer);
    if(call!==current||current.ending)return;$('call-status').textContent='음성 연결 중…';
    const answer=await edge('voice',{sessionId:session.id,sdp:offer.sdp});
    if(call!==current||current.ending)return;
    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
  } catch(e) {
    stream?.getTracks().forEach(track=>track.stop());
    if(current){clearCallClock(current);current.pc.close();}
    if(!current||call===current){call=null;presence.detachAudio();$('remote-audio').srcObject=null;$('call-status').textContent='연결하지 못했어요. 다시 시도해 주세요.';}
    throw e;
  } finally {callStarting=false;setCallLayout(Boolean(call));if(!call&&!callEnding)setView(current?.nextView||'contacts');}
}
function endCall() {
  const current=call;
  if(!current)return Promise.resolve();
  if(current.ending)return current.endingPromise||Promise.resolve();
  // Reserve the end synchronously before any transcription/network awaits.
  current.ending=true;current.acceptingFinalEvents=true;callEnding=true;clearCallClock(current);navigationControls();updateCallControls();$('end-call').disabled=true;
  current.endingPromise=(async()=>{
    try {
      presence.detachAudio();current.stream.getTracks().forEach(track=>track.stop());
      $('call-status').textContent='마지막 발화의 전사와 저장을 확인하는 중…';
      if(current.dc.readyState==='open') {
        current.dc.send(JSON.stringify({type:'session.update',session:{type:'realtime',audio:{input:{turn_detection:{type:'server_vad',create_response:false}}}}}));
        if(current.speaking){current.awaitingCommit=true;current.dc.send(JSON.stringify({type:'input_audio_buffer.commit'}));}
        current.dc.send(JSON.stringify({type:'response.cancel'}));
        await new Promise(resolve=>setTimeout(resolve,1800));
        const until=Date.now()+8000;
        while((current.transcribing.size||current.awaitingCommit)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,150));
      }
      await saving;current.acceptingFinalEvents=false;
      if(current.transcribing.size||current.awaitingCommit||current.transcriptionError)throw Error('전사하지 못한 발화가 있습니다. 완료된 것으로 표시하지 않습니다. 수신된 기록은 저장되며, 최근 통화에서 통화를 정리할 수 있습니다.');
      await sync();await rpc('finish_session',{p_session_id:current.id});current.pc.close();
      const savedName=companions[current.companionId].name;
      selectedReviewSessionId=current.id;historyFilter=null;
      emptyReview(savedName+'와의 통화는 저장됐습니다. 피드백을 만들고 있어요…');
      $('call-status').textContent='통화 저장 완료 · 피드백을 만들고 있습니다';
      prepareFeedback(current.id,current.companionId).catch(error=>notice(error.message));
      current.nextView='review';
    } catch(e) {
      current.acceptingFinalEvents=false;current.pc.close();if(call===current)call=null;current.nextView='history';historyFilter=null;$('call-status').textContent='통화 중단 · 전사 또는 저장 미완료';loadHistory().catch(()=>{});throw e;
    } finally {
      callEnding=false;clearCallClock(current);if(call===current)call=null;
      if(!call){presence.detachAudio();$('remote-audio').pause();$('remote-audio').srcObject=null;setCallLayout(false);if(!callStarting)setView(current.nextView||'history');}
    }
  })();
  return current.endingPromise;
}
async function prepareFeedback(sessionId,id){
  const requestScope=scope;
  const valid=()=>scope===requestScope&&companionId===id&&selectedReviewSessionId===sessionId&&!callStarting&&(!call||call.id===sessionId);
  try{
    const result=await edge('review',{sessionId});
    const analysis=result.analysis;
    if(!analysis||analysis.session_id!==sessionId||!analysis.content||(analysis.content.scope?.companionId&&analysis.content.scope.companionId!==id))throw Error('이번 통화의 피드백을 확인하지 못했습니다.');
    if(valid()){$('call-status').textContent='통화와 피드백 저장 완료';$('review-content').replaceChildren();showAnalysis($('review-content'),{...analysis,companion_id:id});}
    if(scope===requestScope){const refreshed=await Promise.allSettled([loadHistory(),loadMemory()]);if(refreshed.some(result=>result.status==='rejected'))notice('통화는 저장됐습니다. 최근 통화나 복습을 새로고침해 주세요.');}
  }catch(error){
    if(!valid())return;
    emptyReview('통화는 저장됐습니다. 피드백을 아직 준비하지 못했어요.');
    const retry=document.createElement('button');retry.className='glass-button';retry.textContent='피드백 다시 시도';
    retry.onclick=protect(async()=>{if(!valid())return;retry.disabled=true;emptyReview('저장된 통화의 피드백을 만들고 있어요…');await prepareFeedback(sessionId,id);});
    $('review-content').append(retry);notice('대화는 저장됐습니다. '+error.message);
  }
}
function formatDate(value){return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value));}
function showAnalysis(target,analysis){
  const div=document.createElement('div');div.className='analysis';
  const title=document.createElement('h3');const reviewedName=companions[analysis.companion_id||analysis.content?.scope?.companionId]?.name;title.textContent=(reviewedName?reviewedName+' · ':'')+(analysis.kind==='weekly'?'최근 7일 분석':'통화 피드백');div.append(title);
  const content=analysis.content;
  if(analysis.kind==='weekly'&&content.scope?.period_start&&content.scope?.period_end){const period=document.createElement('p');period.className='help';period.textContent=formatDate(content.scope.period_start)+' ~ '+formatDate(content.scope.period_end)+' 기준';div.append(period);}
  const paragraph=text=>{const p=document.createElement('p');p.textContent=text;return p;};
  const evidence=(container,ids)=>{
    if(!ids?.length)return;
    const button=document.createElement('button');button.className='text-button';button.textContent='근거 발화';
    button.onclick=protect(async()=>{
      if(memoryBusy())return;
      const epoch=viewEpoch,requestScope=scope,selected=selectedReviewSessionId;
      const rows=await allRows('transcript_events',`id=in.(${ids.join(',')})&order=timestamp.asc,id.asc`);
      if(epoch!==viewEpoch||requestScope!==scope||selected!==selectedReviewSessionId||!button.isConnected)return;
      const quotes=document.createElement('blockquote');quotes.textContent=rows.filter(row=>row.speaker==='user'&&(!analysis.session_id||row.session_id===analysis.session_id)).map(row=>row.text).join(' / ');button.replaceWith(quotes);
    });container.append(button);
  };
  const group=(parent,key,label,full=false)=>{
    if(!content[key]?.length)return;
    const sectionGroup=document.createElement('section');sectionGroup.className='feedback-group';
    const h=document.createElement('h4');h.textContent=label;sectionGroup.append(h);
    for(const item of (key==='corrections'&&analysis.kind!=='weekly'&&!full?content[key].slice(0,2):content[key])){
      const section=document.createElement('div');section.className='feedback-item';
      if(key==='corrections'){
        const original=paragraph(item.original);original.className='original';
        const improved=paragraph(item.improved);improved.className='improved';
        section.append(original,improved,paragraph(item.reason));
      }else section.append(paragraph(item.text||item.expression));
      evidence(section,item.evidence_ids);sectionGroup.append(section);
    }
    parent.append(sectionGroup);
  };
  if(content.summary){const summary=paragraph(content.summary);summary.className='review-summary';div.append(summary);}
  if(content.strengths?.[0]?.text){const strength=paragraph(content.strengths[0].text);strength.className='help';div.append(strength);}
  group(div,'corrections','더 자연스럽게 말하기');group(div,'practice','다음에도 써볼 표현');
  const hasPractice=Boolean(content.corrections?.length||content.practice?.length);
  const context=hasPractice?disclosure(analysis.kind==='weekly'?'분석 자세히':'통화 돌아보기','feedback-context'):null;
  const supporting=context?.body||div;
  supporting.append(paragraph(content.summary));
  if(content.scope){const scope=document.createElement('small');scope.textContent=`분석 범위: ${content.scope.session_count}회 통화 · ${content.scope.user_event_count}개 사용자 발화`;supporting.append(scope);}

  if(content.corrections?.length>2&&analysis.kind!=='weekly')group(supporting,'corrections','전체 교정',true);
  group(supporting,'strengths','잘한 점');group(supporting,'patterns','반복해서 확인된 패턴');
  if(content.next_scenario){const h=document.createElement('h4');h.textContent='다음 대화에서 나눠볼 이야기';supporting.append(h,paragraph(content.next_scenario));}
  if(context)div.append(context.details);
  target.append(div);
  if(target.id==='review-content'){
    updatePracticePreview();
    if(content.next_scenario&&analysis.kind==='session'){
      const prepare=document.createElement('button');prepare.className='text-button';prepare.textContent='다음 통화 준비';
      const requestScope=scope,id=companionId;
      prepare.onclick=protect(async()=>{if(memoryBusy()||scope!==requestScope||id!==companionId)return;prepare.disabled=true;try{await rpc('learning_plan',{p_companion_id:id,p_scenario:content.next_scenario.slice(0,400)});if(scope!==requestScope||id!==companionId)return;await loadPlan();setView('contacts');notice('다음 이야기를 준비했어요. 통화를 누르면 연결됩니다.');}finally{prepare.disabled=false;}});div.append(prepare);
    }
    if(analysis.kind==='session'&&analysis.id){const practice=document.createElement('div');practice.id='learning-session';div.append(practice);learning.show(analysis);}
  }
}
function openCallDetails({session,analysis,excluded,meta,onReview,requestScope,entry}){
  if(memoryBusy()||scope!==requestScope||!entry.isConnected)return;
  closeDialog('call-detail-dialog');
  const epoch=++callDetailEpoch,name=companions[session.companion_id].name,content=$('call-detail-content');
  const valid=()=>epoch===callDetailEpoch&&scope===requestScope&&$('call-detail-dialog').open&&!memoryBusy();
  $('call-detail-title').textContent=name+'와의 통화';$('call-detail-meta').textContent=meta;
  const feedback=document.createElement('button');feedback.className='glass-button call-feedback';
  feedback.textContent=analysis?'피드백 보기':session.status==='ended'?'피드백 만들기':'수신된 기록으로 종료';
  feedback.onclick=protect(()=>{if(valid())return onReview(false);});content.append(feedback);
  const transcript=disclosure('대화문 보기','call-transcript');let loaded=false,loading=false;
  transcript.details.ontoggle=protect(async()=>{
    if(!transcript.details.open||loaded||loading||!valid())return;
    loading=true;transcript.body.textContent='대화문을 불러오고 있어요…';
    try{
      const rows=await allRows('transcript_events','session_id=eq.'+session.id+'&order=timestamp.asc,id.asc');
      if(!valid())return;
      const pre=document.createElement('pre');pre.textContent=rows.filter(event=>event.session_id===session.id).map(event=>(event.speaker==='user'?'나':name)+': '+event.text).join('\n\n')||'저장된 발화가 없습니다.';
      transcript.body.replaceChildren(pre);loaded=true;
    }catch(error){if(!valid())return;transcript.body.textContent='다시 열어 대화문을 불러와 주세요.';throw error;}
    finally{loading=false;}
  });
  content.append(transcript.details);
  if(session.status==='ended'){
    const management=disclosure('통화 관리','call-management');
    const toggle=document.createElement('button');toggle.className='text-button';toggle.textContent=excluded?'기억에 다시 포함':'기억에서 제외';
    toggle.onclick=protect(async()=>{if(!valid())return;selectCompanion(session.companion_id,{refresh:false});toggle.disabled=true;try{await mutateMemory({action:excluded?'restoreSession':'excludeSession',sessionId:session.id});if(valid()){closeDialog('call-detail-dialog');notice(excluded?'기억에 다시 포함했어요.':'이 통화는 기억에서 제외했어요.');}}finally{toggle.disabled=false;}});
    management.body.append(toggle);
    if(analysis){const retry=document.createElement('button');retry.className='text-button';retry.textContent='피드백 다시 확인';retry.onclick=protect(()=>{if(valid())return onReview(true);});management.body.append(retry);}
    content.append(management.details);
  }
  openDialog('call-detail-dialog');
}
async function loadHistory(){
  if(!auth||!scope)return;
  const epoch=++historyEpoch,requestScope=scope,filter=historyFilter,reviewSelection=selectedReviewSessionId,selectedCompanion=companionId;
  const through=Date.now(),since=through-7*86400000;
  const sessions=await api('/rest/v1/sessions?select=*&user_id=eq.'+auth.user.id+(filter?'&companion_id=eq.'+filter:'')+'&order=created_at.desc&limit=30');
  const analyses=await api('/rest/v1/analyses?select=*&user_id=eq.'+auth.user.id+'&order=created_at.desc&limit=100');
  const weeklySessions=await api('/rest/v1/sessions?select=companion_id,status,ended_at&user_id=eq.'+auth.user.id+'&status=eq.ended&ended_at=gte.'+new Date(since).toISOString()+'&and=(ended_at.lte.'+new Date(through).toISOString()+')&order=ended_at.desc&limit=1000').catch(()=>[]);
  const sessionCompanions=[...new Set(sessions.map(session=>session.companion_id).filter(id=>Object.hasOwn(companions,id)))];
  const exclusions=new Set();
  await Promise.all(sessionCompanions.map(async id=>{try{const controls=await edge('memory-manage',{companionId:id,action:'list'});for(const row of controls.excluded_sessions||[])exclusions.add(row.session_id);}catch(error){if(scope===requestScope&&epoch===historyEpoch)notice(error.message);}}));
  if(epoch!==historyEpoch||requestScope!==scope||filter!==historyFilter)return;
  $('history').replaceChildren();
  $('history-scope').textContent=filter?companions[filter].name+'와 나눈 통화':'';
  weeklyCompanions=new Set(weeklySessions.filter(session=>Object.hasOwn(companions,session.companion_id)&&session.status==='ended'&&Date.parse(session.ended_at)>=since&&Date.parse(session.ended_at)<=through).map(session=>session.companion_id));renderWeeklyAction();
  const ownSessions=sessions.filter(session=>Object.hasOwn(companions,session.companion_id));
  $('memory-search').hidden=!ownSessions.length;$('history-tools').hidden=!ownSessions.length;
  if(selectedReviewSessionId===reviewSelection&&companionId===selectedCompanion){
    const selectedSession=ownSessions.find(session=>session.id===selectedReviewSessionId)||ownSessions.find(session=>session.companion_id===companionId);
    selectedReviewSessionId=selectedSession?.id||null;
    $('review-content').replaceChildren();
    const selectedAnalysis=analyses.find(analysis=>analysis.session_id===selectedReviewSessionId&&analysis.kind==='session');
    if(selectedAnalysis)showAnalysis($('review-content'),{...selectedAnalysis,companion_id:selectedSession.companion_id});
    else emptyReview(selectedSession?'아직 피드백이 없어요. 최근 통화에서 피드백을 만들거나 다시 시도해 주세요.':undefined);
  }
  if(!ownSessions.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent=filter?companions[filter].name+'와 나눈 통화가 아직 없어요.':'아직 통화 기록이 없어요.';$('history').append(empty);return;}
  for(const session of ownSessions){
    const id=session.companion_id,name=companions[id].name;
    const entry=document.createElement('article');entry.className='history-entry';entry.dataset.sessionId=session.id;entry.dataset.companionId=id;
    let meta=formatDate(session.created_at)+' · '+(session.status==='ended'?'종료':'미완료 통화');
    if(session.scenario&&session.scenario!==NATURAL_CONVERSATION)meta+=' · '+session.scenario;
    const row=document.createElement('div');row.className='history-row';
    const open=document.createElement('button');open.className='history-open';open.setAttribute('aria-label',name+'와의 통화 상세');
    const avatar=document.createElement('img');avatar.className='history-avatar';avatar.src=$('ai-art-'+id).dataset.src;avatar.alt='';avatar.loading='lazy';avatar.decoding='async';
    const copy=document.createElement('span');copy.className='history-copy';const title=document.createElement('strong');title.textContent=name;
    const date=document.createElement('small');date.textContent=formatDate(session.created_at)+(session.status==='ended'?'':' · 미완료');copy.append(title,date);open.append(avatar,copy);
    const recall=document.createElement('button');recall.className='history-recall';recall.setAttribute('aria-label',name+'에게 다시 전화');recall.append(document.querySelector('[data-view="contacts"] img').cloneNode());
    recall.onclick=protect(async()=>{selectCompanion(id,{refresh:false});await startCall();});
    const analysis=analyses.find(row=>row.session_id===session.id&&row.kind==='session');
    const openReview=async regenerate=>{
      if(memoryBusy())throw Error('현재 통화를 종료한 뒤 사용하세요.');
      if(scope!==requestScope)return;
      selectCompanion(id,{refresh:false});selectedReviewSessionId=session.id;closeDialog('call-detail-dialog');
      setView('review');const actionView=viewEpoch,actionScope=scope;
      const valid=()=>actionScope===scope&&actionView===viewEpoch&&selectedReviewSessionId===session.id&&companionId===id&&!memoryBusy();
      $('review-content').replaceChildren();
      if(analysis&&!regenerate){showAnalysis($('review-content'),{...analysis,companion_id:id});return;}
      emptyReview('대화의 피드백을 만들고 있어요…');
      await sync();if(!valid())return;
      if(session.status!=='ended'){await rpc('finish_session',{p_session_id:session.id});if(!valid())return;}
      const result=await edge('review',{sessionId:session.id});if(!valid())return;
      if(result.analysis?.session_id&&result.analysis.session_id!==session.id)throw Error('통화의 피드백을 확인하지 못했습니다. 다시 시도하세요.');
      await loadHistory();if(!valid())return;await loadMemory();
    };
    open.onclick=()=>openCallDetails({session,analysis,excluded:exclusions.has(session.id),meta,onReview:openReview,requestScope,entry});
    row.append(open,recall);entry.append(row);$('history').append(entry);
  }
  if(sessions.length===30){const p=document.createElement('p');p.className='help';p.textContent='최근 30회 표시 중입니다. 전체 기록은 백업 파일에서 확인할 수 있습니다.';$('history').append(p);}
}

async function loadMemory(){
  const epoch=++memoryEpoch, selectedCompanion=companionId;
  const data=await edge('memory',{companionId:selectedCompanion});
  if(epoch!==memoryEpoch || selectedCompanion!==companionId)return;
  if($('memory-summary'))$('memory-summary').textContent=data.memories.length?`지난 대화에서 이어가기 · ${data.memories[0].summary}`:'첫 통화부터 나의 학습 기록을 쌓아 보세요.';
  practiceMemory=data.memories.find(memory=>memory.practice?.some(item=>typeof item.expression==='string'&&item.expression.trim()))||null;
  updatePracticePreview();
}
function renderAuthControls(){
  const linked=new Set((auth?.user?.identities||[]).map(identity=>identity.provider));
  for(const button of document.querySelectorAll('[data-oauth]')){
    const provider=button.dataset.oauth,available=providers[provider];
    button.disabled=!loginReady||socialBusy||!available;
    button.setAttribute('aria-label',(provider==='google'?'Google로 계속하기':'카카오 로그인')+(available?'':' · 준비 중'));
  }
  for(const button of document.querySelectorAll('[data-link-provider]')){
    const provider=button.dataset.linkProvider,name=provider==='google'?'Google':'카카오';
    button.disabled=!loginReady||socialBusy||!providers[provider]||linked.has(provider);
    button.textContent=linked.has(provider)?name+' 연결됨':name+' 연결';
  }
  $('account-email').textContent=auth?.user?.email||'로그인한 계정';
  $('social-status').textContent=!loginReady?'로그인 연결을 확인하고 있어요.':providers.google||providers.kakao?'':'간편 로그인을 준비하고 있어요. 이메일로 시작할 수 있어요.';
  $('identity-note').textContent=providers.google||providers.kakao?'다른 이메일을 쓰는 계정도 여기서 연결하면 대화 기록이 그대로 이어져요.':'간편 로그인 연결을 준비하고 있어요.';
}
async function loadAuthProviders(){
  try{const {data}=await request('/auth/v1/settings');providers={google:data.external?.google===true,kakao:data.external?.kakao===true};}
  catch{providers={google:false,kakao:false};}
  renderAuthControls();
}
async function startSocialLogin(provider,link=false){
  if(!authSession||!loginReady||socialBusy||!providers[provider])return;
  if(memoryBusy())throw Error('통화를 마친 뒤 계정을 연결하세요.');
  socialBusy=true;renderAuthControls();notice('');
  try{const url=await authSession.begin(provider,{link});window.location.assign(url);}
  catch{socialBusy=false;renderAuthControls();notice('로그인 연결을 시작하지 못했어요. 잠시 뒤 다시 선택해 주세요.');}
}
function resetSignedOutUI(){
  learning.reset();auth=null;scope=null;historyEpoch++;memoryEpoch++;selectedReviewSessionId=null;
  weeklyCompanions.clear();weeklyRequest=null;renderWeeklyAction();
  closeDialog('memory-dialog');closeDialog('account-dialog');closeDialog('call-detail-dialog');
  for(const id of ['memory-facts','memory-exclusions','history','memory-results','transcript'])$(id).replaceChildren();
  emptyReview();$('setup').hidden=false;$('workspace').hidden=true;$('auth-reset').hidden=true;renderAuthControls();
}
async function ready(){
  if(!config){$('service-state').textContent='서비스 연결을 준비하고 있습니다. 설정이 완료되면 여기서 바로 시작할 수 있어요.';setStatus('서비스 준비 중');return;}
  auth=await authSession.getSession();
  $('service-state').hidden=true;$('social-login').hidden=false;$('email-login').hidden=false;
  $('login-form').hidden=false;
  $('login-help').hidden=false;$('use-code').hidden=false;
  if((!providers.google&&!providers.kakao)||!$('verify-form').hidden)$('email-login').open=true;
  renderAuthControls();
  if(!auth){setStatus('로그인하면 기록이 자동 저장됩니다');return;}
  scope=null;weeklyCompanions.clear();weeklyRequest=null;renderWeeklyAction();closeDialog('call-detail-dialog');
  const user=await api('/auth/v1/user');auth.user=user;
  let data;
  try{data=await edge('config');}
  catch(error){if(error.code==='ACCOUNT_NOT_ALLOWED'){$('auth-reset').hidden=false;throw Error('승인된 이메일 계정만 이용할 수 있습니다. 이메일이 다른 계정은 기존 계정으로 로그인한 뒤 내 계정에서 연결하세요.');}throw error;}
  scope=config.url+'|'+user.id;
  renderAuthControls();$('auth-reset').hidden=true;
  const savedCompanion=localStorage.getItem(companionStorageKey());companionId=Object.hasOwn(companions,savedCompanion)?savedCompanion:'alex';updateCompanion();setView('contacts');
  $('setup').hidden=true;$('workspace').hidden=false;
  await updatePending();try{await sync();}catch(e){notice('미전송 기록이 있습니다: '+e.message);}
  await loadHistory();await loadMemory();await learning.load();await loadPlan();await updatePending();
  $('models').textContent=`음성 ${data.models.voice} · 교정 ${data.models.coach} · 분석 ${data.models.analysis}`;
}
mountEmailLogin({document,storage:localStorage,storageKey:'loop.email-login:'+(config?.url||'unconfigured'),request,notice,onAuthenticated:async data=>{auth=await authSession.adopt(data);notice('');await ready();}});
const logout=protect(async()=>{if(memoryBusy())throw Error('먼저 통화를 종료하세요.');try{await authSession.signOut();}finally{resetSignedOutUI();notice('로그아웃했습니다. 전송 대기 기록이 있다면 같은 계정으로 다시 로그인해 주세요.');}});
$('logout').onclick=logout;$('auth-reset').onclick=logout;
document.querySelectorAll('[data-oauth]').forEach(button=>button.onclick=protect(()=>startSocialLogin(button.dataset.oauth)));
document.querySelectorAll('[data-link-provider]').forEach(button=>button.onclick=protect(()=>startSocialLogin(button.dataset.linkProvider,true)));
$('start-call').onclick=protect(startCall);$('end-call').onclick=protect(endCall);
$('refresh-history').onclick=protect(async()=>{if(memoryBusy())return;await sync();await loadHistory();await loadMemory();});
$('weekly').onclick=protect(async()=>{
  if(memoryBusy())throw Error('통화를 마친 뒤 분석하세요.');
  if(!weeklyCompanions.has(companionId)||weeklyRequest)return;
  const selected=companionId,requestScope=scope,epoch=viewEpoch,request={};weeklyRequest=request;renderWeeklyAction();
  const valid=()=>selected===companionId&&requestScope===scope&&epoch===viewEpoch&&!memoryBusy();
  try{
    await sync();if(!valid())return;
    const result=await edge('weekly',{companionId:selected});if(!valid())return;
    if(result.analysis?.kind!=='weekly'||result.analysis.content?.scope?.companionId!==selected)throw Error('이 상대의 주간 분석을 확인하지 못했어요. 다시 시도해 주세요.');
    await loadHistory();if(!valid())return;
    selectedReviewSessionId=null;$('review-content').replaceChildren();showAnalysis($('review-content'),{...result.analysis,companion_id:selected});
  }finally{if(weeklyRequest===request){weeklyRequest=null;renderWeeklyAction();}}
});
$('memory-search').onsubmit=protect(async e=>{e.preventDefault();if(memoryBusy())return;const selectedCompanion=companionId,epoch=memoryEpoch;const data=await edge('memory',{query:$('memory-query').value.trim(),companionId:selectedCompanion});if(selectedCompanion!==companionId||epoch!==memoryEpoch)return;$('memory-results').replaceChildren();if(!data.memories.length){$('memory-results').textContent='관련 학습 기록이 없습니다.';return;}for(const item of data.memories){const article=document.createElement('article');article.className='history-entry';const p=document.createElement('p');p.textContent=item.summary;const meta=document.createElement('small');meta.textContent=`${formatDate(item.created_at)} · 근거 ${(item.source_event_ids||[]).length}개`;article.append(p,meta);const button=document.createElement('button');button.className='text-button';button.textContent='근거 발화 보기';button.onclick=protect(async()=>{if(memoryBusy())return;const actionView=viewEpoch,actionScope=scope,ids=item.source_event_ids||[];if(!ids.length)return;const rows=await allRows('transcript_events',`id=in.(${ids.join(',')})&order=timestamp.asc,id.asc`);if(actionView!==viewEpoch||actionScope!==scope||epoch!==memoryEpoch||selectedCompanion!==companionId||!button.isConnected)return;const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=rows.filter(row=>row.session_id===item.session_id).map(row=>row.text).join('\n');button.replaceWith(pre);});article.append(button);$('memory-results').append(article);}if(data.limited)notice('관련 기록 일부는 통화 문맥 크기 제한으로 제외되었습니다. 더 구체적인 검색어를 사용하세요.');});
$('export').onclick=protect(async()=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 백업하세요.');await saving;await sync();const backup={schema_version:1,exported_at:new Date().toISOString(),sessions:await allRows('sessions','order=created_at.asc,id.asc'),events:await allRows('transcript_events','order=timestamp.asc,id.asc'),analyses:await allRows('analyses','order=created_at.asc,id.asc'),memory_controls:{state:await allRows('memory_state','order=companion_id.asc'),facts:await allRows('memory_fact_overrides','order=companion_id.asc,key.asc'),exclusions:await allRows('memory_session_exclusions','order=companion_id.asc,session_id.asc')}};const a=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));a.href=url;a.download='sisicolcol-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('restore').onchange=protect(async e=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 복원하세요.');const file=e.target.files[0];if(!file)return;try{if(file.size>15_000_000)throw Error('복원 파일은 15MB 이하로 나눠 주세요.');const data=JSON.parse(await file.text());if(data.schema_version!==1||!Array.isArray(data.sessions)||!Array.isArray(data.events))throw Error('지원하지 않는 백업 형식입니다.');const included=new Set(data.sessions.map(s=>s.id));if(data.events.some(event=>!included.has(event.session_id)))throw Error('세션에 연결되지 않은 발화가 포함된 백업입니다.');
const controls=data.memory_controls??{state:[],facts:[],exclusions:[]};if(!controls||!Array.isArray(controls.state)||!Array.isArray(controls.facts)||!Array.isArray(controls.exclusions))throw Error('백업의 기억 설정 형식이 올바르지 않습니다.');
if([...controls.state,...controls.facts,...controls.exclusions].some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('백업의 기억 설정 형식이 올바르지 않습니다.');const sessionCompanions=new Map(data.sessions.map(session=>[session.id,session.companion_id]));for(const row of [...controls.state,...controls.facts])if(!companions[row.companion_id]||typeof row.companion_id!=='string')throw Error('백업에 알 수 없는 대화 상대의 기억이 있습니다.');for(const row of controls.facts)if(!memorySlots.some(([key])=>key===row.key)||typeof row.value!=='string'||row.value.length>240)throw Error('백업의 기억 사실 형식이 올바르지 않습니다.');for(const row of controls.exclusions)if(typeof row.session_id!=='string'||!companions[row.companion_id]||sessionCompanions.get(row.session_id)!==row.companion_id)throw Error('백업의 기억 제외 기록이 대화와 일치하지 않습니다.');
const activeByCompanion=new Map();for(const session of data.sessions)if(session.status!=='ended'){const group=activeByCompanion.get(session.companion_id)||[];group.push(session);activeByCompanion.set(session.companion_id,group);}for(const [companion,sessions] of activeByCompanion){const ids=new Set(sessions.map(session=>session.id));const count=data.events.filter(event=>ids.has(event.session_id)).length;if(sessions.length>20||count>1000)throw Error('미완료 통화가 많아 안전하게 복원할 수 없습니다. 백업에서 미완료 통화를 정리한 뒤 다시 시도하세요.');}
await sync();memoryEpoch++;practiceMemory=null;$('memory-results').replaceChildren();if($('memory-summary'))$('memory-summary').textContent='기억을 새로 확인하고 있어요…';if($('practice-preview-text'))$('practice-preview-text').textContent='기억을 새로 확인하고 있어요…';if($('practice-preview'))$('practice-preview').disabled=true;
const controlsFor=sessions=>({state:controls.state,facts:controls.facts,exclusions:controls.exclusions.filter(row=>sessions.some(session=>session.id===row.session_id))});
// Ended sessions go first; unfinished sessions for each companion stay in one final atomic batch with their controls.
const ended=data.sessions.filter(session=>session.status==='ended');for(let start=0;start<ended.length;start+=20){const sessions=ended.slice(start,start+20);const ids=new Set(sessions.map(session=>session.id));const events=data.events.filter(event=>ids.has(event.session_id));if(events.length>1000){for(const session of sessions){const own=events.filter(event=>event.session_id===session.id);for(let n=0;n<Math.max(own.length,1);n+=500)await rpc('restore_history',{p_backup:{sessions:[session],events:own.slice(n,n+500),memory_controls:controlsFor([session])}});}}else await rpc('restore_history',{p_backup:{sessions,events,memory_controls:controlsFor(sessions)}});}
for(const sessions of activeByCompanion.values()){const ids=new Set(sessions.map(session=>session.id));const events=data.events.filter(event=>ids.has(event.session_id));await rpc('restore_history',{p_backup:{sessions,events,memory_controls:controlsFor(sessions)}});}
if(!data.sessions.length)await rpc('restore_history',{p_backup:{sessions:[],events:[],memory_controls:controls}});
notice('대화 기록을 복원했습니다. 과거 분석은 신뢰할 수 있는 근거로 다시 생성하세요.');}finally{e.target.value='';if(scope&&auth)await Promise.allSettled([loadHistory(),loadMemory()]);}});
document.querySelectorAll('[data-cue]').forEach(button=>button.onclick=protect(async()=>{
  const current=call;
  if(!current||current.ending||current.compacting||current.responding||current.speaking||current.aiSpeaking||current.dc.readyState!=='open'||current.pc.connectionState!=='connected')return;
  current.responding=true;updateCallControls();
  try{current.dc.send(JSON.stringify({type:'response.create',response:{instructions:button.dataset.cue}}));}catch(error){current.responding=false;updateCallControls();throw error;}
}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&call)updateCallClock(call);});
window.addEventListener('pageshow',event=>{if(call)updateCallClock(call);if(event.persisted){socialBusy=false;renderAuthControls();}});
window.addEventListener('online',()=>sync().catch(e=>notice(e.message)));
window.addEventListener('offline',()=>{cloudVerified=false;updatePending().catch(()=>{});});
window.addEventListener('beforeunload',e=>{if(call || callStarting || callEnding){e.preventDefault();e.returnValue='';}});
setInterval(()=>{if(auth)sync().catch(()=>{});},5000);
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=protect(async()=>{if(memoryBusy())return;const view=button.dataset.view;if(view==='history')historyFilter=null;setView(view);if(view==='history')await loadHistory();if(view==='review')await learning.resume();}));
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeDialog(button.dataset.close));
const companionButtons=[...document.querySelectorAll('[data-companion]')];
companionButtons.forEach(button=>{
  button.onclick=protect(()=>selectCompanion(button.dataset.companion));
  button.onkeydown=event=>{
    if(memoryBusy()||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const index=companionButtons.indexOf(button),count=companionButtons.length;
    const next=event.key==='Home'?0:event.key==='End'?count-1:(index+(event.key==='ArrowRight'?1:count-1))%count;
    companionButtons[next].focus();companionButtons[next].click();
  };
});
document.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>{if(call || callStarting || callEnding)return;openDialog(button.dataset.open);});
if($('account-open'))$('account-open').onclick=()=>{if(!memoryBusy())openDialog('account-dialog');};
const openMemory=protect(async()=>{if(memoryBusy())return notice('통화를 마친 뒤 기억을 관리할 수 있어요.');closeDialog('account-dialog');openDialog('memory-dialog');$('memory-index-status').textContent='';$('memory-index-more').hidden=true;await loadMemoryControls();});
if($('memory-manage-open'))$('memory-manage-open').onclick=openMemory;if($('account-memory'))$('account-memory').onclick=openMemory;
if($('memory-index'))$('memory-index').onclick=protect(indexMemory);if($('memory-index-more'))$('memory-index-more').onclick=protect(indexMemory);
if($('practice-preview'))$('practice-preview').onclick=()=>{
  if(call || callStarting || callEnding || !practiceMemory || !$('review-content'))return;
  selectedReviewSessionId=practiceMemory.session_id;
  $('review-content').replaceChildren();
  showAnalysis($('review-content'),{kind:'session',companion_id:companionId,session_id:practiceMemory.session_id,content:{summary:practiceMemory.summary,corrections:practiceMemory.corrections,practice:practiceMemory.practice}});
  setView('review');
};
if($('mute-call'))$('mute-call').onclick=()=>{const current=call;if(!current||current.ending||current.compacting)return;current.muted=!current.muted;current.stream.getAudioTracks().forEach(track=>track.enabled=!current.muted);updateCallControls();};
updateCompanion();setView('contacts');
async function initializeLogin(){
  if(!config){await ready();return;}
  const providersLoading=loadAuthProviders();let callbackMessage='';
  try{const result=await authSession.completeRedirect();auth=result.session;if(result.linked)callbackMessage='계정을 연결했어요. 다음에는 연결한 계정으로 로그인할 수 있어요.';}
  catch(error){auth=await authSession.getSession().catch(()=>null);callbackMessage=error instanceof LoginFlowError?error.message:'로그인을 완료하지 못했어요. 다시 선택해 주세요.';}
  authSession.onChange((event,session)=>{
    const previousUser=auth?.user?.id;auth=session;
    if(event==='SIGNED_OUT'){
      if(memoryBusy()){call?.stream?.getTracks().forEach(track=>track.stop());call?.pc?.close();window.location.reload();return;}
      resetSignedOutUI();
    }else if(event==='SIGNED_IN'&&previousUser&&session?.user?.id!==previousUser&&!$('workspace').hidden)window.location.reload();
  });
  await providersLoading;loginReady=true;await ready();if(callbackMessage)notice(callbackMessage);
}
initializeLogin().catch(error=>{loginReady=true;renderAuthControls();notice('연결 확인 필요: '+error.message);});

document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();if(auth)setView('contacts');});
