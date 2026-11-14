// Protocol tests only: synthetic frames and byte streams, no auth/provider I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORED_RESPONSE_LIMITS, readAuthoredResponse } from '../web/authored-response.js';

const encoder = new TextEncoder();
const text = { type: 'text', result: { text: 'A specific character perspective.', owner: { turnId: 'synthetic' } } };
const audio = { type: 'audio', result: { protocol: 'authored_dialogue_v1', manifest: { owner: { turnId: 'synthetic' } }, pcmBase64: 'AQI=' } };
const done = { type: 'done', timings: { totalMs: 4210.5, authorMs: 1800, synthesisMs: 2110.5 } };
const frames = [text, audio, done];
const line = value => JSON.stringify(value) + '\n';
const encode = values => encoder.encode(values.map(line).join(''));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const until = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert(predicate(), 'local stream contract must settle');
};
function response(bytes = encode(frames), { headers, status = 200, split } = {}) {
  const parts = split ? split(bytes) : [bytes];
  return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }), {
    status, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', ...headers },
  });
}
function openResponse() {
  let controller, cancellations = 0;
  const value = new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { cancellations++; } }), {
    headers: { 'content-type': 'application/x-ndjson' },
  });
  return { value, push: value => controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value),
    close: () => controller.close(), error: error => controller.error(error), cancelled: () => cancellations };
}
async function rejectsProtocol(value, options = {}) {
  await assert.rejects(readAuthoredResponse(value, { onText: () => {}, ...options }), error => error.code === 'DIALOGUE_STREAM_INVALID');
  assert.equal(value.body.locked, false);
}

test('text arrives early, audio is withheld until done and the actual EOF', async () => {
  const source = openResponse(), seen = []; let settled = false;
  const result = readAuthoredResponse(source.value, { onText: value => { seen.push(value); } }).then(value => { settled = true; return value; });
  source.push(line(text)); await until(() => seen.length === 1);
  assert.deepEqual(seen, [text.result]); assert.equal(settled, false);
  source.push(line(audio) + line(done)); await tick(); assert.equal(settled, false, 'done alone does not hide trailing protocol violations');
  source.close(); assert.deepEqual(await result, { audio: audio.result, timings: done.timings });
  assert.equal(source.cancelled(), 0); assert.equal(source.value.body.locked, false);
});

test('asynchronous canonical-text admission is awaited before finishing the stream', async () => {
  const gate = deferred(); let entered = false, settled = false;
  const result = readAuthoredResponse(response(), { onText: async () => { entered = true; await gate.promise; } }).then(value => { settled = true; return value; });
  await until(() => entered); await tick(); assert.equal(settled, false);
  gate.resolve(); assert.deepEqual((await result).audio, audio.result);
});

test('UTF8 characters, JSON escapes, CRLF and arbitrary byte boundaries preserve exact text', async () => {
  const value = { type: 'text', result: { text: '한국어 🌙 says “hello”\nnext line.', owner: { turnId: 'synthetic' } } }, seen = [];
  const bytes = encoder.encode([value, audio, done].map(item => JSON.stringify(item) + '\r\n').join(''));
  const result = await readAuthoredResponse(response(bytes, { headers: { 'content-type': 'Application/X-NDJSON; Charset="UTF-8"' }, split: value => Array.from(value, (_, index) => value.subarray(index, index + 1)) }), { onText: item => { seen.push(item); } });
  assert.deepEqual(seen, [value.result]); assert.deepEqual(result.timings, done.timings);
});

test('HTTP errors, foreign content types and empty bodies never call text admission', async () => {
  let calls = 0;
  for (const value of [response(encode(frames), { status: 401 }), response(encode(frames), { status: 503 }),
    response(encode(frames), { headers: { 'content-type': 'application/json' } }),
    response(encode(frames), { headers: { 'content-type': 'text/event-stream' } }),
    response(encode(frames), { headers: { 'content-type': 'application/x-ndjson; charset=iso-8859-1' } }), response(new Uint8Array())]) {
    await assert.rejects(readAuthoredResponse(value, { onText: () => { calls++; } })); assert.equal(value.body.locked, false);
  }
  assert.equal(calls, 0);
});

