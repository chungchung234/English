import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {planSpeechSegments,runSpeechSegments,segmentedSynthesisReservation,MAX_SPEECH_SEGMENTS,speechSegmentNonce} from './authored-segments.ts';
import {fidelityTokens,MAX_PCM_BYTES,SYNTHESIS_OUTPUT_CAP,textDigest,verifySpeechCapture} from './verified-speech.ts';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const text='I like the crooked edge. The paper moon feels more interesting that way.';
const owner={scope:'https://synthetic.supabase.co|synthetic-owner',sessionId:'session',companionId:'alex',callEpoch:1,turnNonce:'parent-nonce',turnId:'turn',assistantEventId:'assistant',authorityGeneration:1,expectedMemoryRevision:0,playbackEpoch:1};
const binding={nonce:owner.turnNonce,voice:'cedar',speed:.85,key:'fixture-private-key'};
const gate=()=>{let resolve;const promise=new Promise(accept=>{resolve=accept;});return{promise,resolve};};
async function until(check){const end=Date.now()+2000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,1));}throw Error('Held segment did not arrive.');}
async function setup(options={}){
 const plan=await planSpeechSegments(options.text??text),parts=[],requests=[],prepared=[],trace=[];let dispatches=0;
 const config={text:options.text??text,plan,binding:{...binding,...options.binding},owner,synthesisId:'one-parent-job',deadlineMs:options.deadlineMs,
  dispatch:async()=>{dispatches++;trace.push('guard');await options.guard?.(dispatches);},
  onBegin:()=>{assert.equal(trace.at(-1),'guard');trace.push('begin');options.begin?.();},
  onPart:part=>{assert.equal(trace.at(-1),'guard');parts.push(part);trace.push('emit');options.part?.(part);},
  prepare:partBinding=>{
   const index=prepared.length,record={binding:partBinding,disposed:false};prepared.push(record);
   return{ready:options.ready?.(index)??Promise.resolve(),generate:async request=>{assert(['guard','begin'].includes(trace.at(-1)));requests.push(request);trace.push('generate');const pcm=options.pcm?.(index)??new Uint8Array([index+1,0,index+2,0]);return{pcm,transcript:options.transcript?.(index,request.text)??request.text,finalTranscript:request.text,protocolVerified:true,usage:options.usage?options.usage(index,request.maxOutputTokens):{input_tokens:10,output_tokens:100,total_tokens:110}};},dispose:async()=>{record.disposed=true;}};
  }};
 return{plan,parts,requests,prepared,trace,config,get dispatches(){return dispatches;},run:()=>runSpeechSegments(config)};
}

test('natural transport plan preserves exact Unicode/whitespace bytes, names, all sentences and lexical values',async()=>{
 for(const source of ['\n I met Dr. Smith. It cost 3.14 dollars.\n한글도 남아요!','\ufeffHello! “That was odd,” I said.  ',text,'One long thought without sentence punctuation','I used 3. 5 dollars was the other price.']){
  const plan=await planSpeechSegments(source),bytes=encoder.encode(source),pieces=plan.parts.map((part,index)=>{assert.equal(part.index,index);assert.equal(part.startByte,index?plan.parts[index-1].endByte:0);const piece=decoder.decode(bytes.subarray(part.startByte,part.endByte));assert.equal(part.textSha256,digest(encoder.encode(piece)));return piece;});
  assert.equal(pieces.join(''),source);assert.equal(plan.textByteLength,bytes.length);assert.equal(plan.parts.at(-1).endByte,bytes.length);assert.equal(plan.textSha256,await textDigest(source));assert.deepEqual(pieces.flatMap(fidelityTokens),fidelityTokens(source));
  if(source.includes('Dr.'))assert(pieces[0].includes('Dr. Smith.'));
 }
 const many=Array.from({length:60},(_,i)=>`Sentence ${i} remains here. `).join(''),plan=await planSpeechSegments(many);assert.equal(plan.count,MAX_SPEECH_SEGMENTS);assert.equal(plan.parts.at(-1).endByte,encoder.encode(many).length);
 const single='한글'.repeat(9000);assert.equal((await planSpeechSegments(single)).count,1);
 for(const invalid of ['', '   ',null,'\ud800invalid'])await assert.rejects(planSpeechSegments(invalid));
});

