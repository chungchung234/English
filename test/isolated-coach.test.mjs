import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isolatedCoach} from '../scripts/isolated-coach-check.mjs';

test('isolated deployment packages the transitive coach modules and cleans only its test scope',async()=>{
 const original=globalThis.fetch,seen=[],sources=new Map(),pending=['index.ts'];
 while(pending.length){const name=pending.pop();if(sources.has(name))continue;const source=await readFile('supabase/functions/coach/'+name,'utf8');sources.set(name,source);for(const match of source.matchAll(/from ['"]\.\/([^'"]+\.ts)['"]/g))pending.push(match[1]);}
 const user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(url);seen.push({path:parsed.pathname,method:options.method});
  if(parsed.pathname.endsWith('/functions/deploy')){
   const files=options.body.getAll('file'),names=files.map(file=>file.name);
   for(const [name,source] of sources){assert(names.includes(name),'Missing transitive TypeScript module');const text=await files.find(f=>f.name===name).text();if(name==='index.ts'){assert(text.includes(user));assert(text.includes("const mode='public'"));}else assert.equal(text,source);}
   return new Response(JSON.stringify({status:'ACTIVE'}),{status:200});
  }
  if(parsed.pathname.endsWith('/database/query')){const body=JSON.parse(options.body);assert(body.query.includes("email like '%@example.invalid'"));assert(!body.query.includes('ACCESS_MODE'));return new Response('[]',{status:200});}
  assert.match(parsed.pathname,/\/functions\/coach-check-[a-f0-9]+$/);assert.equal(options.method,'DELETE');return new Response('{}',{status:200});
 };
 try{const check=await isolatedCoach('domkmxmwmihcfadophfg',[user]);await check.cleanup();assert.equal(seen.filter(x=>x.path.endsWith('/database/query')).length,2);assert.equal(seen.filter(x=>x.method==='DELETE').length,1);}finally{globalThis.fetch=original;}
});
