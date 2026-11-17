// Generated, approved silhouettes and eye artwork; animate their texture coordinates.
import {CHARACTER_PALETTES,PRESENCE_STATES,characterPose} from './character-motion.js';
const AI_ART_SOURCES = Object.fromEntries(['alex','mia','juno'].map(name => [name,
  document.getElementById('ai-art-'+name)?.dataset.src || document.getElementById('ai-art-'+name)?.src || new URL('assets/ai-'+name+'.webp',document.baseURI).href
]));
const AI_ART_IMAGES = new Map();
const EMPTY_ART = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
async function loadAIArtwork(name) {
  if(!AI_ART_IMAGES.has(name)) AI_ART_IMAGES.set(name,(async()=>{
    const image=new Image();image.src=AI_ART_SOURCES[name];await image.decode();
    const texture=document.createElement('canvas');texture.width=texture.height=512;
    const pixels=texture.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});
    pixels.drawImage(image,0,0,512,512);
    const frame=pixels.getImageData(0,0,512,512),data=frame.data,n=512;
    // Keep the main connected silhouette, with its antialiasing fringe. Generated
    // transparent files can include isolated colored pixels well outside the body.
    const visited=new Uint8Array(n*n),queue=new Int32Array(n*n);let body=[];
    for(let start=0;start<n*n;start++){
      if(visited[start]||data[start*4+3]<128)continue;
      let head=0,tail=1;queue[0]=start;visited[start]=1;
      while(head<tail){const k=queue[head++],x=k%n,y=Math.floor(k/n);
        for(const next of [x?k-1:-1,x<n-1?k+1:-1,y?k-n:-1,y<n-1?k+n:-1]){
          if(next>=0&&!visited[next]&&data[next*4+3]>=128){visited[next]=1;queue[tail++]=next;}
        }
      }
      if(tail>body.length)body=Array.from(queue.subarray(0,tail));
    }
    const keep=new Uint8Array(n*n);
    for(const k of body){const x=k%n,y=Math.floor(k/n);
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(x+dx>=0&&x+dx<n&&y+dy>=0&&y+dy<n)keep[k+dy*n+dx]=1;
    }
    const color=CHARACTER_PALETTES[name];
    for(let k=0;k<n*n;k++){
      const i=k*4;
      if(!keep[k]||data[i+3]<=8){data.fill(0,i,i+4);continue;}
      // Preserve imagegen's actual eye shapes; enforce the selected flat palette.
      const white=Math.max(0,Math.min(1,(Math.min(data[i],data[i+1],data[i+2])/255-.75)/.21));
      for(let channel=0;channel<3;channel++)data[i+channel]=Math.round(color[channel]+(255-color[channel])*white);
    }
    // Locate the two generated white eyes rather than approximating them in code.
    visited.fill(0);const eyes=[];
    const white=k=>data[k*4+3]>200&&Math.min(data[k*4],data[k*4+1],data[k*4+2])>235;
    for(let start=0;start<n*n;start++){
      if(visited[start]||!white(start))continue;
      let head=0,tail=1,minX=n,minY=n,maxX=0,maxY=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;queue[0]=start;visited[start]=1;
      while(head<tail){const k=queue[head++],x=k%n,y=Math.floor(k/n);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
        for(const next of [x?k-1:-1,x<n-1?k+1:-1,y?k-n:-1,y<n-1?k+n:-1])if(next>=0&&!visited[next]&&white(next)){visited[next]=1;queue[tail++]=next;}
      }
      if(tail>32)eyes.push({angle:.5*Math.atan2(-2*(sxy/tail-sx*sy/(tail*tail)),sxx/tail-sx*sx/(tail*tail)-syy/tail+sy*sy/(tail*tail))-Math.PI/2,area:tail,rect:[(minX+maxX+1)/(2*n),1-(minY+maxY+1)/(2*n),(maxX-minX+5)/n,(maxY-minY+5)/n]});
    }
    const selectedEyes=eyes.sort((a,b)=>b.area-a.area).slice(0,2).sort((a,b)=>a.rect[0]-b.rect[0]);
    const eyeRects=selectedEyes.map(eye=>eye.rect),eyeAngles=selectedEyes.map(eye=>Math.atan(Math.tan(eye.angle)));
    if(eyeRects.length!==2)throw Error('Character artwork must contain two capsule eyes.');
    pixels.putImageData(frame,0,0);
    // Canvas sources consistently honor WebGL's unpack flags on iOS as well.
    // Share the cleaned silhouette with reduced-motion/GPU fallback and swipes.
    return {texture,eyeRects,eyeAngles,posterSrc:texture.toDataURL('image/png')};
  })());
  return AI_ART_IMAGES.get(name);
}
export function createAIPresence(root = document) {
  const profiles={alex:0,mia:1,juno:2};
  const stateNames=PRESENCE_STATES;
  const weights=Object.fromEntries(stateNames.map(key=>[key,key==='idle'?1:0]));
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let profile='alex',state='idle',inputLevel=0,outputLevel=0,ambientClock=0,stateClock=0,muted=false,interrupting=false;
  let context,raf=0,last=0,destroyed=false,paused=false;
  const sources=new Map(),analysers=new Map(),revisions={input:0,output:0};
  const artwork=new Map();
  const vertex='attribute vec2 position;varying vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}';
  const fragment=`precision mediump float;
    varying vec2 uv;uniform sampler2D art;
    uniform vec4 bodyPose,facePose,eyeLeft,eyeRight;
    uniform vec2 eyeOpen,eyeAngles;uniform vec3 bodyColor,eyeStyle;
    float eye(vec2 p,vec4 rect,float openness,float sourceAngle){
      vec2 q=p-rect.xy-facePose.xy;
      // Work along each raster eye's actual axis, not the bounding-box axis.
      q=mat2(cos(sourceAngle),-sin(sourceAngle),sin(sourceAngle),cos(sourceAngle))*q;
      // Bend and rotate the actual capsule texture into a rounded arch or oval.
      float across=clamp(q.x/max(rect.w*max(.1,openness)*.5,.001),-1.,1.);
      q.y-=eyeStyle.z*(1.-across*across);
      float angle=eyeStyle.y;
      q=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*q;
      q.x/=max(.25,eyeStyle.x);q.y/=max(.055,openness);
      q=mat2(cos(sourceAngle),sin(sourceAngle),-sin(sourceAngle),cos(sourceAngle))*q;
      if(abs(q.x)>rect.z*.6||abs(q.y)>rect.w*.6)return 0.;
      vec4 sampleColor=texture2D(art,rect.xy+q);
      vec3 rgb=sampleColor.rgb/max(sampleColor.a,.001);
      float base=min(bodyColor.r,min(bodyColor.g,bodyColor.b));
      return clamp((min(rgb.r,min(rgb.g,rgb.b))-base)/(1.-base),0.,1.)*sampleColor.a;
    }
    void main(){
      vec2 p=uv-.5;float tilt=bodyPose.z;
      p=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p;
      p=p/bodyPose.xy+.5;
      if(p.x<0.||p.x>1.||p.y<0.||p.y>1.){gl_FragColor=vec4(0.);return;}
      float alpha=texture2D(art,p).a;
      float face=max(eye(p,eyeLeft,eyeOpen.x,eyeAngles.x),eye(p,eyeRight,eyeOpen.y,eyeAngles.y));
      gl_FragColor=vec4(mix(bodyColor,vec3(1.),face)*alpha,alpha);
    }`;
  function nameFor(canvas){return canvas.dataset.aiProfile==='current'?profile:canvas.dataset.aiProfile;}
  function updatePoster(s,name){
    const prepared=artwork.get(name);
    if(s.poster.dataset.profile!==name||s.posterArtwork!==prepared){
      s.poster.src=prepared?.posterSrc||EMPTY_ART;s.poster.dataset.profile=name;s.posterArtwork=prepared;
    }
  }
  function showPoster(s,failed=false){
    if(!s.poster){
      s.poster=new Image();s.poster.loading='lazy';s.poster.decoding='async';s.poster.className=s.canvas.className+' ai-presence-poster';
      s.poster.alt=s.canvas.getAttribute('aria-label')||'';
      if(s.canvas.getAttribute('aria-hidden')==='true')s.poster.alt='';
      s.canvas.before(s.poster);
    }
    const name=nameFor(s.canvas);
    updatePoster(s,name);
    s.poster.style.animationPlayState=document.hidden||paused?'paused':'running';
    s.poster.hidden=false;s.canvas.hidden=true;
    if(failed)s.canvas.classList.add('ai-presence-fallback');
  }
  const surfaces=[...root.querySelectorAll('canvas[data-ai-profile]')].map(canvas=>{
    const s={canvas};showPoster(s);
    try{
      const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,powerPreference:'low-power'});
      if(!gl)throw Error('WebGL unavailable');
      if('drawingBufferColorSpace' in gl)gl.drawingBufferColorSpace='srgb';
      const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const reason=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw Error(reason);}return shader;};
      const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment),program=gl.createProgram();
      gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Shader link failed');
      gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
      const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program,'art'),0);
      Object.assign(s,{gl,program,buffer,texture,uniforms:Object.fromEntries(['bodyPose','facePose','eyeLeft','eyeRight','eyeOpen','bodyColor','eyeStyle','eyeAngles'].map(n=>[n,gl.getUniformLocation(program,n)]))});
      s.lostHandler=e=>{e.preventDefault();s.lost=true;showPoster(s,true);};
      canvas.addEventListener('webglcontextlost',s.lostHandler);
      // A lost GPU context keeps the approved artwork with a gentle CSS fallback.
    }catch{showPoster(s,true);}
    return s;
  });
  function rms(kind){
    const analyser=analysers.get(kind);if(!analyser)return 0;
    analyser.node.getByteTimeDomainData(analyser.data);
    let sum=0;for(const value of analyser.data)sum+=((value-128)/128)**2;
    return Math.min(1,Math.max(0,Math.sqrt(sum/analyser.data.length)-.006)*5);
  }
  function approach(value,target,rate,dt){return value+(target-value)*(1-Math.exp(-rate*dt));}
  function draw(now,force=false){
    raf=0;if(destroyed||(!force&&paused)||document.hidden)return;
    if(!force&&last&&now-last<32&&!motion.matches){raf=requestAnimationFrame(draw);return;}
    const dt=last?Math.min(.06,(now-last)/1000):0;last=now;
    const input=muted||state!=='listening'?0:rms('input'),output=state==='speaking'?rms('output'):0;
    const release=profile==='mia'?5:profile==='juno'?10:7;
    inputLevel=approach(inputLevel,input,input>inputLevel?18:release,dt);
    outputLevel=approach(outputLevel,output,output>outputLevel?22:release,dt);
    for(const key of stateNames)weights[key]=motion.matches||paused?(key===state?1:0):approach(weights[key],key===state?1:0,interrupting?28:18,dt);
    if(weights.listening>.98)interrupting=false;
    ambientClock+=dt;stateClock+=dt;
    let drewSurface=false;
    for(const s of surfaces){
      const {canvas,gl}=s,current=canvas.dataset.aiProfile==='current',name=nameFor(canvas);
      canvas.dataset.profile=name;canvas.dataset.state=current?state:'idle';canvas.dataset.muted=String(current&&muted);
      if(s.poster){s.poster.dataset.state=canvas.dataset.state;s.poster.dataset.muted=canvas.dataset.muted;}
      if(s.poster){s.poster.alt=canvas.getAttribute('aria-label')||'';updatePoster(s,name);}
      const visible=canvas.hidden&&s.poster&&!s.poster.hidden?s.poster:canvas;
      let box=visible.getBoundingClientRect();
      if(!box.width||!box.height||box.bottom<0||box.top>innerHeight||(visible.checkVisibility&&!visible.checkVisibility()))continue;
      const image=artwork.get(name);
      if(!image){canvas.dataset.ready='false';showPoster(s);ensureArtwork(name);continue;}
      if(!gl||s.lost){showPoster(s,true);continue;}
      canvas.hidden=false;if(s.poster)s.poster.hidden=true;
      box=canvas.getBoundingClientRect();
      const size=Math.min(440,Math.round(box.width*Math.min(devicePixelRatio||1,1.5)));
      if(canvas.width!==size){canvas.width=size;canvas.height=size;gl.viewport(0,0,size,size);}
      gl.useProgram(s.program);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,s.texture);
      if(s.textureName!==name){
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image.texture);s.textureName=name;
      }
      const pose=characterPose({profile:name,time:ambientClock,stateTime:stateClock,weights:current?weights:{idle:1},input:inputLevel,output:outputLevel,muted:current&&muted,reduced:motion.matches,paused});
      gl.uniform4f(s.uniforms.bodyPose,pose.scaleX,pose.scaleY,pose.tilt,0);
      gl.uniform4f(s.uniforms.facePose,pose.gazeX,pose.gazeY,0,0);
      gl.uniform2f(s.uniforms.eyeOpen,pose.leftOpen,pose.rightOpen);
      gl.uniform3f(s.uniforms.eyeStyle,pose.eyeWidth,pose.eyeTurn,pose.eyeCurve);
      gl.uniform2fv(s.uniforms.eyeAngles,image.eyeAngles);
      gl.uniform4fv(s.uniforms.eyeLeft,image.eyeRects[0]);gl.uniform4fv(s.uniforms.eyeRight,image.eyeRects[1]);
      gl.uniform3fv(s.uniforms.bodyColor,CHARACTER_PALETTES[name].map(value=>value/255));
      gl.drawArrays(gl.TRIANGLES,0,6);canvas.dataset.ready='true';drewSurface=true;
    }
    if(!motion.matches&&!paused&&drewSurface)raf=requestAnimationFrame(draw);
  }
  function refresh(){if(!raf&&!destroyed&&!paused)raf=requestAnimationFrame(draw);}
  const pendingArtwork=new Map();
  function ensureArtwork(name){
    if(!pendingArtwork.has(name))pendingArtwork.set(name,loadAIArtwork(name).then(image=>{
      if(!destroyed){artwork.set(name,image);for(const s of surfaces)if(s.poster&&nameFor(s.canvas)===name)updatePoster(s,name);refresh();}
      return image;
    }).catch(()=>{for(const s of surfaces)if(nameFor(s.canvas)===name)showPoster(s,true);}));
    return pendingArtwork.get(name);
  }
  function snapshot(canvas){
    const surface=surfaces.find(value=>value.canvas===canvas);if(!surface)return null;
    try{
      const source=canvas.hidden?surface.poster:canvas;
      if(!source||source instanceof HTMLImageElement&&!source.complete)return null;
      // Redraw before copying: WebGL does not retain its previous drawing buffer.
      if(source===canvas&&surface.gl&&!surface.lost)surface.gl.drawArrays(surface.gl.TRIANGLES,0,6);
      const copy=document.createElement('canvas');copy.width=canvas.width||240;copy.height=canvas.height||240;
      copy.getContext('2d').drawImage(source,0,0,copy.width,copy.height);return copy;
    }catch{return null;}
  }
  function setPaused(value){paused=Boolean(value);cancelAnimationFrame(raf);raf=0;last=0;for(const s of surfaces)s.canvas.dataset.paused=String(paused);if(paused)draw(performance.now(),true);else refresh();}
  function setProfile(value){profile=Object.hasOwn(profiles,value)?value:'alex';refresh();}
  function setState(value){
    const next=stateNames.includes(value)?value:'idle';
    if(next!==state){stateClock=0;interrupting=state==='speaking'&&next==='listening';}
    if(next!=='speaking')outputLevel=0;
    state=next;refresh();
  }
  function setMuted(value){muted=Boolean(value);if(muted)inputLevel=0;refresh();}
  async function attachAudio(stream,kind){
    if(!['input','output'].includes(kind))return;
    const revision=++revisions[kind];
    try{
      const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio||!stream?.getAudioTracks().length)return;
      context??=new Audio();const active=context;if(active.state==='suspended')await active.resume();
      if(destroyed||active!==context||active.state==='closed'||revision!==revisions[kind])return;
      sources.get(kind)?.disconnect();analysers.get(kind)?.node.disconnect();
      const source=active.createMediaStreamSource(stream),node=active.createAnalyser();node.fftSize=256;source.connect(node);
      sources.set(kind,source);analysers.set(kind,{node,data:new Uint8Array(node.fftSize)});
    }catch{/* Visualization must never block audio playback or call persistence. */}
  }
  function detachAudio(){
    revisions.input++;revisions.output++;
    for(const source of sources.values())source.disconnect();for(const a of analysers.values())a.node.disconnect();
    sources.clear();analysers.clear();inputLevel=outputLevel=0;muted=false;
    const old=context;context=null;old?.close().catch(()=>{});setState('idle');
  }
  const visibility=()=>{for(const s of surfaces)if(s.poster)s.poster.style.animationPlayState=document.hidden||paused?'paused':'running';if(document.hidden){cancelAnimationFrame(raf);raf=0;last=0;}else refresh();};
  const changed=()=>{cancelAnimationFrame(raf);raf=0;last=0;refresh();};
  document.addEventListener('visibilitychange',visibility);motion.addEventListener('change',changed);refresh();
  return {get ready(){return Promise.all([...new Set(surfaces.length?surfaces.map(s=>nameFor(s.canvas)):[profile])].map(ensureArtwork));},async posterSource(name){return (await ensureArtwork(Object.hasOwn(profiles,name)?name:'alex'))?.posterSrc||EMPTY_ART;},snapshot,setProfile,setState,setMuted,setPaused,attachAudio,detachAudio,refresh,destroy(){
    destroyed=true;cancelAnimationFrame(raf);detachAudio();document.removeEventListener('visibilitychange',visibility);motion.removeEventListener('change',changed);
    for(const s of surfaces){s.canvas.removeEventListener('webglcontextlost',s.lostHandler);s.poster?.remove();if(s.gl){s.gl.deleteTexture(s.texture);s.gl.deleteBuffer(s.buffer);s.gl.deleteProgram(s.program);}}
  }};
}