test('non-OK status is retained without copying provider error bodies', async () => {
  const privateValue = 'PRIVATE_HTTP_ERROR_CANARY';
  await assert.rejects(readAuthoredResponse(response(encoder.encode(privateValue), { status: 429 }), { onText: () => {} }), error => {
    assert.equal(error.status, 429); assert.equal(error.code, 'DIALOGUE_STREAM_HTTP_ERROR');
    assert(!error.message.includes(privateValue)); return true;
  });
});

test('both budget codes survive an error before or after canonical text, with no audio result', async () => {
  const privateValue = 'PRIVATE_PROVIDER_DETAIL_CANARY';
  for (const code of ['BUDGET_EXCEEDED', 'COST_BUDGET_EXCEEDED']) for (const prefix of [[], [text]]) {
    const source = openResponse(), seen = [];
    const result = readAuthoredResponse(source.value, { onText: value => { seen.push(value); } });
    source.push(prefix.map(line).join('') + line({ type: 'error', error: { code, message: privateValue } }));
    await assert.rejects(result, error => { assert.equal(error.code, code); assert(!error.message.includes(privateValue)); return true; });
    assert.equal(seen.length, prefix.length); assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
  }
});

test('unsafe error codes become a fixed safe fallback rather than entering diagnostics', async () => {
  for (const code of ['token=PRIVATE_CODE_CANARY', 'lower_case', 'X'.repeat(65), { secret: 'PRIVATE_CODE_CANARY' }, null]) {
    await assert.rejects(readAuthoredResponse(response(encode([{ type: 'error', error: { code, message: 'private message' } }])), { onText: () => {} }), error => {
      assert.equal(error.code, 'DIALOGUE_STREAM_UNAVAILABLE'); assert(!JSON.stringify(error).includes('PRIVATE')); return true;
    });
  }
});

test('missing phases, missing final newline and unfinished JSON are rejected', async () => {
  for (const bytes of [encode([text]), encode([text, audio]), encoder.encode(line(text) + line(audio) + JSON.stringify(done)),
    encoder.encode(line(text) + '{"type":"audio","result":'), encoder.encode(line(text) + line(audio) + line(done) + ' ')]) await rejectsProtocol(response(bytes));
});

test('duplicates, reordering, unadvertised progress and frames after done cannot release audio', async () => {
  for (const values of [[audio, text, done], [done], [text, text, audio, done], [text, done], [text, audio, audio, done],
    [...frames, done], [...frames, { type: 'error', error: { code: 'BUDGET_EXCEEDED', message: 'failure' } }],
    [{ type: 'progress', stage: 'thinking' }, ...frames]]) await rejectsProtocol(response(encode(values)));
  await rejectsProtocol(response(encoder.encode(frames.map(line).join('') + '\n')));
});

test('strict envelopes and typed results reject malformed protocol without duplicating owner validation', async () => {
  for (const value of [{ ...text, extra: true }, { type: 'text', result: null }, { type: 'text', result: [] },
    { type: 'error', error: { code: 'BUDGET_EXCEEDED', message: 'x', secret: true } }]) await rejectsProtocol(response(encode([value, audio, done])));
  for (const value of [{ ...audio, extra: true }, { type: 'audio', result: null }, { type: 'audio', result: [] },
    { type: 'audio', result: { pcmBase64: 'AQI=', manifest: [] } }, { type: 'audio', result: { pcmBase64: 12, manifest: {} } }]) await rejectsProtocol(response(encode([text, value, done])));
});

test('final timings require exactly the bounded finite numeric stage fields', async () => {
  for (const timings of [null, [], { totalMs: 1 }, { ...done.timings, more: 1 }, { ...done.timings, authorMs: -1 },
    { ...done.timings, synthesisMs: 180001 }, { ...done.timings, totalMs: null }, { ...done.timings, authorMs: '1800' }]) await rejectsProtocol(response(encode([text, audio, { type: 'done', timings }])));
});

test('line and total byte limits accept the boundary and reject one byte beyond it', async () => {
  const bytes = encode(frames);
  for (const [key, count] of [['textFrameBytes', encoder.encode(JSON.stringify(text)).byteLength], ['audioFrameBytes', encoder.encode(JSON.stringify(audio)).byteLength],
    ['metadataFrameBytes', encoder.encode(JSON.stringify(done)).byteLength], ['totalBytes', bytes.byteLength]]) {
    assert.deepEqual((await readAuthoredResponse(response(bytes), { onText: () => {}, limits: { [key]: count } })).audio, audio.result);
    await rejectsProtocol(response(bytes), { limits: { [key]: count - 1 } });
  }
});

