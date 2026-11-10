import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthSession} from '../src/auth-session.mjs';

function fixture(){
 const memory=()=>{const items=new Map();return {getItem:key=>items.get(key)??null,setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};};
 const storage=memory(),intentStorage=memory(),location={href:'https://example.com/English/'};
 const history={state:null,replaceState(state,title,url){location.href=new URL(url,location.href).href;}};
 const session={access_token:'fixture',refresh_token:'refresh',expires_at:2000000000,user:{id:'existing-user'}};
 const calls={exchange:[],logout:0,refresh:0};
 const client={
  async initialize(){return {error:null};},async getSession(){return {data:{session},error:null};},
  async signInWithOAuth(input){calls.signin=input;return {data:{url:'https://auth-fixture.supabase.co/auth/v1/authorize?provider='+input.provider,flowId:'flow-fixture'},error:null};},
  async linkIdentity(input){calls.link=input;return {data:{url:input.provider==='kakao'?'https://kauth.kakao.com/oauth/authorize':'https://accounts.google.com/oauth',flowId:'flow-fixture'},error:null};},
  async exchangeCodeForSession(code,options){calls.exchange.push({code,options});return {data:{session},error:null};},
  async signOut(){calls.logout++;return {error:null};},
  async refreshSession(){calls.refresh++;return {data:{session:{...session,access_token:'renewed'}},error:null};},
 };
 const auth=createAuthSession({url:'https://auth-fixture.supabase.co',key:'sb_publishable_fixture'},{client,storage,intentStorage,location,history,now:()=>1700000000000});
 return {auth,storage,intentStorage,location,client,session,calls};
}

test('OAuth callbacks require the initiating tab intent and use its PKCE flow before any session is adopted',async()=>{
 const f=fixture();await f.auth.begin('google');
 assert.equal(f.calls.signin.options.skipBrowserRedirect,true);assert.equal(f.calls.signin.options.redirectTo,'https://example.com/English/');
 f.location.href+='?code=one-use-code';
 const result=await f.auth.completeRedirect();
 assert(result.handled);assert.equal(result.session.user.id,'existing-user');
 assert.deepEqual(f.calls.exchange,[{code:'one-use-code',options:{flowId:'flow-fixture'}}]);
 assert.equal(f.location.href,'https://example.com/English/');
 assert.equal(f.intentStorage.getItem('loop.oauth:https://auth-fixture.supabase.co'),null);
 f.location.href+='?code=replayed-code';await assert.rejects(f.auth.completeRedirect(),/만료/);assert.equal(f.calls.exchange.length,1);
});

test('unsolicited and implicit-token callbacks never exchange or replace a session and are scrubbed from the URL',async()=>{
 for(const suffix of ['?code=unrequested','#access_token=attacker-token&refresh_token=attacker-refresh']){
  const f=fixture();f.location.href+=suffix;await assert.rejects(f.auth.completeRedirect(),/만료/);
  assert.equal(f.calls.exchange.length,0);assert.equal(f.calls.logout,0);assert.equal(f.location.href,'https://example.com/English/');
 }
});

test('cancelled, expired and wrong-path login requests fail before exchanging a code',async()=>{
 const cancelled=fixture();await cancelled.auth.begin('kakao');cancelled.location.href+='?error=access_denied&error_description=untrusted-text';
 await assert.rejects(cancelled.auth.completeRedirect(),error=>error.message.includes('취소')&&!error.message.includes('untrusted-text'));
 assert.equal(cancelled.calls.exchange.length,0);assert(!cancelled.location.href.includes('error'));
 for(const change of ['expired','path']){
  const f=fixture();await f.auth.begin('google');
  if(change==='expired'){
   const key='loop.oauth:https://auth-fixture.supabase.co';const intent=JSON.parse(f.intentStorage.getItem(key));intent.createdAt-=11*60*1000;f.intentStorage.setItem(key,JSON.stringify(intent));
  }else f.location.href='https://example.com/other/';
  f.location.href+='?code=fixture';await assert.rejects(f.auth.completeRedirect(),/만료/);assert.equal(f.calls.exchange.length,0);
 }
});

test('linking requires the same existing account before and after consent, preserving the existing user id',async()=>{
 const good=fixture();await good.auth.begin('google',{link:true});good.location.href+='?code=linked';
 const result=await good.auth.completeRedirect();assert(result.linked);assert.equal(result.session.user.id,'existing-user');
 const changed=fixture();await changed.auth.begin('google',{link:true});changed.session.user.id='different-user';changed.location.href+='?code=linked';
 await assert.rejects(changed.auth.completeRedirect(),/계정이 바뀌어/);assert.equal(changed.calls.exchange.length,0);
 const wrong=fixture();await wrong.auth.begin('google',{link:true});wrong.client.exchangeCodeForSession=async()=>({data:{session:{...wrong.session,user:{id:'wrong-user'}}},error:null});wrong.location.href+='?code=wrong-account';
 await assert.rejects(wrong.auth.completeRedirect(),/기존 계정/);assert.equal(wrong.calls.logout,1);
});

test('unsupported providers and unexpected authorization hosts cannot initiate redirects',async()=>{
 const f=fixture();await assert.rejects(f.auth.begin('unknown'),/지원하지/);
 f.client.signInWithOAuth=async()=>({data:{url:'https://untrusted.example/steal',flowId:'fixture'},error:null});
 await assert.rejects(f.auth.begin('google'),/주소/);assert.equal(f.intentStorage.getItem('loop.oauth:https://auth-fixture.supabase.co'),null);
});

test('an expired access token is refreshed through the official client without requesting an email',async()=>{
 const f=fixture();f.session.expires_at=1600000000;
 assert.equal(await f.auth.accessToken(),'renewed');assert.equal(f.calls.refresh,1);assert.equal(f.calls.signin,undefined);
});

test('Kakao sign-in and linking request only email without adding default photo or nickname consent',async()=>{
 const f=fixture();await f.auth.begin('kakao');
 assert.deepEqual(f.calls.signin.options.queryParams,{scope:'account_email'});
 assert.equal(f.calls.signin.options.scopes,undefined);
 await f.auth.begin('kakao',{link:true});
 assert.deepEqual(f.calls.link.options.queryParams,{scope:'account_email'});
 await f.auth.begin('google');assert.equal(f.calls.signin.options.queryParams,undefined);
});
