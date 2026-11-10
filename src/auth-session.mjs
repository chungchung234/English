import { AuthClient } from '@supabase/auth-js';

export const socialProviders=['google','kakao'];
export class LoginFlowError extends Error {}
const cleanSession=session=>{
  if(!session)return null;
  const {provider_token,provider_refresh_token,...saved}=session;
  return saved;
};

// The official SDK owns PKCE, token rotation, cross-tab locking and refresh.
// App intent additionally binds each callback to the initiating tab and account.
export function createAuthSession(config, {
  storage=globalThis.localStorage, intentStorage=globalThis.sessionStorage,
  location=globalThis.location, history=globalThis.history, now=Date.now, client,
}={}) {
  const storageKey='loop.auth:'+config.url,intentKey='loop.oauth:'+config.url;
  const persistentStorage={
    getItem:key=>storage.getItem(key),
    setItem(key,value){
      if(key===storageKey)value=JSON.stringify(cleanSession(JSON.parse(value)));
      storage.setItem(key,value);
    },
    removeItem:key=>storage.removeItem(key),
  };
  client ||= new AuthClient({
    url:config.url+'/auth/v1',headers:{apikey:config.key},storageKey,
    storage:persistentStorage,persistSession:true,autoRefreshToken:true,
    flowType:'pkce',detectSessionInUrl:false,skipAutoInitialize:true,
  });
  const unwrap=result=>{if(result.error)throw result.error;return result.data;};
  const redirectUrl=()=>{
    const url=new URL(location.href);url.search='';url.hash='';return url.href;
  };
  function cleanCallbackUrl() {
    const url=new URL(location.href);
    for(const key of ['code','error','error_code','error_description','sb_flow_id'])url.searchParams.delete(key);
    if(/(?:access_token|refresh_token|error|provider_token)=/.test(url.hash))url.hash='';
    history.replaceState(history.state,'',url.pathname+url.search+url.hash);
  }
  async function getSession(){return cleanSession(unwrap(await client.getSession()).session);}
  async function completeRedirect() {
    const url=new URL(location.href),hash=new URLSearchParams(url.hash.slice(1));
    const code=url.searchParams.get('code');
    const error=url.searchParams.get('error')||url.searchParams.get('error_code')||hash.get('error')||hash.get('error_code');
    const implicit=hash.has('access_token')||hash.has('refresh_token');
    const initialized=await client.initialize();if(initialized.error)throw initialized.error;
    if(!code&&!error&&!implicit)return {handled:false,session:await getSession()};
    let intent;
    try{intent=JSON.parse(intentStorage.getItem(intentKey)||'null');}catch{/* no trusted intent */}
    cleanCallbackUrl();intentStorage.removeItem(intentKey);
    if(error)throw new LoginFlowError('로그인이 취소되었거나 연결을 완료하지 못했어요. 다시 선택해 주세요.');
    if(implicit||!intent||!socialProviders.includes(intent.provider)||!['signin','link'].includes(intent.action)||
      typeof intent.flowId!=='string'||!intent.flowId||intent.redirectTo!==redirectUrl()||
      !Number.isFinite(intent.createdAt)||now()-intent.createdAt>10*60*1000||intent.createdAt>now()+30000)
      throw new LoginFlowError('로그인 요청이 만료됐어요. 이 화면에서 다시 로그인을 시작하세요.');
    if(intent.action==='link'){
      const existing=await getSession();
      if(!existing?.user?.id||existing.user.id!==intent.userId)throw new LoginFlowError('계정이 바뀌어 연결을 멈췄어요. 기존 계정으로 다시 로그인하세요.');
    }
    const {session}=unwrap(await client.exchangeCodeForSession(code,{flowId:intent.flowId}));
    if(!session)throw new LoginFlowError('로그인을 완료하지 못했어요. 다시 시도하세요.');
    if(intent.action==='link'&&session.user.id!==intent.userId){
      await client.signOut({scope:'local'});
      throw new LoginFlowError('기존 계정과 연결된 정보를 확인하지 못했어요. 다시 로그인하세요.');
    }
    return {handled:true,linked:intent.action==='link',provider:intent.provider,session:cleanSession(session)};
  }
  async function begin(provider,{link=false}={}) {
    if(!socialProviders.includes(provider))throw new LoginFlowError('지원하지 않는 로그인 방식입니다.');
    const session=link?await getSession():null;
    if(link&&!session?.user?.id)throw new LoginFlowError('기존 계정으로 먼저 로그인하세요.');
    // Fail before navigation if same-tab callback state cannot be retained.
    intentStorage.setItem(intentKey,JSON.stringify({pending:true}));
    try{
      const options={redirectTo:redirectUrl(),skipBrowserRedirect:true};
      // Supabase's Kakao defaults also request photo/nickname consent. This app
      // only needs the verified email. Override the provider scope directly;
      // options.scopes would append to those defaults instead of replacing them.
      if(provider==='kakao')options.queryParams={scope:'account_email'};
      const result=link?await client.linkIdentity({provider,options}):await client.signInWithOAuth({provider,options});
      const data=unwrap(result);
      if(!data.url||!data.flowId)throw new LoginFlowError('로그인 연결을 준비하지 못했어요. 다시 시도하세요.');
      const target=new URL(data.url);
      const allowed=provider==='google'?['https://accounts.google.com']:['https://kauth.kakao.com'];
      if(target.origin!==new URL(config.url).origin&&(!link||!allowed.includes(target.origin)))throw new LoginFlowError('로그인 연결 주소를 확인하지 못했어요.');
      intentStorage.setItem(intentKey,JSON.stringify({provider,action:link?'link':'signin',userId:session?.user.id,
        createdAt:now(),redirectTo:options.redirectTo,flowId:data.flowId}));
      return data.url;
    }catch(error){intentStorage.removeItem(intentKey);throw error;}
  }
  return {
    client,storageKey,completeRedirect,begin,getSession,
    async adopt(session){return cleanSession(unwrap(await client.setSession(session)).session);},
    async accessToken(){
      let session=await getSession();
      if(!session)throw new LoginFlowError('로그인이 필요합니다.');
      if(session.expires_at*1000<=now()+60000)session=unwrap(await client.refreshSession()).session;
      if(!session?.access_token)throw new LoginFlowError('다시 로그인해 주세요.');
      return session.access_token;
    },
    async signOut(){intentStorage.removeItem(intentKey);unwrap(await client.signOut({scope:'local'}));},
    onChange(callback){return client.onAuthStateChange((event,session)=>callback(event,cleanSession(session)));},
  };
}
