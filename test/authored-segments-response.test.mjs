// Synthetic transport streams only; no auth, provider, browser or database I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUTHORED_SEGMENTS_RESPONSE_LIMITS, readAuthoredSegmentsResponse } from '../web/authored-segments-response.js';

const encoder = new TextEncoder(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uid = number => '10000000-0000-4000-8000-' + String(number).padStart(12, '0');
const owner = { scope: 'https://synthetic.supabase.co|' + uid(1), sessionId: uid(2), companionId: 'alex', callEpoch: 7,
  turnNonce: uid(3), turnId: uid(4), assistantEventId: uid(5), authorityGeneration: 2, expectedMemoryRevision: 4, playbackEpoch: 3 };
const timings = { totalMs: 4230, authorMs: 1750, synthesisMs: 1990 };
const line = value => JSON.stringify(value) + '\n';
const bytes = values => encoder.encode(values.map(line).join(''));
function fixture(texts = ['Hi 🌙. ', 'Stay curious.'], pcms = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0, 5, 0])]) {
  const text = texts.join(''), textSha256 = hash(encoder.encode(text)); let offset = 0;
  const parts = texts.map((text, index) => { const startByte = offset; offset += encoder.encode(text).byteLength; return { index, startByte, endByte: offset, textSha256: hash(encoder.encode(text)) }; });
  const plan = { version: 'verified-speech-segments-v1', count: parts.length, textByteLength: offset, textSha256, parts };
  const textFrame = { type: 'text', result: { protocol: 'authored_dialogue_v1', owner: structuredClone(owner), generation: 1, text, textSha256,
    assistantEvent: { id: owner.assistantEventId, text, speaker: 'assistant', storage: 'server' } }, plan };
  const pcmManifest = (pcm, sha) => ({ owner: structuredClone(owner), synthesisId: uid(6), textSha256: sha, pcmSha256: hash(pcm),
    format: 'pcm_s16le', sampleRate: 24000, channels: 1, sourceFrames: pcm.length / 2, byteLength: pcm.length,
    transcriptVerification: { status: 'matched', policyVersion: 'lexical-fidelity-v1', approvedTextSha256: sha }, synthesisSpeed: .85 });
  const segments = parts.map((part, index) => ({ type: 'segment', result: { protocol: 'authored_dialogue_v1',
    manifest: { version: 'verified-pcm-segment-v1', ...pcmManifest(pcms[index], part.textSha256), ...part, count: parts.length, parentTextSha256: textSha256 }, pcmBase64: pcms[index].toString('base64') } }));
  const final = { type: 'final', result: { protocol: 'authored_dialogue_v1', manifest: { version: 'verified-pcm-candidate-v1', ...pcmManifest(Buffer.concat(pcms), textSha256) } } };
  const done = { type: 'done', timings: { ...timings } };
  return { text: textFrame, segments, final, done, frames: [textFrame, ...segments, final, done] };
}
function response(input = bytes(fixture().frames), { status = 200, headers, split } = {}) {
  const chunks = split ? split(input) : [input];
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), {
    status, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', ...headers },
  });
}
function openResponse() {
  let controller, cancellations = 0;
  const value = new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { cancellations++; } }), { headers: { 'content-type': 'application/x-ndjson' } });
  return { value, push: value => controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value),
    close: () => controller.close(), error: error => controller.error(error), cancelled: () => cancellations };
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const until = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert(predicate(), 'local protocol callback must settle');
};
async function rejectsProtocol(value, options = {}) {
  await assert.rejects(readAuthoredSegmentsResponse(value, { onText() {}, onSegment() {}, ...options }), error => error.code === 'DIALOGUE_STREAM_INVALID');
  assert.equal(value.body.locked, false);
}

