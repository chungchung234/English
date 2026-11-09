import { createOutbox, flushOutbox } from '../src/outbox.js';
import { validatePublicConfig } from '../src/public-config.mjs';
const $ = id => document.getElementById(id);
const outbox = createOutbox();
const config = globalThis.LOOP_PUBLIC_CONFIG ? validatePublicConfig(globalThis.LOOP_PUBLIC_CONFIG.url,globalThis.LOOP_PUBLIC_CONFIG.key) : null;
const authStorageKey='loop.auth:'+(config?.url||'unconfigured');
let auth = JSON.parse(localStorage.getItem(authStorageKey) || 'null');
let refreshPromise, flushing, call, scope, saving = Promise.resolve(), historyEpoch = 0, memoryEpoch = 0, cloudVerified = false;
const companions = {mia:{name:'Mia'},alex:{name:'Alex'},juno:{name:'Juno'}};
let companionId = 'alex', callStarting = false, callEnding = false, selectedReviewSessionId = null, practiceMemory = null;
const companionName = () => companions[companionId].name;
const companionStorageKey = () => 'loop.companion:' + config.url + '|' + auth.user.id;
function setView(view) {
  if(call || callStarting || callEnding) return;
  document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== view);
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    if(selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
}
function updateScenarioLabel() {
  const option = $('scenario').selectedOptions[0];
  if($('scenario-label')) $('scenario-label').textContent = option?.dataset.label || option?.textContent || '';
}
function updateCompanion() {
  if($('companion-name')) $('companion-name').textContent = companionName();
  if($('live-name')) $('live-name').textContent=companionName();
  if($('live-avatar')) $('live-avatar').src=document.querySelector('[data-companion="'+companionId+'"] img')?.src||'assets/companion-'+companionId+'.webp';
  if($('companion-avatar')) { $('companion-avatar').src = document.querySelector('[data-companion="'+companionId+'"] img')?.src || 'assets/companion-'+companionId+'.webp'; $('companion-avatar').alt = companionName(); }
  document.querySelectorAll('[data-companion]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.companion === companionId)));
  if(!call && !callStarting && !callEnding) $('call-status').textContent = companionName()+'와 대화할 준비가 되었어요';
}
function setCallLayout(active) {
  document.body.dataset.callState = active ? 'live' : '';
  if($('call-home')) $('call-home').hidden = active;
  if($('live-call')) $('live-call').hidden = !active;
  $('start-call').hidden = active;
  $('end-call').hidden = !active || callStarting;
  $('end-call').disabled = active && callStarting;
  $('scenario').disabled = active;
  $('orb').classList.toggle('live',active);
  if($('mute-call')) { $('mute-call').disabled = !active || callStarting; $('mute-call').setAttribute('aria-pressed','false'); $('mute-call').setAttribute('aria-label','마이크 끄기'); }
  document.querySelectorAll('[data-cue]').forEach(button => button.disabled = !active || !call);
}
function openDialog(id) { const dialog=$(id); if(dialog && !dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog=$(id); if(dialog?.open) dialog.close(); }
function emptyReview(message = '통화를 마치면 이곳에서 피드백을 확인할 수 있어요.') {
  if(!$('review-content')) return;
  const p=document.createElement('p');p.className='empty-state';p.textContent=message;$('review-content').replaceChildren(p);
}

const notice = message => { $('notice').textContent = message || ''; };
const protect = fn => async (...args) => { try { await fn(...args); } catch(e) { notice(e.message); } };
function setStatus(text) { $('save-status').textContent = text; }
async function request(path, {method='GET', body, token, headers={}}={}) {
  const response = await fetch(config.url + path, {method,headers:{apikey:config.key,...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
  const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data={message:text.slice(0,200)}; }
  if (!response.ok) throw Error(data.error?.message || data.msg || data.message || data.error_description || `요청 실패 (${response.status})`);
  return {data,response};
}
function saveAuth(data) {
  auth={...data, expires_at:data.expires_at || Math.floor(Date.now()/1000)+data.expires_in};
  localStorage.setItem(authStorageKey, JSON.stringify(auth));
}
async function accessToken() {
  if (!auth) throw Error('로그인이 필요합니다.');
  if (auth.expires_at*1000 > Date.now()+60000) return auth.access_token;
  if (!refreshPromise) refreshPromise=request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:auth.refresh_token}}).then(({data}) => {saveAuth(data);return auth.access_token;}).finally(()=>{refreshPromise=null;});
  return refreshPromise;
}
async function api(path, options={}) { const result=await request(path,{...options,token:await accessToken()});if(path.startsWith('/rest/v1/'))cloudVerified=true;return result.data; }
async function rpc(name, body) { return api('/rest/v1/rpc/'+name,{method:'POST',body}); }
async function edge(name, body) { return api('/functions/v1/coach/'+name,{method:body===undefined?'GET':'POST',body}); }
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
async function capture(event) {
  const current=call;
  if(!current)return;
  let speaker,text;
  if(event.type==='conversation.item.input_audio_transcription.completed') {speaker='user';text=event.transcript;current.transcribing.delete(event.item_id);}
  else if(event.type==='response.output_audio_transcript.done') {speaker='assistant';text=event.transcript;}
  else return;
  if(!text?.trim())return;
  const eventKey=`${speaker}:${event.item_id}:${event.content_index??0}`;
  if(current.seen.has(eventKey))return;
  const item={id:crypto.randomUUID(),event_key:eventKey,speaker,text:text.trim(),occurred_at:new Date().toISOString()};
  await outbox.put({id:item.id,scope,sessionId:current.id,event:item});
  current.seen.add(eventKey);
  renderTurn(item,true);await updatePending();
  sync().catch(e=>notice('클라우드 전송 대기: '+e.message));
}
async function startCall() {
  notice('');
  if(call || callStarting || callEnding)throw Error('진행 중인 통화를 먼저 종료하세요.');
  if(!isSecureContext || !navigator.mediaDevices?.getUserMedia)throw Error('마이크를 사용할 수 없습니다. 보안 연결(HTTPS)과 브라우저 마이크 권한을 확인하세요.');
  setView('call');callStarting=true;$('start-call').disabled=true;
  $('transcript').replaceChildren();$('turn-count').textContent='0개 발화';$('empty-transcript').hidden=false;setCallLayout(true);
  $('call-status').textContent=companionName()+'와 연결하고 있어요…';
  let stream;
  try {
    await sync();
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    const [session]=await api('/rest/v1/sessions',{method:'POST',headers:{Prefer:'return=representation'},body:{id:crypto.randomUUID(),user_id:auth.user.id,scenario:$('scenario').value,companion_id:companionId}});
    const pc=new RTCPeerConnection();
    call={id:session.id,pc,stream,seen:new Set(),transcribing:new Set(),transcriptionError:false,ending:false,speaking:false,awaitingCommit:false};
    $('transcript').replaceChildren();$('turn-count').textContent='0개 발화';$('empty-transcript').hidden=false;
    stream.getTracks().forEach(track=>pc.addTrack(track,stream));
    pc.ontrack=e=>{$('remote-audio').srcObject=e.streams[0];$('remote-audio').play().catch(()=>notice('음성 재생이 차단되었습니다. 화면을 누른 뒤 다시 시작해 주세요.'));};
    const dc=pc.createDataChannel('oai-events');call.dc=dc;
    dc.onmessage=e=>{
      let event;try{event=JSON.parse(e.data);}catch{return;}
      if(!call)return;
      if(event.type==='input_audio_buffer.speech_started')call.speaking=true;
      if(event.type==='input_audio_buffer.speech_stopped')call.speaking=false;
      if(event.type==='input_audio_buffer.committed'){call.awaitingCommit=false;call.transcribing.add(event.item_id);}
      if(event.type==='conversation.item.input_audio_transcription.failed'){call.transcriptionError=true;call.transcribing.delete(event.item_id);notice('일부 발화의 전사에 실패했습니다. 해당 발화는 기록되지 않았습니다.');}
      if(event.type==='error'&&event.error?.code!=='response_cancel_not_active'){call.transcriptionError=true;notice('음성 연결 오류: '+(event.error?.message||'알 수 없는 오류'));}
      saving=saving.then(()=>capture(event)).catch(error=>{if(call)call.transcriptionError=true;notice('저장 실패: '+error.message);setStatus('저장 실패 · 통화를 중단하고 확인하세요');if(call)call.stream.getTracks().forEach(t=>t.enabled=false);});
    };
    dc.onopen=()=>{if(!call?.ending)dc.send(JSON.stringify({type:'response.create',response:{instructions:'Begin the roleplay now with a short friendly greeting and one question. Do not narrate setup.'}}));};
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='connected')$('call-status').textContent=companionName()+'와 통화 중 · 편하게 말씀하세요';
      if(['failed','disconnected'].includes(pc.connectionState)){notice('음성 연결이 끊겼습니다. 수신된 기록은 저장됩니다. 통화를 종료한 뒤 다시 시작하세요.');$('call-status').textContent='음성 연결 끊김';}
    };
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    $('call-status').textContent='음성 연결 중…';
    const answer=await edge('voice',{sessionId:session.id,sdp:offer.sdp});
    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
    setCallLayout(true);
    document.querySelectorAll('[data-cue]').forEach(b=>b.disabled=false);
  } catch(e) {stream?.getTracks().forEach(t=>t.stop());call?.pc.close();call=null;setCallLayout(false);$('call-status').textContent='연결하지 못했어요. 다시 시도해 주세요.';throw e;}
  finally {callStarting=false;$('start-call').disabled=false;if(call){$('end-call').hidden=false;$('end-call').disabled=false;if($('mute-call'))$('mute-call').disabled=false;}}
}
async function endCall() {
  if(!call || call.ending)return;
  const current=call;current.ending=true;callEnding=true;$('end-call').disabled=true;
  try {
    current.stream.getTracks().forEach(t=>t.stop());
    $('call-status').textContent='마지막 발화의 전사와 저장을 확인하는 중…';
    if(current.dc.readyState==='open') {
      current.dc.send(JSON.stringify({type:'session.update',session:{type:'realtime',audio:{input:{turn_detection:{type:'server_vad',create_response:false}}}}}));
      if(current.speaking){current.awaitingCommit=true;current.dc.send(JSON.stringify({type:'input_audio_buffer.commit'}));}
      current.dc.send(JSON.stringify({type:'response.cancel'}));
      // VAD must finish before tearing down the connection. Track pending transcription IDs.
      await new Promise(resolve=>setTimeout(resolve,1800));
      const until=Date.now()+8000;
      while((current.transcribing.size||current.awaitingCommit) && Date.now()<until)await new Promise(resolve=>setTimeout(resolve,150));
    }
    await saving;
    if(current.transcribing.size || current.awaitingCommit || current.transcriptionError)throw Error('전사하지 못한 발화가 있습니다. 완료된 것으로 표시하지 않습니다. 수신된 기록은 저장되며, 새로고침 후 기록에서 통화를 정리할 수 있습니다.');
    await sync();
    await rpc('finish_session',{p_session_id:current.id});
    current.pc.close();call=null;
    $('call-status').textContent='통화 저장 완료 · 피드백을 만들고 있습니다';
    try {await edge('review',{sessionId:current.id});$('call-status').textContent='통화와 피드백 저장 완료';} catch(e) {notice('대화는 저장됐습니다. 피드백 재시도가 필요합니다: '+e.message);$('call-status').textContent='통화 저장 완료 · 피드백 미완료';}
    selectedReviewSessionId=current.id;await loadHistory();await loadMemory();setCallLayout(false);callEnding=false;setView('review');
  } catch(e) {
    current.pc.close();call=null;$('call-status').textContent='통화 중단 · 전사 또는 저장 미완료';
    loadHistory().catch(()=>{});throw e;
  } finally {
    callEnding=false;$('end-call').disabled=false;
    if(!call)setCallLayout(false);
  }
}
function formatDate(value){return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value));}
function showAnalysis(target,analysis){
  const div=document.createElement('div');div.className='analysis';
  const title=document.createElement('h3');title.textContent=analysis.kind==='weekly'?'최근 7일 분석':'통화 피드백';div.append(title);
  const content=analysis.content;
  const paragraph=text=>{const p=document.createElement('p');p.textContent=text;return p;};
  const evidence=(container,ids)=>{if(!ids?.length)return;const button=document.createElement('button');button.className='text-button';button.textContent='근거 발화';button.onclick=protect(async()=>{const rows=await allRows('transcript_events',`id=in.(${ids.join(',')})&order=timestamp.asc,id.asc`);const quotes=document.createElement('blockquote');quotes.textContent=rows.filter(r=>r.speaker==='user').map(r=>r.text).join(' / ');button.replaceWith(quotes);});container.append(button);};
  div.append(paragraph(content.summary));
  if(content.scope){const scope=document.createElement('small');scope.textContent=`분석 범위: ${content.scope.session_count}회 통화 · ${content.scope.user_event_count}개 사용자 발화`;div.append(scope);}
  for(const [key,label] of [['strengths','잘한 점'],['corrections','더 자연스럽게 말하기'],['practice','다음에도 써볼 표현'],['patterns','반복해서 확인된 패턴']]){
    if(!content[key]?.length)continue;
    const h=document.createElement('h4');h.textContent=label;div.append(h);
    for(const item of content[key]){
      const section=document.createElement('div');section.className='feedback-item';
      if(key==='corrections'){
        const original=paragraph(item.original);original.className='original';
        const improved=paragraph(item.improved);improved.className='improved';
        section.append(original,improved,paragraph(item.reason));
      }else section.append(paragraph(item.text||item.expression));
      evidence(section,item.evidence_ids);div.append(section);
    }
  }
  if(content.next_scenario){const h=document.createElement('h4');h.textContent='다음 연습';div.append(h,paragraph(content.next_scenario));const button=document.createElement('button');button.className='secondary';button.textContent='이 상황으로 다음 통화';button.onclick=()=>{if(call || callStarting || callEnding){notice('현재 통화를 마친 뒤 선택하세요.');return;}const option=document.createElement('option');option.value=content.next_scenario;option.textContent=content.next_scenario;$('scenario').append(option);$('scenario').value=option.value;updateScenarioLabel();setView('call');};div.append(button);}
  target.append(div);
}
async function loadHistory(){
  const epoch=++historyEpoch, selectedCompanion=companionId;
  const sessions=await api('/rest/v1/sessions?select=*&companion_id=eq.'+selectedCompanion+'&order=created_at.desc&limit=30');
  const analyses=await api('/rest/v1/analyses?select=*&order=created_at.desc&limit=100');
  if(epoch!==historyEpoch || selectedCompanion!==companionId)return;
  $('history').replaceChildren();
  const selectedSession=sessions.find(session=>session.id===selectedReviewSessionId)||sessions[0];
  selectedReviewSessionId=selectedSession?.id||null;
  if($('review-content')) {
    $('review-content').replaceChildren();
    const selectedAnalysis=analyses.find(analysis=>analysis.session_id===selectedReviewSessionId&&analysis.kind==='session');
    if(selectedAnalysis)showAnalysis($('review-content'),selectedAnalysis);
    else emptyReview(selectedSession ? '아직 피드백이 없어요. 기록에서 피드백을 만들거나 다시 시도해 주세요.' : undefined);
  }
  if(!sessions.length){$('history').textContent=companionName()+'와 나눈 대화가 아직 없어요.';return;}
  for(const session of sessions){
    const entry=document.createElement('article');entry.className='history-entry';
    const title=document.createElement('h3');title.textContent=Array.from($('scenario').options).find(option=>option.value===session.scenario)?.dataset.label||session.scenario;
    const meta=document.createElement('small');meta.textContent=`${formatDate(session.created_at)} · ${session.status==='ended'?'종료':'미완료 통화'}`;
    const actions=document.createElement('div');actions.className='history-actions';
    const details=document.createElement('button');details.className='text-button';details.textContent='대화문 보기';
    details.onclick=protect(async()=>{const rows=await allRows('transcript_events',`session_id=eq.${session.id}&order=timestamp.asc,id.asc`);if(companionId!==selectedCompanion)return;const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=rows.map(e=>`${e.speaker==='user'?'나':companions[selectedCompanion].name}: ${e.text}`).join('\n\n')||'저장된 발화가 없습니다.';details.replaceWith(pre);});
    const analysis=analyses.find(a=>a.session_id===session.id&&a.kind==='session');
    const review=document.createElement('button');review.className='text-button';review.textContent=analysis?'피드백 보기':session.status==='ended'?'피드백 만들기':'수신된 기록으로 종료';
    review.onclick=protect(async()=>{
      if(call || callStarting || callEnding)throw Error('현재 통화를 종료한 뒤 사용하세요.');
      selectedReviewSessionId=session.id;
      if(analysis){if($('review-content')){$('review-content').replaceChildren();showAnalysis($('review-content'),analysis);}setView('review');return;}
      review.disabled=true;
      try{await sync();if(session.status!=='ended')await rpc('finish_session',{p_session_id:session.id});await edge('review',{sessionId:session.id});await loadHistory();await loadMemory();setView('review');}finally{review.disabled=false;}
    });
    actions.append(details,review);
    if(analysis){const retry=document.createElement('button');retry.className='text-button';retry.textContent='피드백 다시 확인';retry.onclick=protect(async()=>{if(call || callStarting || callEnding)throw Error('현재 통화를 종료한 뒤 사용하세요.');retry.disabled=true;try{selectedReviewSessionId=session.id;await sync();await edge('review',{sessionId:session.id});await loadHistory();await loadMemory();setView('review');}finally{retry.disabled=false;}});actions.append(retry);}
    entry.append(title,meta,actions);$('history').append(entry);
  }
  const weekly=analyses.find(a=>a.kind==='weekly'&&(a.content?.scope?.companionId===selectedCompanion));
  if(weekly)showAnalysis($('history'),weekly);
  if(sessions.length===30){const p=document.createElement('p');p.className='help';p.textContent='최근 30회 표시 중입니다. 전체 기록은 백업 파일에서 확인할 수 있습니다.';$('history').append(p);}
}
async function loadMemory(){
  const epoch=++memoryEpoch, selectedCompanion=companionId;
  const data=await edge('memory',{companionId:selectedCompanion});
  if(epoch!==memoryEpoch || selectedCompanion!==companionId)return;
  if($('memory-summary'))$('memory-summary').textContent=data.memories.length?`지난 대화에서 이어가기 · ${data.memories[0].summary}`:'첫 통화부터 나의 학습 기록을 쌓아 보세요.';
  practiceMemory=data.memories.find(memory=>memory.practice?.some(item=>typeof item.expression==='string'&&item.expression.trim()))||null;
  const expression=practiceMemory?.practice.find(item=>typeof item.expression==='string'&&item.expression.trim())?.expression;
  if($('practice-preview-text'))$('practice-preview-text').textContent=expression||'아직 표현이 없어요.';
  if($('practice-preview'))$('practice-preview').disabled=!expression;
}
async function ready(){
  if(!config){$('service-state').textContent='서비스 연결을 준비하고 있습니다. 설정이 완료되면 여기서 바로 시작할 수 있어요.';setStatus('서비스 준비 중');return;}
  $('service-state').textContent='기록을 이어갈 이메일을 입력해 주세요.';
  $('login-form').hidden=false;
  if(!auth){setStatus('로그인하면 기록이 자동 저장됩니다');return;}
  const user=await api('/auth/v1/user');auth.user=user;localStorage.setItem(authStorageKey,JSON.stringify(auth));scope=config.url+'|'+user.id;
  const savedCompanion=localStorage.getItem(companionStorageKey());companionId=Object.hasOwn(companions,savedCompanion)?savedCompanion:'alex';updateCompanion();updateScenarioLabel();setView('call');
  $('setup').hidden=true;$('workspace').hidden=false;$('companion-open').hidden=false;
  await updatePending();try{await sync();}catch(e){notice('미전송 기록이 있습니다: '+e.message);}
  await loadHistory();await loadMemory();await updatePending();
  const data=await edge('config');$('models').textContent=`음성 ${data.models.voice} · 교정 ${data.models.coach} · 분석 ${data.models.analysis}`;
}
$('login-form').onsubmit=protect(async e=>{e.preventDefault();await request('/auth/v1/otp',{method:'POST',body:{email:$('email').value.trim(),create_user:true}});$('verify-form').hidden=false;notice('이메일로 받은 인증 코드를 입력하세요.');});
$('verify-form').onsubmit=protect(async e=>{e.preventDefault();const {data}=await request('/auth/v1/verify',{method:'POST',body:{email:$('email').value.trim(),token:$('otp').value.trim(),type:'email'}});saveAuth(data);notice('');await ready();});
$('logout').onclick=protect(async()=>{if(call || callStarting || callEnding)throw Error('먼저 통화를 종료하세요.');try{await api('/auth/v1/logout',{method:'POST'});}finally{localStorage.removeItem(authStorageKey);auth=null;scope=null;historyEpoch++;memoryEpoch++;selectedReviewSessionId=null;closeDialog('account-dialog');$('setup').hidden=false;$('workspace').hidden=true;$('companion-open').hidden=true;notice('로그아웃했습니다. 전송 대기 기록이 있다면 같은 계정으로 다시 로그인해 주세요.');}});
$('start-call').onclick=protect(startCall);$('end-call').onclick=protect(endCall);
$('refresh-history').onclick=protect(async()=>{await sync();await loadHistory();await loadMemory();});
$('weekly').onclick=protect(async()=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 분석하세요.');await sync();$('weekly').disabled=true;try{await edge('weekly',{companionId});await loadHistory();}finally{$('weekly').disabled=false;}});
$('memory-search').onsubmit=protect(async e=>{e.preventDefault();const selectedCompanion=companionId;const data=await edge('memory',{query:$('memory-query').value.trim(),companionId:selectedCompanion});if(selectedCompanion!==companionId)return;$('memory-results').replaceChildren();if(!data.memories.length){$('memory-results').textContent='관련 학습 기록이 없습니다.';return;}for(const item of data.memories){const article=document.createElement('article');article.className='history-entry';const p=document.createElement('p');p.textContent=item.summary;const meta=document.createElement('small');meta.textContent=`${formatDate(item.created_at)} · 근거 ${(item.source_event_ids||[]).length}개`;article.append(p,meta);const button=document.createElement('button');button.className='text-button';button.textContent='근거 발화 보기';button.onclick=protect(async()=>{const ids=item.source_event_ids||[];if(!ids.length)return;const rows=await allRows('transcript_events',`id=in.(${ids.join(',')})&order=timestamp.asc,id.asc`);const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=rows.map(r=>r.text).join('\n');button.replaceWith(pre);});article.append(button);$('memory-results').append(article);}if(data.limited)notice('관련 기록 일부는 통화 문맥 크기 제한으로 제외되었습니다. 더 구체적인 검색어를 사용하세요.');});
$('export').onclick=protect(async()=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 백업하세요.');await saving;await sync();const backup={schema_version:1,exported_at:new Date().toISOString(),sessions:await allRows('sessions','order=created_at.asc,id.asc'),events:await allRows('transcript_events','order=timestamp.asc,id.asc'),analyses:await allRows('analyses','order=created_at.asc,id.asc')};const a=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));a.href=url;a.download='sisicolcol-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('restore').onchange=protect(async e=>{if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 복원하세요.');const file=e.target.files[0];if(!file)return;try{if(file.size>15_000_000)throw Error('복원 파일은 15MB 이하로 나눠 주세요.');const data=JSON.parse(await file.text());if(data.schema_version!==1||!Array.isArray(data.sessions)||!Array.isArray(data.events))throw Error('지원하지 않는 백업 형식입니다.');const included=new Set(data.sessions.map(s=>s.id));if(data.events.some(e=>!included.has(e.session_id)))throw Error('세션에 연결되지 않은 발화가 포함된 백업입니다.');await sync();
// Batches are individually atomic and safely repeatable; earlier batches remain on later failure.
for(let start=0;start<data.sessions.length;start+=20){const sessions=data.sessions.slice(start,start+20);const ids=new Set(sessions.map(s=>s.id));const events=data.events.filter(e=>ids.has(e.session_id));if(events.length>1000){for(const session of sessions){const own=events.filter(e=>e.session_id===session.id);for(let n=0;n<Math.max(own.length,1);n+=500)await rpc('restore_history',{p_backup:{sessions:[session],events:own.slice(n,n+500)}});}}else await rpc('restore_history',{p_backup:{sessions,events}});}
notice('대화 기록을 복원했습니다. 과거 분석은 신뢰할 수 있는 근거로 다시 생성하세요.');await loadHistory();await loadMemory();}finally{e.target.value='';}});
document.querySelectorAll('[data-cue]').forEach(b=>b.onclick=protect(async()=>{if(call?.dc.readyState!=='open')return;call.dc.send(JSON.stringify({type:'response.create',response:{instructions:b.dataset.cue}}));}));
window.addEventListener('online',()=>sync().catch(e=>notice(e.message)));
window.addEventListener('offline',()=>{cloudVerified=false;updatePending().catch(()=>{});});
window.addEventListener('beforeunload',e=>{if(call || callStarting || callEnding){e.preventDefault();e.returnValue='';}});
setInterval(()=>{if(auth)sync().catch(()=>{});},5000);
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>setView(button.dataset.view));
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeDialog(button.dataset.close));
if($('topic-open'))$('topic-open').onclick=()=>{if(!call && !callStarting && !callEnding)openDialog('topic-dialog');};
if($('topic-done'))$('topic-done').onclick=()=>{updateScenarioLabel();closeDialog('topic-dialog');};
$('scenario').addEventListener('change',updateScenarioLabel);
if($('companion-open'))$('companion-open').onclick=()=>{if(call || callStarting || callEnding){notice('통화를 마친 뒤 대화 상대를 바꿀 수 있어요.');return;}openDialog('companion-dialog');};
document.querySelectorAll('[data-companion]').forEach(button=>button.onclick=protect(async()=>{
  if(call || callStarting || callEnding)throw Error('통화를 마친 뒤 대화 상대를 바꿀 수 있어요.');
  const next=button.dataset.companion;if(!Object.hasOwn(companions,next))return;
  closeDialog('companion-dialog');if(next===companionId)return;
  companionId=next;practiceMemory=null;localStorage.setItem(companionStorageKey(),companionId);selectedReviewSessionId=null;
  updateCompanion();$('history').replaceChildren();$('memory-results').replaceChildren();$('memory-query').value='';emptyReview();
  if($('practice-preview-text'))$('practice-preview-text').textContent='지난 대화에서 표현을 찾고 있어요…';
  if($('practice-preview'))$('practice-preview').disabled=true;
  await loadHistory();await loadMemory();
}));
document.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>{if(call || callStarting || callEnding)return;openDialog(button.dataset.open);});
if($('account-open'))$('account-open').onclick=()=>openDialog('account-dialog');
if($('practice-preview'))$('practice-preview').onclick=()=>{
  if(call || callStarting || callEnding || !practiceMemory || !$('review-content'))return;
  selectedReviewSessionId=practiceMemory.session_id;
  $('review-content').replaceChildren();
  showAnalysis($('review-content'),{kind:'session',content:{summary:practiceMemory.summary,corrections:practiceMemory.corrections,practice:practiceMemory.practice}});
  setView('review');
};
if($('mute-call'))$('mute-call').onclick=()=>{if(!call || call.ending)return;const muted=$('mute-call').getAttribute('aria-pressed')!=='true';call.stream.getAudioTracks().forEach(track=>track.enabled=!muted);$('mute-call').setAttribute('aria-pressed',String(muted));$('mute-call').setAttribute('aria-label',muted?'마이크 켜기':'마이크 끄기');};
updateCompanion();updateScenarioLabel();setView('call');
ready().catch(e=>notice('연결 확인 필요: '+e.message));

document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();if(auth)setView('call');});