test('punctuation and emoji-only sentence boundaries stay verbatim beside lexical speech instead of creating unverifiable reader parts',async()=>{
 for(const source of ['😊! I like that crooked edge.','... I like that crooked edge.','!!! I like that crooked edge.','I like that crooked edge. 😊!','I like that edge. !!! The paper moon is more interesting.']){
  const plan=await planSpeechSegments(source),bytes=encoder.encode(source),pieces=plan.parts.map(part=>decoder.decode(bytes.subarray(part.startByte,part.endByte)));
  assert.equal(pieces.join(''),source);assert(pieces.every(piece=>fidelityTokens(piece).length>0));assert.deepEqual(pieces.flatMap(fidelityTokens),fidelityTokens(source));
  const f=await setup({text:source}),capture=await f.run();assert.equal(f.requests.length,plan.count);await verifySpeechCapture(capture,source);
 }
 assert.equal((await planSpeechSegments('😊! !!!')).count,1,'all-nonlexical text retains the existing whole-reader verification boundary');
});

test('first verified part is delivered while next readiness is held, with exact ranges/parent identity and one decreasing output ceiling',async()=>{
 const held=gate(),f=await setup({ready:index=>index===1?held.promise:Promise.resolve()});let complete=false;const work=f.run().then(value=>{complete=true;return value;});
 await until(()=>f.parts.length===1);assert.equal(complete,false);assert.equal(f.requests.length,1);assert.equal(f.prepared.length,2);assert.equal(f.requests[0].maxOutputTokens,SYNTHESIS_OUTPUT_CAP);assert.equal(f.prepared[1].binding.maxOutputTokens,SYNTHESIS_OUTPUT_CAP-100);
 held.resolve();const capture=await work;assert.equal(f.requests.length,2);assert.equal(f.requests[1].maxOutputTokens,SYNTHESIS_OUTPUT_CAP-100);assert.equal(f.dispatches,4);assert(f.prepared.every(reader=>reader.disposed));
 for(const[index,part]of f.parts.entries()){assert.deepEqual(part.manifest.owner,owner);assert.equal(part.manifest.synthesisId,'one-parent-job');assert.equal(part.manifest.index,index);assert.equal(part.manifest.count,f.plan.count);assert.equal(part.manifest.textSha256,f.plan.parts[index].textSha256);assert.equal(part.manifest.parentTextSha256,f.plan.textSha256);assert.equal(part.manifest.pcmSha256,digest(Buffer.from(part.pcmBase64,'base64')));assert.equal(f.requests[index].nonce,speechSegmentNonce(binding.nonce,index));}
 assert.deepEqual(capture.usage,{input_tokens:20,output_tokens:200,total_tokens:220});const clip=await verifySpeechCapture(capture,text);assert.equal(clip.pcmSha256,digest(Buffer.concat(f.parts.map(part=>Buffer.from(part.pcmBase64,'base64')))));
});

test('single reservation counts every planned input/setup overhead and only one global output budget',async()=>{
 const plan=await planSpeechSegments(text),reservation=segmentedSynthesisReservation(text,plan,binding.voice,binding.speed,binding.nonce);
 assert(reservation>.08&&reservation<.12);const many='A complete thought. '.repeat(40),manyPlan=await planSpeechSegments(many),large=segmentedSynthesisReservation(many,manyPlan,binding.voice,binding.speed,binding.nonce);assert.equal(manyPlan.count,16);assert(large>.08&&large<.25,'not 16 separate4096-output reservations');
});

test('unknown nonfinal usage, exhausted global tokens and perpart overspend stop without dispatching later parts',async()=>{
 for(const usage of [()=>null,()=>({input_tokens:1,output_tokens:0,total_tokens:1}),()=>({input_tokens:1,output_tokens:4096,total_tokens:4097})]){
  const f=await setup({usage});await assert.rejects(f.run());assert.equal(f.requests.length,1);assert.equal(f.parts.length,0);assert.equal(f.prepared.length,1);assert(f.prepared.every(reader=>reader.disposed));
 }
 const over=await setup({usage:(index,cap)=>({input_tokens:10,output_tokens:index?cap+1:4000,total_tokens:10+(index?cap+1:4000)})});await assert.rejects(over.run(),error=>error.code==='SYNTHESIS_OUTPUT_LIMIT');assert.equal(over.requests.length,2);assert.equal(over.requests[1].maxOutputTokens,96);assert.equal(over.parts.length,1);
 const lastUnknown=await setup({usage:index=>index?null:{input_tokens:10,output_tokens:100,total_tokens:110}});const capture=await lastUnknown.run();assert.equal(capture.usage,null,'unknown final usage keeps the one parent reservation');assert.equal(lastUnknown.parts.length,2);
});