test('first verified segment is delivered before future parts, final, done or EOF exist', async () => {
  const source = openResponse(), f = fixture(), seen = []; let settled = false, admittedPlan;
  const result = readAuthoredSegmentsResponse(source.value, {
    onText(value, plan) { seen.push(value); admittedPlan = plan; }, onSegment(value) { seen.push(value); },
  }).then(value => { settled = true; return value; });
  source.push(line(f.text)); await until(() => seen.length === 1);
  assert.deepEqual(admittedPlan, f.text.plan); assert(Object.isFrozen(admittedPlan)); assert(Object.isFrozen(admittedPlan.parts)); assert(Object.isFrozen(admittedPlan.parts[0]));
  source.push(line(f.segments[0])); await until(() => seen.length === 2);
  assert.deepEqual(seen[1], f.segments[0].result); assert.equal(settled, false);
  source.push(line(f.segments[1]) + line(f.final) + line(f.done)); await until(() => seen.length === 3); await tick();
  assert.equal(settled, false, 'done is not clean EOF');
  source.close(); assert.deepEqual(await result, { final: f.final.result, timings });
  assert.equal(source.cancelled(), 0); assert.equal(source.value.body.locked, false);
});

test('async text and per-segment admission provide sequential callback backpressure', async () => {
  const f = fixture(), textGate = deferred(), partGate = deferred(), seen = []; let settled = false;
  const result = readAuthoredSegmentsResponse(response(bytes(f.frames)), {
    async onText() { seen.push('text'); await textGate.promise; },
    async onSegment(value) { seen.push(value.manifest.index); if (value.manifest.index === 0) await partGate.promise; },
  }).then(value => { settled = true; return value; });
  await until(() => seen.length === 1); await tick(); assert.deepEqual(seen, ['text']); assert.equal(settled, false);
  textGate.resolve(); await until(() => seen.length === 2); await tick(); assert.deepEqual(seen, ['text', 0]); assert.equal(settled, false);
  partGate.resolve(); assert.deepEqual((await result).final, f.final.result); assert.deepEqual(seen, ['text', 0, 1]);
});

test('UTF8 byte ranges, JSON escapes, CRLF and byte-by-byte network splits preserve the exact text', async () => {
  const f = fixture(['한국어 🌙 says “hello”.\n', 'Next line.']), seen = [];
  const input = encoder.encode(f.frames.map(value => JSON.stringify(value) + '\r\n').join(''));
  const result = await readAuthoredSegmentsResponse(response(input, { headers: { 'content-type': 'Application/X-NDJSON; Charset="UTF-8"' },
    split: value => Array.from(value, (_, index) => value.subarray(index, index + 1)) }), { onText: value => seen.push(value.text), onSegment() {} });
  assert.deepEqual(seen, [f.text.result.text]); assert.deepEqual(result.final, f.final.result);
});

test('a literal BOM in committed text or at a part boundary is preserved, not stripped', async () => {
  const f = fixture(['\ufeffHi 🌙. ', '\ufeffStay curious.']), seen = [];
  const result = await readAuthoredSegmentsResponse(response(bytes(f.frames)), {
    onText(value, plan) { seen.push(value.text); assert.deepEqual(plan, f.text.plan); }, onSegment() {},
  });
  assert.deepEqual(seen, ['\ufeffHi 🌙. \ufeffStay curious.']); assert.deepEqual(result.final, f.final.result);
});

test('plan gaps, overlaps, empty ranges, counts and ranges splitting a UTF8 codepoint reject before admission', async () => {
  const changes = [
    f => { f.text.plan.parts[0].index = 1; }, f => { f.text.plan.parts[1].startByte++; }, f => { f.text.plan.parts[1].startByte--; },
    f => { f.text.plan.parts[0].endByte = 0; }, f => { f.text.plan.parts[1].endByte--; }, f => { f.text.plan.textByteLength++; },
    f => { f.text.plan.count = 17; }, f => { f.text.plan.count = '2'; }, f => { f.text.plan.parts[0].textSha256 = ['0'.repeat(64)]; },
    f => { f.text.plan.parts[0].endByte = 4; f.text.plan.parts[1].startByte = 4; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); let calls = 0;
    await rejectsProtocol(response(bytes(f.frames)), { onText: () => { calls++; } }); assert.equal(calls, 0);
  }
});

