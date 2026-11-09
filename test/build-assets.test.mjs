import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('phone build uses cached external AI assets and keeps CSP and subpath URLs valid',async()=>{
 execFileSync(process.execPath,['scripts/build-web.mjs','--require-config'],{cwd:new URL('../',import.meta.url),env:{...process.env,PUBLIC_SUPABASE_URL:'https://test-project.supabase.co',PUBLIC_SUPABASE_KEY:'sb_publishable_test'}});
 const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
 assert(Buffer.byteLength(html)<300_000,'primary HTML including the official auth SDK must stay below 300 kB; character art stays separately cached');
 assert(!html.includes('data:image/png;base64,'));
 for(const name of ['alex','mia','juno']){
  const source=await readFile(new URL(`../web/assets/ai-${name}.webp`,import.meta.url));
  const hash=createHash('sha256').update(source).digest('hex').slice(0,12),url=`assets/ai-${name}.${hash}.webp`;
  assert(html.includes(url),`build must reference ${name} by content hash`);
  assert.deepEqual(await readFile(new URL('../dist/'+url,import.meta.url)),source);
  assert.equal(new URL(url,'https://example.com/English/').pathname,'/English/'+url);
 }
 const inlineScript=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];assert(inlineScript);
 const digest=createHash('sha256').update(inlineScript).digest('base64');assert(html.includes(`script-src 'sha256-${digest}'`));
 const headers=await readFile(new URL('../dist/_headers',import.meta.url),'utf8');assert.match(headers,/max-age=31536000, immutable/);
});
