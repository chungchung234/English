import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createOutbox,flushOutbox,flushOutboxSession} from '../src/outbox.js';
function fixture(records){let data=structuredClone(records);return{
 list:async scope=>structuredClone(data.filter(x=>x.scope===scope)),
 put:async row=>{data=data.filter(x=>x.id!==row.id);data.push(structuredClone(row));},
 removeAcknowledged:async records=>{data=data.filter(row=>!records.some(expected=>isDeepStrictEqual(row,expected)));},
 data:()=>structuredClone(data)
};}
const event=(id,sessionId='s',scope='user-a')=>({id,sessionId,scope,event:{id,text:'hello',occurred_at:'2026-11-15T00:00:00.000Z'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('failed cloud write retains local data and retry uses identical IDs',async()=>{const box=fixture([event('a'),event('b')]);let first;await assert.rejects(flushOutbox(box,'user-a',async(s,events)=>{first=events;throw Error('offline');}),/offline/);assert.equal(box.data().length,2);await flushOutbox(box,'user-a',async(s,events)=>assert.deepEqual(events,first));assert.equal(box.data().length,0);});
test('acknowledged batch only is removed; different account and unsent batch remain',async()=>{const rows=Array.from({length:51},(_,n)=>event('a'+n));rows.push(event('private','s','user-b'));const box=fixture(rows);let n=0;await assert.rejects(flushOutbox(box,'user-a',async()=>{if(++n===2)throw Error('network lost');}));assert.deepEqual(box.data().map(e=>e.id),['a50','private']);});
test('outbox is partitioned by session as well as account',async()=>{const box=fixture([event('a','s1'),event('b','s2'),event('x','s1','user-b')]);const calls=[];await flushOutbox(box,'user-a',async(s,events)=>calls.push([s,events.map(e=>e.id)]));assert.deepEqual(calls,[['s1',['a']],['s2',['b']]]);assert.equal(box.data()[0].scope,'user-b');});
test('empty and pending queues sync without Map.groupBy while preserving account and session boundaries',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(Map,'groupBy');Object.defineProperty(Map,'groupBy',{configurable:true,value:undefined});
 try{
  assert.equal(await flushOutbox(fixture([]),'user-a',async()=>assert.fail('empty queues must not send')),0);
  const box=fixture([event('a','s1'),event('b','s2'),event('c','s1'),event('private','s1','user-b')]),sent=[];
  assert.equal(await flushOutbox(box,'user-a',async(session,events)=>sent.push([session,events.map(row=>row.id)])),0);
  assert.deepEqual(sent,[['s1',['a','c']],['s2',['b']]]);assert.deepEqual(box.data().map(row=>row.id),['private']);
 }finally{if(descriptor)Object.defineProperty(Map,'groupBy',descriptor);else delete Map.groupBy;}
});

test('session flush selects only the requested account, session and source IDs',async()=>{
 const rows=[event('current','live'),event('unneeded','live'),event('old','old'),event('private','live','user-b')];
 const box=fixture(rows),sent=[];
 assert.equal(await flushOutboxSession(box,'user-a','live',async(session,events)=>sent.push([session,events.map(row=>row.id)]),{eventIds:['current']}),0);
 assert.deepEqual(sent,[['live',['current']]]);assert.deepEqual(box.data().map(row=>row.id),['unneeded','old','private']);
 assert.equal(await flushOutboxSession(box,'user-a','live',async()=>assert.fail('an empty source list cannot send'),{eventIds:[]}),0);
 assert.equal(await flushOutboxSession(box,'user-a','absent',async()=>assert.fail('a different session cannot send')),0);
});

test('current-session ACK does not join a held older-session flush and duplicate sends keep exact payloads',async()=>{
 const original=event('current','live'),box=fixture([event('older','old'),original,event('private','live','user-b')]);
 const entered=deferred(),release=deferred(),accepted=new Map(),currentSends=[];let backgroundFinished=false;
 const send=async(session,events)=>{
  if(session==='old'){entered.resolve();await release.promise;}
  for(const row of events){const prior=accepted.get(row.id);if(prior)assert.deepEqual(row,prior);else accepted.set(row.id,structuredClone(row));}
  if(session==='live')currentSends.push(structuredClone(events));
 };
 const background=flushOutbox(box,'user-a',send).then(value=>{backgroundFinished=true;return value;});
 await entered.promise;
 try{
  assert.equal(await flushOutboxSession(box,'user-a','live',send,{eventIds:['current']}),0);
  assert.equal(backgroundFinished,false,'the unrelated network request remains held');
  assert.deepEqual(box.data().map(row=>row.id),['older','private']);
 }finally{release.resolve();}
 assert.equal(await background,0);
 assert.deepEqual(currentSends,[[original.event],[original.event]],'the stale global snapshot retries only the identical UUID and payload');
 assert.deepEqual(box.data().map(row=>row.id),['private']);
});

test('a session failure retains its unacknowledged batch and does not send another session',async()=>{
 const live=Array.from({length:51},(_,i)=>event('a'+i,'live'));
 const box=fixture([event('old','old'),...live,event('private','live','user-b')]);let requests=0;
 await assert.rejects(flushOutboxSession(box,'user-a','live',async(session,events)=>{
  assert.equal(session,'live');assert(events.length<=50);if(++requests===2)throw Error('offline');
 }),/offline/);
 assert.equal(requests,2);assert.deepEqual(box.data().map(row=>row.id),['old','a50','private']);
});

test('a pending ACK never removes newly enqueued rows or a replacement payload',async()=>{
 for(const flush of [
  (box,send)=>flushOutbox(box,'user-a',send),
  (box,send)=>flushOutboxSession(box,'user-a','live',send)
 ]){
  const original=event('same','live'),replacement={...original,event:{...original.event,text:'new local payload'}};
  const box=fixture([original]),entered=deferred(),release=deferred();
  const flight=flush(box,async()=>{entered.resolve();await release.promise;});await entered.promise;
  await box.put(replacement);await box.put(event('new','live'));release.resolve();
  assert.equal(await flight,2);assert.deepEqual(box.data(),[replacement,event('new','live')]);
 }
});

test('the sent payload cannot mutate the acknowledged snapshot while a replacement is queued',async()=>{
 const original=event('same','live'),replacement={...original,event:{...original.event,text:'replacement'}};
 const box=fixture([original]),entered=deferred(),release=deferred();
 const flight=flushOutboxSession(box,'user-a','live',async(_session,events)=>{
  assert.deepEqual(structuredClone(events),[original.event]);entered.resolve();await release.promise;
  assert.throws(()=>{events[0].text='replacement';},TypeError);
  assert.throws(()=>{events.splice(0,1);},TypeError);
 });
 await entered.promise;await box.put(replacement);release.resolve();assert.equal(await flight,1);assert.deepEqual(box.data(),[replacement]);
});

test('session flush rejects malformed selection before sending and rechecks scope even for a loose store',async()=>{
 const box=fixture([]),send=async()=>assert.fail('invalid selections cannot send');
 await assert.rejects(flushOutboxSession(box,'user-a','',send),TypeError);
 await assert.rejects(flushOutboxSession(box,'user-a','live',send,{eventIds:['']}),TypeError);
 await assert.rejects(flushOutboxSession(box,'user-a','live',send,{eventIds:'current'}),TypeError);
 const loose=fixture([event('current','live'),event('private','live','user-b')]);loose.list=async()=>loose.data();
 const sent=[];assert.equal(await flushOutboxSession(loose,'user-a','live',async(_session,events)=>sent.push(events.map(row=>row.id))),0);
 assert.deepEqual(sent,[['current']]);assert.deepEqual(loose.data().map(row=>row.id),['private']);
});

// Async IndexedDB stand-in: tests exercise the actual queue API's get/compare/
// delete callbacks. Native IndexedDB supplies readwrite transaction isolation.
function fakeIndexedDB(){
 const databases=new Map();
 return{open(name){const request={};queueMicrotask(()=>{
  let db=databases.get(name);
  if(!db){const stores=new Map();db={
   createObjectStore(storeName,{keyPath}){stores.set(storeName,{keyPath,rows:new Map()});},
   transaction(storeName){const data=stores.get(storeName);let pending=0,scheduled=false;
    const tx={error:null,aborted:false,abort(){this.aborted=true;this.error??=Error('Transaction aborted');queueMicrotask(()=>this.onabort?.());}};
    const settle=()=>{if(pending||scheduled||tx.aborted)return;scheduled=true;setTimeout(()=>{scheduled=false;if(!pending&&!tx.aborted)tx.oncomplete?.();},0);};
    const operation=run=>{const req={};pending++;setTimeout(()=>{try{if(!tx.aborted){req.result=run();req.onsuccess?.();}}catch(error){tx.error=error;req.error=error;req.onerror?.();tx.onerror?.();tx.aborted=true;tx.onabort?.();}finally{pending--;settle();}},0);return req;};
    return{get error(){return tx.error;},set oncomplete(fn){tx.oncomplete=fn;settle();},set onerror(fn){tx.onerror=fn;},set onabort(fn){tx.onabort=fn;},objectStore(){return{
     get:id=>operation(()=>structuredClone(data.rows.get(id))),getAll:()=>operation(()=>[...data.rows.values()].map(row=>structuredClone(row))),
     put:row=>operation(()=>data.rows.set(row[data.keyPath],structuredClone(row))),delete:id=>operation(()=>data.rows.delete(id))
    };}};
   }
  };databases.set(name,db);request.result=db;request.onupgradeneeded?.();}else request.result=db;request.onsuccess?.();
 });return request;}};
}

test('actual queue conditional ACK removal includes scope, session and complete event content',async()=>{
 const db=fakeIndexedDB(),box=createOutbox('conditional-ack',{indexedDBImpl:db});
 const original=event('same','live');
 for(const replacement of [
  {...original,scope:'user-b'}, {...original,sessionId:'other'}, {...original,event:{...original.event,text:'replacement'}}
 ]){
  await box.put(original);await box.put(replacement);assert.equal(await box.removeAcknowledged([original]),0);
  const reopened=createOutbox('conditional-ack',{indexedDBImpl:db});assert.deepEqual(await reopened.list(replacement.scope),[replacement]);
  assert.equal(await reopened.removeAcknowledged([replacement]),1);assert.deepEqual(await reopened.list(replacement.scope),[]);
 }
 const reordered={event:{occurred_at:original.event.occurred_at,text:original.event.text,id:original.id},scope:original.scope,sessionId:original.sessionId,id:original.id};
 await box.put(reordered);assert.equal(await box.removeAcknowledged([original]),1,'property order does not change the acknowledged record');
});