test('text protocol, full SHA binding and canonical Unicode are checked before callbacks', async () => {
  for (const change of [f => { f.text.result.protocol = 'other'; }, f => { f.text.plan.textSha256 = '0'.repeat(64); },
    f => { f.text.result.owner.sessionId = [owner.sessionId]; }, f => { f.text.result.owner.unadvertised = true; },
    f => { f.text.result.textSha256 = ['0'.repeat(64)]; }, f => { f.text.plan.extra = true; },
    f => { f.text.result.text = '\ud800'; f.text.plan.textByteLength = 3; }]) {
    const f = fixture(); change(f); let calls = 0;
    await rejectsProtocol(response(bytes(f.frames)), { onText: () => { calls++; } }); assert.equal(calls, 0);
  }
});

test('crypto plan admission rejects through the awaited callback before any PCM part is exposed', async () => {
  const f = fixture(); f.text.plan.parts[0].textSha256 = '0'.repeat(64); let segments = 0;
  await rejectsProtocol(response(bytes(f.frames)), {
    onText(value, plan) { const first = encoder.encode(value.text).subarray(plan.parts[0].startByte, plan.parts[0].endByte); if (hash(first) !== plan.parts[0].textSha256) throw Error('PRIVATE_CRYPTO_DETAIL'); },
    onSegment() { segments++; },
  });
  assert.equal(segments, 0);
});

test('part index/count/ranges/parent/source hashes and exact ownership are bound before the segment callback', async () => {
  const changes = [f => { f.segments[0].result.manifest.index = 1; }, f => { f.segments[0].result.manifest.count = 1; },
    f => { f.segments[0].result.manifest.startByte = 1; }, f => { f.segments[0].result.manifest.endByte++; },
    f => { f.segments[0].result.manifest.parentTextSha256 = '0'.repeat(64); }, f => { f.segments[0].result.manifest.textSha256 = '0'.repeat(64); },
    f => { f.segments[0].result.manifest.owner.turnNonce = uid(99); }, f => { f.segments[0].result.manifest.owner.scope += '-other'; },
    f => { f.segments[0].result.manifest.owner.companionId = 'mia'; }, f => { f.segments[0].result.manifest.owner.expectedMemoryRevision++; },
    f => { f.segments[0].result.manifest.owner.playbackEpoch++; }, f => { f.segments[0].result.manifest.owner.extra = true; },
    f => { f.segments[0].result.protocol = 'other'; }];
  for (const change of changes) {
    const f = fixture(); change(f); let calls = 0;
    await rejectsProtocol(response(bytes(f.frames)), { onSegment() { calls++; } }); assert.equal(calls, 0);
  }
});

test('synthesis job and speed cannot change between parts or in the final manifest', async () => {
  for (const change of [f => { f.segments[1].result.manifest.synthesisId = uid(99); }, f => { f.segments[1].result.manifest.synthesisSpeed = 1; },
    f => { f.final.result.manifest.synthesisId = uid(99); }, f => { f.final.result.manifest.synthesisSpeed = 1; }]) {
    const f = fixture(); change(f); await rejectsProtocol(response(bytes(f.frames)));
  }
});

test('strict PCM shape, transcript fidelity tuple and canonical base64 are checked without decoding a second copy', async () => {
  const changes = [f => { f.segments[0].result.manifest.version = 'other'; }, f => { f.segments[0].result.manifest.format = 'wav'; },
    f => { f.segments[0].result.manifest.sampleRate = 48000; }, f => { f.segments[0].result.manifest.channels = 2; },
    f => { f.segments[0].result.manifest.sourceFrames++; }, f => { f.segments[0].result.manifest.pcmSha256 = ['0'.repeat(64)]; },
    f => { f.segments[0].result.manifest.transcriptVerification.policyVersion = 'fuzzy'; }, f => { f.segments[0].result.manifest.transcriptVerification.approvedTextSha256 = '0'.repeat(64); },
    f => { f.segments[0].result.manifest.transcriptVerification.status = 'pending'; }, f => { f.segments[0].result.manifest.extra = true; },
    ...['AQI', 'AQJ=', 'AB==', 'A===', 'A-AA', 'AQI=\n', ''].map(value => f => { f.segments[0].result.pcmBase64 = value; })];
  for (const change of changes) {
    const f = fixture(); change(f); let calls = 0;
    await rejectsProtocol(response(bytes(f.frames)), { onSegment() { calls++; } }); assert.equal(calls, 0);
  }
});

