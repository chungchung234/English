// Approved character artwork, animated as a continuous material rather than redrawn.
// Motion principles: Google Gemini visual design; state continuity: VoiceOrbs/Murmur.
const AI_ART_SOURCES = Object.fromEntries(['alex','mia','juno'].map(name => [name,
  document.getElementById('ai-art-'+name)?.dataset.src || document.getElementById('ai-art-'+name)?.src || new URL('assets/ai-'+name+'.webp',document.baseURI).href
]));
const AI_ART_IMAGES = new Map();
async function loadAIArtwork(name) {
  if(!AI_ART_IMAGES.has(name)) AI_ART_IMAGES.set(name,(async()=>{
    const image=new Image();image.src=AI_ART_SOURCES[name];await image.decode();
    // Decode once per character; all visible surfaces share this source.
    return typeof createImageBitmap==='function'
      ? createImageBitmap(image,{resizeWidth:512,resizeHeight:512,resizeQuality:'high',imageOrientation:'flipY',premultiplyAlpha:'none'}) : image;
  })());
  return AI_ART_IMAGES.get(name);
}
export function createAIPresence(root = document) {
  const profiles={alex:0,mia:1,juno:2};
  const stateNames=['idle','connecting','listening','thinking','speaking','error'];
  const weights=Object.fromEntries(stateNames.map(key=>[key,key==='idle'?1:0]));
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let profile='alex',state='idle',inputLevel=0,outputLevel=0,clock=0,idleClock=0;
  let context,raf=0,last=0,destroyed=false;
  const sources=new Map(),analysers=new Map(),revisions={input:0,output:0};
  const artwork=new Map();
  const vertex='attribute vec2 position;varying vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}';
  const fragment=`precision mediump float;
    varying vec2 uv;uniform sampler2D art;
    uniform float time,personality,activity,rest;
    uniform vec4 attention;
    void main(){
      bool mia=personality>.5&&personality<1.5;bool juno=personality>1.5;
      float tempo=mia?.72:(juno?1.12:.86);float t=time*tempo;
      vec2 p=uv-.5;
      // Whole-body motion is conditional: incoming voice opens the form vertically,
      // outgoing voice lends it volume; silent speech states do not fake a pulse.
      float character=mia?.78:(juno?1.12:.92);
      vec2 scale=vec2(1.)+activity*character*(attention.x*vec2(-.018,.040)+attention.z*vec2(.055,.095));
      p/=scale;
      float tilt=activity*attention.z*character*.040*sin(t*1.15);
      p=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p;
      float angle=atan(p.y,p.x);float radius=length(p);
      float bend=activity*character*(attention.x*.012+attention.z*.042);
      float contour=sin(angle*(juno?3.:2.)+t)*bend;
      vec2 maskUV=.5+p*(1.+contour*smoothstep(.12,.42,radius));
      maskUV+=p*attention.y*.025;
      vec4 original=texture2D(art,clamp(maskUV,0.,1.));
      if(original.a<.002){gl_FragColor=vec4(0.);return;}
      float reach=.010+attention.x*.035+attention.y*.070+attention.z*.050+activity*.090;
      vec2 flow;
      if(mia){
        // Broad embracing arcs, with a long response/release.
        flow=vec2(sin(p.y*4.+t*.8)-sin(p.y*4.),cos(p.x*3.-t*.65)-cos(p.x*3.));
      }else if(juno){
        // A bend in direction, not rapid jitter or an orbit around the screen.
        flow=vec2(sin(p.y*4.+t)+.25*sin(p.x*5.-t*.7),cos(p.x*4.-t*.85));
        flow-=vec2(sin(p.y*4.)+.25*sin(p.x*5.),cos(p.x*4.));
      }else{
        // A single composed diagonal current.
        float drift=sin(p.y*3.+t*.7)-sin(p.y*3.);
        flow=vec2(drift,drift*.5);
      }
      // Keep source alpha/silhouette separate from the larger internal flow.
      float innerMask=1.-smoothstep(.17,.34,length(maskUV-.5));
      vec2 inside=clamp(maskUV+((maskUV-.5)*attention.y*.08+flow*reach)*innerMask*original.a,0.,1.);
      vec4 moving=texture2D(art,inside);
      float safe=smoothstep(.72,.99,moving.a);
      vec3 color=mix(original.rgb,moving.rgb,safe);
      float light=1.+attention.y*.018+activity*.025;
      color=mix(color,min(vec3(1.),color*light),1.-rest*.55);
      gl_FragColor=vec4(color,original.a);
    }`;
  function nameFor(canvas){return canvas.dataset.aiProfile==='current'?profile:canvas.dataset.aiProfile;}
  function showPoster(s,failed=false){
    if(!s.poster){
      s.poster=new Image();s.poster.loading='lazy';s.poster.decoding='async';s.poster.className=s.canvas.className+' ai-presence-poster';
      s.poster.alt=s.canvas.getAttribute('aria-label')||'';
      if(s.canvas.getAttribute('aria-hidden')==='true')s.poster.alt='';
      s.canvas.before(s.poster);
    }
    const name=nameFor(s.canvas);
    if(s.poster.dataset.profile!==name){s.poster.src=AI_ART_SOURCES[name];s.poster.dataset.profile=name;}
    s.poster.hidden=false;s.canvas.hidden=true;
    if(failed)s.canvas.classList.add('ai-presence-fallback');
  }
  const surfaces=[...root.querySelectorAll('canvas[data-ai-profile]')].map(canvas=>{
    const s={canvas};showPoster(s);
    try{
      const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,powerPreference:'low-power'});
      if(!gl)throw Error('WebGL unavailable');
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
      Object.assign(s,{gl,program,buffer,texture,uniforms:Object.fromEntries(['time','personality','activity','rest','attention'].map(n=>[n,gl.getUniformLocation(program,n)]))});
      s.lostHandler=e=>{e.preventDefault();s.lost=true;showPoster(s,true);};
      canvas.addEventListener('webglcontextlost',s.lostHandler);
      // A lost GPU context retains the same approved artwork as a static image.
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
  function draw(now){
    raf=0;if(destroyed||document.hidden)return;
    if(last&&now-last<32&&!motion.matches){raf=requestAnimationFrame(draw);return;}
    const dt=last?Math.min(.06,(now-last)/1000):0;last=now;
    const input=rms('input'),output=rms('output');
    const speed=profile==='mia'?1.8:profile==='juno'?3.8:2.8;
    inputLevel=approach(inputLevel,input,input>inputLevel?10:speed,dt);
    outputLevel=approach(outputLevel,output,output>outputLevel?10:speed,dt);
    for(const key of stateNames)weights[key]=approach(weights[key],key===state?1:0,state==='idle'||state==='error'?5:14,dt);
    // Integrate tempo. Multiplying an elapsed clock by a new speed would jump the flow.
    clock+=dt*(.22*weights.idle+.42*weights.connecting+.48*weights.listening+.86*weights.thinking+.73*weights.speaking+.12*weights.error);
    idleClock+=dt*.22;
    const energy=outputLevel*weights.speaking+inputLevel*weights.listening;
    let drewSurface=false;
    for(const s of surfaces){
      const {canvas,gl}=s,current=canvas.dataset.aiProfile==='current',name=nameFor(canvas);
      canvas.dataset.profile=name;canvas.dataset.state=current?state:'idle';
      if(s.poster){s.poster.alt=canvas.getAttribute('aria-label')||'';if(s.poster.dataset.profile!==name){s.poster.src=AI_ART_SOURCES[name];s.poster.dataset.profile=name;}}
      if(!gl||s.lost)continue;
      const visible=canvas.hidden&&s.poster&&!s.poster.hidden?s.poster:canvas;
      let box=visible.getBoundingClientRect();
      if(!box.width||!box.height||box.bottom<0||box.top>innerHeight||(visible.checkVisibility&&!visible.checkVisibility()))continue;
      const image=artwork.get(name);
      if(!image){canvas.dataset.ready='false';showPoster(s);ensureArtwork(name);continue;}
      canvas.hidden=false;if(s.poster)s.poster.hidden=true;
      box=canvas.getBoundingClientRect();
      const size=Math.min(440,Math.round(box.width*Math.min(devicePixelRatio||1,1.5)));
      if(canvas.width!==size){canvas.width=size;canvas.height=size;gl.viewport(0,0,size,size);}
      gl.useProgram(s.program);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,s.texture);
      if(s.textureName!==name){
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);s.textureName=name;
      }
      gl.uniform1f(s.uniforms.time,motion.matches?0:current?clock:idleClock);
      gl.uniform1f(s.uniforms.personality,profiles[name]??0);
      gl.uniform1f(s.uniforms.activity,motion.matches?0:current?energy:0);
      gl.uniform1f(s.uniforms.rest,current?weights.error:0);
      gl.uniform4f(s.uniforms.attention,
        motion.matches||!current?0:weights.listening,motion.matches||!current?0:weights.thinking,
        motion.matches||!current?0:weights.speaking,motion.matches||!current?0:weights.connecting);
      gl.drawArrays(gl.TRIANGLES,0,6);canvas.dataset.ready='true';drewSurface=true;
    }
    if(!motion.matches&&drewSurface)raf=requestAnimationFrame(draw);
  }
  function refresh(){if(!raf&&!destroyed)raf=requestAnimationFrame(draw);}
  const pendingArtwork=new Map();
  function ensureArtwork(name){
    if(!pendingArtwork.has(name))pendingArtwork.set(name,loadAIArtwork(name).then(image=>{
      if(!destroyed){artwork.set(name,image);refresh();}
    }).catch(()=>{for(const s of surfaces)if(nameFor(s.canvas)===name)showPoster(s,true);}));
    return pendingArtwork.get(name);
  }
  function setProfile(value){profile=Object.hasOwn(profiles,value)?value:'alex';refresh();}
  function setState(value){state=stateNames.includes(value)?value:'idle';refresh();}
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
    sources.clear();analysers.clear();inputLevel=outputLevel=0;
    const old=context;context=null;old?.close().catch(()=>{});setState('idle');
  }
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;last=0;}else refresh();};
  const changed=()=>{cancelAnimationFrame(raf);raf=0;last=0;refresh();};
  document.addEventListener('visibilitychange',visibility);motion.addEventListener('change',changed);refresh();
  return {get ready(){return ensureArtwork(profile);},setProfile,setState,attachAudio,detachAudio,refresh,destroy(){
    destroyed=true;cancelAnimationFrame(raf);detachAudio();document.removeEventListener('visibilitychange',visibility);motion.removeEventListener('change',changed);
    for(const s of surfaces){s.canvas.removeEventListener('webglcontextlost',s.lostHandler);s.poster?.remove();if(s.gl){s.gl.deleteTexture(s.texture);s.gl.deleteBuffer(s.buffer);s.gl.deleteProgram(s.program);}}
  }};
}
