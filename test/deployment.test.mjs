import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {isolatedCoach} from '../scripts/isolated-coach-check.mjs';
import {build} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const coachModules=['authored-dialogue.ts','background.ts','character-viewpoints.ts','conversation-memory.ts','core.ts','dialogue-continuity.ts','enhancements.ts','index.ts','live-context.ts','opening-policy.ts','policy.ts','review-learning.ts','shared-exchanges.ts','temporal-context.ts','verified-speech.ts','weekly.ts'];
function buildSql(change='',file='202611090001_init.sql',version='202611090001'){
 const result=spawnSync('python3',['-c',`import importlib.util\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('deploy','scripts/deploy.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(m.migration_sql(Path('supabase/migrations/'+${JSON.stringify(file)}).read_text()+${JSON.stringify(change)},${JSON.stringify(version)}))`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return result.stdout;
}
test('HTTPS coach deployment includes each local TypeScript dependency',()=>{
 const code=`import importlib.util,json\nfrom pathlib import Path\nfrom email.parser import BytesParser\nfrom email import policy\ns=importlib.util.spec_from_file_location('deploy','scripts/deploy.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nclass Response:\n def __enter__(self):return self\n def __exit__(self,*args):pass\n def read(self,*args):return b'{"status":"ACTIVE"}'\ndef receive(request,timeout=None):\n envelope=('Content-Type: '+request.get_header('Content-type')+'\\r\\nMIME-Version: 1.0\\r\\n\\r\\n').encode()+request.data\n parts=list(BytesParser(policy=policy.default).parsebytes(envelope).iter_parts())\n files=[(part.get_filename(),part.get_payload(decode=True)) for part in parts if part.get_filename()]\n for name,source in files:\n  assert source==(Path('supabase/functions/coach')/name).read_bytes()\n metadata=[json.loads(part.get_payload(decode=True)) for part in parts if part.get_param('name',header='content-disposition')=='metadata']\n assert metadata==[{'name':'coach','entrypoint_path':'index.ts','verify_jwt':False}]\n print(json.dumps({'filenames':[name for name,_ in files]}))\n return Response()\nm.urllib.request.urlopen=receive\nm.deploy_function_https('domkmxmwmihcfadophfg','local-fixture-only')`;
 const result=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout).filenames.sort(),coachModules);
});
test('isolated coach packaging preserves exact module sources and adds only its fixed access gates',async()=>{
 const original=globalThis.fetch,token=process.env.SUPABASE_ACCESS_TOKEN;
 const user='11111111-1111-4111-8111-111111111111',added=`  if (!["${user}"].includes(user.id)) throw new AppError(403, 'TEST_ACCOUNT_ONLY', 'Test account required.');\n`;
 const publicMode="const mode=envValue('ACCESS_MODE')||'public'",testMode="const mode='public'";
 let uploads=0,approvals=0,removed=0;
 process.env.SUPABASE_ACCESS_TOKEN='local-fixture-only';
 globalThis.fetch=async(input,options)=>{
  const url=new URL(input);assert.equal(url.origin,'https://api.supabase.com');assert(url.pathname.startsWith('/v1/projects/aaaaaaaaaaaaaaaaaaaa/'));
  assert.equal(options.headers.Authorization,'Bearer local-fixture-only');
  if(url.pathname.endsWith('/functions/deploy')){
   uploads++;assert.equal(options.method,'POST');const files=options.body.getAll('file');assert.deepEqual(files.map(file=>file.name).sort(),coachModules);
   const metadata=JSON.parse(options.body.get('metadata'));assert.deepEqual(metadata,{name:url.searchParams.get('slug'),entrypoint_path:'index.ts',verify_jwt:false});
   for(const file of files){
    const originalBytes=await readFile('supabase/functions/coach/'+file.name),actualBytes=Buffer.from(await file.arrayBuffer());
    const originalSource=originalBytes.toString('utf8'),source=actualBytes.toString('utf8');
    if(file.name==='index.ts'){
     assert(originalSource.includes(publicMode));assert(!originalSource.includes(added));assert(source.includes(testMode));assert(source.includes(added));
     assert.equal(source.replace(testMode,publicMode).replace(added,''),originalSource,'the isolated entrypoint changes only the fixed test-account and access-mode gates');
    }else assert.deepEqual(actualBytes,originalBytes,file.name+' bytes must match the local module');
   }
   return new Response('{"status":"ACTIVE"}');
  }
  if(url.pathname.endsWith('/database/query')){
   approvals++;assert.equal(options.method,'POST');const {query}=JSON.parse(options.body);assert(query.includes("email like '%@example.invalid'"));assert(query.includes(user));return new Response('[]');
  }
  assert.equal(options.method,'DELETE');assert.match(url.pathname,/\/functions\/coach-check-[a-f0-9]{8}$/);removed++;return new Response('{}');
 };
 try{const check=await isolatedCoach('aaaaaaaaaaaaaaaaaaaa',[user]);await check.cleanup();assert.equal(uploads,1);assert.equal(approvals,2);assert.equal(removed,1);}
 finally{globalThis.fetch=original;if(token===undefined)delete process.env.SUPABASE_ACCESS_TOKEN;else process.env.SUPABASE_ACCESS_TOKEN=token;}
});
test('coach runtime bundle graph matches the upload and retains its pinned deferred reader dependency',async()=>{
 const result=await build({entryPoints:['supabase/functions/coach/index.ts'],bundle:true,write:false,metafile:true,platform:'neutral',format:'esm',target:'es2022',external:['npm:*'],logLevel:'silent'});
 const files=Object.keys(result.metafile.inputs).filter(name=>name.startsWith('supabase/functions/coach/')&&name.endsWith('.ts')).map(name=>name.split('/').at(-1)).sort();
 assert.deepEqual(files,coachModules,'every local runtime dependency must be included in the upload');
 const imports=Object.values(result.metafile.outputs).flatMap(output=>output.imports);
 assert(imports.some(item=>item.path==='npm:ws@8.18.3'&&item.external&&item.kind==='dynamic-import'),'the reader keeps its pinned lazy import visible to the deployment bundler');
});
test('HTTPS deploy payload is idempotent, refuses changed checksum, and blocks missing-token deployment',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 const sql=buildSql();await db.exec(sql);await db.exec(sql);
 assert.equal((await db.query('select count(*) from loop_private.migrations')).rows[0].count,1);
 await assert.rejects(db.exec(buildSql('\n-- changed')),/checksum differs/);
 await db.exec('rollback');
 assert.equal((await db.query('select count(*) from loop_private.migrations')).rows[0].count,1);
 const companionSql=buildSql('','202611090002_companions.sql','202611090002');await db.exec(companionSql);await db.exec(companionSql);
 assert.equal((await db.query('select count(*) from loop_private.migrations')).rows[0].count,2);
 assert.equal((await db.query("select column_default from information_schema.columns where table_name='sessions' and column_name='companion_id'")).rows.length,1);
 const allMigrations=readdirSync('supabase/migrations').filter(name=>name.endsWith('.sql')).sort();
 for(const file of allMigrations.slice(2)){const wrapped=buildSql('',file,file.split('_')[0]);await db.exec(wrapped);await db.exec(wrapped);}
 assert.equal((await db.query('select count(*) from loop_private.migrations')).rows[0].count,allMigrations.length);
 const verify=spawnSync('python3',['scripts/deploy.py'],{env:{...process.env,SUPABASE_PROJECT_REF:'domkmxmwmihcfadophfg',SUPABASE_ACCESS_TOKEN:''},encoding:'utf8'});
 assert.notEqual(verify.status,0);assert.match(verify.stderr,/missing/);assert.doesNotMatch(verify.stderr,/https:\/\//);
});
