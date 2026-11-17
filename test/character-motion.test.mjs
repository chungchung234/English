import test from 'node:test';
import assert from 'node:assert/strict';
import {characterPose} from '../web/character-motion.js';
test('speech entry has no fake pulse; actual output changes the silhouette',()=>{
 const silent=characterPose({time:1,weights:{speaking:1}});
 const idle=characterPose({time:1,weights:{idle:1}});
 assert.equal(silent.scaleX,idle.scaleX);assert.equal(silent.scaleY,idle.scaleY);
 const voice=characterPose({time:1,weights:{speaking:1},output:.8});
 assert(voice.scaleY>silent.scaleY);assert(voice.scaleX<silent.scaleX);
});
test('mute removes input response but does not suppress AI output',()=>{
 const options={time:1,weights:{listening:1},muted:true};
 assert.deepEqual(characterPose({...options,input:0}),characterPose({...options,input:1}));
 const speaking={time:1,weights:{speaking:1},output:.8};
 assert.deepEqual(characterPose(speaking),characterPose({...speaking,muted:true}));
});
test('attention and recovery states remain visually distinct without voice',()=>{
 const listening=characterPose({time:1,weights:{listening:1}});
 const thinking=characterPose({time:1,weights:{thinking:1}});
 const connecting=characterPose({time:1,weights:{connecting:1}});
 const error=characterPose({time:1,weights:{error:1}});
 assert(thinking.gazeY>listening.gazeY);assert(thinking.scaleY<listening.scaleY);
 assert.notDeepEqual(connecting,listening);assert.equal(error.scaleX,1);assert.equal(error.tilt,0);
 assert(error.leftOpen<listening.leftOpen);
});
test('reduced motion and ending stay neutral regardless of state/audio',()=>{
 const neutral=characterPose({reduced:true});
 for(const profile of ['alex','mia','juno'])for(const time of [0,3.6,8.7]){
  assert.deepEqual(characterPose({profile,time,weights:{speaking:1},input:1,output:1,reduced:true}),neutral);
  assert.deepEqual(characterPose({profile,time,weights:{speaking:1},output:1,paused:true}),neutral);
 }
});
test('gestures hold their expression, then return to rest',async()=>{
 const {gestureBeat}=await import('../web/character-motion.js');
 assert.equal(gestureBeat(.5),1);assert.equal(gestureBeat(1),1);
 assert.equal(gestureBeat(2),0);assert.equal(gestureBeat(4),0);
 const heldA=characterPose({profile:'alex',time:.6,weights:{listening:1}});
 const heldB=characterPose({profile:'alex',time:.9,weights:{listening:1}});
 assert.equal(heldA.gazeX,heldB.gazeX);assert.equal(heldA.tilt,heldB.tilt);
 assert.equal(characterPose({time:2,weights:{listening:1}}).gazeX,0);
});
test('eyes lead the body; each character has a distinct eye vocabulary',()=>{
 const early=characterPose({time:.25,weights:{listening:1}});
 const later=characterPose({time:.35,weights:{listening:1}});
 assert(early.gazeX>0);assert(Math.abs(early.tilt)<1e-8);assert(later.tilt>early.tilt);
 const alex=characterPose({profile:'alex',time:.8,weights:{thinking:1}});
 const mia=characterPose({profile:'mia',time:.8,weights:{listening:1}});
 const juno=characterPose({profile:'juno',time:.8,weights:{listening:1}});
 assert(alex.leftOpen<.6&&alex.eyeWidth>1,'Alex has small rounded thinking eyes');
 assert(mia.eyeCurve>.02&&mia.eyeTurn>1,'Mia has curved eyes');
 assert(juno.eyeTurn>1&&juno.eyeCurve===0,'Juno has sideways oval eyes');
});