test('the PCM base64 hard ceiling applies even when the outer audio frame is below its byte ceiling', async () => {
  const oversized = { type: 'audio', result: { manifest: {}, pcmBase64: 'A'.repeat(5760001) } };
  await rejectsProtocol(response(encode([text, oversized, done])));
});

test('advertised excessive length, excessive read chunks and invalid limit overrides fail closed', async () => {
  await rejectsProtocol(response(encode(frames), { headers: { 'content-length': String(AUTHORED_RESPONSE_LIMITS.totalBytes + 1) } }));
  await rejectsProtocol(response(encode(frames), { split: bytes => [bytes.subarray(0, 10), bytes.subarray(10)] }), { limits: { readChunks: 1 } });
  for (const limits of [{ totalBytes: AUTHORED_RESPONSE_LIMITS.totalBytes + 1 }, { totalBytes: 0 }, { unknown: 1 }, { readChunks: NaN }]) await rejectsProtocol(response(), { limits });
});

test('malformed UTF8 and raw control bytes cannot pass JSON admission', async () => {
  for (const bytes of [new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d, 10]),
    encoder.encode('{"type":"text","result":{"text":"bad\u0000text"}}\n'), new Uint8Array([0xf0, 0x9f, 10])]) await rejectsProtocol(response(bytes));
});

test('abort while waiting for bytes rejects promptly and cancels the owned reader once', { timeout: 5000 }, async () => {
  const source = openResponse(), controller = new AbortController();
  const result = readAuthoredResponse(source.value, { onText: () => {}, signal: controller.signal });
  await tick(); controller.abort(Object.assign(Error('PRIVATE_ABORT_CANARY'), { name: 'TimeoutError' }));
  await assert.rejects(result, error => { assert.equal(error.name, 'TimeoutError'); assert.equal(error.code, 'DIALOGUE_STREAM_ABORTED'); assert(!error.message.includes('PRIVATE')); return true; });
  assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
});

test('abort also interrupts a text-admission callback that has not settled', { timeout: 5000 }, async () => {
  const source = openResponse(), controller = new AbortController(), gate = deferred(); let calls = 0;
  const result = readAuthoredResponse(source.value, { signal: controller.signal, onText: async () => { calls++; await gate.promise; } });
  source.push(line(text)); await until(() => calls === 1); controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError'); assert.equal(source.cancelled(), 1);
  gate.resolve(); await tick(); assert.equal(source.value.body.locked, false);
});

test('an unconfirmed transport cancel cannot keep an aborted response waiting', { timeout: 5000 }, async () => {
  const controller = new AbortController(), cancellation = deferred(); let cancelled = 0;
  const value = new Response(new ReadableStream({ cancel() { cancelled++; return cancellation.promise; } }), { headers: { 'content-type': 'application/x-ndjson' } });
  const result = readAuthoredResponse(value, { signal: controller.signal, onText: () => {} });
  await tick(); controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(cancelled, 1); assert.equal(value.body.locked, false);
  cancellation.resolve();
});

test('an already aborted request cannot emit text or leak its private cancellation reason', async () => {
  const source = openResponse(), controller = new AbortController(); let calls = 0;
  controller.abort(Error('PRIVATE_EARLY_ABORT_CANARY'));
  await assert.rejects(readAuthoredResponse(source.value, { signal: controller.signal, onText: () => { calls++; } }), error => error.name === 'AbortError' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 0); assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
});

test('failed text validation and network failure cancel without returning partial audio or private detail', async () => {
  const first = openResponse();
  const rejected = readAuthoredResponse(first.value, { onText: () => { throw Object.assign(Error('PRIVATE_CALLBACK_CANARY'), { code: 'token=PRIVATE_CALLBACK_CANARY' }); } });
  first.push(line(text)); await assert.rejects(rejected, error => error.code === 'DIALOGUE_STREAM_INVALID' && !error.message.includes('PRIVATE'));
  assert.equal(first.cancelled(), 1); assert.equal(first.value.body.locked, false);
  const second = openResponse(); let called = false;
  const lost = readAuthoredResponse(second.value, { onText: () => { called = true; } });
  second.push(line(text)); await until(() => called); second.error(Error('PRIVATE_TRANSPORT_CANARY'));
  await assert.rejects(lost, error => error.code === 'DIALOGUE_STREAM_INVALID' && !error.message.includes('PRIVATE'));
  assert.equal(second.value.body.locked, false);
});
