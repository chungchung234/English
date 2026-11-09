// Prepare email-code login without changing any SMTP account or password.
const ref=process.env.SUPABASE_PROJECT_REF||'domkmxmwmihcfadophfg';
const token=process.env.SUPABASE_ACCESS_TOKEN;
if(!token)throw Error('Provider authorization is required.');
const endpoint=`https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
const html='<div style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;padding:24px;max-width:440px"><h1 style="font-size:24px">Loop 로그인 코드</h1><p>영어 연습을 이어가려면 아래 코드를 로그인 화면에 입력해 주세요.</p><p style="font-size:32px;letter-spacing:6px;font-weight:700">{{ .Token }}</p><p>로그인을 요청하지 않으셨다면 이 메일을 무시하세요.</p></div>';
try{
 const response=await fetch(endpoint,{method:'PATCH',headers,body:JSON.stringify({site_url:'https://chungchung234.github.io/English/',mailer_subjects_magic_link:'[Loop] 로그인 인증코드',mailer_subjects_confirmation:'[Loop] 가입 인증코드',mailer_templates_magic_link_content:html,mailer_templates_confirmation_content:html}),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error(`Auth template update HTTP ${response.status}`);
 const check=await fetch(endpoint,{headers,signal:AbortSignal.timeout(30000)});
 if(!check.ok)throw Error(`Auth template verification HTTP ${check.status}`);
 const data=await check.json();
 if(!data.mailer_templates_magic_link_content?.includes('{{ .Token }}')||!data.mailer_templates_confirmation_content?.includes('{{ .Token }}'))throw Error('OTP code templates were not confirmed.');
 console.log('::notice title=Email login prepared::Login and signup emails now contain the code expected by the app. Existing SMTP credentials were not modified.');
}catch(error){console.error('::error title=Email template setup::'+error.message);process.exitCode=1;}
