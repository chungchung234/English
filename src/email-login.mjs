// UX guards only: Supabase enforces authentication and server-side limits.
// Never persist codes or credentials in this controller.
export function mountEmailLogin({document, storage, storageKey, request, onAuthenticated, notice}) {
  const el=id=>document.getElementById(id);
  const email=el('email'), send=el('send-code'), verify=el('verify-code');
  let sending=false, verifying=false, codeEmail='', state={};
  try { state=JSON.parse(storage.getItem(storageKey)||'{}')||{}; } catch { /* optional persistence */ }
  const normalized=()=>email.value.trim().toLowerCase();
  const seconds=until=>Math.max(0,Math.ceil(((Number(until)||0)-Date.now())/1000));
  const save=()=>{try{storage.setItem(storageKey,JSON.stringify(state));}catch{/* private browsing */}};
  const wait=()=>state.reason==='email-limit'||state.reason==='request-limit'||state.email===normalized()?seconds(state.until):0;
  function update() {
    const left=wait(), verifyLeft=seconds(state.verifyUntil);
    const duration=left>60?`${Math.ceil(left/60)}분`:`${left}초`;
    send.disabled=sending||verifying||left>0;
    send.textContent=sending?'발송 중…':left?`${duration} 후 다시 받기`:'코드 받기';
    verify.disabled=verifying||sending||verifyLeft>0;
    verify.textContent=verifying?'로그인 중…':verifyLeft?`${verifyLeft}초 후 로그인`:'로그인';
    email.readOnly=sending||verifying;
    el('use-code').disabled=sending||verifying;
    el('login-form').setAttribute('aria-busy',String(sending));
    el('verify-form').setAttribute('aria-busy',String(verifying));
    el('login-help').textContent=left
      ? state.reason==='email-limit'?'인증메일 발송 한도에 도달했어요. 기다리는 동안 이미 받은 코드를 입력할 수 있어요.'
        :state.reason==='request-limit'?'요청이 많아요. 표시된 시간이 지난 뒤 다시 시도해 주세요.'
        :state.reason==='unknown'?'발송 결과를 확인하지 못했어요. 먼저 메일함을 확인해 주세요.'
        :'메일함과 스팸함을 확인하세요. 재발송은 60초 뒤에 가능해요.'
      :'이미 받은 코드로도 로그인할 수 있어요.';
  }
  function cooldown(address, duration, reason) {
    state={...state,email:address,until:Date.now()+duration*1000,reason};save();update();
  }
  function showCode(address, focus=false) {
    if(codeEmail!==address)el('otp').value='';
    codeEmail=address;el('verify-form').hidden=false;
    if(focus)el('otp').focus();
  }
  function retrySeconds(error, fallback) {
    const value=error.retryAfter;
    if(value!==null&&value!==undefined&&String(value).trim()!=='') {
      const numeric=Number(value);
      if(Number.isFinite(numeric)&&numeric>=0)return Math.max(1,Math.ceil(numeric));
      const date=Date.parse(value);
      if(Number.isFinite(date))return Math.max(1,Math.ceil((date-Date.now())/1000));
    }
    return fallback;
  }
  function rateLimited(error) {return error.status===429||['over_email_send_rate_limit','over_request_rate_limit'].includes(error.code);}
  email.addEventListener('input',()=>{
    if(codeEmail&&codeEmail!==normalized()){codeEmail='';el('otp').value='';el('verify-form').hidden=true;}
    update();
  });
  el('use-code').onclick=()=>{if(email.reportValidity())showCode(normalized(),true);};
  el('login-form').onsubmit=async event=>{
    event.preventDefault();
    if(sending||verifying||wait()||!email.reportValidity())return;
    const address=normalized();sending=true;update();notice('');
    try {
      await request('/auth/v1/otp',{method:'POST',body:{email:address,create_user:true}});
      cooldown(address,60,'sent');showCode(address,true);
      notice('이메일로 받은 최신 인증 코드를 입력하세요.');
    } catch(error) {
      showCode(address);
      if(rateLimited(error)) {
        const interval=error.message?.match(/after (\d+) seconds?/i);
        const hourly=!interval&&(error.code==='over_email_send_rate_limit'||/email rate limit/i.test(error.message));
        cooldown(address,retrySeconds(error,interval?Number(interval[1]):hourly?3600:60),hourly?'email-limit':'request-limit');
        notice(hourly?'인증메일 발송 한도에 도달했어요. 이미 받은 코드로 로그인하거나, 대기시간이 지난 뒤 다시 요청하세요.':'요청이 많아 잠시 제한됐어요. 표시된 대기시간 뒤에 다시 시도하세요.');
      } else {
        cooldown(address,60,'unknown');
        notice(error.status>=500?'인증메일을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.':error.code==='email_address_invalid'?'이메일 주소를 확인해 주세요.':'메일 발송 결과를 확인하지 못했어요. 메일함을 확인한 뒤 다시 시도해 주세요.');
      }
    } finally {sending=false;update();}
  };
  el('verify-form').onsubmit=async event=>{
    event.preventDefault();
    if(verifying||sending||seconds(state.verifyUntil)||!email.reportValidity())return;
    const address=normalized(),token=el('otp').value.trim();
    if(address!==codeEmail){notice('이메일을 확인한 뒤 이미 받은 코드로 로그인을 선택하세요.');return;}
    if(!token)return;
    verifying=true;update();notice('');let authenticated=false;
    try {
      const {data}=await request('/auth/v1/verify',{method:'POST',body:{email:address,token,type:'email'}});
      authenticated=true;el('otp').value='';state={};save();await onAuthenticated(data);
    } catch(error) {
      if(authenticated)notice(error.message||'서비스 연결을 확인해 주세요.');
      else if(rateLimited(error)) {
        state.verifyUntil=Date.now()+retrySeconds(error,60)*1000;save();
        notice('코드 확인 요청이 많아 잠시 제한됐어요. 대기시간이 지난 뒤 다시 입력하세요.');
      } else if(['otp_expired','access_denied'].includes(error.code)||error.status===403) {
        notice('코드가 만료됐거나 올바르지 않아요. 가장 최근 메일의 코드를 확인하세요.');
      } else notice(error.status?'로그인을 완료하지 못했어요. 코드와 이메일을 확인해 주세요.':'연결을 확인한 뒤 다시 로그인해 주세요.');
    } finally {verifying=false;update();}
  };
  // Restore only the address/cooldown, never the code.
  if(typeof state.email==='string'&&seconds(state.until)){email.value=state.email;showCode(state.email);}
  update();
  const timer=setInterval(update,1000);
  const onStorage=event=>{if(event.key!==storageKey)return;try{state=JSON.parse(event.newValue||'{}')||{};}catch{state={};}update();};
  document.defaultView.addEventListener('storage',onStorage);
  return {destroy(){clearInterval(timer);document.defaultView.removeEventListener('storage',onStorage);}};
}
