// Exercise the actual shader and audio-resource lifecycle in Chromium.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:'4193',PUBLIC_SUPABASE_URL:'',PUBLIC_SUPABASE_KEY:''},stdio:'pipe'});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await page.goto('http://127.0.0.1:4193');
 const result=await page.evaluate(async()=>{
  const {createAIPresence}=await import('/ai-presence.js');
  document.querySelector('#setup').hidden=true;document.querySelector('#workspace').hidden=false;
  // Own renderer so its audio context lifecycle can be tested without opening a call.
  const root=document.createElement('section');const canvas=document.createElement('canvas');canvas.dataset.aiProfile='current';canvas.width=canvas.height=240;root.append(canvas);document.body.replaceChildren(root);
  const getContext=canvas.getContext.bind(canvas);canvas.getContext=(kind,options)=>getContext(kind,{...options,preserveDrawingBuffer:true});
  const presence=createAIPresence(root);const tick=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  await presence.ready;await tick();const fallback=canvas.classList.contains('ai-presence-fallback');
  const images=[];for(const name of ['alex','mia','juno']){presence.setProfile(name);await presence.ready;await tick();images.push(canvas.toDataURL());}
  const first=images[2];presence.setState('speaking');await tick();const reducedStatic=first===canvas.toDataURL();
  const RealAudio=window.AudioContext,contexts=[];
  window.AudioContext=class extends RealAudio{constructor(){super();contexts.push(this);}};
  const generator=new RealAudio(),tone=generator.createOscillator(),output=generator.createMediaStreamDestination();tone.connect(output);tone.start();
  await presence.attachAudio(output.stream,'output');const resumed=contexts[0]?.state==='running';
  presence.detachAudio();await new Promise(r=>setTimeout(r,20));const closed=contexts[0]?.state==='closed';
  await presence.attachAudio(output.stream,'input');presence.destroy();await new Promise(r=>setTimeout(r,20));const allClosed=contexts.every(c=>c.state==='closed');
  const tracksRetained=output.stream.getAudioTracks().every(t=>t.readyState==='live');
  tone.stop();output.stream.getTracks().forEach(t=>t.stop());await generator.close();window.AudioContext=RealAudio;
  return {fallback,distinct:new Set(images).size,reducedStatic,resumed,closed,allClosed,tracksRetained};
 });
 assert.deepEqual(result,{fallback:false,distinct:3,reducedStatic:true,resumed:true,closed:true,allClosed:true,tracksRetained:true});
 console.log('PASS: three shaders render distinctly; reduced motion stays still; real audio analysers resume, reconnect, and release contexts without stopping call tracks.');
 const alphaPage=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,reducedMotion:'reduce'});
 await alphaPage.goto('http://127.0.0.1:4193');
 const compositing=await alphaPage.evaluate(async()=>{
  const {createAIPresence}=await import('/ai-presence.js');document.body.replaceChildren();
  const root=document.createElement('section'),canvas=document.createElement('canvas');canvas.dataset.aiProfile='current';canvas.className='ai-presence ai-presence-home';root.append(canvas);document.body.append(root);
  const get=canvas.getContext.bind(canvas);canvas.getContext=(kind,options)=>get(kind,{...options,preserveDrawingBuffer:true});
  const presence=createAIPresence(root),results=[];
  for(const name of ['alex','mia','juno']){
   presence.setProfile(name);await presence.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const gl=canvas.getContext('webgl'),n=canvas.width,pixels=new Uint8Array(n*n*4);gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   let unassociated=0,debris=0;
   for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=(y*n+x)*4,a=pixels[i+3];
    if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>a+1)unassociated++;
    if(!a||a>=128)continue;let nearBody=false;
    for(let dy=-3;dy<=3&&!nearBody;dy++)for(let dx=-3;dx<=3;dx++){
     const xx=x+dx,yy=y+dy;if(xx>=0&&xx<n&&yy>=0&&yy<n&&pixels[(yy*n+xx)*4+3]>=128){nearBody=true;break;}
    }
    if(!nearBody)debris++;
   }
   const poster=new Image();poster.src=await presence.posterSource(name);await poster.decode();
   const sample=document.createElement('canvas');sample.width=poster.naturalWidth;sample.height=poster.naturalHeight;
   const context=sample.getContext('2d');context.drawImage(poster,0,0);const data=context.getImageData(0,0,sample.width,sample.height).data;
   // Corners and the distant top/bottom bands must stay transparent on any background.
   let borderPixels=0;for(let y=0;y<sample.height;y++)for(let x=0;x<sample.width;x++)if(x<24||y<24||x>=sample.width-24||y>=sample.height-24)borderPixels+=data[(y*sample.width+x)*4+3]>0;
   results.push({name,premultiplied:gl.getContextAttributes().premultipliedAlpha,unassociated,debris,borderPixels,posterIsCleaned:poster.src.startsWith('data:image/png')});
  }
  presence.destroy();return results;
 });
 assert(compositing.every(item=>item.premultiplied&&item.unassociated===0&&item.debris===0&&item.borderPixels===0&&item.posterIsCleaned),'GPU and fallback must share a clean silhouette with premultiplied output and no detached translucent fragments');
 await alphaPage.close();
 console.log('PASS: mobile-scale GPU pixels use premultiplied alpha; all three characters and shared fallback/swipe posters have no detached export debris.');
 const idlePage=await browser.newPage({viewport:{width:390,height:844}});
 await idlePage.goto('http://127.0.0.1:4193');
 const idle=await idlePage.evaluate(async()=>{
  const {createAIPresence}=await import('/ai-presence.js');document.body.replaceChildren();
  const root=document.createElement('section'),canvas=document.createElement('canvas');canvas.dataset.aiProfile='current';canvas.width=canvas.height=240;
  const original=canvas.getContext.bind(canvas);canvas.getContext=(kind,options)=>original(kind,{...options,preserveDrawingBuffer:true});root.append(canvas);document.body.append(root);
  const presence=createAIPresence(root),results=[];
  const pixels=()=>{const gl=canvas.getContext('webgl'),data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
  for(const name of ['alex','mia','juno']){
   presence.setProfile(name);await presence.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const before=pixels();await new Promise(resolve=>setTimeout(resolve,1300));const after=pixels();
   let alpha=0;for(let i=3;i<before.length;i+=4)alpha+=Math.abs(before[i]-after[i]);
   results.push({name,alphaMean:alpha/(before.length/4)});
  }
  presence.destroy();return results;
 });
 assert(idle.every(result=>result.alphaMean>.05),'every idle character must gently move its contour without an audio stream');
 console.log('PASS: all three idle characters gently breathe and drift without audio.');
 await idlePage.close();
 const audioPage=await browser.newPage({viewport:{width:640,height:600}});
 await audioPage.goto('http://127.0.0.1:4193');
 const reactive=await audioPage.evaluate(async()=>{
  const {createAIPresence}=await import('/ai-presence.js');document.body.replaceChildren();
  const views=[];for(let i=0;i<2;i++){const root=document.createElement('section'),c=document.createElement('canvas');c.width=c.height=240;c.dataset.aiProfile='current';const original=c.getContext.bind(c);c.getContext=(kind,opts)=>original(kind,{...opts,preserveDrawingBuffer:true});root.append(c);document.body.append(root);views.push({c,p:createAIPresence(root)});}
  await Promise.all(views.map(v=>v.p.ready));views.forEach(v=>v.p.setState('speaking'));
  const audio=new AudioContext(),osc=audio.createOscillator(),gain=audio.createGain(),stream=audio.createMediaStreamDestination();gain.gain.value=.25;osc.connect(gain).connect(stream);osc.start();await views[1].p.attachAudio(stream.stream,'output');
  await new Promise(r=>setTimeout(r,700));
  const pixels=views.map(({c})=>{const gl=c.getContext('webgl'),data=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;});let delta=0,alphaDelta=0;for(let i=0;i<pixels[0].length;i++){const difference=Math.abs(pixels[0][i]-pixels[1][i]);delta+=difference;if(i%4===3)alphaDelta+=difference;}
  const mean=delta/pixels[0].length;views.forEach(v=>v.p.destroy());osc.stop();stream.stream.getTracks().forEach(t=>t.stop());await audio.close();return {mean,alphaMean:alphaDelta/(pixels[0].length/4)};
 });
 assert(reactive.mean>.2,'measured audio must visibly change artwork relative to the same silent speaking state');
 assert(reactive.alphaMean>.5,'voice must visibly change the outer contour as well as the internal material');
 console.log('PASS: a real generated audio track visibly modulates the approved artwork; speech state alone does not fake an audio signal.');
 const fallback=await browser.newPage();await fallback.goto('http://127.0.0.1:4193');
 assert(await fallback.evaluate(async()=>{const {createAIPresence}=await import('/ai-presence.js');const root=document.createElement('div'),c=document.createElement('canvas');c.dataset.aiProfile='mia';c.getContext=()=>null;root.append(c);document.body.replaceChildren(root);const v=createAIPresence(root);await v.ready;const poster=root.querySelector('img');await poster.decode();const works=c.classList.contains('ai-presence-fallback')&&poster.src.startsWith('data:image/png')&&poster.dataset.profile==='mia';v.destroy();return works;}));
 console.log('PASS: missing WebGL keeps the same-artwork fallback.');
}finally{await browser.close();server.kill('SIGTERM');}
