import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationMemoryDelivery} from '../src/conversation-memory.js';
function harness(prepare){
 let time=0,user='owner',isBusy=false,next=0;const scheduled=new Map(),calls=[];
 const delivery=createConversationMemoryDelivery({identity:()=>user,busy:()=>isBusy,now:()=>time,prepare:async body=>{calls.push(body);return prepare(body);},timers:{setTimeout(fn,delay){scheduled.set(++next,{fn,at:time+delay});return next;},clearTimeout(id){scheduled.delete(id);}}});
 async function run(){const [id,task]=[...scheduled].sort((a,b)=>a[1].at-b[1].at)[0]||[];assert(task,'expected a pending delivery');scheduled.delete(id);time=task.at;task.fn();await new Promise(resolve=>setImmediate(resolve));}
 return {delivery,calls,scheduled,run,setUser:value=>user=value,setBusy:value=>isBusy=value,get time(){return time;}};
}
test('background preparation yields to live calls, serializes companions and coalesces repeated history loads',async()=>{
 const h=harness(()=>({status:'ready'}));h.setBusy(true);h.delivery.wake(['alex','mia','alex']);await h.run();assert.equal(h.calls.length,0);h.setBusy(false);await h.run();assert.deepEqual(h.calls,[{companionId:'alex'}]);await h.run();assert.equal(h.calls.length,2);h.delivery.wake(['alex']);assert.equal(h.scheduled.size,0);
});
test('persisted server backoff survives repeated wakeups and controls the next attempt',async()=>{
 let n=0;const h=harness(()=>++n===1?{status:'retry_wait',retry_at:new Date(120_000).toISOString()}:{status:'ready'});
 h.delivery.wake(['mia']);await h.run();h.delivery.wake(['mia']);await h.run();assert.equal(h.time,120_000);assert.equal(h.calls.length,2);assert.equal(h.scheduled.size,0);
});
test('sign-out and account changes discard pending responses and cannot schedule work for the old account',async()=>{
 let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));h.delivery.wake(['alex']);await h.run();h.setUser(null);finish({status:'retry_wait',retry_at:new Date(60_000).toISOString()});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.scheduled.size,0);
 h.setUser('other');h.delivery.wake(['mia']);await h.run();assert.equal(h.calls.at(-1).companionId,'mia');h.delivery.clear();finish({status:'ready'});
});
test('delivery bounds transport retries and never automatically retries forbidden access',async()=>{
 const h=harness(()=>{throw Error('network');});h.delivery.wake(['juno']);for(let n=0;n<3;n++)await h.run();assert.equal(h.calls.length,3);assert.equal(h.scheduled.size,0);
 const forbidden=harness(()=>{throw Object.assign(Error('forbidden'),{status:403});});forbidden.delivery.wake(['alex']);await forbidden.run();assert.equal(forbidden.scheduled.size,0);
});
