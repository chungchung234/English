// Read-only operational checks. Never print configuration values or credentials.
const ref=process.env.SUPABASE_PROJECT_REF||'domkmxmwmihcfadophfg';
const token=process.env.SUPABASE_ACCESS_TOKEN;
if(!token)throw Error('Deployment authorization is required.');
async function get(path){const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/${path}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`Provider metadata check ${path}: HTTP ${r.status}`);return r.json();}
try{
 const auth=await get('config/auth');
 const smtp=Boolean(auth.smtp_host&&auth.smtp_user&&auth.smtp_admin_email);
 const confirmed=auth.mailer_autoconfirm===true;
 console.log(`::notice title=Email login configuration::Custom SMTP configured: ${smtp}; email confirmation bypass enabled: ${confirmed}.`);
 if(!smtp&&!confirmed)console.log('::warning title=Public email delivery::Custom SMTP is not configured. Verify delivery to users outside the project team before claiming public email login works.');
 try{
  const backup=await get('database/backups');
  const count=Array.isArray(backup.backups)?backup.backups.length:0;
  console.log(`::notice title=Database backup metadata::Retained backups: ${count}; PITR enabled: ${backup.pitr_enabled===true}. Restore has not been tested.`);
 }catch{console.log('::warning title=Database backup metadata::Backup metadata could not be verified with this token. Restore has not been tested.');}
}catch(error){console.error('::error title=Provider readiness::'+error.message);process.exitCode=1;}
