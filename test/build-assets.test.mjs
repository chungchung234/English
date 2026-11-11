import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('phone build caches content-hashed application and AI assets with verified CSP and subpath URLs',async()=>{
 execFileSync(process.execPath,['scripts/build-web.mjs','--require-config'],{cwd:new URL('../',import.meta.url),env:{...process.env,PUBLIC_SUPABASE_URL:'https://test-project.supabase.co',PUBLIC_SUPABASE_KEY:'sb_publishable_test'}});
 const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
 assert(Buffer.byteLength(html)<300_000,'primary HTML must stay below 300 kB; application code and character art stay separately cached');
 assert(!html.includes('data:image/png;base64,'));
 for(const name of ['bookmark-simple','calendar-blank','chevron']){
  assert.match(html,new RegExp(`data-review-icon="${name}" src="data:image/svg\\+xml;base64,`),'runtime review icons must be embedded for deployed subpath hosting');
 }
 for(const name of ['alex','mia','juno']){
  const source=await readFile(new URL(`../web/assets/ai-${name}.webp`,import.meta.url));
  const hash=createHash('sha256').update(source).digest('hex').slice(0,12),url=`assets/ai-${name}.${hash}.webp`;
  assert(html.includes(url),`build must reference ${name} by content hash`);
  assert.deepEqual(await readFile(new URL('../dist/'+url,import.meta.url)),source);
  assert.equal(new URL(url,'https://example.com/English/').pathname,'/English/'+url);
 }
 const scriptTag=html.match(/<script type="module" src="(assets\/app\.[a-f0-9]{12}\.js)" integrity="sha256-([^"]+)" crossorigin="anonymous"><\/script>/);assert(scriptTag);
 const script=await readFile(new URL('../dist/'+scriptTag[1],import.meta.url),'utf8');
 const digest=createHash('sha256').update(script).digest('base64');assert.equal(scriptTag[2],digest);assert(html.includes(`script-src 'sha256-${digest}'`));
 assert(scriptTag[1].includes(createHash('sha256').update(script).digest('hex').slice(0,12)));
 assert.equal(new URL(scriptTag[1],'https://example.com/English/').pathname,'/English/'+scriptTag[1]);
 const headers=await readFile(new URL('../dist/_headers',import.meta.url),'utf8');assert.match(headers,/max-age=31536000, immutable/);
});