test('final manifest must match every part total and the parent owner/text/job/speed, without repeating PCM', async () => {
  for (const change of [f => { f.final.result.manifest.byteLength += 2; f.final.result.manifest.sourceFrames++; },
    f => { f.final.result.manifest.textSha256 = '0'.repeat(64); }, f => { f.final.result.manifest.owner.turnId = uid(99); },
    f => { f.final.result.manifest.transcriptVerification.approvedTextSha256 = '0'.repeat(64); },
    f => { f.final.result.pcmBase64 = 'AQI='; }, f => { f.final.result.manifest.version = 'other'; }]) {
    const f = fixture(); change(f); await rejectsProtocol(response(bytes(f.frames)));
  }
});

test('duplicates, reordering, missing parts, unsolicited progress and frames after done cannot complete a turn', async () => {
  const f = fixture();
  for (const frames of [[f.segments[0], f.text, f.segments[1], f.final, f.done], [f.text, f.text, ...f.segments, f.final, f.done],
    [f.text, f.segments[1], f.segments[0], f.final, f.done], [f.text, f.segments[0], f.segments[0], f.segments[1], f.final, f.done],
    [f.text, f.segments[0], f.final, f.done], [f.text, ...f.segments, f.done], [f.text, ...f.segments, f.final],
    [...f.frames, f.done], [...f.frames, { type: 'error', error: { code: 'BUDGET_EXCEEDED', message: 'failure' } }],
    [{ type: 'progress', stage: 'thinking' }, ...f.frames]]) await rejectsProtocol(response(bytes(frames)));
  for (const input of [new Uint8Array(), encoder.encode(f.frames.map(line).join('') + '\n'), encoder.encode(f.frames.map(line).join('') + ' '),
    encoder.encode(f.frames.slice(0, -1).map(line).join('') + JSON.stringify(f.done)), encoder.encode(line(f.text) + '{"type":"segment","result":')]) await rejectsProtocol(response(input));
});

test('error frames before or after early PCM preserve both budget codes and erase private provider details', async () => {
  const f = fixture(), privateValue = 'PRIVATE_PROVIDER_CANARY';
  for (const code of ['BUDGET_EXCEEDED', 'COST_BUDGET_EXCEEDED']) for (const prefix of [[], [f.text], [f.text, f.segments[0]]]) {
    const source = openResponse(); let parts = 0;
    const result = readAuthoredSegmentsResponse(source.value, { onText() {}, onSegment() { parts++; } });
    source.push(prefix.map(line).join('') + line({ type: 'error', error: { code, message: privateValue } }));
    await assert.rejects(result, error => error.code === code && !error.message.includes(privateValue));
    assert.equal(parts, prefix.length === 2 ? 1 : 0); assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
  }
});

test('unsafe backend codes and malformed error envelopes never expose payloads', async () => {
  for (const code of ['token=PRIVATE_CODE_CANARY', 'lower_case', 'X'.repeat(65), { private: 'PRIVATE_CODE_CANARY' }, null]) {
    await assert.rejects(readAuthoredSegmentsResponse(response(bytes([{ type: 'error', error: { code, message: 'private' } }])), { onText() {}, onSegment() {} }),
      error => error.code === 'DIALOGUE_STREAM_UNAVAILABLE' && !JSON.stringify(error).includes('PRIVATE'));
  }
  for (const value of [{ type: 'error', error: { code: 'BUDGET_EXCEEDED', message: 'x', extra: true } },
    { type: 'error', error: { code: 'BUDGET_EXCEEDED', message: 'x'.repeat(257) } }]) await rejectsProtocol(response(bytes([value])));
});

