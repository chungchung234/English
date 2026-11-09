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
 assert(await fallback.evaluate(async()=>{const {createAIPresence}=await import('/ai-presence.js');const root=document.createElement('div'),c=document.createElement('canvas');c.dataset.aiProfile='mia';c.getContext=()=>null;root.append(c);const v=createAIPresence(root);const works=c.classList.contains('ai-presence-fallback');v.destroy();return works;}));
 console.log('PASS: missing WebGL has a static fallback.');
}finally{await browser.close();server.kill('SIGTERM');}
