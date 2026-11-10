import test from 'node:test';
import assert from 'node:assert/strict';
import { clientBuild, telemetryMetadata, createConnectedTelemetry, createTelemetryDiagnostics } from '../src/learning-telemetry.mjs';

const eventId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const metadata={client_build:'source:1234567890abcdef12345678',telemetry_schema:1};
const occurredAt='2026-11-10T12:00:00.000Z';
function scheduler(){
  const timers=new Map();let next=0;
  return { setTimer(fn,delay){const id=++next;timers.set(id,{fn,delay});return id;},clearTimer(id){timers.delete(id);},
    get delays(){return [...timers.values()].map(timer=>timer.delay);},
    async run(){const [id,timer]=timers.entries().next().value||[];assert(timer,'expected a scheduled retry');timers.delete(id);timer.fn();await new Promise(resolve=>setImmediate(resolve));} };
}
const receiptOptions={randomUUID:()=>eventId,now:()=>occurredAt};

test('RTC observation alone creates one immutable receipt; local failure retries without a second connected event',async()=>{
  const clock=scheduler(),records=[],stages=[];let stored=false,resolveWrite;
  const delivery=createConnectedTelemetry({sessionId,metadata,isCurrent:()=>true,receiptOptions,...clock,
    enqueue:async receipt=>{records.push(receipt);if(records.length===1)return false;return await new Promise(resolve=>{resolveWrite=resolve;});},
    onStage:stage=>stages.push(stage),onPersisted:()=>{stored=true;}});
  for(const state of ['new','connecting','checking','disconnected'])assert.equal(await delivery.observe(state),false);
  assert.equal(records.length,0,'an SDP answer or checking state is not RTC connection evidence');
  assert.equal(await delivery.observe('connected'),false);
  assert.equal(stored,false);assert.equal(delivery.state.stage,'created');assert.deepEqual(clock.delays,[250]);
  await delivery.observe('connected');assert.equal(records.length,1,'duplicate observation must not overlap the scheduled retry');
  await clock.run();assert.equal(records.length,2);assert.equal(stored,false,'in-flight write is not durable success');
  await delivery.observe('connecting');
  resolveWrite(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stored,true);assert.equal(delivery.state.stage,'device_persisted');assert.equal(clock.delays.length,0);
  assert.strictEqual(records[0],records[1]);assert.equal(records[0].eventId,eventId);assert.equal(records[0].occurredAt,occurredAt);
  assert(Object.isFrozen(records[0]));assert(Object.isFrozen(records[0].metadata));
  await delivery.observe('connected');assert.equal(records.length,2);
  assert.equal(stages.at(-1).stage,'device_persisted');
});

test('storage retries are bounded and stale calls/accounts cannot record success or schedule another write',async()=>{
  const clock=scheduler();let active=true,calls=0,stored=false;
  const delivery=createConnectedTelemetry({sessionId,metadata,receiptOptions,isCurrent:()=>active,...clock,
    enqueue:async()=>{calls++;throw Error('temporary storage failure');},onPersisted:()=>{stored=true;}});
  await delivery.observe('connected');
  for(const delay of [250,1000,3000,8000]){assert.deepEqual(clock.delays,[delay]);await clock.run();}
  assert.equal(calls,5);assert.equal(stored,false);assert.deepEqual(clock.delays,[]);
  await delivery.observe('connected');assert.equal(calls,5,'repeated RTC notifications cannot reset the budget');
  active=false;
  const otherClock=scheduler();let resolveWrite;
  const stale=createConnectedTelemetry({sessionId,metadata,receiptOptions,isCurrent:()=>active,...otherClock,
    enqueue:()=>new Promise(resolve=>{resolveWrite=resolve;}),onPersisted:()=>{stored=true;}});
  assert.equal(await stale.observe('connected'),false);
  active=true;const waiting=stale.observe('connected');active=false;resolveWrite(true);await waiting;
  assert.equal(stored,false);assert.deepEqual(otherClock.delays,[]);
  active=true;let afterEnd=0;
  const ended=createConnectedTelemetry({sessionId,metadata,receiptOptions,isCurrent:()=>active,...otherClock,enqueue:async()=>{afterEnd++;return false;}});
  await ended.observe('connected');ended.stop();assert.deepEqual(otherClock.delays,[]);
  await ended.observe('connected');assert.equal(afterEnd,1);
});

test('metadata allowlist and account-scoped diagnostic journal never retain caller content or downgrade acknowledgements',()=>{
  const unsafe={...metadata,text:'private speech',token:'secret',email:'owner@example.com',sdp:'offer'};
  assert.deepEqual(telemetryMetadata(unsafe),metadata);
  for(const value of ['owner@example.com','git:abc with speech','source:bad',''])assert.equal(clientBuild(value),'dev:unversioned');
  assert.equal(clientBuild('git:abcdef1234567'),'git:abcdef1234567');
  const rows=new Map(),storage={getItem:key=>rows.get(key),setItem:(key,value)=>rows.set(key,value)};
  let scope='https://example.com|account-a';
  const journal=createTelemetryDiagnostics({getScope:()=>scope,storage,now:()=>occurredAt,limit:2});
  const value={eventId,sessionId,metadata:unsafe,occurredAt,text:'private speech',token:'secret',email:'owner@example.com'};
  journal.record({...value,stage:'created',reason:'storage',attempts:1});
  journal.record({...value,stage:'device_persisted'});journal.record({...value,stage:'server_ack'});
  journal.record({...value,stage:'created'});
  assert.equal(journal.list()[0].stage,'server_ack');
  for(const privateValue of ['private speech','secret','owner@example.com','offer'])assert(!JSON.stringify([...rows.values()]).includes(privateValue));
  scope='https://example.com|account-b';assert.deepEqual(journal.list(),[]);
  journal.record({...value,stage:'created'});assert.equal(journal.list()[0].stage,'created');
  scope=null;assert.deepEqual(journal.list(),[]);journal.record({...value,stage:'server_ack'});
  scope='https://example.com|account-a';assert.equal(journal.list()[0].stage,'server_ack');
  const broken=createTelemetryDiagnostics({getScope:()=>scope,storage:{getItem(){throw Error('denied');},setItem(){throw Error('denied');}}});
  assert.doesNotThrow(()=>broken.record({...value,stage:'created'}));assert.deepEqual(broken.list(),[]);
});
