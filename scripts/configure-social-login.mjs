import {pathToFileURL} from 'node:url';
class SocialLoginSetupError extends Error {}

// Only the management API receives credentials. Never echo provider responses,
// configuration objects, client IDs, or secrets to the terminal or built app.
export async function configureSocialLogin(env,{prepare=false,enableConfigured=false,fromEnv=false}={},fetcher=fetch){
  const ref=env.SUPABASE_PROJECT_REF||'domkmxmwmihcfadophfg';
  if(!/^[a-z0-9]{20}$/.test(ref))throw new SocialLoginSetupError('Invalid project reference.');
  if(!env.SUPABASE_ACCESS_TOKEN)throw new SocialLoginSetupError('Supabase management authorization is required.');
  const siteUrl='https://chungchung234.github.io/English/';
  const endpoint=`https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers={Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'};
  async function call(method,body){
    const response=await fetcher(endpoint,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new SocialLoginSetupError(`Social login configuration ${method}: HTTP ${response.status}. Provider details withheld.`);
    try{return await response.json();}catch{throw new SocialLoginSetupError('Unexpected authentication configuration response. Provider details withheld.');}
  }
  const before=await call('GET'),patch={};
  if(prepare){
    const redirects=new Set(String(before.uri_allow_list||'').split(',').map(value=>value.trim()).filter(Boolean));
    redirects.add(siteUrl);
    patch.uri_allow_list=[...redirects].join(',');
    patch.security_manual_linking_enabled=true;
  }
  const fields={google:['GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET'],kakao:['KAKAO_REST_API_KEY','KAKAO_CLIENT_SECRET']};
  for(const [provider,[idName,secretName]] of Object.entries(fields)){
    if(fromEnv&&(env[idName]||env[secretName])){
      if(!env[idName]||!env[secretName])throw new SocialLoginSetupError(`${provider}: both credential fields are required; enter secrets through secure settings.`);
      patch[`external_${provider}_client_id`]=env[idName].trim();
      patch[`external_${provider}_secret`]=env[secretName].trim();
    }
    const configured=Boolean((patch[`external_${provider}_client_id`]||before[`external_${provider}_client_id`])&&(patch[`external_${provider}_secret`]||before[`external_${provider}_secret`]));
    if(enableConfigured&&configured){patch[`external_${provider}_enabled`]=true;patch[`external_${provider}_email_optional`]=false;}
  }
  let after=before;
  if(Object.keys(patch).length){
    await call('PATCH',patch);after=await call('GET');
    for(const [key,value] of Object.entries(patch))if(after[key]!==value)throw new SocialLoginSetupError('Social login configuration readback did not match. No credentials printed.');
    for(const key of Object.keys(before)){
      if(key in patch)continue;
      if(/^(smtp_|rate_limit_|sessions_|mailer_autoconfirm$)/.test(key)&&JSON.stringify(before[key])!==JSON.stringify(after[key]))throw new SocialLoginSetupError('An unrelated authentication setting changed during configuration.');
    }
  }
  const providers=Object.fromEntries(Object.keys(fields).map(provider=>[provider,{
    enabled:after[`external_${provider}_enabled`]===true,
    credentialsConfigured:Boolean(after[`external_${provider}_client_id`]&&after[`external_${provider}_secret`]),
  }]));
  return {siteUrl,callbackUrl:`https://${ref}.supabase.co/auth/v1/callback`,
    redirectPrepared:String(after.uri_allow_list||'').split(',').includes(siteUrl),
    accountLinkingEnabled:after.security_manual_linking_enabled===true,providers,actualProviderConsentAndLoginTested:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  configureSocialLogin(process.env,{prepare:process.argv.includes('--prepare'),enableConfigured:process.argv.includes('--enable-configured'),fromEnv:process.argv.includes('--configure-from-env')})
    .then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error instanceof SocialLoginSetupError?error.message:'Social login setup request failed. Provider details withheld.');process.exitCode=1;});
}
