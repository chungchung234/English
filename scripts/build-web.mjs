import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validatePublicConfig } from '../src/public-config.mjs';
const root=new URL('../',import.meta.url),read=path=>readFile(new URL(path,root),'utf8');
const url=process.env.PUBLIC_SUPABASE_URL,key=process.env.PUBLIC_SUPABASE_KEY;
const config=url&&key?validatePublicConfig(url,key):null;
if((url||key)&&!config)throw Error('Set both PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_KEY.');
if(process.argv.includes('--require-config')&&!config)throw Error('Public hosting build requires Supabase public URL and key.');
const json=JSON.stringify(config).replaceAll('<','\\u003c');
const shared=(await read('web/ai-presence.js')).replaceAll('export ','')+'\n'+(await read('src/outbox.js')).replaceAll('export ','')+'\n'+(await read('src/public-config.mjs')).replaceAll('export ','');
const js=(await read('web/app.js')).replace(/^import .*?;\n/gm,'');
const script=`globalThis.LOOP_PUBLIC_CONFIG=${json};\n${shared}\n${js}`;
const style=await read('web/style.css');
const hash=text=>createHash('sha256').update(text).digest('base64');
const policy=`default-src 'self'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'`;
let html=(await read('web/index.html')).replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,`<meta http-equiv="Content-Security-Policy" content="${policy}">`)
.replace('<link rel="stylesheet" href="style.css">',`<style>${style}</style>`)
.replace('<script src="public-config.js"></script><script type="module" src="app.js"></script>',`<script type="module">${script}</script>`);
const assetPaths=[...new Set([...html.matchAll(/src="(assets\/[^"]+)"/g)].map(match=>match[1]))];
for(const asset of assetPaths){
 const ext=asset.split('.').pop();const type=({svg:'image/svg+xml',png:'image/png',webp:'image/webp'})[ext];
 if(!type)throw Error('Unsupported image type');
 const data=await readFile(new URL('web/'+asset,root));
 html=html.replaceAll('src="'+asset+'"','src="data:'+type+';base64,'+data.toString('base64')+'"');
}
await mkdir(new URL('dist/',root),{recursive:true});
await writeFile(new URL('dist/index.html',root),html);
await rm(new URL('dist/loop-artifact.html',root),{force:true});
await writeFile(new URL('dist/_headers',root),`/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: microphone=(self)\n`);
console.log(`Built public website: dist/index.html (${Buffer.byteLength(html)} bytes; connection ${config?'configured':'pending'})`);

await writeFile(new URL('dist/THIRD_PARTY_LICENSES.txt',root),await read('web/assets/PHOSPHOR-LICENSE'));