test('fresh pre-generation and pre-emission source checks stop exactly at the revoked part, with no retries',async()=>{
 for(const revoked of [1,2,3,4]){
  const f=await setup({guard:count=>{if(count===revoked)throw Error('source revoked');}});await assert.rejects(f.run(),/source revoked/);
  assert.equal(f.requests.length,Math.floor(revoked/2));assert.equal(f.parts.length,revoked>2?1:0);assert(f.prepared.every(reader=>reader.disposed));
 }
 const mismatch=await setup({transcript:(index,source)=>index?'Changed spoken words.':source});await assert.rejects(mismatch.run(),error=>error.code==='SYNTHESIS_TEXT_MISMATCH');assert.equal(mismatch.parts.length,1);assert.equal(mismatch.requests.length,2);
});

test('abort after transient delivery and one cumulative deadline close all readers and never begin remaining parts',async()=>{
 const controller=new AbortController(),cancelled=await setup({binding:{signal:controller.signal},part:()=>controller.abort()});await assert.rejects(cancelled.run());assert.equal(cancelled.parts.length,1);assert.equal(cancelled.requests.length,1);assert(cancelled.prepared.every(reader=>reader.disposed));
 const held=gate(),timeout=await setup({ready:index=>index?held.promise:Promise.resolve(),deadlineMs:30});await assert.rejects(timeout.run(),error=>error.code==='SYNTHESIS_UNAVAILABLE');assert.equal(timeout.requests.length,1);assert(timeout.prepared.every(reader=>reader.disposed));
});

test('global PCM bound applies across individually valid pieces and no invalid later part is emitted',async()=>{
 const large=new Uint8Array(MAX_PCM_BYTES-2);large[0]=1;const f=await setup({pcm:index=>index?new Uint8Array([1,0,2,0]):large});await assert.rejects(f.run(),error=>error.code==='SYNTHESIS_SEGMENT_INVALID');assert.equal(f.parts.length,1);assert.equal(f.requests.length,2);
});

test('forged byte ranges, text hashes and unsafe lexical splits fail before provider dispatch and dispose an inherited warm handle',async()=>{
 for(const mutation of [plan=>{plan.parts[0].endByte--;},plan=>{plan.parts[0].textSha256='0'.repeat(64);},plan=>{plan.textSha256='0'.repeat(64);}]){
  const f=await setup();mutation(f.plan);let disposed=0;f.config.firstPrepared={ready:Promise.resolve(),generate:async()=>{throw Error('must not generate');},dispose:async()=>{disposed++;}};await assert.rejects(f.run());assert.equal(f.requests.length,0);assert.equal(f.dispatches,0);assert.equal(disposed,1);
 }
 const source='It costs $5.00.',f=await setup({text:source}),cut=source.indexOf('.')+1,first=source.slice(0,cut),last=source.slice(cut);
 f.plan.count=2;f.plan.parts=[{index:0,startByte:0,endByte:cut,textSha256:await textDigest(first)},{index:1,startByte:cut,endByte:encoder.encode(source).length,textSha256:await textDigest(last)}];
 await assert.rejects(f.run());assert.equal(f.prepared.length,0);assert.equal(f.requests.length,0);assert.equal(f.dispatches,0,'valid byte ranges and hashes cannot authorize a split that changes numeric lexical meaning');
});

test('valid plan with an already-aborted signal or expired absolute deadline disposes inherited setup before any generation',async()=>{
 for(const mode of ['abort','expired']){
  const controller=new AbortController();if(mode==='abort')controller.abort();const f=await setup({binding:{signal:controller.signal}});let disposed=0;
  f.config.firstPrepared={ready:Promise.resolve(),generate:async()=>{throw Error('must not generate');},dispose:async()=>{disposed++;}};if(mode==='expired')f.config.deadlineAt=Date.now()-1;
  await assert.rejects(f.run());assert.equal(f.requests.length,0);assert.equal(f.dispatches,0);assert.equal(disposed,1);
 }
});
