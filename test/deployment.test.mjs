import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
function buildSql(change='',file='202611090001_init.sql',version='202611090001'){
 const result=spawnSync('python3',['-c',`import importlib.util\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('deploy','scripts/deploy.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(m.migration_sql(Path('supabase/migrations/'+${JSON.stringify(file)}).read_text()+${JSON.stringify(change)},${JSON.stringify(version)}))`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return result.stdout;
}
test('HTTPS coach deployment includes each local TypeScript dependency',()=>{
 const code=`import importlib.util,json,re\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('deploy','scripts/deploy.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nclass Response:\n def __enter__(self):return self\n def __exit__(self,*args):pass\n def read(self,*args):return b'{"status":"ACTIVE"}'\ndef receive(request,timeout=None):\n body=request.data\n names=re.findall(b'filename="([^"]+)"',body)\n for name in ('index.ts','core.ts','policy.ts','enhancements.ts','weekly.ts','temporal-context.ts','conversation-memory.ts','background.ts','review-learning.ts','opening-policy.ts'):\n  assert name.encode() in names\n  assert (Path('supabase/functions/coach')/name).read_bytes() in body\n print(json.dumps({'filenames':[x.decode() for x in names]}))\n return Response()\nm.urllib.request.urlopen=receive\nm.deploy_function_https('domkmxmwmihcfadophfg','local-fixture-only')`;
 const result=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout).filenames.sort(),['background.ts','conversation-memory.ts','core.ts','enhancements.ts','index.ts','opening-policy.ts','policy.ts','review-learning.ts','temporal-context.ts','weekly.ts']);
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
