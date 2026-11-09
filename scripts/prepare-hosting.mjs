import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatePublicConfig } from '../src/public-config.mjs';

// Resolve deployment configuration in CI. Only an anon/publishable key is
// returned. Provider management credentials never enter the built website.
export async function hostingConfig(env, request=fetch) {
  const ref=env.SUPABASE_PROJECT_REF||'domkmxmwmihcfadophfg';
  if(!/^[a-z0-9]{20}$/.test(ref))throw Error('Invalid Supabase project reference.');
  const url=env.PUBLIC_SUPABASE_URL||`https://${ref}.supabase.co`;
  let key=env.PUBLIC_SUPABASE_KEY||env.SUPABASE_ANON_KEY;
  if(!key&&env.SUPABASE_ACCESS_TOKEN){
    const response=await request(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,{headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Cannot resolve the public project key (HTTP ${response.status}).`);
    const rows=await response.json();
    if(!Array.isArray(rows))throw Error('Unexpected public key metadata.');
    for(const row of rows){
      if(row.type!=='publishable'&&row.name!=='anon')continue;
      try{key=validatePublicConfig(url,row.api_key).key;break;}catch{/* Ignore secret or malformed records. */}
    }
  }
  if(!key)throw Error('Deployment needs PUBLIC_SUPABASE_KEY or SUPABASE_ACCESS_TOKEN in repository Actions settings. No empty service will be published.');
  return validatePublicConfig(url,key);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const config=await hostingConfig(process.env);
    if(!process.env.GITHUB_ENV)throw Error('GITHUB_ENV output path is required.');
    await appendFile(process.env.GITHUB_ENV,`PUBLIC_SUPABASE_URL=${config.url}\nPUBLIC_SUPABASE_KEY=${config.key}\n`);
    console.log('Public site configuration resolved. No secret values printed.');
  }catch(error){
    if(process.env.GITHUB_ACTIONS==='true'){const message=error.message.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');console.error('::error title=Deployment configuration::'+message);}
    else console.error(error.message);
    process.exitCode=1;
  }
}
