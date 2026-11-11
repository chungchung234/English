import { createSessionReview } from './session-review.js';
import { createConversationMemoryDelivery } from '../src/conversation-memory.js';
import { createLearningReview } from '../src/learning-review.mjs';
import { createCallCompletion } from './call-completion.js';
import { createCallCues } from './call-cues.js';
import { createAIPresence } from './ai-presence.js';
import { createSpeechSpeed, validSpeed, formatSpeed, SPEED } from './speech-speed.js';
import { createPostCallTranscript } from './post-call-transcript.js';
import { createVoiceTurnControls } from './voice-turn-controls.js';
import { createConversationClock, deviceTimeZone, formatInstant, recordTimeLabel, sessionTimeLabel, sessionTimeZone } from './conversation-time.js';
import { createOutbox, flushOutbox } from '../src/outbox.js';
import { validatePublicConfig } from '../src/public-config.mjs';
import { mountEmailLogin } from '../src/email-login.mjs';
import { createAuthSession, LoginFlowError } from '../src/auth-session.mjs';
import { clientBuild, telemetryMetadata, createConnectedTelemetry, createTelemetryDiagnostics } from '../src/learning-telemetry.mjs';
const $ = id => document.getElementById(id);
$('privacy-dialog').querySelector('.privacy-copy').append(' 복습 수행·미루기·제외·보류 선택과 학습 노트 확인·연습 등 사용 이력도 내 계정에 저장됩니다.');
const outbox = createOutbox();
const presence = createAIPresence();
const config = globalThis.LOOP_PUBLIC_CONFIG ? validatePublicConfig(globalThis.LOOP_PUBLIC_CONFIG.url,globalThis.LOOP_PUBLIC_CONFIG.key) : null;
const authSession=config?createAuthSession(config):null;
const authTransitionLogo=$('setup').querySelector('.setup-brand-logo').cloneNode();
authTransitionLogo.className='auth-transition-logo';$('auth-transition-brand').append(authTransitionLogo);
let readyEpoch=0,providersLoaded=false,authVisualEpoch=0,authTransitionLeaving=false,authVisualAnimations=[];
let companionSlideAnimations=[],companionDrag=null,companionClickGuard=null;
const companionMotion=matchMedia('(prefers-reduced-motion: reduce)');
let auth=null,loginReady=false,socialBusy=false,providers={google:false,kakao:false};
let flushing, call, callCues, scope, saving = Promise.resolve(), historyEpoch = 0, memoryEpoch = 0, cloudVerified = false;
const releaseMetadata = telemetryMetadata({client_build:clientBuild()});
const telemetryDiagnostics = createTelemetryDiagnostics({getScope:()=>auth&&scope?scope:null});
const companions = {mia:{name:'Mia',trait:'다정하고 사려 깊은 대화'},alex:{name:'Alex',trait:'차분하고 명료한 대화'},juno:{name:'Juno',trait:'경쾌하고 호기심 많은 대화'}};
let companionId = 'alex', callStarting = false, callEnding = false, selectedReviewSessionId = null, practiceMemory = null;
let currentView = 'contacts', viewEpoch = 0, historyFilter = null;
let callDetailEpoch=0, weeklyCompanions=new Set(), weeklyRequest=null;
const transcriptReview=createPostCallTranscript({
 context:()=>({scope,companionId,sessionId:selectedReviewSessionId}),
 allRows,pendingRows:account=>outbox.list(account)
});
const sessionReview=createSessionReview({
 context:()=>({scope,sessionId:selectedReviewSessionId,active:currentView==='review'}),
 getRows:async ids=>{const rows=transcriptReview.getRows(),missing=ids?.filter(id=>!rows.some(row=>row.id===id));if(!missing?.length)return rows;const owner=scope,session=selectedReviewSessionId;const fetched=await allRows('transcript_events',`session_id=eq.${session}&id=in.(${missing.join(',')})&order=timestamp.asc,id.asc`);return owner===scope&&session===selectedReviewSessionId?[...rows,...fetched]:[];},
 showSource:(ids,options)=>transcriptReview.showSource(ids,options),
 onViewed:node=>learning.feedbackViewed?.(node),
 onExit:()=>{learning.closePractice?.();if(call?.ending){call.wrapupHome=true;call.nextView='contacts';}setView('contacts',true);}
});
const learning=createLearningReview({document,rpc,edge,allRows,sync,isBusy:()=>memoryBusy(),
 getEventMetadata:()=>releaseMetadata,onTelemetryStage:event=>telemetryDiagnostics.record(event),
 getScope:()=>auth&&scope?{key:scope+'|'+companionId,companionId,name:companionName()}:null,
 onFeedbackState:state=>sessionReview.update(state),onNotice:message=>notice(message),setView,setReviewMode,navigationKey:()=>viewEpoch,onPlan:()=>loadPlan().catch(error=>notice(error.message)),
 refresh:()=>loadHistory(),onAnalysis:analysis=>{
  if(selectedReviewSessionId!==analysis.session_id||companionId!==(analysis.companion_id||analysis.content?.scope?.companionId)||callStarting||call&&call.id!==analysis.session_id)return;
  $('review-content').replaceChildren();showAnalysis($('review-content'),analysis);
  if(currentView==='review'&&$('review-panel').dataset.mode==='session')$('review-announcement').textContent='이번 대화의 학습 노트가 준비됐어요.';
 },onSession:async(sessionId,analysis)=>{
  if(memoryBusy())return;
  const requestScope=scope,selected=companionId,navigation=viewEpoch;
  if(!analysis){const rows=await api('/rest/v1/analyses?session_id=eq.'+sessionId+'&kind=eq.session&order=created_at.desc&limit=1');analysis=rows[0];}
  if(scope!==requestScope||companionId!==selected||navigation!==viewEpoch||memoryBusy())return;
  selectedReviewSessionId=sessionId;setReviewMode('session');$('review-content').replaceChildren();
  selectTranscript({id:sessionId,companion_id:selected,status:'ended'});
  transcriptReview.prioritizeFeedback();
  if(analysis)showAnalysis($('review-content'),{...analysis,companion_id:selected});else mountLearningSession(sessionId);
  setView('review');
 }
});
function mountLearningSession(sessionId,session={}){
 $('review-content').replaceChildren();
 const host=document.createElement('div');host.id='learning-session';$('review-content').append(host);
 learning.selectSession({id:sessionId,companion_id:companionId,status:'ended',...session});
}
function selectTranscript(session, current=null){
 transcriptReview.select(session,{name:companions[session.companion_id]?.name,current});
}
const NATURAL_CONVERSATION = 'Natural English conversation about everyday life';
const CALL_DURATION = 20 * 60 * 1000;
const memorySlots=[['name','이름'],['occupation','직업'],['location','사는 곳'],['goal','목표'],['interest','관심사'],['preference','선호']];
let excludedMemorySessions=new Set();
const companionName = () => companions[companionId].name;
const companionStorageKey = () => 'loop.companion:' + config.url + '|' + auth.user.id;
function setReviewMode(mode) {
  const panel=$('review-panel');if(!panel)return;
  panel.dataset.mode=mode;
  sessionReview.sync();$('session-feedback-context').textContent=companionName()+'와의 대화';
  $('review-announcement').textContent='';
  $('review-title').textContent=mode==='session'?'통화 돌아보기':mode==='weekly'?'최근 7일':'복습';
  $('review-context').textContent=mode==='session'?companionName()+'와의 통화':companionName()+'와 이어가기';
  $('review-back').hidden=mode==='hub';
  renderWeeklyAction();
}
function openReviewHub() {
  learning.closePractice?.();setReviewMode('hub');setView('review');
  $('review-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});
}
function showWrapup() {
  const region=document.createElement('section');region.className='review-state';region.dataset.reviewState='finalizing';
  const title=document.createElement('h2');title.textContent='통화가 끝났어요';
  const state=document.createElement('p');state.className='help';state.setAttribute('role','status');state.textContent='마지막 말을 정리하고 저장을 확인하고 있어요.';
  region.append(title,state);$('review-content').replaceChildren(region);
}
function setView(view,allowWrapup=false) {
  if((memoryBusy()&&!allowWrapup) || !['contacts','call','history','review'].includes(view)) return false;
  if(view!==currentView){
    if(currentView==='review')learning.closePractice?.();
    window.scrollTo({top:0,behavior:'instant'});
  }
  if(view!=='contacts')stopCompanionSlide();
  currentView=view;viewEpoch++;
  document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== view);
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    if(selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  sessionReview.sync();presence.refresh();if(typeof learning!=='undefined')learning.viewed();return true;
}
function navigationControls() {
  const busy=memoryBusy();
  document.querySelectorAll('[data-view], [data-companion], [data-open], .history-open, .history-recall, #account-memory, #account-open, #refresh-history').forEach(button=>button.disabled=busy);
  renderWeeklyAction();
  memoryControlsDisabled(false);
}
function stopCompanionSlide(){
  const pointer=companionDrag?.id,capture=$('workspace');companionDrag=null;
  if(pointer!==undefined&&capture.hasPointerCapture(pointer))capture.releasePointerCapture(pointer);
  $('companion-art').style.transform='';$('companion-art').style.opacity='';
  const lens=$('companion-selector').querySelector('.selection-lens');lens.style.transform='';lens.style.transition='';
  for(const animation of companionSlideAnimations)animation.cancel();
  companionSlideAnimations=[];$('companion-stage').querySelectorAll('.companion-slide-out,.companion-swipe-peek').forEach(node=>node.remove());
}
companionMotion.addEventListener('change',()=>{if(companionMotion.matches)stopCompanionSlide();});
const companionStage=$('companion-stage'),companionCapture=$('workspace');
function companionTravel(){return Math.min(companionStage.clientWidth,parseFloat(getComputedStyle($('orb')).width)+24);}
companionStage.addEventListener('dragstart',event=>event.preventDefault());
document.addEventListener('pointerdown',event=>{
  companionClickGuard=null;
  if(!event.isPrimary||event.button!==0||memoryBusy()||currentView!=='contacts'||companionCapture.hidden||document.querySelector('dialog[open]'))return;
  if(event.target.closest('a,input,select,textarea,summary,label,.glass-dock'))return;
  stopCompanionSlide();
  companionDrag={id:event.pointerId,x:event.clientX,y:event.clientY,delta:0,horizontal:false,button:event.target.closest('button,[role=button]')};
});
document.addEventListener('pointermove',event=>{
  const drag=companionDrag;if(!drag||drag.id!==event.pointerId)return;
  const x=event.clientX-drag.x,y=event.clientY-drag.y;
  if(!drag.horizontal){
    // Allow the small vertical wobble of a slow thumb drag before choosing an axis.
    if(Math.abs(y)>16&&Math.abs(y)>Math.abs(x)*1.5){companionDrag=null;return;}
    if(Math.abs(x)<8||Math.abs(x)<Math.abs(y)*.9)return;
    drag.horizontal=true;companionCapture.setPointerCapture(event.pointerId);
  }
  if(event.cancelable)event.preventDefault();
  const order=companionButtons.map(button=>button.dataset.companion),index=order.indexOf(companionId);
  drag.delta=x;
  const atEdge=x>0&&index===0||x<0&&index===order.length-1;
  if(!companionMotion.matches){
    const travel=companionTravel(),offset=atEdge?x*.2:Math.sign(x)*(Math.min(Math.abs(x),travel)+Math.max(0,Math.abs(x)-travel)*.2),progress=Math.min(1,Math.abs(offset)/travel);
    $('companion-art').style.transform=`translateX(${offset}px)`;
    $('companion-art').style.opacity=String(1-progress);
    const next=index+(x<0?1:-1);let peek=companionStage.querySelector('.companion-swipe-peek');
    if(atEdge){peek?.remove();}else{
      if(!peek){peek=document.createElement('div');peek.className='companion-swipe-peek';peek.setAttribute('aria-hidden','true');const image=new Image();image.alt='';image.className='ai-presence ai-presence-home';peek.append(image);companionStage.append(peek);}
      if(peek.dataset.profile!==order[next]){const name=order[next];peek.dataset.profile=name;presence.posterSource(name).then(source=>{if(peek.isConnected&&peek.dataset.profile===name)peek.querySelector('img').src=source;});}
      peek.style.transform=`translateX(${offset+(x<0?1:-1)*travel}px)`;
      peek.style.opacity=String(.2+progress*.8);
    }
    const lens=$('companion-selector').querySelector('.selection-lens');lens.style.transition='none';
    lens.style.transform=`translateX(${Math.max(0,Math.min(order.length-1,index-Math.max(-1,Math.min(1,offset/travel))))*100}%)`;
  }
});
function finishCompanionDrag(event,cancelled=false){
  const drag=companionDrag;if(!drag||drag.id!==event.pointerId)return;
  companionDrag=null;
  if(drag.horizontal&&drag.button)companionClickGuard={button:drag.button,until:performance.now()+400};
  if(companionCapture.hasPointerCapture(drag.id))companionCapture.releasePointerCapture(drag.id);
  const order=companionButtons.map(button=>button.dataset.companion),index=order.indexOf(companionId);
  const target=index+(drag.delta<0?1:-1),threshold=Math.max(28,Math.min(36,companionTravel()*.12));
  if(!cancelled&&drag.horizontal&&Math.abs(drag.delta)>=threshold&&target>=0&&target<order.length&&!memoryBusy()){
    selectCompanion(order[target]);return;
  }
  const art=$('companion-art'),from=getComputedStyle(art).transform,opacity=getComputedStyle(art).opacity,peek=companionStage.querySelector('.companion-swipe-peek');
  const peekFrom=peek?getComputedStyle(peek).transform:null,peekOpacity=peek?getComputedStyle(peek).opacity:null;stopCompanionSlide();
  if(!drag.horizontal||companionMotion.matches)return;
  const options={duration:280,easing:'cubic-bezier(.22,.68,.16,1)'};
  companionSlideAnimations=[art.animate([{transform:from,opacity},{transform:'translateX(0)',opacity:1}],options)];
  if(peek){companionStage.append(peek);companionSlideAnimations.push(peek.animate([{transform:peekFrom,opacity:peekOpacity},{transform:`translateX(${(drag.delta<0?1:-1)*companionTravel()}px)`,opacity:0}],options));}
  const active=companionSlideAnimations;Promise.allSettled(active.map(animation=>animation.finished)).then(()=>{if(companionSlideAnimations===active)stopCompanionSlide();});
}
document.addEventListener('click',event=>{
  if(event.detail&&companionClickGuard&&performance.now()<companionClickGuard.until&&event.target.closest('button,[role=button]')===companionClickGuard.button){
    companionClickGuard=null;event.preventDefault();event.stopImmediatePropagation();
  }
},true);
document.addEventListener('pointerup',event=>finishCompanionDrag(event));
document.addEventListener('pointercancel',event=>finishCompanionDrag(event,true));
// Touch starts with implicit capture on the canvas; ignore its transfer to the stage.
document.addEventListener('lostpointercapture',event=>{if(event.target===companionCapture)finishCompanionDrag(event,true);});

function prepareCompanionSlide(next){
  const stage=$('companion-stage'),art=$('companion-art');
  const canSlide=currentView==='contacts'&&!$('workspace').hidden&&!companionMotion.matches&&typeof art.animate==='function';
  const position=canSlide?getComputedStyle(art).transform:'none';
  const opacity=canSlide?getComputedStyle(art).opacity:'1',frame=canSlide?presence.snapshot($('orb')):null;
  const outgoing=frame?document.createElement('div'):null;
  if(frame){frame.className='ai-presence ai-presence-home';outgoing.append(frame);}
  const peek=stage.querySelector('.companion-swipe-peek'),entry=peek?.dataset.profile===next?getComputedStyle(peek).transform:null,entryOpacity=entry?getComputedStyle(peek).opacity:0;
  const order=[...document.querySelectorAll('[data-companion]')].map(button=>button.dataset.companion);
  const direction=order.indexOf(next)>order.indexOf(companionId)?1:-1;
  stopCompanionSlide();
  return ()=>{
    if(!canSlide)return;
    const options={duration:280,easing:'cubic-bezier(.22,.68,.16,1)'};
    if(outgoing){
      outgoing.className='companion-slide-out';outgoing.setAttribute('aria-hidden','true');stage.append(outgoing);
      companionSlideAnimations.push(outgoing.animate([{transform:position,opacity},{transform:`translateX(${-direction*companionTravel()}px)`,opacity:0}],options));
    }
    companionSlideAnimations.push(art.animate([{transform:entry||`translateX(${direction*companionTravel()}px)`,opacity:entryOpacity},{transform:'translateX(0)',opacity:1}],options));
    const active=companionSlideAnimations;
    Promise.allSettled(active.map(animation=>animation.finished)).then(()=>{if(companionSlideAnimations===active)stopCompanionSlide();});
  };
}
function selectCompanion(next, {refresh=true}={}) {
  if(memoryBusy())throw Error('통화를 마친 뒤 대화 상대를 바꿀 수 있어요.');
  if(!Object.hasOwn(companions,next))throw Error('대화 상대를 선택하세요.');
  if(next===companionId)return;
  const slide=prepareCompanionSlide(next);
  historyEpoch++;memoryEpoch++;viewEpoch++;
  closeDialog('memory-dialog');$('memory-facts').replaceChildren();$('memory-exclusions').replaceChildren();excludedMemorySessions=new Set();
  companionId=next;practiceMemory=null;selectedReviewSessionId=null;learning.reset();setReviewMode('hub');$('next-plan').hidden=true;
  if(auth&&config)localStorage.setItem(companionStorageKey(),companionId);
  transcriptReview.clear();updateCompanion();slide();$('memory-results').replaceChildren();$('memory-query').value='';emptyReview();
  if($('practice-preview-text'))$('practice-preview-text').textContent='지난 대화에서 표현을 찾고 있어요…';
  if($('practice-preview'))$('practice-preview').disabled=true;
  if(refresh&&auth){loadPlan().catch(error=>notice(error.message));learning.load();loadMemory().catch(e=>notice(e.message));loadHistory().catch(e=>notice(e.message));}
}
async function loadPlan(){
 if(!scope)return;
 const plan=learning.getPlan();
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
  const current=call, connected=Boolean(current?.ready&&current.pc.connectionState==='connected');
  const locked=!current||!connected||current.ending||current.compacting||callStarting;
  if($('mute-call')){$('mute-call').disabled=locked||Boolean(current?.inputBlocked);$('mute-call').setAttribute('aria-pressed',String(Boolean(current?.muted)));$('mute-call').setAttribute('aria-label','음소거');}
  document.querySelectorAll('[data-cue]').forEach(button=>button.disabled=locked||!connected||!current.voiceInstructions||current.responding||current.speaking||current.aiSpeaking||current.floor?.blocksResponse);
  $('speed-call').disabled=locked||!connected;
  $('speed-apply').disabled=!current||current.ending||callStarting||!connected||!validSpeed(selectedSpeechSpeed());
  current?.speed?.availability(Boolean(connected&&current.dc?.readyState==='open'&&!current.ending), Boolean(current.responding||current.aiSpeaking||current.speaking||current.compacting||callStarting));
  current?.floor?.availability(Boolean(connected&&current.dc?.readyState==='open'&&!current.ending));
  renderFloor(current);
}
function renderFloor(current) {
  const state=current?.floor?.state;
  if(state?.held&&!current.ending){presence.setState('listening');$('call-status').textContent=state.pending?'응답 제어 확인 중':state.phase==='error'?'응답 제어 확인 필요':'듣고 있어요 · 편하게 말씀하세요';}
}
function savedSpeechSpeed() {
  try { const value=Number(localStorage.getItem('loop.speech-speed:'+scope));return validSpeed(value)?value:SPEED.default; } catch { return SPEED.default; }
}
function renderSpeechSpeed(state) {
  $('speed-current').textContent=formatSpeed(state.applied);
  $('speed-call').setAttribute('aria-label','말하기 속도 '+formatSpeed(state.applied).replace('×','배'));
  $('speed-pending').hidden=!state.pending;
  $('speed-pending').textContent=state.pending?formatSpeed(state.desired)+' · 다음 답변에 적용 대기 중':'';
}
function selectedSpeechSpeed() {
  return Number($('speed-form').elements['speech-speed'].value);
}
function renderSpeedDraft(value) {
  const options=[...document.querySelectorAll('[name="speech-speed"]')];
  options.forEach(option=>{option.checked=Number(option.value)===value;});
  const custom=!options.some(option=>option.checked);
  $('speed-custom-current').hidden=!custom;
  $('speed-custom-current').textContent=custom?'현재 '+formatSpeed(value)+' · 변경할 속도를 선택하세요':'';
  updateCallControls();
}
function setCallPhase(phase) {
  document.body.dataset.callPhase=phase;presence.setPaused(phase==='ending');
  for(const selector of ['.live-actions','.call-floor-controls','.transcript-details']){const node=document.querySelector(selector);if(node)node.inert=phase==='ending';}
}
function setCallLayout(active) {
  if(!active){setCallPhase('');$('call-completion-status').hidden=true;$('view-ending-transcript').hidden=true;}
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
  if(current.startedAt!==null&&remaining<=0){current.durationReached=true;notice('20분이 되어 통화를 종료하고 저장합니다.');endCall().catch(e=>notice(e.message));}
}

function applyConversationContext(current, response) {
  if(call!==current||current.ending)return;
  if(response.clock){current.clock=createConversationClock({clock:response.clock,timeZone:current.time_zone});if(response.clock.session_created_at)current.created_at=response.clock.session_created_at;}
  if(response.memory_context)current.memoryContext=response.memory_context;
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
  if(call!==current||current.ending||!current.ready)return;
  if(current.stream.getAudioTracks().some(track=>track.readyState!=='ended'))presence.attachAudio(current.stream,'input');
  if(current.remoteStream?.getAudioTracks().some(track=>track.readyState!=='ended')){
    presence.attachAudio(current.remoteStream,'output');
    if($('remote-audio').srcObject!==current.remoteStream){$('remote-audio').srcObject=current.remoteStream;$('remote-audio').play().catch(()=>{if(call===current&&!current.ending)notice('음성 재생이 차단되었습니다. 화면을 눌러 다시 재생해 주세요.');});}
  }
}
function activateCall(current) {
  if(call!==current||current.ending||current.pc.connectionState!=='connected'||!current.dataOpen||current.dc.readyState!=='open')return;
  current.cues.connected();current.ready=true;setCallPhase('connected');
  if(!current.compacting){current.stream.getAudioTracks().forEach((track,i)=>track.enabled=!current.inputBlocked&&!current.muted&&(!current.compactionInput||current.compactionInput[i]));current.compactionInput=null;}
  startCallClock(current);if(current.ending)return;
  attachCallAudio(current);notice(current.inputBlocked?'기기 저장 오류로 마이크를 껐어요. 통화를 마치고 저장 상태를 확인해 주세요.':'');presence.setState(current.inputBlocked?'error':current.aiSpeaking?'speaking':current.responding?'thinking':'listening');$('call-status').textContent=current.inputBlocked?'저장 오류 · 통화를 마쳐 주세요':companionName()+'와 통화 중 · 편하게 말씀하세요';
  if(!current.greeted&&!current.inputBlocked&&!current.floor.blocksResponse){current.greeted=true;current.responding=true;current.dc.send(JSON.stringify({type:'response.create'}));}
  updateCallControls();
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
function emptyReview(message = '통화를 마치면 이곳에서 학습 노트를 확인할 수 있어요.') {
  if(!$('review-content')) return;
  const p=document.createElement('p');p.className='empty-state';p.textContent=message;$('review-content').replaceChildren(p);
  updatePracticePreview();
}
function renderWeeklyAction(){
  const available=Boolean(auth&&scope&&weeklyCompanions.has(companionId)&&$('review-panel')?.dataset.mode==='hub');
  $('weekly').hidden=!available;$('weekly').disabled=!available||Boolean(weeklyRequest)||memoryBusy();
  $('weekly').textContent=weeklyRequest?'분석 중…':'주간 분석';
}
function updatePracticePreview(){
  const expression=!learning.hasPendingExclusions()?practiceMemory?.practice.find(item=>typeof item.expression==='string'&&item.expression.trim())?.expression:null;
  const visible=false; // The review hub owns the single current recommendation.
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
function setStatus(text) { if(document.body.dataset.callPhase!=='ending')$('save-status').textContent = text; }
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
const conversationMemory=createConversationMemoryDelivery({identity:()=>auth&&scope?scope:null,busy:()=>Boolean(call||callStarting||callEnding),prepare:body=>edge('memory-prepare',body)});
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
  flushing=flushOutbox(outbox,current,async(sessionId,events)=>{
    await rpc('append_events',{p_session_id:sessionId,p_events:events});
    if(call?.scope===current&&call.id===sessionId)for(const event of events){const row=call.transcript.get(event.event_key||event.id);if(row)row.storage='server';}
    transcriptReview.confirm(current,sessionId,events);
  }).then(updatePending).catch(async e=>{await updatePending();throw e;}).finally(()=>{flushing=null;});
  return flushing;
}
function renderTurn(event,pending=false) {
  $('empty-transcript').hidden=true;
  const li=document.createElement('li');li.dataset.id=event.id;li.classList.toggle('pending',pending);
  const who=document.createElement('b');who.textContent=event.speaker==='user'?'YOU':companionName().toUpperCase();
  const stamp=document.createElement('small');stamp.className='transcript-record-time';stamp.textContent=recordTimeLabel(event.occurred_at||event.timestamp,call?.clock?.timeZone||call?.time_zone);li.append(who,stamp,document.createTextNode(event.text));$('transcript').append(li);li.scrollIntoView({block:'nearest'});
  $('turn-count').textContent=`${$('transcript').children.length}개 발화`;
}
function observeCallItem(current,itemId) {
  if(!current.itemTimes.has(itemId)) {
    current.lastItemTime=Math.max(current.clock?.now()??Date.now(),(current.lastItemTime||0)+1);
    current.itemTimes.set(itemId,new Date(current.lastItemTime).toISOString());
  }
  return current.itemTimes.get(itemId);
}
function receiveTurn(event,current) {
  if(!current || (current.ending&&!current.acceptingFinalEvents))return;
  if(current.floor?.ignoresTranscript(event))return;
  let speaker,text;
  if(event.type==='conversation.item.input_audio_transcription.completed') {speaker='user';text=event.transcript;current.transcribing.delete(event.item_id);}
  else if(event.type==='response.output_audio_transcript.done') {speaker='assistant';text=event.transcript;}
  else return;
  if(!text?.trim())return;
  const eventKey=`${speaker}:${event.item_id}:${event.content_index??0}`;
  if(current.seen.has(eventKey))return;
  const item=current.transcript.get(eventKey)||{id:crypto.randomUUID(),event_key:eventKey,speaker,text:text.trim(),occurred_at:observeCallItem(current,event.item_id)};
  item.storage='received';current.transcript.set(eventKey,item);
  current.seen.add(eventKey);
  if(call===current){
    if(!current.ending&&!$('transcript').querySelector(`[data-id="${item.id}"]`))renderTurn(item,true);
    transcriptReview.changed(current);
  }
  return item;
}
async function capture(item,current) {
  if(!item)return;
  const {storage:ignored,...stored}=item;
  try{await outbox.put({id:item.id,scope:current.scope,sessionId:current.id,event:stored});}
  catch(error){item.storage='failed';current.seen.delete(item.event_key);transcriptReview.changed(current);throw error;}
  if(item.storage!=='server')item.storage='device';transcriptReview.changed(current);
  if(call===current)await updatePending();
  sync().catch(e=>notice('클라우드 전송 대기: '+e.message));
}
// Compact only at a completed assistant turn. Pause input while taking the
// durable checkpoint, then delete old items only after the server acknowledges
// the replacement instructions. A failed checkpoint leaves the live context intact.
async function compactCall(current) {
  if(call!==current || current.ending || current.compacting || current.floor?.blocksResponse || current.transcriptionError || current.pc.connectionState!=='connected') return;
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
    current.omitLearningContext ||= learning.hasPendingExclusions();
    const result=await edge('checkpoint',{sessionId:current.id,omitLearningContext:current.omitLearningContext});
    if(call!==current || current.ending || current.dc.readyState!=='open')return;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{current.checkpointAck=null;reject(Error('기억 갱신 확인이 지연됐습니다.'));},8000);
      current.checkpointInstructions=result.instructions;
      current.checkpointAck=()=>{clearTimeout(timer);current.checkpointAck=null;resolve();};
      current.dc.send(JSON.stringify({type:'session.update',session:{type:'realtime',instructions:result.instructions}}));
    });
    if(call!==current || current.ending)return;
    applyConversationContext(current,result);
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
    if(call===current&&!current.ending&&current.ready&&current.pc.connectionState==='connected'){current.stream.getAudioTracks().forEach((track,i)=>track.enabled=!current.inputBlocked&&!current.muted&&enabled[i]);current.compactionInput=null;}
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
  setView('call');callStarting=true;historyEpoch++;memoryEpoch++;selectedReviewSessionId=null;transcriptReview.clear();emptyReview(companionName()+'와의 통화를 마치면 학습 노트를 확인할 수 있어요.');setCallLayout(true);
  $('transcript').replaceChildren();$('turn-count').textContent='0개 발화';$('empty-transcript').hidden=false;
  if($('call-timer'))$('call-timer').textContent='00:00';if($('call-remaining'))$('call-remaining').hidden=true;
  $('call-completion-status').hidden=true;$('call-completion-status').textContent='';$('view-ending-transcript').hidden=true;
  $('call-status').textContent=companionName()+'와 연결하고 있어요';presence.setState('connecting');setCallPhase('connecting');
  const cues=createCallCues();callCues=cues;cues.startConnecting();
  const callScope=scope, callUserId=auth.user.id, selectedCompanion=companionId;
  let stream,current;
  try {
    await sync();
    await learning.load();await learning.flush();
    const omitLearningContext=learning.hasPendingExclusions();
    const prepared=learning.getPlan();
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    if(!callStarting||scope!==callScope||companionId!==selectedCompanion)throw Error('통화 연결이 취소되었습니다.');
    const callTimeZone=deviceTimeZone();
    const [session]=await api('/rest/v1/sessions',{method:'POST',headers:{Prefer:'return=representation'},body:{id:crypto.randomUUID(),user_id:auth.user.id,scenario:!omitLearningContext&&prepared?.scenario?'User-prepared conversation: '+prepared.scenario:NATURAL_CONVERSATION,companion_id:selectedCompanion,client_build:releaseMetadata.client_build,time_zone:callTimeZone}});
    if(!callStarting||scope!==callScope||companionId!==selectedCompanion)throw Error('통화 연결이 취소되었습니다.');
    const pc=new RTCPeerConnection();
    current={cues,ready:false,dataOpen:false,greeted:false,omitLearningContext,id:session.id,companionId:selectedCompanion,scope:callScope,pc,stream,remoteStream:null,seen:new Set(),transcribing:new Set(),transcriptionError:false,ending:false,acceptingFinalEvents:false,speaking:false,responding:false,aiSpeaking:false,muted:false,awaitingCommit:false,items:[],lastCompact:Date.now(),lastCompactAttempt:0,needsCompact:false,compacting:false,compactFailures:0,startedAt:null,startedMono:null,deadline:null,durationTimer:null,clockInterval:null};
    current.transcript=new Map();current.itemTimes=new Map();call=current;
    current.time_zone=session.time_zone??callTimeZone;current.created_at=session.created_at;current.clock=createConversationClock({timeZone:current.time_zone});
    current.floor=createVoiceTurnControls({send:event=>{const wasResponding=current.responding;if(event.type==='response.create')current.responding=true;try{current.dc.send(JSON.stringify(event));}catch(error){current.responding=wasResponding;throw error;}},
      blockOutput:blocked=>{if(call===current&&!current.ending)$('remote-audio').muted=blocked;},
      changed:state=>{if(call!==current||current.ending)return;if(current.floorHeld&&!state.held){presence.setState(current.aiSpeaking?'speaking':current.responding?'thinking':'listening');$('call-status').textContent=current.aiSpeaking?companionName()+'가 말하고 있어요':current.responding?'답변을 준비하고 있어요':'듣고 있어요 · 편하게 말씀하세요';}current.floorHeld=state.held;renderFloor(current);},
      failed:message=>{if(call===current&&!current.ending)notice(message);}});
    $('remote-audio').muted=false;
    current.connectedTelemetry=createConnectedTelemetry({sessionId:current.id,metadata:releaseMetadata,
      receiptOptions:{now:()=>new Date(current.clock?.now()??Date.now()).toISOString()},
      isCurrent:()=>call===current&&!current.ending&&scope===callScope&&auth?.user?.id===callUserId&&companionId===selectedCompanion&&pc.connectionState!=='closed',
      enqueue:receipt=>learning.recordConnected(current.id,receipt),
      onStage:event=>telemetryDiagnostics.record(event),onPersisted:()=>{current.connectedRecorded=true;}});
    const initialSpeed=savedSpeechSpeed();current.initialSpeed=initialSpeed;
    current.speed=createSpeechSpeed({initial:initialSpeed,send:event=>dc.send(JSON.stringify(event)),
      changed:state=>{if(call===current)renderSpeechSpeed(state);},
      applied:value=>{if(call!==current||current.ending)return;try{localStorage.setItem('loop.speech-speed:'+current.scope,String(value));}catch{/* The call can continue without a stored preference. */}notice('말하기 속도를 '+formatSpeed(value)+'로 변경했어요.');},
      failed:message=>{if(call===current&&!current.ending)notice(message);}});
    renderSpeechSpeed(current.speed.state);
    stream.getTracks().forEach(track=>{track.enabled=false;pc.addTrack(track,stream);});
    pc.ontrack=e=>{
      if(call!==current||current.ending)return;
      const remote=e.streams[0]||new MediaStream([e.track]);current.remoteStream=remote;
      if(current.ready)attachCallAudio(current);
    };
    const dc=pc.createDataChannel('oai-events');current.dc=dc;
    dc.onmessage=e=>{
      if(call!==current || (current.ending&&!current.acceptingFinalEvents))return;
      let event;try{event=JSON.parse(e.data);}catch{return;}
      // A one-off response instruction replaces the session's instructions.
      // Retain the effective provider configuration so hints keep the same
      // English-only, concise persona and private-context boundaries.
      if(['session.created','session.updated'].includes(event.type)&&typeof event.session?.instructions==='string'&&event.session.instructions.trim())current.voiceInstructions=event.session.instructions;
      const speedError=current.speed.event(event);
      if(!current.ending&&current.ready) {
        if(event.type==='input_audio_buffer.speech_started'){presence.setState('listening');$('call-status').textContent='듣고 있어요 · 편하게 말씀하세요';}
        if(event.type==='input_audio_buffer.speech_stopped' || event.type==='response.created'){presence.setState('thinking');$('call-status').textContent='답변을 준비하고 있어요';}
        if(event.type==='output_audio_buffer.started'){current.aiSpeaking=true;presence.setState('speaking');$('call-status').textContent=companionName()+'가 말하고 있어요';}
        if(event.type==='output_audio_buffer.stopped' || event.type==='output_audio_buffer.cleared'){current.aiSpeaking=false;presence.setState('listening');$('call-status').textContent='듣고 있어요 · 편하게 말씀하세요';}
        if(event.type==='response.done' && event.response?.status && event.response.status!=='completed'){presence.setState('listening');$('call-status').textContent='듣고 있어요 · 편하게 말씀하세요';}
      }
      if(event.type==='conversation.item.created' || event.type==='conversation.item.added') {
        if(event.item?.id && !current.items.includes(event.item.id))current.items.push(event.item.id);
        if(event.item?.id)observeCallItem(current,event.item.id);
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
      if(event.type==='input_audio_buffer.speech_stopped'){current.speaking=false;current.awaitingCommit=true;if(!current.ending&&!current.floor.blocksResponse)current.responding=true;}
      if(event.type==='input_audio_buffer.committed'){current.awaitingCommit=false;current.transcribing.add(event.item_id);observeCallItem(current,event.item_id);}
      if(event.type==='conversation.item.input_audio_transcription.failed'){current.transcriptionError=true;current.transcribing.delete(event.item_id);notice('일부 발화의 전사에 실패했습니다. 해당 발화는 기록되지 않았습니다.');}
      // An old cancelled response.done must be processed before resume can
      // issue a new response and mark its request as pending synchronously.
      const floorError=current.floor.event(event);
      // A VAD commit may race the final manual commit. An empty-buffer error
      // for our own final request is not proof of lost speech: keep waiting
      // for committed + ASR receipts, and retain partial status if absent.
      const finalCommitEmpty=event.type==='error'&&Boolean(current.ending&&current.finalCommitId)&&event.error?.event_id===current.finalCommitId&&event.error?.code==='input_audio_buffer_commit_empty';
      if(event.type==='error'&&!speedError&&!floorError&&!finalCommitEmpty&&!['response_cancel_not_active','conversation_already_has_active_response'].includes(event.error?.code)) {current.transcriptionError=true;notice('음성 연결 오류: '+(event.error?.message||'알 수 없는 오류'));}
      if(!current.ending)updateCallControls();
      const received=receiveTurn(event,current);
      saving=saving.then(()=>capture(received,current)).catch(error=>{current.transcriptionError=true;current.inputBlocked=true;if(call===current){notice('저장 실패: '+error.message);setStatus('저장 실패 · 통화를 중단하고 확인하세요');current.stream.getTracks().forEach(track=>track.enabled=false);updateCallControls();}});
    };
    dc.onopen=()=>{current.dataOpen=true;activateCall(current);};
    dc.onclose=()=>{current.dataOpen=false;if(call!==current||current.ending)return;current.ready=false;notice('음성 연결이 종료되어 수신된 대화를 저장합니다.');endCall().catch(error=>notice(error.message));};
    pc.onconnectionstatechange=()=>{
      if(call!==current||current.ending)return;
      if(pc.connectionState==='connected') {
        void current.connectedTelemetry.observe(pc.connectionState);
        activateCall(current);
      }
      if(pc.connectionState==='disconnected') {current.ready=false;current.stream.getAudioTracks().forEach(track=>track.enabled=false);notice('연결을 다시 확인하고 있어요. 통화 시간과 기록은 이어집니다.');$('call-status').textContent='연결을 다시 확인하고 있어요';presence.detachAudio();presence.setState('connecting');setCallPhase('connecting');}
      if(pc.connectionState==='failed') {notice('음성 연결을 복구하지 못해 수신된 대화를 저장합니다.');presence.setState('error');endCall().catch(e=>notice(e.message));}
      updateCallControls();
    };
    const offer=await pc.createOffer();if(call!==current||current.ending)return;await pc.setLocalDescription(offer);
    if(call!==current||current.ending)return;$('call-status').textContent=companionName()+'에게 전화 거는 중';
    current.omitLearningContext ||= learning.hasPendingExclusions();
    const answer=await edge('voice',{sessionId:session.id,sdp:offer.sdp,omitLearningContext:current.omitLearningContext,speechSpeed:current.initialSpeed});
    if(call!==current||current.ending)return;
    applyConversationContext(current,answer);
    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
  } catch(e) {
    cues.dispose();if(callCues===cues)callCues=null;
    stream?.getTracks().forEach(track=>track.stop());
    if(current){current.connectedTelemetry?.stop();current.speed?.dispose();current.floor?.dispose();clearCallClock(current);current.pc.close();}
    if(!current||call===current){call=null;presence.detachAudio();$('remote-audio').srcObject=null;$('call-status').textContent='연결하지 못했어요. 다시 시도해 주세요.';}
    throw e;
  } finally {callStarting=false;setCallLayout(Boolean(call));if(!call&&!callEnding)setView(current?.nextView||'contacts');}
}
function endCall() {
  const current=call;
  if(!current)return Promise.resolve();
  if(current.ending)return current.endingPromise||Promise.resolve();
  const endRequestedAt=performance.now();
  // Reserve the end synchronously before any transcription/network awaits.
  current.durationMs=Math.min(CALL_DURATION,callElapsed(current));current.ending=true;current.connectedTelemetry?.stop();current.acceptingFinalEvents=true;callEnding=true;clearCallClock(current);navigationControls();updateCallControls();$('end-call').disabled=true;
  current.speed?.dispose();current.floor?.dispose();closeDialog('speed-dialog');
  current.stream.getTracks().forEach(track=>track.stop());
  presence.detachAudio();$('remote-audio').pause();$('remote-audio').srcObject=null;
  current.remoteStream?.getAudioTracks().forEach(track=>track.enabled=false);
  setCallPhase('ending');$('speed-pending').hidden=true;$('save-status').textContent='마지막 대화는 계속 저장해요';$('call-status').textContent='통화가 종료됐어요';$('call-status').tabIndex=-1;$('call-status').focus({preventScroll:true});current.cues.end();
  current.assistantInterrupted=Boolean(current.responding||current.aiSpeaking);
  current.transcriptPhase='finalizing';current.nextView='review';selectedReviewSessionId=current.id;historyFilter=null;
  setReviewMode('session');showWrapup();sessionReview.update({sessionId:current.id,status:'finalizing'});if(!current.durationReached)notice('');
  selectTranscript({id:current.id,companion_id:current.companionId,status:'active',created_at:current.created_at,time_zone:current.time_zone},current);
  const cueCleanup=setTimeout(()=>{current.cues.dispose();if(callCues===current.cues)callCues=null;},600);
  current.completion=createCallCompletion({startedAt:endRequestedAt,
    onUpdate:state=>{
      if(state.status==='saved')current.saveDurationMs=state.elapsedMs;
      if(scope!==current.scope||selectedReviewSessionId!==current.id||document.body.dataset.callPhase!=='ending')return;
      const elapsed=$('call-completion-status');elapsed.hidden=false;elapsed.textContent=`종료 후 ${(state.elapsedMs/1000).toFixed(1)}초 경과`;
      const message=state.status==='saved'?'대화 저장을 확인했어요':state.status==='partial'?'일부 기록의 저장 상태를 확인해 주세요':state.stage==='saving'?'대화를 서버에 저장하고 있어요':'마지막 발화를 정리하고 있어요';
      if($('save-status').textContent!==message)$('save-status').textContent=message;
      $('view-ending-transcript').hidden=!state.canReview;$('view-ending-transcript').disabled=!state.canReview;
    },
    onReview:state=>{
      if(scope===current.scope&&selectedReviewSessionId===current.id&&!current.wrapupHome){
        setCallLayout(false);setView('review',true);
        $('session-record-title')?.focus({preventScroll:true});
      }
    }
  });
  current.onWrapupHome=()=>{current.wrapupHome=true;current.nextView='contacts';setView('contacts',true);notice('수신된 발화의 저장을 확인하고 있어요. 앱을 닫으면 전사 중인 음성은 복구되지 않을 수 있어요. 서버 저장 완료 전에는 통화 완료로 표시하지 않아요.');};
  const wrapupTimer=setTimeout(()=>{
    if(!current.ending||!callEnding)return;
    current.wrapupCanLeave=true;transcriptReview.changed(current);
  },10000);
  current.endingPromise=(async()=>{
    try {
      presence.detachAudio();current.stream.getTracks().forEach(track=>track.stop());
      // The end cue reveals received text; only finish acknowledgement allows feedback.
      if(current.dc.readyState==='open') {
        current.dc.send(JSON.stringify({type:'session.update',session:{type:'realtime',audio:{input:{turn_detection:current.floor?.shutdownPolicy()??null}}}}));
        if(current.speaking){current.awaitingCommit=true;current.finalCommitId='final-commit-'+crypto.randomUUID();current.dc.send(JSON.stringify({type:'input_audio_buffer.commit',event_id:current.finalCommitId}));}
        current.dc.send(JSON.stringify({type:'response.cancel'}));
        await new Promise(resolve=>setTimeout(resolve,1800));
        const until=Date.now()+8000;
        while((current.transcribing.size||current.awaitingCommit)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,150));
      }
      current.acceptingFinalEvents=false;current.completion.setStage('saving');await saving;
      if(current.transcribing.size||current.awaitingCommit||current.transcriptionError)throw Error('전사하지 못한 발화가 있습니다. 완료된 것으로 표시하지 않습니다. 수신된 기록은 저장되며, 최근 통화에서 통화를 정리할 수 있습니다.');
      if(scope!==current.scope)throw Error('계정이 바뀌어 이 통화의 저장 상태를 확인하지 못했어요. 원래 계정에서 기록을 확인해 주세요.');
      await sync();
      while((await outbox.list(current.scope)).some(record=>record.sessionId===current.id)) {
        if(scope!==current.scope)throw Error('계정이 바뀌어 저장 확인을 중단했어요. 원래 계정에서 다시 확인해 주세요.');
        await sync();
      }
      if(scope!==current.scope)throw Error('계정이 바뀌어 저장 확인을 중단했어요. 원래 계정에서 다시 확인해 주세요.');
      const finishResponse=await rpc('finish_session',{p_session_id:current.id});
      const finished=Array.isArray(finishResponse)&&finishResponse.length===1?finishResponse[0]:finishResponse;
      if(finished?.id!==current.id||finished.status!=='ended'||typeof finished.ended_at!=='string'||!Number.isFinite(Date.parse(finished.ended_at)))throw Error('서버의 통화 저장 완료 응답을 확인하지 못했어요. 기록에서 저장 상태를 다시 확인해 주세요.');
      current.ended_at=finished.ended_at;current.pc.close();
      if(scope!==current.scope)throw Error('계정이 바뀌었어요. 원래 계정에서 통화 저장 상태를 확인해 주세요.');
      selectedReviewSessionId=current.id;historyFilter=null;
      current.transcriptPhase='saved';current.completion.settle('saved');transcriptReview.changed(current);
      if(document.body.dataset.callPhase!=='ending')$('call-status').textContent='통화 저장 완료 · 학습 노트를 만들고 있습니다';
      mountLearningSession(current.id);
      conversationMemory.wake([current.companionId],{force:true});
      learning.saved({id:current.id,companion_id:current.companionId,status:'ended',created_at:current.created_at,time_zone:current.time_zone,ended_at:current.ended_at??null}).catch(error=>notice(error.message));
      if(!current.wrapupHome)current.nextView='review';
    } catch(e) {
      current.acceptingFinalEvents=false;current.transcriptPhase='partial';current.completion.settle('partial');transcriptReview.changed(current);
      current.pc.close();if(call===current)call=null;if(!current.wrapupHome)current.nextView='review';historyFilter=null;
      if(document.body.dataset.callPhase!=='ending')$('call-status').textContent='통화 중단 · 전사 또는 저장 미완료';
      if(scope===current.scope) {
        notice('');mountLearningSession(current.id,{status:'active'});learning.interrupted({id:current.id,companion_id:current.companionId,status:'active'},e.message);
        loadHistory().catch(()=>{});
      }
      // Recovery is kept beside this call, rather than covering it with a toast.
    } finally {
      await current.completion.reviewed;current.completion.dispose();clearTimeout(cueCleanup);current.cues.dispose();if(callCues===current.cues)callCues=null;
      clearTimeout(wrapupTimer);current.wrapupCanLeave=false;$('wrapup-home')?.remove();callEnding=false;clearCallClock(current);if(call===current)call=null;
      if(!call){presence.detachAudio();$('remote-audio').pause();$('remote-audio').srcObject=null;setCallLayout(false);if(!callStarting&&scope===current.scope)setView(current.nextView||'history');}
    }
  })();
  return current.endingPromise;
}
async function prepareFeedback(sessionId,id){
 if(!auth||id!==companionId)return;
 await learning.load();
 await learning.requestReview(sessionId);
}
function formatDate(value){return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value));}
function showAnalysis(target,analysis){
  if(analysis.kind==='session'&&target.id==='review-content'){
    selectTranscript({id:analysis.session_id,companion_id:analysis.companion_id||analysis.content?.scope?.companionId||companionId,status:'ended'});
    const host=document.createElement('div');host.id='learning-session';target.replaceChildren(host);learning.show(analysis);return;
  }
  const div=document.createElement('div');div.className='analysis';
  const title=document.createElement('h3');const reviewedName=companions[analysis.companion_id||analysis.content?.scope?.companionId]?.name;title.textContent=(reviewedName?reviewedName+' · ':'')+(analysis.kind==='weekly'?'최근 7일 분석':'통화 학습 노트');div.append(title);
  const content=analysis.content;
  if(analysis.kind==='weekly'){
    const period=document.createElement('p');period.className='help';
    period.textContent=content.scope?.period_start&&content.scope?.period_end?formatDate(content.scope.period_start)+' ~ '+formatDate(content.scope.period_end)+' KST · 직전 168시간':'이전 분석에 정확한 시작·종료 시각이 없어 분석 기간을 확인할 수 없어요.';
    const generated=document.createElement('p');generated.className='help';const generatedAt=analysis.generated_at||analysis.created_at;
    generated.textContent='생성: '+(generatedAt?formatDate(generatedAt)+' KST':'시각 정보 없음')+' · 이후 통화는 이 결과에 자동 포함되지 않아요.';div.append(period,generated);
  }
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
        section.dataset.correctionExpression=item.improved;const category=document.createElement('small');category.textContent=item.category==='error'?'의미·문법 오류':'선택 가능한 대안';section.append(category,original,improved,paragraph(item.reason));
      }else {if(key==='practice')section.dataset.correctionExpression=item.text||item.expression;section.append(paragraph(item.text||item.expression));}
      evidence(section,item.evidence_ids);sectionGroup.append(section);
    }
    parent.append(sectionGroup);
  };
  const isSession=analysis.kind==='session';
  if(isSession){
    div.id='review-core';
    const details=disclosure('통화 내용과 전체 학습 노트','feedback-context');
    if(content.summary)details.body.append(paragraph(content.summary));
    group(details.body,'strengths','잘한 점');
    group(details.body,'corrections','교정과 대안',true);
    group(details.body,'practice','다음에도 써볼 표현');
    group(details.body,'patterns','반복해서 확인된 패턴');
    if(content.next_scenario){const h=document.createElement('h4');h.textContent='다음에 나눌 이야기';details.body.append(h,paragraph(content.next_scenario));}
    if(content.scope){const scope=document.createElement('small');scope.textContent=`분석에 포함된 사용자 발화 ${content.scope.user_event_count ?? 0}개`;details.body.append(scope);}
    div.replaceChildren(details.details);
  }else{
    if(content.summary)div.append(paragraph(content.summary));
    group(div,'strengths','잘한 점');group(div,'corrections','교정과 대안',true);group(div,'practice','다음에도 써볼 표현');group(div,'patterns','반복해서 확인된 패턴');
  }
  target.append(div);
  if(target.id==='review-content'){
    updatePracticePreview();
    if(isSession&&analysis.session_id)selectTranscript({id:analysis.session_id,companion_id:analysis.companion_id||analysis.content?.scope?.companionId||companionId,status:'ended'});
    else if(analysis.kind==='weekly')transcriptReview.clear();
    if(isSession&&analysis.id){const practice=document.createElement('div');practice.id='learning-session';div.before(practice);learning.show(analysis);}
  }
}
function openCallDetails({session,analysis,excluded,meta,onReview,requestScope,entry}){
  if(memoryBusy()||scope!==requestScope||!entry.isConnected)return;
  closeDialog('call-detail-dialog');
  const epoch=++callDetailEpoch,name=companions[session.companion_id].name,content=$('call-detail-content');
  const valid=()=>epoch===callDetailEpoch&&scope===requestScope&&$('call-detail-dialog').open&&!memoryBusy();
  $('call-detail-title').textContent=name+'와의 통화';$('call-detail-meta').textContent=meta;
  const feedback=document.createElement('button');feedback.className='glass-button call-feedback';
  feedback.textContent=analysis?'학습 노트 보기':session.status==='ended'?'학습 노트 상태 보기':'수신된 기록으로 마무리';
  feedback.onclick=protect(()=>{if(valid())return onReview(false);});content.append(feedback);
  const transcript=disclosure('대화문 보기','call-transcript');let loaded=false,loading=false;
  transcript.details.ontoggle=protect(async()=>{
    if(!transcript.details.open||loaded||loading||!valid())return;
    loading=true;transcript.body.textContent='대화문을 불러오고 있어요…';
    try{
      const rows=await allRows('transcript_events','session_id=eq.'+session.id+'&order=timestamp.asc,id.asc');
      if(!valid())return;
      const events=document.createElement('div'),zone=sessionTimeZone(session).zone,owned=rows.filter(event=>event.session_id===session.id);
      for(const event of owned){const stamp=document.createElement('small');stamp.className='transcript-record-time';stamp.textContent=recordTimeLabel(event.timestamp||event.occurred_at,zone);const pre=document.createElement('pre');pre.textContent=(event.speaker==='user'?'나':name)+': '+event.text;events.append(stamp,pre);}
      if(!owned.length)events.textContent='저장된 발화가 없습니다.';
      const note=document.createElement('p');note.className='help';note.textContent='자동 전사된 기록이에요. 중간에 멈춘 답변은 실제로 들은 내용과 다를 수 있어요.';
      const timing=document.createElement('p');timing.className='help';timing.textContent='기록 시각은 발화를 수신한 때이며 실제 말하기 시작 시각과 다를 수 있어요.';
      transcript.body.replaceChildren(note,timing,events);loaded=true;
    }catch(error){if(!valid())return;transcript.body.textContent='다시 열어 대화문을 불러와 주세요.';throw error;}
    finally{loading=false;}
  });
  content.append(transcript.details);
  transcript.details.open=true;
  if(session.status==='ended'){
    const management=disclosure('통화 관리','call-management');
    const toggle=document.createElement('button');toggle.className='text-button';toggle.textContent=excluded?'기억에 다시 포함':'기억에서 제외';
    toggle.onclick=protect(async()=>{if(!valid())return;selectCompanion(session.companion_id,{refresh:false});toggle.disabled=true;try{await mutateMemory({action:excluded?'restoreSession':'excludeSession',sessionId:session.id});if(valid()){closeDialog('call-detail-dialog');notice(excluded?'기억에 다시 포함했어요.':'이 통화는 기억에서 제외했어요.');}}finally{toggle.disabled=false;}});
    management.body.append(toggle);
    if(analysis){const retry=document.createElement('button');retry.className='text-button';retry.textContent='학습 노트 다시 확인';retry.onclick=protect(()=>{if(valid())return onReview(true);});management.body.append(retry);}
    content.append(management.details);
  }
  openDialog('call-detail-dialog');
}
async function loadHistory(){
  if(!auth||!scope)return;
  const epoch=++historyEpoch,requestScope=scope,filter=historyFilter,reviewSelection=selectedReviewSessionId,selectedCompanion=companionId,reviewMode=$('review-panel').dataset.mode;
  const through=Date.now(),since=through-7*86400000;
  const sessions=await api('/rest/v1/sessions?select=*&user_id=eq.'+auth.user.id+(filter?'&companion_id=eq.'+filter:'')+'&order=created_at.desc&limit=30');
  const analyses=await api('/rest/v1/analyses?select=*&user_id=eq.'+auth.user.id+'&order=created_at.desc&limit=100');
  const weeklySessions=await api('/rest/v1/sessions?select=companion_id,status,ended_at&user_id=eq.'+auth.user.id+'&status=eq.ended&ended_at=gte.'+new Date(since).toISOString()+'&and=(ended_at.lte.'+new Date(through).toISOString()+')&order=ended_at.desc&limit=1000').catch(()=>[]);
  const sessionCompanions=[...new Set(sessions.map(session=>session.companion_id).filter(id=>Object.hasOwn(companions,id)))];
  if(sessions.length&&epoch===historyEpoch&&requestScope===scope)conversationMemory.wake(Object.keys(companions));
  const exclusions=new Set();
  await Promise.all(sessionCompanions.map(async id=>{try{const controls=await edge('memory-manage',{companionId:id,action:'list'});for(const row of controls.excluded_sessions||[])exclusions.add(row.session_id);}catch(error){if(scope===requestScope&&epoch===historyEpoch)notice(error.message);}}));
  if(epoch!==historyEpoch||requestScope!==scope||filter!==historyFilter)return;
  $('history').replaceChildren();
  $('history-scope').textContent=filter?companions[filter].name+'와 나눈 통화':'';
  weeklyCompanions=new Set(weeklySessions.filter(session=>Object.hasOwn(companions,session.companion_id)&&session.status==='ended'&&Date.parse(session.ended_at)>=since&&Date.parse(session.ended_at)<=through).map(session=>session.companion_id));renderWeeklyAction();
  const ownSessions=sessions.filter(session=>Object.hasOwn(companions,session.companion_id));
  $('memory-search').hidden=!ownSessions.length;$('history-tools').hidden=!ownSessions.length;
  if(reviewMode!=='weekly'&&$('review-panel').dataset.mode===reviewMode&&selectedReviewSessionId===reviewSelection&&companionId===selectedCompanion){
    const selectedSession=ownSessions.find(session=>session.id===selectedReviewSessionId)||ownSessions.find(session=>session.companion_id===companionId);
    selectedReviewSessionId=selectedSession?.id||null;
    if(selectedSession)selectTranscript(selectedSession);else transcriptReview.clear();
    $('review-content').replaceChildren();
    const selectedAnalysis=analyses.find(analysis=>analysis.session_id===selectedReviewSessionId&&analysis.kind==='session');
    if(selectedAnalysis)showAnalysis($('review-content'),{...selectedAnalysis,companion_id:selectedSession.companion_id});
    else {emptyReview(selectedSession?'아직 학습 노트가 없어요. 상태를 확인하거나 원할 때 학습 노트를 만들 수 있어요.':undefined);if(selectedSession){mountLearningSession(selectedSession.id);learning.selectSession(selectedSession);}}
  }
  await learning.load({sessions:ownSessions,analyses});
  if(epoch!==historyEpoch||requestScope!==scope)return;
  if(!ownSessions.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent=filter?companions[filter].name+'와 나눈 통화가 아직 없어요.':'아직 통화 기록이 없어요.';$('history').append(empty);return;}
  for(const session of ownSessions){
    const id=session.companion_id,name=companions[id].name;
    const entry=document.createElement('article');entry.className='history-entry';entry.dataset.sessionId=session.id;entry.dataset.companionId=id;
    let meta=sessionTimeLabel(session)+' · '+(session.status==='ended'?'종료':'미완료 통화');
    if(session.scenario&&session.scenario!==NATURAL_CONVERSATION)meta+=' · '+session.scenario;
    const row=document.createElement('div');row.className='history-row';
    const open=document.createElement('button');open.className='history-open';open.setAttribute('aria-label',name+'와의 통화 상세');
    const avatar=document.createElement('img');avatar.className='history-avatar';avatar.src=$('ai-art-'+id).dataset.src;avatar.alt='';avatar.loading='lazy';avatar.decoding='async';
    const copy=document.createElement('span');copy.className='history-copy';const title=document.createElement('strong');title.textContent=name;
    const date=document.createElement('small'),time=sessionTimeZone(session);date.textContent=formatInstant(session.created_at,time.zone)+' · '+time.zone+(time.saved?'':' 표시')+(session.status==='ended'?'':' · 미완료');copy.append(title,date);open.append(avatar,copy);
    const recall=document.createElement('button');recall.className='history-recall';recall.setAttribute('aria-label',name+'에게 다시 전화');recall.append(document.querySelector('[data-view="contacts"] img').cloneNode());
    recall.onclick=protect(async()=>{selectCompanion(id,{refresh:false});await startCall();});
    const analysis=analyses.find(row=>row.session_id===session.id&&row.kind==='session');
    const openReview=async regenerate=>{
      if(memoryBusy())throw Error('현재 통화를 종료한 뒤 사용하세요.');
      if(scope!==requestScope)return;
      selectCompanion(id,{refresh:false});selectedReviewSessionId=session.id;setReviewMode('session');closeDialog('call-detail-dialog');
      selectTranscript(session);
      transcriptReview.prioritizeFeedback();
      setView('review');const actionView=viewEpoch,actionScope=scope;
      const valid=()=>actionScope===scope&&actionView===viewEpoch&&selectedReviewSessionId===session.id&&companionId===id&&!memoryBusy();
      $('review-content').replaceChildren();
      if(analysis&&!regenerate){showAnalysis($('review-content'),{...analysis,companion_id:id});return;}
      emptyReview('저장된 통화와 학습 노트 상태를 확인하고 있어요…');
      await sync();if(!valid())return;
      if(session.status!=='ended'){mountLearningSession(session.id);learning.selectSession(session);return;}
      mountLearningSession(session.id);learning.selectSession(session);
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
function renderTelemetrySupport(){
  let details=$('account-connection-info');
  if(!details){details=document.createElement('details');details.id='account-connection-info';details.className='dialog-footnote';const summary=document.createElement('summary');summary.textContent='앱·연결 정보';details.append(summary);$('account-dialog').append(details);}
  details.querySelectorAll('p').forEach(node=>node.remove());
  const version=document.createElement('p');version.textContent='앱 버전: '+releaseMetadata.client_build;details.append(version);
  const latest=telemetryDiagnostics.list().at(-1);
  if(latest){const status=document.createElement('p');status.textContent='최근 통화 연결 기록: '+({created:'기기 저장 확인 전',device_persisted:'기기 보관 확인 · 서버 확인 대기',server_ack:'서버 수신 확인'})[latest.stage];const reference=document.createElement('p');reference.textContent='지원 참조: '+latest.eventId;details.append(status,reference);}
}
async function loadAuthProviders(){
  try{const {data}=await request('/auth/v1/settings');providers={google:data.external?.google===true,kakao:data.external?.kakao===true};}
  catch{providers={google:false,kakao:false};}
  providersLoaded=true;
  if(!providers.google&&!providers.kakao)$('email-login').open=true;
  renderAuthControls();
}
async function startSocialLogin(provider,link=false){
  if(!authSession||!loginReady||socialBusy||!providers[provider])return;
  if(memoryBusy())throw Error('통화를 마친 뒤 계정을 연결하세요.');
  socialBusy=true;renderAuthControls();notice('');
  try{const url=await authSession.begin(provider,{link});window.location.assign(url);}
  catch{socialBusy=false;renderAuthControls();notice('로그인 연결을 시작하지 못했어요. 잠시 뒤 다시 선택해 주세요.');}
}
function clearAuthAnimations(){
  authVisualEpoch++;for(const animation of authVisualAnimations)animation.cancel();authVisualAnimations=[];
}
function hideAuthTransition(){
  clearAuthAnimations();authTransitionLeaving=false;$('auth-transition').hidden=true;
}
function showAuthTransition(){
  const panel=$('auth-transition');if(!panel.hidden&&!authTransitionLeaving)return;
  clearAuthAnimations();authTransitionLeaving=false;$('setup').hidden=true;panel.hidden=false;
  if(!companionMotion.matches)authVisualAnimations=[panel.querySelector('.auth-transition-content').animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(.22,.68,.16,1)'})];
}
function revealWorkspace(){
  const panel=$('auth-transition'),workspace=$('workspace');
  clearAuthAnimations();$('setup').hidden=true;workspace.hidden=false;
  if(panel.hidden||companionMotion.matches){hideAuthTransition();return;}
  authTransitionLeaving=true;const epoch=authVisualEpoch;
  const options={duration:180,easing:'cubic-bezier(.22,.68,.16,1)',fill:'forwards'};
  authVisualAnimations=[panel.animate([{opacity:1},{opacity:0}],options),workspace.animate([{opacity:0},{opacity:1}],options)];
  Promise.allSettled(authVisualAnimations.map(animation=>animation.finished)).then(()=>{if(epoch===authVisualEpoch)hideAuthTransition();});
}
companionMotion.addEventListener('change',()=>{if(companionMotion.matches){if(authTransitionLeaving)hideAuthTransition();else clearAuthAnimations();}});
function resetSignedOutUI(){
  conversationMemory.clear();
  stopCompanionSlide();
  readyEpoch++;hideAuthTransition();
  learning.reset();auth=null;scope=null;historyEpoch++;memoryEpoch++;selectedReviewSessionId=null;
  transcriptReview.clear();
  weeklyCompanions.clear();weeklyRequest=null;renderWeeklyAction();
  closeDialog('memory-dialog');closeDialog('account-dialog');closeDialog('call-detail-dialog');
  for(const id of ['memory-facts','memory-exclusions','history','memory-results','transcript'])$(id).replaceChildren();
  emptyReview();$('setup').hidden=false;$('workspace').hidden=true;$('auth-reset').hidden=true;renderAuthControls();
}
async function ready(){
  if(!config){$('service-state').textContent='서비스 연결을 준비하고 있습니다. 설정이 완료되면 여기서 바로 시작할 수 있어요.';setStatus('서비스 준비 중');return;}
  const epoch=++readyEpoch;
  const session=await authSession.getSession();
  if(epoch!==readyEpoch)return;
  auth=session;
  $('service-state').hidden=true;$('social-login').hidden=false;$('email-login').hidden=false;
  $('login-form').hidden=false;
  $('login-help').hidden=false;$('use-code').hidden=false;
  if((providersLoaded&&!providers.google&&!providers.kakao)||!$('verify-form').hidden)$('email-login').open=true;
  renderAuthControls();
  if(!auth){hideAuthTransition();$('setup').hidden=false;setStatus('로그인하면 기록이 자동 저장됩니다');return;}
  scope=null;transcriptReview.clear();weeklyCompanions.clear();weeklyRequest=null;renderWeeklyAction();closeDialog('call-detail-dialog');
  if($('workspace').hidden)showAuthTransition();
  let user,data;
  try{[user,data]=await Promise.all([api('/auth/v1/user'),edge('config')]);}
  catch(error){
    if(epoch!==readyEpoch)return;
    hideAuthTransition();$('setup').hidden=false;$('auth-reset').hidden=false;
    if(error.code==='ACCOUNT_NOT_ALLOWED'){$('auth-reset').hidden=false;throw Error('승인된 이메일 계정만 이용할 수 있습니다. 이메일이 다른 계정은 기존 계정으로 로그인한 뒤 내 계정에서 연결하세요.');}
    throw error;
  }
  if(epoch!==readyEpoch)return;
  auth.user=user;
  scope=config.url+'|'+user.id;
  renderAuthControls();$('auth-reset').hidden=true;
  const savedCompanion=localStorage.getItem(companionStorageKey());companionId=Object.hasOwn(companions,savedCompanion)?savedCompanion:'alex';updateCompanion();setView('contacts');
  revealWorkspace();
  $('models').textContent=`음성 ${data.models.voice} · 교정 ${data.models.coach} · 분석 ${data.models.analysis}`;
  await updatePending();try{await sync();}catch(e){notice('미전송 기록이 있습니다: '+e.message);}
  await loadHistory();await loadMemory();await learning.load();await loadPlan();await updatePending();
}
mountEmailLogin({document,storage:localStorage,storageKey:'loop.email-login:'+(config?.url||'unconfigured'),request,notice,onAuthenticated:async data=>{auth=await authSession.adopt(data);notice('');await ready();}});
const logout=protect(async()=>{if(memoryBusy())throw Error('먼저 통화를 종료하세요.');try{await authSession.signOut();}finally{resetSignedOutUI();notice('로그아웃했습니다. 전송 대기 기록이 있다면 같은 계정으로 다시 로그인해 주세요.');}});
$('logout').onclick=logout;$('auth-reset').onclick=logout;
document.querySelectorAll('[data-oauth]').forEach(button=>button.onclick=protect(()=>startSocialLogin(button.dataset.oauth)));
document.querySelectorAll('[data-link-provider]').forEach(button=>button.onclick=protect(()=>startSocialLogin(button.dataset.linkProvider,true)));
$('view-ending-transcript').onclick=()=>{if(call?.ending)call.completion?.openReview();};
$('start-call').onclick=protect(startCall);$('end-call').onclick=protect(endCall);
$('speed-call').onclick=()=>{if(!call||call.ending)return;renderSpeedDraft(call.speed.state.desired);openDialog('speed-dialog');};
$('speed-form').onchange=()=>renderSpeedDraft(selectedSpeechSpeed());
$('speed-form').onsubmit=event=>{event.preventDefault();if(!call||call.ending||$('speed-apply').disabled)return;const value=selectedSpeechSpeed();if(!validSpeed(value))return;call.speed.request(value);closeDialog('speed-dialog');};
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
    selectedReviewSessionId=null;setReviewMode('weekly');$('review-content').replaceChildren();showAnalysis($('review-content'),{...result.analysis,companion_id:selected});
  }finally{if(weeklyRequest===request){weeklyRequest=null;renderWeeklyAction();}}
});
$('memory-search').onsubmit=protect(async e=>{e.preventDefault();if(memoryBusy())return;const selectedCompanion=companionId,epoch=memoryEpoch;const data=await edge('memory',{query:$('memory-query').value.trim(),companionId:selectedCompanion});if(selectedCompanion!==companionId||epoch!==memoryEpoch)return;$('memory-results').replaceChildren();if(!data.memories.length){$('memory-results').textContent='관련 학습 기록이 없습니다.';return;}for(const item of data.memories){const article=document.createElement('article');article.className='history-entry';const p=document.createElement('p');p.textContent=item.summary;const meta=document.createElement('small');meta.textContent=`${item.session_created_at?formatInstant(item.session_created_at,sessionTimeZone({time_zone:item.session_time_zone}).zone):'통화 시각 미확인'} · ${sessionTimeZone({time_zone:item.session_time_zone}).label} · 근거 ${(item.source_event_ids||[]).length}개`;article.append(p,meta);const button=document.createElement('button');button.className='text-button';button.textContent='근거 발화 보기';button.onclick=protect(async()=>{if(memoryBusy())return;const actionView=viewEpoch,actionScope=scope,ids=item.source_event_ids||[];if(!ids.length)return;const rows=await allRows('transcript_events',`id=in.(${ids.join(',')})&order=timestamp.asc,id.asc`);if(actionView!==viewEpoch||actionScope!==scope||epoch!==memoryEpoch||selectedCompanion!==companionId||!button.isConnected)return;const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=rows.filter(row=>row.session_id===item.session_id).map(row=>row.text).join('\n');button.replaceWith(pre);});article.append(button);$('memory-results').append(article);}if(data.limited)notice('관련 기록 일부는 통화 문맥 크기 제한으로 제외되었습니다. 더 구체적인 검색어를 사용하세요.');});
$('export').onclick=protect(async()=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 백업하세요.');const backupScope=scope;await saving;await sync();await learning.flush();const learningProgress=await learning.getBackup();const backup={schema_version:2,learning_progress:learningProgress,exported_at:new Date().toISOString(),sessions:await allRows('sessions','order=created_at.asc,id.asc'),events:await allRows('transcript_events','order=timestamp.asc,id.asc'),analyses:await allRows('analyses','order=created_at.asc,id.asc'),memory_controls:{state:await allRows('memory_state','order=companion_id.asc'),facts:await allRows('memory_fact_overrides','order=companion_id.asc,key.asc'),exclusions:await allRows('memory_session_exclusions','order=companion_id.asc,session_id.asc')}};if(scope!==backupScope||!auth)throw Error('백업 중 계정이 바뀌었어요. 같은 계정에서 다시 선택해 주세요.');const a=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));a.href=url;a.download='sisicolcol-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('restore').onchange=protect(async e=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 복원하세요.');const restoreScope=scope,restoreRpc=async(name,body)=>{if(scope!==restoreScope||!auth)throw Error('복원 중 계정이 바뀌었어요. 이전 배치는 보존되며 같은 계정에서 다시 시도할 수 있어요.');return rpc(name,body);};const file=e.target.files[0];if(!file)return;try{if(file.size>15_000_000)throw Error('복원 파일은 15MB 이하로 나눠 주세요.');const data=JSON.parse(await file.text());if(![1,2].includes(data.schema_version)||!Array.isArray(data.sessions)||!Array.isArray(data.events)||(data.schema_version===2&&!Array.isArray(data.learning_progress)))throw Error('지원하지 않는 백업 형식입니다.');const included=new Set(data.sessions.map(s=>s.id));if(data.events.some(event=>!included.has(event.session_id)))throw Error('세션에 연결되지 않은 발화가 포함된 백업입니다.');
if(data.schema_version===2&&data.learning_progress.some(item=>!included.has(item.source_session_id||item.restored_session_id)||(item.held_sources||[]).some(source=>!included.has(source.session_id))))throw Error('복습 출처 통화가 빠진 백업입니다.');
const controls=data.memory_controls??{state:[],facts:[],exclusions:[]};if(!controls||!Array.isArray(controls.state)||!Array.isArray(controls.facts)||!Array.isArray(controls.exclusions))throw Error('백업의 기억 설정 형식이 올바르지 않습니다.');
if([...controls.state,...controls.facts,...controls.exclusions].some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('백업의 기억 설정 형식이 올바르지 않습니다.');const sessionCompanions=new Map(data.sessions.map(session=>[session.id,session.companion_id]));for(const row of [...controls.state,...controls.facts])if(!companions[row.companion_id]||typeof row.companion_id!=='string')throw Error('백업에 알 수 없는 대화 상대의 기억이 있습니다.');for(const row of controls.facts)if(!memorySlots.some(([key])=>key===row.key)||typeof row.value!=='string'||row.value.length>240)throw Error('백업의 기억 사실 형식이 올바르지 않습니다.');for(const row of controls.exclusions)if(typeof row.session_id!=='string'||!companions[row.companion_id]||sessionCompanions.get(row.session_id)!==row.companion_id)throw Error('백업의 기억 제외 기록이 대화와 일치하지 않습니다.');
const activeByCompanion=new Map();for(const session of data.sessions)if(session.status!=='ended'){const group=activeByCompanion.get(session.companion_id)||[];group.push(session);activeByCompanion.set(session.companion_id,group);}for(const [companion,sessions] of activeByCompanion){const ids=new Set(sessions.map(session=>session.id));const count=data.events.filter(event=>ids.has(event.session_id)).length;if(sessions.length>20||count>1000)throw Error('미완료 통화가 많아 안전하게 복원할 수 없습니다. 백업에서 미완료 통화를 정리한 뒤 다시 시도하세요.');}
await sync();memoryEpoch++;practiceMemory=null;$('memory-results').replaceChildren();if($('memory-summary'))$('memory-summary').textContent='기억을 새로 확인하고 있어요…';if($('practice-preview-text'))$('practice-preview-text').textContent='기억을 새로 확인하고 있어요…';if($('practice-preview'))$('practice-preview').disabled=true;
const controlsFor=sessions=>({state:controls.state,facts:controls.facts,exclusions:controls.exclusions.filter(row=>sessions.some(session=>session.id===row.session_id))});
// Ended sessions go first; unfinished sessions for each companion stay in one final atomic batch with their controls.
const ended=data.sessions.filter(session=>session.status==='ended');for(let start=0;start<ended.length;start+=20){const sessions=ended.slice(start,start+20);const ids=new Set(sessions.map(session=>session.id));const events=data.events.filter(event=>ids.has(event.session_id));if(events.length>1000){for(const session of sessions){const own=events.filter(event=>event.session_id===session.id);for(let n=0;n<Math.max(own.length,1);n+=500)await restoreRpc('restore_history',{p_backup:{sessions:[session],events:own.slice(n,n+500),memory_controls:controlsFor([session])}});}}else await restoreRpc('restore_history',{p_backup:{sessions,events,memory_controls:controlsFor(sessions)}});}
for(const sessions of activeByCompanion.values()){const ids=new Set(sessions.map(session=>session.id));const events=data.events.filter(event=>ids.has(event.session_id));await restoreRpc('restore_history',{p_backup:{sessions,events,memory_controls:controlsFor(sessions)}});}
if(!data.sessions.length)await restoreRpc('restore_history',{p_backup:{sessions:[],events:[],memory_controls:controls}});
for(const session of data.sessions)if(session.record_incomplete===true)await restoreRpc('learning_finish_partial',{p_session_id:session.id});if(scope!==restoreScope||!auth)throw Error('복원 중 계정이 바뀌었어요. 같은 계정에서 다시 시도해 주세요.');if(data.schema_version===2)await learning.restoreBackup(data.learning_progress);notice('대화와 복습 이력을 복원했습니다. 학습 노트는 유효한 근거로 다시 생성하세요.');}finally{e.target.value='';if(scope&&auth)await Promise.allSettled([loadHistory(),loadMemory()]);}});
document.querySelectorAll('[data-cue]').forEach(button=>button.onclick=protect(async()=>{
  const current=call;
  if(!current||!current.voiceInstructions||current.ending||current.compacting||current.floor?.blocksResponse||current.responding||current.speaking||current.aiSpeaking||current.dc.readyState!=='open'||current.pc.connectionState!=='connected')return;
  current.responding=true;updateCallControls();
  try{current.dc.send(JSON.stringify({type:'response.create',response:{instructions:current.voiceInstructions+'\nFor this response only: '+button.dataset.cue}}));}catch(error){current.responding=false;updateCallControls();throw error;}
}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&call)updateCallClock(call);});
window.addEventListener('pageshow',event=>{if(call)updateCallClock(call);if(event.persisted){socialBusy=false;renderAuthControls();}});
window.addEventListener('online',()=>sync().catch(e=>notice(e.message)));
window.addEventListener('offline',()=>{cloudVerified=false;updatePending().catch(()=>{});});
window.addEventListener('beforeunload',e=>{if(call || callStarting || callEnding){e.preventDefault();e.returnValue='';}});
setInterval(()=>{if(auth)sync().catch(()=>{});},5000);
$('review-back').onclick=protect(()=>{if(!memoryBusy())openReviewHub();});
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=protect(async()=>{if(memoryBusy())return;const view=button.dataset.view;if(view==='history')historyFilter=null;if(view==='review')openReviewHub();else setView(view);if(view==='history')await loadHistory();if(view==='review')await learning.resume();}));
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
if($('account-open'))$('account-open').onclick=()=>{if(!memoryBusy()){renderTelemetrySupport();openDialog('account-dialog');}};
const openMemory=protect(async()=>{if(memoryBusy())return notice('통화를 마친 뒤 기억을 관리할 수 있어요.');closeDialog('account-dialog');openDialog('memory-dialog');$('memory-index-status').textContent='';$('memory-index-more').hidden=true;await loadMemoryControls();});
if($('memory-manage-open'))$('memory-manage-open').onclick=openMemory;if($('account-memory'))$('account-memory').onclick=openMemory;
if($('memory-index'))$('memory-index').onclick=protect(indexMemory);if($('memory-index-more'))$('memory-index-more').onclick=protect(indexMemory);
if($('practice-preview'))$('practice-preview').onclick=protect(()=>learning.openPreview());
if($('mute-call'))$('mute-call').onclick=()=>{const current=call;if(!current||!current.ready||current.ending||current.compacting||current.inputBlocked)return;current.muted=!current.muted;current.stream.getAudioTracks().forEach(track=>track.enabled=!current.muted);updateCallControls();};

