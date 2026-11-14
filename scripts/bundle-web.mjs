import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const digest=source=>createHash('sha256').update(source).digest('hex');

export function resolveBuildSiteUrl(env=process.env){
 let site=env.BUILD_SITE_URL;
 if(!site&&env.GITHUB_REPOSITORY){
  const parts=env.GITHUB_REPOSITORY.split('/');
  if(parts.length!==2||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0])||!/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])||['.','..'].includes(parts[1]))throw Error('GITHUB_REPOSITORY must identify a GitHub owner and repository.');
  const [owner,repository]=parts;
  site=`https://${owner.toLowerCase()}.github.io/${repository.toLowerCase()===owner.toLowerCase()+'.github.io'?'':repository+'/'}`;
 }
 if(!site)throw Error('Set BUILD_SITE_URL for a local/custom hosting build; GitHub Pages CI uses GITHUB_REPOSITORY.');
 let url;try{url=new URL(site);}catch{throw Error('BUILD_SITE_URL must be an absolute site URL.');}
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!loopback)||url.username||url.password||/[?#\s;&'"<>\\]/.test(url.href))throw Error('BUILD_SITE_URL must be a secure site URL without credentials, query, or fragment; local loopback HTTP is supported.');
 if(!url.pathname.endsWith('/'))url.pathname+='/';
 return url.href;
}

export async function bundleVerifiedPcmWorklet({minify=false}={}){
 const result=await build({absWorkingDir:root,entryPoints:['web/verified-pcm-worklet.js'],bundle:true,write:false,
  platform:'browser',format:'esm',target:'es2022',minify,legalComments:'none',logLevel:'silent'});
 const source=result.outputFiles[0].text,sha256=digest(source);
 return Object.freeze({source,sha256,asset:`assets/verified-pcm-worklet.${sha256.slice(0,12)}.js`});
}

export function pcmWorkletMetadata(worklet,siteUrl){
 if(!/^[a-f0-9]{64}$/.test(worklet?.sha256)||worklet.asset!==`assets/verified-pcm-worklet.${worklet.sha256.slice(0,12)}.js`)throw Error('Invalid verified PCM Worklet asset.');
 return Object.freeze({url:new URL(worklet.asset,siteUrl).href,sha256:worklet.sha256});
}

export async function bundleWeb({minify=false,workletAsset=null}={}){
 const result=await build({absWorkingDir:root,entryPoints:['web/app.js'],bundle:true,write:false,
  platform:'browser',format:'esm',target:'es2022',minify,legalComments:'none',logLevel:'silent'});
 const prefix=workletAsset?`globalThis.LOOP_PCM_WORKLET_ASSET=Object.freeze(${JSON.stringify(workletAsset)});\n`:'';
 // Safe to embed under the HTML script element with a CSP hash.
 return (prefix+result.outputFiles[0].text).replace(/<\/script/gi,'<\\/script');
}