test('HTTP/content-type/options and bounded stage timings fail before a false completion', async () => {
  const f = fixture(); let calls = 0;
  for (const value of [response(bytes(f.frames), { status: 429 }), response(bytes(f.frames), { status: 503 }),
    response(bytes(f.frames), { headers: { 'content-type': 'application/json' } }), response(bytes(f.frames), { headers: { 'content-type': 'application/x-ndjson; charset=iso-8859-1' } })]) {
    await assert.rejects(readAuthoredSegmentsResponse(value, { onText() { calls++; }, onSegment() {} })); assert.equal(value.body.locked, false);
  }
  assert.equal(calls, 0);
  await assert.rejects(readAuthoredSegmentsResponse(response(bytes(f.frames), { status: 429 }), { onText() {}, onSegment() {} }), error => error.status === 429 && error.code === 'DIALOGUE_STREAM_HTTP_ERROR');
  for (const bad of [null, [], { totalMs: 1 }, { ...timings, extra: 1 }, { ...timings, totalMs: -1 }, { ...timings, synthesisMs: 180001 }, { ...timings, authorMs: '1' }]) {
    await rejectsProtocol(response(bytes([...f.frames.slice(0, -1), { type: 'done', timings: bad }])));
  }
  for (const limits of [{ pcmBytes: 0 }, { parts: 17 }, { totalBytes: AUTHORED_SEGMENTS_RESPONSE_LIMITS.totalBytes + 1 }, { unknown: 1 }]) await rejectsProtocol(response(), { limits });
});

test('line/total/cumulative limits accept exact boundaries and reject one unit beyond', async () => {
  const f = fixture(), input = bytes(f.frames);
  const limits = { textFrameBytes: encoder.encode(JSON.stringify(f.text)).byteLength,
    segmentFrameBytes: Math.max(...f.segments.map(value => encoder.encode(JSON.stringify(value)).byteLength)),
    metadataFrameBytes: Math.max(encoder.encode(JSON.stringify(f.final)).byteLength, encoder.encode(JSON.stringify(f.done)).byteLength),
    totalBytes: input.byteLength, parts: 2, pcmBytes: f.final.result.manifest.byteLength,
    base64Characters: f.segments.reduce((sum, value) => sum + value.result.pcmBase64.length, 0) };
  assert.deepEqual((await readAuthoredSegmentsResponse(response(input), { onText() {}, onSegment() {}, limits })).final, f.final.result);
  for (const key of Object.keys(limits)) await rejectsProtocol(response(input), { limits: { ...limits, [key]: limits[key] - 1 } });
  await rejectsProtocol(response(input, { headers: { 'content-length': String(AUTHORED_SEGMENTS_RESPONSE_LIMITS.totalBytes + 1) } }));
  await rejectsProtocol(response(input, { split: value => [value.subarray(0, 10), value.subarray(10)] }), { limits: { readChunks: 1 } });
});

test('sixteen independently padded parts can fill the global PCM limit without a false base64-overhead rejection', async () => {
  const texts = [...'abcdefghijklmnop'], pcms = texts.map((_, index) => Buffer.alloc(index === 15 ? 4320000 - 15 * 4 : 4, 0));
  const f = fixture(texts, pcms), characters = f.segments.reduce((sum, value) => sum + value.result.pcmBase64.length, 0); let calls = 0;
  assert.equal(characters, 5760040); assert.equal(f.final.result.manifest.byteLength, 4320000);
  const result = await readAuthoredSegmentsResponse(response(bytes(f.frames)), { onText() {}, onSegment() { calls++; } });
  assert.equal(calls, 16); assert.equal(result.final.manifest.sourceFrames, 2160000);
});

