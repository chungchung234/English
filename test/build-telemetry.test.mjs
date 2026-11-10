import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('release provenance uses CI SHA or deterministic source hash and remains covered by content hashes, CSP, and SRI',async t=>{
  const root=new URL('../',import.meta.url),work=await mkdtemp(join(tmpdir(),'loop-telemetry-build-'));
  t.after(()=>rm(work,{recursive:true,force:true}));
  await mkdir(join(work,'scripts'));
  await Promise.all([
    cp(new URL('web/',root),join(work,'web'),{recursive:true}),
    cp(new URL('src/',root),join(work,'src'),{recursive:true}),
    cp(new URL('scripts/build-web.mjs',root),join(work,'scripts/build-web.mjs')),
    cp(new URL('scripts/bundle-web.mjs',root),join(work,'scripts/bundle-web.mjs')),
    symlink(new URL('node_modules/',root).pathname,join(work,'node_modules'),'dir')
  ]);
  const env={PATH:process.env.PATH,PUBLIC_SUPABASE_URL:'https://test-project.supabase.co',PUBLIC_SUPABASE_KEY:'sb_publishable_test'};
  async function build(extra={}){
    execFileSync(process.execPath,['scripts/build-web.mjs','--require-config'],{cwd:work,env:{...env,...extra}});
    const html=await readFile(join(work,'dist/index.html'),'utf8');
    const tag=html.match(/src="(assets\/app\.[a-f0-9]{12}\.js)" integrity="sha256-([^"]+)"/);assert(tag);
    const script=await readFile(join(work,'dist',tag[1]),'utf8');
    const version=script.match(/globalThis\.LOOP_CLIENT_BUILD="([^"]+)"/)[1];
    const hash=createHash('sha256').update(script).digest('base64');assert.equal(tag[2],hash);assert(html.includes(`script-src 'sha256-${hash}'`));
    assert(tag[1].includes(createHash('sha256').update(script).digest('hex').slice(0,12)));
    return {version,asset:tag[1]};
  }
  const fallback=await build();assert.match(fallback.version,/^source:[0-9a-f]{24}$/);
  assert.deepEqual(await build(),fallback,'repeated builds of the same source have the same release and asset hashes');
  const sha='abcdef1234567890abcdef1234567890abcdef12',ci=await build({GITHUB_SHA:sha});
  assert.equal(ci.version,'git:'+sha);assert.notEqual(ci.asset,fallback.asset);
  assert.equal((await build({CI_COMMIT_SHA:sha.toUpperCase()})).version,'git:'+sha);
  assert.throws(()=>execFileSync(process.execPath,['scripts/build-web.mjs'],{cwd:work,env:{...env,GITHUB_SHA:'invalid release label'},stdio:'pipe'}),/CI commit must be a Git SHA/);
});