updateCompanion();setView('contacts');
async function initializeLogin(){
  if(!config){await ready();return;}
  const providersLoading=loadAuthProviders();let callbackMessage='';
  if(new URL(location.href).searchParams.has('code'))showAuthTransition();
  try{const result=await authSession.completeRedirect();auth=result.session;if(result.linked)callbackMessage='계정을 연결했어요. 다음에는 연결한 계정으로 로그인할 수 있어요.';}
  catch(error){auth=await authSession.getSession().catch(()=>null);callbackMessage=error instanceof LoginFlowError?error.message:'로그인을 완료하지 못했어요. 다시 선택해 주세요.';}
  authSession.onChange((event,session)=>{
    const previousUser=auth?.user?.id;auth=session;
    if(event==='SIGNED_OUT'){
      if(memoryBusy()){call?.stream?.getTracks().forEach(track=>track.stop());call?.pc?.close();window.location.reload();return;}
      resetSignedOutUI();
    }else if(event==='SIGNED_IN'&&previousUser&&session?.user?.id!==previousUser&&!$('workspace').hidden)window.location.reload();
  });
  loginReady=true;await ready();if(callbackMessage)notice(callbackMessage);await providersLoading;
}
initializeLogin().catch(error=>{loginReady=true;hideAuthTransition();if($('workspace').hidden)$('setup').hidden=false;renderAuthControls();notice('연결 확인 필요: '+error.message);});

document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();if(auth)setView('contacts');});

window.addEventListener('pagehide',()=>callCues?.dispose());