test('malformed UTF8/control bytes and strict envelope extras are rejected', async () => {
  for (const input of [new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d, 10]), new Uint8Array([0xf0, 0x9f, 10]),
    encoder.encode('{"type":"text","result":{"text":"bad\u0000text"}}\n')]) await rejectsProtocol(response(input));
  for (const change of [f => { f.text.extra = true; }, f => { f.segments[0].extra = true; }, f => { f.segments[0].result.extra = true; },
    f => { f.final.extra = true; }, f => { f.done.extra = true; }]) { const f = fixture(); change(f); await rejectsProtocol(response(bytes(f.frames))); }
});

test('abort while waiting for bytes cancels once, releases the reader and hides its private reason', { timeout: 5000 }, async () => {
  const source = openResponse(), controller = new AbortController();
  const result = readAuthoredSegmentsResponse(source.value, { onText() {}, onSegment() {}, signal: controller.signal });
  await tick(); controller.abort(Object.assign(Error('PRIVATE_ABORT_CANARY'), { name: 'TimeoutError' }));
  await assert.rejects(result, error => error.name === 'TimeoutError' && error.code === 'DIALOGUE_STREAM_ABORTED' && !error.message.includes('PRIVATE'));
  assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
});

test('abort interrupts either pending callback without admitting later parts or a full completion', { timeout: 5000 }, async () => {
  for (const phase of ['text', 'segment']) {
    const source = openResponse(), controller = new AbortController(), gate = deferred(), seen = [], f = fixture();
    const result = readAuthoredSegmentsResponse(source.value, { signal: controller.signal,
      async onText() { seen.push('text'); if (phase === 'text') await gate.promise; },
      async onSegment(value) { seen.push(value.manifest.index); await gate.promise; },
    });
    source.push(bytes(f.frames)); await until(() => seen.length === (phase === 'text' ? 1 : 2)); controller.abort();
    await assert.rejects(result, error => error.name === 'AbortError'); assert.equal(source.cancelled(), 1);
    gate.resolve(); await tick(); assert.deepEqual(seen, phase === 'text' ? ['text'] : ['text', 0]); assert.equal(source.value.body.locked, false);
  }
});

test('an unconfirmed cancel and an already-aborted signal cannot keep the parser waiting', { timeout: 5000 }, async () => {
  const controller = new AbortController(), gate = deferred(); let cancellations = 0;
  const value = new Response(new ReadableStream({ cancel() { cancellations++; return gate.promise; } }), { headers: { 'content-type': 'application/x-ndjson' } });
  const result = readAuthoredSegmentsResponse(value, { onText() {}, onSegment() {}, signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(result, error => error.name === 'AbortError'); assert.equal(cancellations, 1); assert.equal(value.body.locked, false); gate.resolve();
  const source = openResponse(), early = new AbortController(); let calls = 0; early.abort(Error('PRIVATE_EARLY_ABORT'));
  await assert.rejects(readAuthoredSegmentsResponse(source.value, { onText() { calls++; }, onSegment() {}, signal: early.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0); assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
});

test('callback rejection and midstream network loss never leak private details or return partial final metadata', async () => {
  const f = fixture();
  for (const phase of ['text', 'segment']) {
    const value = response(bytes(f.frames));
    await assert.rejects(readAuthoredSegmentsResponse(value, { onText() { if (phase === 'text') throw Error('PRIVATE_TEXT_CANARY'); },
      onSegment() { throw Object.assign(Error('PRIVATE_PART_CANARY'), { code: 'token=PRIVATE_CALLBACK' }); } }),
    error => error.code === 'DIALOGUE_STREAM_INVALID' && !error.message.includes('PRIVATE'));
    assert.equal(value.body.locked, false);
  }
  const source = openResponse(); let parts = 0;
  const result = readAuthoredSegmentsResponse(source.value, { onText() {}, onSegment() { parts++; } });
  source.push(line(f.text) + line(f.segments[0])); await until(() => parts === 1); source.error(Error('PRIVATE_TRANSPORT_CANARY'));
  await assert.rejects(result, error => error.code === 'DIALOGUE_STREAM_INVALID' && !error.message.includes('PRIVATE')); assert.equal(source.value.body.locked, false);
});
