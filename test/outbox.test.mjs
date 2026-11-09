import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flushOutbox} from '../src/outbox.js';
function fixture(records){let data=structuredClone(records);return{list:async scope=>data.filter(x=>x.scope===scope),remove:async ids=>{data=data.filter(x=>!ids.includes(x.id));},data:()=>data};}
const event=(id,sessionId='s',scope='user-a')=>({id,sessionId,scope,event:{id,text:'hello'}});
test('failed cloud write retains local data and retry uses identical IDs',async()=>{const box=fixture([event('a'),event('b')]);let first;await assert.rejects(flushOutbox(box,'user-a',async(s,events)=>{first=events;throw Error('offline');}),/offline/);assert.equal(box.data().length,2);await flushOutbox(box,'user-a',async(s,events)=>assert.deepEqual(events,first));assert.equal(box.data().length,0);});
test('acknowledged batch only is removed; different account and unsent batch remain',async()=>{const rows=Array.from({length:51},(_,n)=>event('a'+n));rows.push(event('private','s','user-b'));const box=fixture(rows);let n=0;await assert.rejects(flushOutbox(box,'user-a',async()=>{if(++n===2)throw Error('network lost');}));assert.deepEqual(box.data().map(e=>e.id),['a50','private']);});
test('outbox is partitioned by session as well as account',async()=>{const box=fixture([event('a','s1'),event('b','s2'),event('x','s1','user-b')]);const calls=[];await flushOutbox(box,'user-a',async(s,events)=>calls.push([s,events.map(e=>e.id)]));assert.deepEqual(calls,[['s1',['a']],['s2',['b']]]);assert.equal(box.data()[0].scope,'user-b');});
