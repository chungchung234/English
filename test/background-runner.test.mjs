import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
function run(body){return spawnSync('python3',['-c',`import sys,importlib.util,json,io\nsys.path.insert(0,'scripts')\ns=importlib.util.spec_from_file_location('runner','scripts/run-background-jobs.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${body}`],{encoding:'utf8'});}
test('scheduled runner reuses server authorization only for its project, bounds work and never prints credentials',()=>{
 const result=run(`calls=[]\ndef management(ref,token,path,*args):\n assert token=='fixture-management-private'\n return [{'ready':True}] if path=='database/query' else [{'name':'service_role','api_key':'fixture-server-private'}]\ndef invoke(req,timeout):\n assert req.full_url=='https://domkmxmwmihcfadophfg.supabase.co/functions/v1/coach/background-work'\n assert req.get_header('Authorization')=='Bearer fixture-server-private'\n assert req.data==b'{}'\n calls.append(1)\n return io.BytesIO(json.dumps({'status':'retry_wait','kind':'session'}).encode())\nm.management_request=management;m.urllib.request.urlopen=invoke\nm.drain('domkmxmwmihcfadophfg','fixture-management-private',2)\nassert len(calls)==2`);
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim().split('\n').length,2);assert(!result.stdout.includes('private'));assert(!result.stderr.includes('private'));
});
test('rollout preflight never claims work or reads server keys when the queue schema is absent',()=>{
 const result=run(`def management(ref,token,path,*args):\n assert path=='database/query'\n return [{'ready':False}]\nm.management_request=management\nm.urllib.request.urlopen=lambda *args: (_ for _ in ()).throw(Exception('must not invoke'))\nm.drain('domkmxmwmihcfadophfg','fixture-private',4)`);
 assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('no work was claimed'));assert(!result.stdout.includes('fixture-private'));
});
