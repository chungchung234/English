import test from 'node:test';
import assert from 'node:assert/strict';
import {configureSocialLogin} from '../scripts/configure-social-login.mjs';

test('social auth preparation preserves SMTP, limits, existing redirects and disabled unconfigured providers',async()=>{
 let config={uri_allow_list:'https://existing.example/app',security_manual_linking_enabled:false,external_google_enabled:false,external_kakao_enabled:false,smtp_pass:'private-smtp',rate_limit_email_sent:30,mailer_autoconfirm:false};
 let patched;
 const result=await configureSocialLogin({SUPABASE_ACCESS_TOKEN:'management-secret'},{prepare:true,enableConfigured:true},async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.supabase.com');
  if(options.method==='PATCH'){patched=JSON.parse(options.body);config={...config,...patched};}
  return Response.json(config);
 });
 assert.deepEqual(patched,{uri_allow_list:'https://existing.example/app,https://chungchung234.github.io/English/',security_manual_linking_enabled:true});
 assert(result.redirectPrepared&&result.accountLinkingEnabled);assert(!result.providers.google.enabled&&!result.providers.kakao.enabled);
 assert(!JSON.stringify(result).includes('private-smtp'));assert(!JSON.stringify(result).includes('management-secret'));
});

test('only configured Google and Kakao providers can be enabled, without publishing credentials',async()=>{
 let config={uri_allow_list:'',external_google_enabled:false,external_kakao_enabled:false};
 const env={SUPABASE_ACCESS_TOKEN:'management-secret',GOOGLE_OAUTH_CLIENT_ID:'private-client',GOOGLE_OAUTH_CLIENT_SECRET:'private-oauth'};
 const result=await configureSocialLogin(env,{fromEnv:true,enableConfigured:true},async(url,options)=>{
  if(options.method==='PATCH')config={...config,...JSON.parse(options.body)};
  return Response.json(config);
 });
 assert(result.providers.google.enabled&&result.providers.google.credentialsConfigured);assert(!result.providers.kakao.enabled);
 assert.equal(config.external_google_email_optional,false);
 assert(!JSON.stringify(result).includes('private-client'));assert(!JSON.stringify(result).includes('private-oauth'));
 await assert.rejects(configureSocialLogin({...env,GOOGLE_OAUTH_CLIENT_SECRET:''},{fromEnv:true},async()=>Response.json({})),/both credential fields/);
});

test('configuration errors never echo raw provider validation that may contain a secret',async()=>{
 await assert.rejects(configureSocialLogin({SUPABASE_ACCESS_TOKEN:'management-secret'},{},async()=>Response.json({message:'leaked-client-secret'},{status:400})),error=>error.message.includes('400')&&!error.message.includes('leaked-client-secret'));
 await assert.rejects(configureSocialLogin({SUPABASE_ACCESS_TOKEN:'management-secret'},{},async()=>new Response('leaked-client-secret')),error=>!error.message.includes('leaked-client-secret'));
});
