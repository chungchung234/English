import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const port=Number(process.env.PORT||4173);
http.createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(pathname==='/public-config.js'&&process.env.PUBLIC_SUPABASE_KEY){const {validatePublicConfig}=await import('../src/public-config.mjs');const config=validatePublicConfig(process.env.PUBLIC_SUPABASE_URL,process.env.PUBLIC_SUPABASE_KEY);res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end('globalThis.LOOP_PUBLIC_CONFIG='+JSON.stringify(config)+';');return;}
  const built=pathname==='/built'||pathname.startsWith('/built/');
  const builtPath=pathname.slice('/built'.length);
  const location=built?path.join(root,'dist',builtPath===''||builtPath==='/'?'index.html':builtPath):pathname.startsWith('/src/')?path.join(root,pathname):path.join(root,'web',pathname==='/'?'index.html':pathname);
  const permitted=built?path.join(root,'dist'):[pathname.startsWith('/src/')?'src':'web'].map(dir=>path.join(root,dir))[0];
  if(!location.startsWith(permitted+path.sep))throw Error('Not found');
  const data=await readFile(location);
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'}[path.extname(location)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Permissions-Policy':'microphone=(self)'});res.end(data);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Local validation server on port ${port}`));
