// Same project secrets, temporary function accessible only to named test users.
// Never changes production access mode or copies the OpenAI key.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export async function isolatedCoach(ref,userIds) {
 const slug='coach-check-'+randomUUID().slice(0,8);
 const form=new FormData();form.set('metadata',JSON.stringify({name:slug,entrypoint_path:'index.ts',verify_jwt:false}));
 for(const name of ['index.ts','core.ts','policy.ts','enhancements.ts','weekly.ts','temporal-context.ts','conversation-memory.ts','background.ts','review-learning.ts']){
  let source=await readFile(new URL('../supabase/functions/coach/'+name,import.meta.url),'utf8');
  if(name==='index.ts'){
   source=source.replace("const mode=envValue('ACCESS_MODE')||'public'", "const mode='public'");
   source=source.replace('  return user.id;',`  if (!${JSON.stringify(userIds)}.includes(user.id)) throw new AppError(403, 'TEST_ACCOUNT_ONLY', 'Test account required.');\n  return user.id;`);
  }
  form.append('file',new Blob([source],{type:'application/typescript'}),name);
 }
 const url=`https://api.supabase.com/v1/projects/${ref}/functions`;
 const headers={Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`};
 const r=await fetch(url+'/deploy?slug='+slug,{method:'POST',headers,body:form,signal:AbortSignal.timeout(120000)});
 if(!r.ok)throw Error('Isolated function deploy HTTP '+r.status);
 async function approval(remove=false){
  if(!userIds.every(id=>/^[a-f0-9-]{36}$/.test(id)))throw Error('Invalid test user ID');
  const ids=userIds.map(id=>"'"+id+"'").join(',');
  const emails=`select lower(btrim(email)) from auth.users where id in (${ids}) and email like '%@example.invalid'`;
  const query=remove ? `delete from loop_private.approved_emails where email in (${emails})` : `insert into loop_private.approved_emails(email) ${emails} on conflict do nothing`;
  const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({query})});
  if(!r.ok)throw Error('Temporary account approval HTTP '+r.status);
 }
 try {await approval();} catch(error) {await fetch(url+'/'+slug,{method:'DELETE',headers});throw error;}
 return {slug,async cleanup(){await approval(true);const r=await fetch(url+'/'+slug,{method:'DELETE',headers});if(!r.ok)throw Error('Isolated function cleanup HTTP '+r.status);}};
}
