import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRealtimeReader, fidelityTokens, wordsMatch, verifySpeechCapture, pcmFromBase64, pcmToBase64, READER_INSTRUCTIONS, SYNTHESIS_MODEL, FIDELITY_POLICY_VERSION, realtimeReaderRequests, MAX_PCM_BYTES, PCM_RATE, SYNTHESIS_OUTPUT_CAP } from './verified-speech.ts';

// Frozen experimental reference uses its original independent code-point scan.
function reference(value) {
 const text=value.normalize('NFC').replace(/[\u2018\u2019\u201b\u02bc\uff07]/g,"'").replace(/[\u201c\u201d\u201f\uff02]/g,'"').replace(/\u2212/g,'-').replace(/\p{White_Space}+/gu,' ').trim().toLocaleLowerCase('en');
 const points=Array.from(text),tokens=[],letter=c=>typeof c==='string'&&/[\p{L}\p{M}]/u.test(c),numeric=c=>typeof c==='string'&&/\p{N}/u.test(c);
 const neighbor=(i,d)=>{for(let j=i+d;j>=0&&j<points.length;j+=d)if(points[j]!==' ')return points[j];return undefined;};
 for(let i=0;i<points.length;){const match=points.slice(i).join('').match(/^[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/u);if(match){tokens.push(match[0]);i+=Array.from(match[0]).length;continue;}
 const c=points[i],left=neighbor(i,-1),right=neighbor(i,1);if(/[\p{Sc}+%‰]/u.test(c)||(c==='-'&&!(letter(left)&&letter(right)))||(['.',',',':','/'].includes(c)&&numeric(left)&&numeric(right))||(c==='.'&&numeric(right)))tokens.push(c);i++;}return tokens;
}
test('linear scanner keeps frozen lexical-fidelity-v1 typography, signs, contractions and complete words',()=>{
 assert.equal(FIDELITY_POLICY_VERSION,'lexical-fidelity-v1');
 const cases=["I’d pick that—it's odd.",'-.5 + 2,000 / 12:30 $ 5 20 %','− 2 ① １ 1a2 1a 2','twenty-one twenty one','a\u0301 Á 中文🙂!?\u2003x','- a - 2 .5 . 5 3.5 35',"can't cannot can not don't dont do not","a-'b --2 2‰",'🙂 '.repeat(1000)];
 let seed=13;const alphabet=Array.from("Ab1a2-'$.5:%🙂é中\u0301 \t");
 for(let n=0;n<60;n++){let input='';for(let i=0;i<100;i++){seed=(seed*1664525+1013904223)>>>0;input+=alphabet[seed%alphabet.length];}cases.push(input);}
 for(const input of cases)assert.deepEqual(fidelityTokens(input),reference(input));
 assert(wordsMatch('I’d like it.','i\'d like it!'));
 for(const [a,b]of [["don't",'do'],["I'll",'I'],["it's",'it is'],['.5','5'],['- 2','2'],['$ 5','5'],['20 %','20'],['1a2','1a 2'],['12','twelve'],['a b','b a']])assert.equal(wordsMatch(a,b),false,a+' / '+b);
});
test('whole capture gate hashes original UTF8, rejects mismatch/odd/silent/unverified PCM',async()=>{
 const text='I’d choose that.',pcm=new Uint8Array([0,1,1,0]),capture={pcm,transcript:"I'd choose that!",finalTranscript:text,usage:{},protocolVerified:true};
 const result=await verifySpeechCapture(capture,text);assert.equal(result.textSha256,createHash('sha256').update(text).digest('hex'));assert.equal(result.pcmSha256,createHash('sha256').update(pcm).digest('hex'));assert.equal(result.sourceFrames,2);
 for(const changes of [{protocolVerified:false},{transcript:'I would choose that.'},{finalTranscript:'I chose that.'},{pcm:new Uint8Array([1])},{pcm:new Uint8Array([0,0])}])await assert.rejects(verifySpeechCapture({...capture,...changes},text));
 assert.deepEqual(pcmFromBase64(pcmToBase64(pcm)),pcm);assert.throws(()=>pcmFromBase64('@@'));
});
class Socket {
 constructor(mode='valid'){this.readyState=1;this.listeners=new Map();this.sent=[];this.mode=mode;}
 on(name,fn){const list=this.listeners.get(name)||[];list.push(fn);this.listeners.set(name,list);return this;}
 once(name,fn){const once=(...args)=>{this.listeners.set(name,(this.listeners.get(name)||[]).filter(x=>x!==once));fn(...args);};return this.on(name,once);}
 emit(name,event){for(const fn of [...(this.listeners.get(name)||[])])fn(event);}
 msg(event){this.emit('message',{toString:()=>JSON.stringify(event)});}
 send(raw){const e=JSON.parse(raw);this.sent.push(e);if(e.type==='session.update'){const session={...e.session,model:SYNTHESIS_MODEL};if(this.mode==='wrong-config')session.audio.output.voice='other';this.msg({type:'session.updated',session});return;}
 const response={id:'r1',metadata:e.response.metadata,model:SYNTHESIS_MODEL,instructions:e.response.instructions};const part={response_id:'r1',item_id:'a1',output_index:0,content_index:0};
 this.msg({type:'response.created',response});this.msg({type:'response.output_item.added',response_id:'r1',output_index:0,item:{id:'a1',type:'message',role:'assistant'}});this.msg({type:'response.content_part.added',...part,part:{type:'audio'}});
 if(this.mode==='extra-part')this.msg({type:'response.content_part.added',...part,content_index:1,part:{type:'audio'}});
 this.msg({type:'response.output_audio.delta',...part,delta:pcmToBase64(new Uint8Array([1,0,2,0]))});this.msg({type:'response.output_audio.done',...part});
 const transcript=this.mode==='mismatch'?'A changed reply.':'A prepared reply.';this.msg({type:'response.output_audio_transcript.done',...part,transcript});
 const terminal={type:'response.done',response:{...response,status:this.mode==='incomplete'?'incomplete':'completed',output:[{id:'a1',type:'message',role:'assistant',content:[{type:'audio',transcript}]}],usage:{input_tokens:10,output_tokens:20,total_tokens:30}}};this.msg(terminal);if(this.mode==='duplicate-terminal')this.msg(terminal);
 }
 close(){if(this.mode==='late-audio')this.msg({type:'response.output_audio.delta',response_id:'r1',item_id:'a1',output_index:0,content_index:0,delta:'AQA='});this.readyState=3;this.emit('close');}
 terminate(){this.readyState=3;this.emit('close');}
}
test('production reader uses supported OOB body and strict single audio part before any return',async()=>{
 let socket;const request={text:'A prepared reply.',nonce:'nonce',voice:'cedar',speed:.85,key:'mock-key'};
 const capture=await createRealtimeReader(()=>socket=new Socket())(request);await verifySpeechCapture(capture,request.text);
 assert.equal(socket.sent.length,2);assert.equal(socket.sent[0].session.instructions,READER_INSTRUCTIONS);assert.equal(socket.sent[0].session.audio.input.transcription,null);assert.deepEqual(socket.sent[1].response.input,[]);assert.equal(socket.sent[1].response.conversation,'none');assert.equal(socket.sent[1].response.instructions,'Say exactly the following:\n'+request.text);assert.deepEqual(socket.sent[1].response.tools,[]);
 assert.deepEqual({...socket.sent[1],event_id:undefined},{...realtimeReaderRequests(request).response,event_id:undefined});
 for(const mode of ['wrong-config','extra-part','incomplete','duplicate-terminal','late-audio'])await assert.rejects(createRealtimeReader(()=>new Socket(mode))(request));
 const different=await createRealtimeReader(()=>new Socket('mismatch'))(request);await assert.rejects(verifySpeechCapture(different,request.text),error=>error.code==='SYNTHESIS_TEXT_MISMATCH');
});

test('lexical-v1 agrees with its frozen probe on Unicode code-point offsets and preserves value-bearing differences', () => {
 const inputs = [
  '🙂𐐀𐐨é A\u0301 中文 한글 ١٢ １２ ①', '👩🏽‍💻 cafe\u0301\u202f“D’Ángelo”', "I\u2018m I\u2019m I\u201bm I\u02bcm I\uff07m",
  '‘a’ “b” ‟c‟ ＂d＂', '\u00a0\tAlpha\r\nBeta\u2009Gamma\u3000', '$ 5 € 3.50 £.5 ₹−2 ₿ + 7 % 8‰',
  '3 . 5 3 , 000 12 : 30 1 / 2 - 8 +9 -a a- a-b a - b', 'İ I ı i Σ σ ς Ł ł', '\ud800word\udfff 𝟠.𝟡 𝒜𐐀',
  '\u0301a a\u0301 z\u200dword x\ufe0f', 'A1 1A 1a2 A_1 A—B A-B A+B'
 ];
 for (const input of inputs) assert.deepEqual(fidelityTokens(input), reference(input), JSON.stringify(input));
 const agrees = [['cafe\u0301', 'CAFÉ'], ['I’d rather not.', "i'd rather not!"], ['twenty-one', 'twenty one'], ['3 . 5', '3.5'], ['− 2', '-2']];
 for (const [source, spoken] of agrees) assert.equal(wordsMatch(source, spoken), true, `${source} / ${spoken}`);
 for (const [source, spoken] of [['①', '1'], ['１２', '12'], ['café', 'cafe'], ['İ', 'i'], ['€5', '$5'], ['.5', '5'], ['3.50', '350'],
  ['3,000', '3000'], ['12:30', '1230'], ['1/2', '12'], ['- 2', '+2'], ['+2', '2'], ['20‰', '20%'], ['A1', 'A 1'],
  ["we're", 'we are'], ['not yet', 'yet'], ['a b', 'b a'], ['hello', 'hello hello']]) assert.equal(wordsMatch(source, spoken), false, `${source} / ${spoken}`);
 for (const empty of ['', ' \u2003\n', '🙂 !?']) assert.equal(wordsMatch(empty, empty), false);
 assert.throws(() => fidelityTokens(null), error => error.code === 'SYNTHESIS_TEXT_INVALID');
});

const readerRequest = { text: 'A prepared reply.', nonce: 'synthetic-turn-nonce', voice: 'cedar', speed: .85, key: 'fixture-key-never-sent', deadlineMs: 100 };
const clone = value => structuredClone(value);
function readerFrames(request = readerRequest) {
 const response = { id: 'response-owned', metadata: { turn_nonce: request.nonce, purpose: 'authored_dialogue_synthesis' }, model: SYNTHESIS_MODEL,
  instructions: 'Say exactly the following:\n' + request.text };
 const part = { response_id: response.id, item_id: 'item-owned', output_index: 0, content_index: 0 };
 return [
  { type: 'response.created', response },
  { type: 'response.output_item.added', response_id: response.id, output_index: 0, item: { id: part.item_id, type: 'message', role: 'assistant' } },
  { type: 'response.content_part.added', ...part, part: { type: 'audio' } },
  { type: 'response.output_audio.delta', ...part, delta: pcmToBase64(new Uint8Array([1, 0, 2, 0])) },
  { type: 'response.output_audio.done', ...part },
  { type: 'response.output_audio_transcript.done', ...part, transcript: request.text },
  { type: 'response.done', response: { ...clone(response), status: 'completed', output: [{ id: part.item_id, type: 'message', role: 'assistant', content: [{ type: 'audio', transcript: request.text }] }], usage: { input_tokens: 12, output_tokens: 21, total_tokens: 33 } } }
 ];
}
class ScriptedSocket extends Socket {
 constructor(recipe = {}, request = readerRequest) { super(); this.recipe = recipe; this.request = request; this.readyState = recipe.readyState ?? 1; this.closeCalls = 0; this.terminateCalls = 0; }
 send(raw) {
  const event = JSON.parse(raw); this.sent.push(event);
  const normal = event.type === 'session.update' ? [{ type: 'session.updated', session: { ...clone(event.session), model: SYNTHESIS_MODEL } }] : readerFrames(this.request);
  const frames = event.type === 'session.update' ? this.recipe.session?.(normal, this) ?? normal : this.recipe.response?.(normal, this) ?? normal;
  for (const frame of frames) this.msg(frame);
 }
 close() {
  if (this.readyState === 3 || this.readyState === 2) return;
  this.closeCalls++; this.readyState = 2;
  for (const frame of this.recipe.atClose?.(this) || []) this.msg(frame);
  if (this.recipe.refuseClose) return;
  this.readyState = 3; this.emit('close');
 }
 terminate() { this.terminateCalls++; this.readyState = 3; this.emit('close'); }
}
function scripted(recipe = {}, changes = {}) {
 let socket, opens = 0; const request = { ...readerRequest, ...changes };
 const operation = createRealtimeReader((url, key) => {
  opens++; assert.equal(url, 'wss://api.openai.com/v1/realtime?model=' + SYNTHESIS_MODEL); assert.equal(key, request.key);
  socket = new ScriptedSocket(recipe, request); return socket;
 })(request);
 return { operation, get socket() { return socket; }, get opens() { return opens; } };
}
async function rejectsOnce(recipe, changes) {
 const run = scripted(recipe, changes); await assert.rejects(run.operation);
 assert.equal(run.opens, 1, 'an invalid synthesis must not open a replacement provider request');
 assert(run.socket.sent.filter(event => event.type === 'response.create').length <= 1, 'there is no synthesis retry');
 assert.equal(run.socket.readyState, 3); return run.socket;
}

test('reader emits exactly the frozen product OOB request, with empty input and no ASR, tools or conversation writes', async () => {
 const run = scripted(), capture = await run.operation; await verifySpeechCapture(capture, readerRequest.text);
 assert.equal(run.opens, 1); assert.equal(run.socket.sent.length, 2);
 const [session, response] = run.socket.sent.map(({ event_id, ...value }) => { assert.match(event_id, /^[0-9a-f-]{36}$/); return value; });
 assert.deepEqual(session, { type: 'session.update', session: { type: 'realtime', reasoning: { effort: 'low' }, instructions: READER_INSTRUCTIONS,
  max_output_tokens: 4096, truncation: 'disabled', output_modalities: ['audio'], tools: [], tool_choice: 'none',
  audio: { input: { transcription: null, turn_detection: null }, output: { voice: 'cedar', speed: .85, format: { type: 'audio/pcm', rate: 24000 } } } } });
 assert.deepEqual(response, { type: 'response.create', response: { conversation: 'none', input: [], instructions: 'Say exactly the following:\nA prepared reply.',
  output_modalities: ['audio'], tools: [], tool_choice: 'none', metadata: { turn_nonce: readerRequest.nonce, purpose: 'authored_dialogue_synthesis' } } });
 assert.equal(PCM_RATE, 24000); assert.equal(SYNTHESIS_OUTPUT_CAP, 4096); assert.deepEqual([...capture.pcm], [1, 0, 2, 0]);
});

test('wrong session configuration followed by a valid ACK remains permanently faulted and never starts synthesis', async () => {
 const changes = [session => { session.model = 'other-model'; }, session => { session.instructions += ' commentary'; }, session => { session.audio.output.voice = 'other'; },
  session => { session.audio.output.speed = 1; }, session => { session.audio.output.format.rate = 8000; }, session => { session.audio.output.format.type = 'audio/pcmu'; },
  session => { session.audio.input.transcription = { model: 'asr' }; }, session => { session.audio.input.turn_detection = { type: 'server_vad' }; },
  session => { session.tools = [{ type: 'function', name: 'unexpected' }]; }, session => { session.tool_choice = 'auto'; }];
 for (const change of changes) {
  const socket = await rejectsOnce({ session: frames => { const bad = clone(frames[0]); change(bad.session); return [bad, ...frames]; } });
  assert.equal(socket.sent.filter(event => event.type === 'response.create').length, 0);
 }
 await rejectsOnce({ session: frames => [frames[0], clone(frames[0])] });
});

test('late bad or duplicate ACKs and provider errors during close cannot bless an otherwise completed capture', async () => {
 for (const late of [
  { type: 'session.updated', session: { ...realtimeReaderRequests(readerRequest).session.session, model: 'wrong' } },
  { type: 'error', error: { code: 'fixture_error' } },
  readerFrames().at(-1), readerFrames()[3]
 ]) await rejectsOnce({ atClose: () => [late] });
});

test('output response, item and part identity/index mismatches remain faulted even when valid data follows', async () => {
 const mutations = [
  frames => { frames[0].response.metadata.turn_nonce = 'other-nonce'; }, frames => { frames[0].response.metadata.purpose = 'other-purpose'; },
  frames => { frames[0].response.model = 'other-model'; }, frames => { frames[0].response.instructions = 'Say another thing.'; },
  frames => { frames[1].response_id = 'other'; }, frames => { frames[1].output_index = 1; }, frames => { frames[1].item.role = 'user'; },
  frames => { frames[2].item_id = 'other-item'; }, frames => { frames[2].content_index = 1; }, frames => { frames[2].output_index = 1; },
  frames => { frames[3].response_id = 'other'; }, frames => { frames[3].item_id = 'other'; }, frames => { frames[3].content_index = 1; }, frames => { frames[3].output_index = 1; },
  frames => { frames[4].item_id = 'other'; }, frames => { frames[5].response_id = 'other'; }, frames => { frames[6].response.output[0].id = 'other'; },
  frames => { frames[6].response.output[0].content.push({ type: 'audio', transcript: readerRequest.text }); }, frames => { frames[6].response.status = 'incomplete'; }
 ];
 for (const change of mutations) await rejectsOnce({ response: frames => { const bad = clone(frames); change(bad); return [...bad, ...readerFrames()]; } });
});

test('every terminal and shape duplicate is rejected rather than being reinterpreted as a new successful response', async () => {
 for (const index of [0, 1, 2, 4, 5, 6]) await rejectsOnce({ response: frames => frames.flatMap((frame, i) => i === index ? [frame, clone(frame)] : [frame]) });
 for (const type of ['conversation.item.created', 'conversation.item.added']) await rejectsOnce({ response: frames => [{ type, item: { id: 'unexpected' } }, ...frames] });
 await rejectsOnce({ response: frames => { frames[3].delta = '@@'; return frames; } });
 await rejectsOnce({ response: (_frames, socket) => { socket.emit('message', { toString: () => '{invalid json' }); return readerFrames(); } });
});

test('abort, provider error, socket close and each bounded wait fail without synthesis retries', async () => {
 const aborted = new AbortController(); aborted.abort(); const cancelled = scripted({}, { signal: aborted.signal });
 await assert.rejects(cancelled.operation); assert.equal(cancelled.opens, 0); assert.equal(cancelled.socket, undefined);
 await rejectsOnce({ session: (_frames, socket) => { socket.emit('error', Error('local fixture socket failure')); return []; } });
 await rejectsOnce({ response: (_frames, socket) => { socket.readyState = 3; socket.emit('close'); return []; } });
 const controller = new AbortController(); await rejectsOnce({ response: () => { controller.abort(); return readerFrames(); } }, { signal: controller.signal });
 for (const recipe of [{ readyState: 0 }, { session: () => [] }, { response: () => [] }, { response: frames => frames.filter(frame => frame.type !== 'response.output_audio.delta') }]) await rejectsOnce(recipe, { deadlineMs: 15 });
 const unclosed = await rejectsOnce({ refuseClose: true }); assert.equal(unclosed.terminateCalls, 1);
});

test('deadline and abort bound an unsettled socket factory, and any later socket is closed without generation', async () => {
 for (const ending of ['deadline', 'abort']) {
  let release, opens = 0; const gate = new Promise(resolve => { release = resolve; }), controller = new AbortController();
  const reader = createRealtimeReader(() => { opens++; return gate; });
  const work = reader({ ...readerRequest, signal: controller.signal, deadlineMs: 20 });
  await Promise.resolve(); if (ending === 'abort') controller.abort();
  await assert.rejects(work, error => error.code === 'SYNTHESIS_UNAVAILABLE'); assert.equal(opens, 1);
  const socket = new ScriptedSocket(); release(socket);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(socket.readyState, 3); assert.equal(socket.sent.length, 0); assert.equal(socket.closeCalls, 1);
 }
 let opens = 0; await assert.rejects(createRealtimeReader(() => { opens++; throw Error('private provider detail'); })(readerRequest),
  error => error.code === 'SYNTHESIS_UNAVAILABLE' && !error.message.includes('private provider detail'));
 assert.equal(opens, 1);
});

test('whole capture rejects oversized, silent, odd or mismatched audio and both transcript sources independently', async () => {
 const capture = { pcm: new Uint8Array([1, 0, 2, 0]), transcript: readerRequest.text, finalTranscript: readerRequest.text, usage: null, protocolVerified: true };
 for (const change of [{ pcm: new Uint8Array() }, { pcm: new Uint8Array(MAX_PCM_BYTES + 2).fill(1) }, { pcm: new Uint8Array([1]) },
  { pcm: new Uint8Array(4) }, { protocolVerified: false }, { transcript: 'A changed reply.' }, { finalTranscript: 'A different reply.' },
  { transcript: 'x'.repeat(20001) }, { finalTranscript: 'x'.repeat(20001) }]) await assert.rejects(verifySpeechCapture({ ...capture, ...change }, readerRequest.text));
 const exact = new Uint8Array(MAX_PCM_BYTES); exact[0] = 1;
 assert.equal((await verifySpeechCapture({ ...capture, pcm: exact }, readerRequest.text)).byteLength, MAX_PCM_BYTES);
 const fragmented = total => ({ response: frames => {
  const chunks = [], full = pcmToBase64(new Uint8Array(8192).fill(1));
  for (let left = total; left > 0; left -= Math.min(left, 8192)) chunks.push({ ...frames[3], delta: left >= 8192 ? full : pcmToBase64(new Uint8Array(left).fill(1)) });
  return [...frames.slice(0, 3), ...chunks, ...frames.slice(4)];
 } });
 // This verifies the aggregate byte bound, not CPU throughput while other
 // local WASM/database suites run. Deadline behavior has dedicated cases.
 const bounded = await scripted(fragmented(MAX_PCM_BYTES), { deadlineMs: 30000 }).operation;
 assert.equal((await verifySpeechCapture(bounded, readerRequest.text)).byteLength, MAX_PCM_BYTES, 'aggregate bound supports valid small wire chunks at the exact limit');
 await rejectsOnce(fragmented(MAX_PCM_BYTES + 2), { deadlineMs: 30000 });
 const odd = await scripted({ response: frames => { frames[3].delta = 'AQ=='; return frames; } }).operation;
 await assert.rejects(verifySpeechCapture(odd, readerRequest.text), error => error.code === 'SYNTHESIS_AUDIO_INVALID');
});
