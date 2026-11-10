import { test } from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechSpeed} from '../web/speech-speed.js';
function harness(options={}) {
  const sent=[],applied=[],errors=[];
  const control=createSpeechSpeed({send:event=>sent.push(event),applied:value=>applied.push(value),failed:message=>errors.push(message),...options});
  const ack=value=>control.event({type:'session.updated',session:{audio:{output:{speed:value}}}});
  return {control,sent,applied,errors,ack};
}
test('speed waits for generation and playback to finish, coalesces drafts, and requires matching acknowledgement',()=>{
  const {control,sent,applied,ack}=harness();
  control.availability(true,true);control.request(.85);control.request(.9);
  assert.equal(sent.length,0);assert.equal(control.state.applied,1);
  control.availability(true,false);assert.equal(sent.length,1);assert.equal(sent[0].session.audio.output.speed,.9);
  ack(1);assert.equal(control.state.pending,true);assert.deepEqual(applied,[]);
  ack(.9);assert.deepEqual(applied,[.9]);assert.equal(control.state.pending,false);control.dispose();
});
test('late settings errors and timeout never consume unrelated errors or keep a stale call alive',async()=>{
  const {control,sent,errors,ack}=harness({timeoutMs:10});control.availability(true,false);control.request(.85);
  assert.equal(control.event({type:'error',error:{event_id:'not-ours'}}),false);
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(errors.length,1);assert.equal(control.state.applied,1);
  ack(.85);assert.equal(control.state.applied,.85,'late server acknowledgement remains the truth');
  control.dispose();assert.equal(control.event({type:'error',error:{event_id:sent[0].event_id}}),true);
  assert.equal(control.request(.75),false);assert.equal(sent.length,1);
});
test('rejected speed can be retried, and disconnected/ended calls do not send queued updates',()=>{
  const {control,sent,errors,ack}=harness();
  control.availability(true,false);control.request(.85);
  assert.equal(control.event({type:'error',error:{event_id:sent[0].event_id}}),true);
  assert.equal(errors.length,1);assert.equal(control.state.applied,1);assert.equal(control.state.pending,false);
  control.request(.85);ack(.85);assert.equal(control.state.applied,.85);
  control.availability(false,false);control.request(1.15);assert.equal(sent.length,2);
  control.dispose();control.availability(true,false);assert.equal(sent.length,2);
});
