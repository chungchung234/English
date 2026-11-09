import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function bundleWeb({minify=false}={}){
 const result=await build({absWorkingDir:root,entryPoints:['web/app.js'],bundle:true,write:false,
  platform:'browser',format:'esm',target:'es2022',minify,legalComments:'none',logLevel:'silent'});
 // Safe to embed under the HTML script element with a CSP hash.
 return result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
}
