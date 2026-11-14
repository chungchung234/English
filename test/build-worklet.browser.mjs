// Real Chromium exercises the built CSP and AudioWorklet module loader. The
// tiny local processor verifies delivery only, not speech quality or acoustics.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url);
const probeWorklet=`class BuildCspProbe extends AudioWorkletProcessor {
 constructor(){super();this.port.onmessage=event=>this.port.postMessage({received:event.data});}
 process(inputs,outputs){for(const output of outputs)for(const channel of output)channel.fill(0);return true;}
}
registerProcessor('loop-build-csp-probe',BuildCspProbe);`;
const probeApp=`let context;
globalThis.probeWorkletAdd=async url=>{context ||= new AudioContext();await context.resume();await context.audioWorklet.addModule(url||globalThis.LOOP_PCM_WORKLET_ASSET.url);return true;};
globalThis.probeWorklet=async()=>{await globalThis.probeWorkletAdd();const node=new AudioWorkletNode(context,'loop-build-csp-probe');node.connect(context.destination);const received=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No native Worklet receipt')),3000);node.port.onmessage=event=>{clearTimeout(timer);resolve(event.data.received);};node.port.postMessage('native-render-receipt');});node.disconnect();return{received,frozen:Object.isFrozen(globalThis.LOOP_PCM_WORKLET_ASSET),asset:globalThis.LOOP_PCM_WORKLET_ASSET};};`;

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'loop-worklet-build-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await mkdir(path.join(directory,'scripts'));
 await Promise.all([
  cp(new URL('web/',root),path.join(directory,'web'),{recursive:true}),
  cp(new URL('src/',root),path.join(directory,'src'),{recursive:true}),
  ...['build-web.mjs','bundle-web.mjs','serve.mjs'].map(name=>cp(new URL('scripts/'+name,root),path.join(directory,'scripts',name))),
  symlink(new URL('node_modules/',root).pathname,path.join(directory,'node_modules'),'dir')
 ]);
 await writeFile(path.join(directory,'web/app.js'),probeApp);await writeFile(path.join(directory,'web/verified-pcm-worklet.js'),probeWorklet);
 return directory;
}
function build(directory,site){
 execFileSync(process.execPath,['scripts/build-web.mjs','--require-config'],{cwd:directory,stdio:'pipe',env:{PATH:process.env.PATH,BUILD_SITE_URL:site,PUBLIC_SUPABASE_URL:'https://test-project.supabase.co',PUBLIC_SUPABASE_KEY:'sb_publishable_fixture'}});
}
async function inspect(directory){
 const html=await readFile(path.join(directory,'dist/index.html'),'utf8');
 const tag=html.match(/src="(assets\/app\.[a-f0-9]{12}\.js)" integrity="sha256-([^"]+)"/);assert(tag);
 const script=await readFile(path.join(directory,'dist',tag[1]),'utf8'),mainHash=createHash('sha256').update(script).digest('base64');assert.equal(tag[2],mainHash);
 const asset=JSON.parse(script.match(/globalThis\.LOOP_PCM_WORKLET_ASSET=Object\.freeze\((\{[^\n]+\})\);/)[1]);
 const source=await readFile(path.join(directory,'dist/assets',new URL(asset.url).pathname.split('/').at(-1)));
 assert.equal(createHash('sha256').update(source).digest('hex'),asset.sha256);
 assert.deepEqual(html.match(/script-src ([^;]+);/)[1].split(' '),[`'sha256-${mainHash}'`,"'wasm-unsafe-eval'",asset.url]);
 return{asset,html,source};
}
const launch=()=>chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});

test('built hash-only CSP loads the exact native Worklet under a site subpath and blocks a neighboring module', {timeout:30000},async t=>{
 const directory=await fixture(t),requests=new Map();
 const server=http.createServer(async(req,res)=>{
  try{const pathname=new URL(req.url,'http://localhost').pathname;requests.set(pathname,(requests.get(pathname)||0)+1);
   if(!pathname.startsWith('/English/'))throw Error('Not found');
   const relative=pathname.slice('/English/'.length)||'index.html',file=path.resolve(directory,'dist',relative);
   if(!file.startsWith(path.join(directory,'dist')+path.sep))throw Error('Not found');
   res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':'text/javascript'});res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/English/`;build(directory,base);
 const {asset,source}=await inspect(directory);assert.equal(new URL(asset.url).origin,new URL(base).origin);
 const forbidden=new URL('assets/unlisted-worklet.js',base);await writeFile(path.join(directory,'dist/assets/unlisted-worklet.js'),source);
 const browser=await launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.goto(base);await page.waitForFunction(()=>typeof globalThis.probeWorklet==='function');
 const result=await page.evaluate(()=>globalThis.probeWorklet());assert.deepEqual(result,{received:'native-render-receipt',frozen:true,asset});
 assert.equal(requests.get(new URL(asset.url).pathname),1,'native addModule fetches the canonical hashed asset');
 assert.equal(await page.evaluate(async url=>{try{await globalThis.probeWorkletAdd(url);return false;}catch{return true;}},forbidden.href),true);
 assert.equal(requests.get(forbidden.pathname)||0,0,'CSP blocks an unlisted same-origin Worklet before any network request');
});

test('local source server provides matching hashed Worklet metadata and rejects stale content paths', {timeout:30000},async t=>{
 const directory=await fixture(t),server=spawn(process.execPath,['scripts/serve.mjs'],{cwd:directory,env:{PATH:process.env.PATH,PORT:'0'},stdio:'pipe'});
 t.after(()=>{server.kill('SIGTERM');});
 const port=await new Promise((resolve,reject)=>{server.once('error',reject);let output='';server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/Local validation server on port (\d+)/);if(match)resolve(Number(match[1]));});server.once('exit',()=>reject(Error('Local fixture server exited')));});
 const base=`http://127.0.0.1:${port}/`,script=await (await fetch(new URL('app.js',base))).text();
 const asset=JSON.parse(script.match(/globalThis\.LOOP_PCM_WORKLET_ASSET=Object\.freeze\((\{[^\n]+\})\);/)[1]);
 assert.equal(new URL(asset.url).origin,new URL(base).origin);const response=await fetch(asset.url);assert.equal(response.status,200);
 assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),asset.sha256);
 assert.match(response.headers.get('Cache-Control'),/immutable/);
 assert.equal((await fetch(new URL('assets/verified-pcm-worklet.000000000000.js',base))).status,404);
 const browser=await launch();t.after(()=>browser.close());const page=await browser.newPage();await page.goto(base);await page.waitForFunction(()=>typeof globalThis.probeWorklet==='function');
 const result=await page.evaluate(()=>globalThis.probeWorklet());assert.equal(result.received,'native-render-receipt');assert.equal(result.asset.sha256,asset.sha256);
});
