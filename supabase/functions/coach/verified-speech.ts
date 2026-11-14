import { AppError } from './core.ts';

// Same frozen rule as the separately reviewed read-aloud experiment. This is
// lexical agreement with the provider's audio transcript, not waveform ASR or
// proof that a listener heard the clip.
export const FIDELITY_POLICY_VERSION = 'lexical-fidelity-v1';
export const MAX_PCM_BYTES = 4_320_000;
export const READER_INSTRUCTIONS = "Read the user's text aloud without adding commentary.";
export const SYNTHESIS_MODEL = 'gpt-realtime-2.1-mini';
export const PCM_RATE = 24000;
export const SYNTHESIS_OUTPUT_CAP = 4096;
export type SpeechCapture = { pcm: Uint8Array; transcript: string; finalTranscript: string; usage: unknown; protocolVerified: boolean };
export type SpeechRequest = { text: string; nonce: string; voice: string; speed: number; key: string; signal?: AbortSignal; deadlineMs?: number };
export type SynthesisAdapter = (request: SpeechRequest) => Promise<SpeechCapture>;
export function realtimeReaderRequests(request: Pick<SpeechRequest, 'text' | 'voice' | 'speed' | 'nonce'>) {
  return { session: { type: 'session.update', session: { type: 'realtime', reasoning: { effort: 'low' }, instructions: READER_INSTRUCTIONS, max_output_tokens: SYNTHESIS_OUTPUT_CAP, truncation: 'disabled', output_modalities: ['audio'], tools: [], tool_choice: 'none', audio: { input: { transcription: null, turn_detection: null }, output: { voice: request.voice, speed: request.speed, format: { type: 'audio/pcm', rate: PCM_RATE } } } } },
    response: { type: 'response.create', response: { conversation: 'none', input: [], instructions: 'Say exactly the following:\n' + request.text, output_modalities: ['audio'], tools: [], tool_choice: 'none', metadata: { turn_nonce: request.nonce, purpose: 'authored_dialogue_synthesis' } } } };
}

export function fidelityTokens(value: string): string[] {
  if (typeof value !== 'string') throw new AppError(502, 'SYNTHESIS_TEXT_INVALID', 'The spoken response could not be verified.');
  const text = value.normalize('NFC').replace(/[\u2018\u2019\u201b\u02bc\uff07]/g, "'").replace(/[\u201c\u201d\u201f\uff02]/g, '"').replace(/\u2212/g, '-').replace(/\p{White_Space}+/gu, ' ').trim().toLocaleLowerCase('en');
  const points = Array.from(text), tokens: string[] = [], offsets: number[] = [], before: (string | undefined)[] = [], after: (string | undefined)[] = [];
  let unit = 0, neighbor: string | undefined;
  for (let i = 0; i < points.length; i++) { offsets.push(unit); unit += points[i].length; before[i] = neighbor; if (points[i] !== ' ') neighbor = points[i]; }
  neighbor = undefined;
  for (let i = points.length - 1; i >= 0; i--) { after[i] = neighbor; if (points[i] !== ' ') neighbor = points[i]; }
  const word = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/uy;
  const letter = (c: unknown) => typeof c === 'string' && /[\p{L}\p{M}]/u.test(c), numeric = (c: unknown) => typeof c === 'string' && /\p{N}/u.test(c);
  for (let i = 0; i < points.length;) {
    word.lastIndex = offsets[i]; const match = word.exec(text);
    if (match) { tokens.push(match[0]); const end = word.lastIndex; do { i++; } while (i < points.length && offsets[i] < end); continue; }
    const c = points[i], left = before[i], right = after[i];
    if (/[\p{Sc}+%‰]/u.test(c) || (c === '-' && !(letter(left) && letter(right))) || (['.', ',', ':', '/'].includes(c) && numeric(left) && numeric(right)) || (c === '.' && numeric(right))) tokens.push(c);
    i++;
  }
  return tokens;
}
export function wordsMatch(source: string, transcript: string): boolean {
  const expected = fidelityTokens(source), actual = fidelityTokens(transcript);
  return expected.length > 0 && expected.length === actual.length && expected.every((word, index) => word === actual[index]);
}
export function pcmToBase64(bytes: Uint8Array): string {
  let raw = ''; for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(raw);
}
export function pcmFromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new AppError(502, 'SYNTHESIS_AUDIO_INVALID', 'The spoken response could not be verified.');
  try { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { throw new AppError(502, 'SYNTHESIS_AUDIO_INVALID', 'The spoken response could not be verified.'); }
}
export async function pcmDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), value => value.toString(16).padStart(2, '0')).join('');
}
export const textDigest = (text: string) => pcmDigest(new TextEncoder().encode(text));
export async function verifySpeechCapture(capture: SpeechCapture, text: string) {
  const pcm = capture?.pcm;
  if (capture?.protocolVerified !== true || !(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 || pcm.length > MAX_PCM_BYTES || !pcm.some(value => value !== 0)) {
    throw new AppError(502, 'SYNTHESIS_AUDIO_INVALID', 'The spoken response could not be verified.');
  }
  if (typeof capture.transcript !== 'string' || typeof capture.finalTranscript !== 'string' || capture.transcript.length > 20_000 || capture.finalTranscript.length > 20_000 || !wordsMatch(text, capture.transcript) || !wordsMatch(text, capture.finalTranscript)) {
    throw new AppError(502, 'SYNTHESIS_TEXT_MISMATCH', 'The spoken response did not match the prepared reply.');
  }
  return { pcm, textSha256: await textDigest(text), pcmSha256: await pcmDigest(pcm), sourceFrames: pcm.length / 2, byteLength: pcm.length };
}

type Data = Record<string, any>;
export interface ReaderSocket { readyState: number; on(name: string, callback: (...args: any[]) => void): unknown; once(name: string, callback: (...args: any[]) => void): unknown; send(text: string): void; close(): void; terminate(): void }
export type OpenReaderSocket = (url: string, key: string) => ReaderSocket | Promise<ReaderSocket>;
async function openReaderSocket(url: string, key: string): Promise<ReaderSocket> {
  // Imported only when the explicitly enabled server adapter is invoked. Tests
  // inject a socket and never load or contact this provider.
  const { default: WebSocket } = await import('npm:ws@8.18.3');
  return new WebSocket(url, { headers: { Authorization: 'Bearer ' + key }, perMessageDeflate: false });
}
export type PreparedSpeechBinding = Omit<SpeechRequest, 'text'>;
export type PreparedSpeech = { ready: Promise<void>; generate(request: SpeechRequest): Promise<SpeechCapture>; dispose(): Promise<void> };
export type PrepareSynthesisAdapter = (binding: PreparedSpeechBinding) => PreparedSpeech;

// A prepared reader belongs to one server request. Session setup carries no
// caller text and creates no response. The caller must await ready BEFORE its
// final budget/source dispatch guard, then invoke generate without setup awaits.
export function createPreparedRealtimeReader(binding: PreparedSpeechBinding, open: OpenReaderSocket = openReaderSocket): PreparedSpeech {
  return preparedReader(binding, open);
}
function preparedReader(binding: PreparedSpeechBinding, open: OpenReaderSocket, absoluteDeadline?: number): PreparedSpeech {
  const unavailable = () => new AppError(502, 'SYNTHESIS_UNAVAILABLE', 'The spoken response could not be completed.');
  const invalid = () => new AppError(502, 'SYNTHESIS_UNVERIFIED', 'The spoken response could not be verified.');
  const duration = Math.min(55_000, Math.max(1, binding.deadlineMs ?? 55_000));
  let deadline = absoluteDeadline ?? Date.now() + Math.min(15_000, duration);
  let socket: ReaderSocket | null = null, openingAbort: (() => void) | null = null, disposing: Promise<void> | null = null;
  let fault = false, opened = false, closed = false, closing = false, disposed = false, prepared = false, consumed = false, generating = false;
  let responseId = '', itemId = '', bytes = 0, sessionAcks = 0, itemCount = 0, partCount = 0, audioDone = 0, transcriptDone = 0;
  let done = false, transcript = '', finalTranscript = '', responseInstructions = '', usage: unknown;
  const chunks: Uint8Array[] = [], waiters = new Set<() => void>();
  const pulse = () => { for (const test of [...waiters]) test(); };
  const fail = () => { fault = true; pulse(); };
  const signalAbort = () => { fail(); void dispose(); };
  const samePart = (event: Data) => Boolean(responseId && itemId && event.response_id === responseId && event.item_id === itemId && event.output_index === 0 && event.content_index === 0);
  const lifetime = setTimeout(() => { fail(); void dispose(); }, Math.max(1, (absoluteDeadline ?? Date.now() + 120_000) - Date.now()));
  function waitFor(condition: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fault = true; test(); }, Math.max(1, deadline - Date.now()));
      const test = () => {
        if (fault || binding.signal?.aborted || Date.now() >= deadline || disposed) { clearTimeout(timer); waiters.delete(test); reject(unavailable()); }
        else if (condition()) { clearTimeout(timer); waiters.delete(test); resolve(); }
      };
      waiters.add(test); test();
    });
  }
  function send(event: Data) {
    if (!socket || socket.readyState !== 1 || fault || disposed || Date.now() >= deadline) throw unavailable();
    socket.send(JSON.stringify({ ...event, event_id: crypto.randomUUID() }));
  }
  function onMessage(raw: { toString(): string }) {
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error' || typeof event.type === 'string' && event.type.startsWith('response.') && !generating) { fail(); return; }
      if (event.type === 'session.updated') {
        sessionAcks++;
        const session = event.session;
        if (sessionAcks !== 1 || session?.model !== SYNTHESIS_MODEL || session?.instructions !== READER_INSTRUCTIONS || session?.audio?.output?.voice !== binding.voice || session?.audio?.output?.speed !== binding.speed || session?.audio?.output?.format?.type !== 'audio/pcm' || session?.audio?.output?.format?.rate !== PCM_RATE || session?.audio?.input?.turn_detection !== null || session?.audio?.input?.transcription !== null || !Array.isArray(session?.tools) || session.tools.length !== 0 || session.tool_choice !== 'none') fail();
      }
      if (event.type === 'conversation.item.created' || event.type === 'conversation.item.added') fail();
      if (event.type === 'response.created') {
        if (responseId || typeof event.response?.id !== 'string' || event.response.metadata?.turn_nonce !== binding.nonce || event.response.metadata?.purpose !== 'authored_dialogue_synthesis' || (event.response.model !== undefined && event.response.model !== SYNTHESIS_MODEL) || (typeof event.response.instructions === 'string' && event.response.instructions !== responseInstructions)) fail();
        else responseId = event.response.id;
      }
      if (event.type === 'response.output_item.added') {
        if (!responseId || event.response_id !== responseId || event.output_index !== 0 || itemId || event.item?.type !== 'message' || event.item?.role !== 'assistant' || typeof event.item?.id !== 'string') fail();
        else { itemId = event.item.id; itemCount++; }
      }
      if (event.type === 'response.content_part.added') {
        if (!samePart(event) || partCount || !['audio', 'output_audio'].includes(event.part?.type)) fail(); else partCount++;
      }
      if (event.type === 'response.output_audio.delta') {
        if (!samePart(event) || partCount !== 1 || audioDone || done || typeof event.delta !== 'string') fail();
        else { const chunk = pcmFromBase64(event.delta); bytes += chunk.length; if (bytes > MAX_PCM_BYTES) fail(); else chunks.push(chunk); }
      }
      if (event.type === 'response.output_audio.done') { if (!samePart(event) || partCount !== 1 || audioDone || done) fail(); else audioDone++; }
      if (event.type === 'response.output_audio_transcript.done') {
        if (!samePart(event) || partCount !== 1 || transcriptDone || done || typeof event.transcript !== 'string' || event.transcript.length > 20_000) fail();
        else { transcriptDone++; transcript = event.transcript; }
      }
      if (event.type === 'response.done') {
        const response = event.response, output = response?.output, item = Array.isArray(output) && output.length === 1 ? output[0] : null, part = Array.isArray(item?.content) && item.content.length === 1 ? item.content[0] : null;
        if (done || !responseId || response?.id !== responseId || response.status !== 'completed' || response.metadata?.turn_nonce !== binding.nonce || response.metadata?.purpose !== 'authored_dialogue_synthesis' || (response.model !== undefined && response.model !== SYNTHESIS_MODEL) || (typeof response.instructions === 'string' && response.instructions !== responseInstructions) || item?.id !== itemId || item?.type !== 'message' || item?.role !== 'assistant' || !['audio', 'output_audio'].includes(part?.type) || typeof part?.transcript !== 'string' || part.transcript.length > 20_000 || !audioDone || !transcriptDone) fail();
        else { done = true; finalTranscript = part.transcript; usage = response.usage; }
      }
      pulse();
    } catch { fail(); }
  }
  function dispose(): Promise<void> {
    if (disposing) return disposing;
    disposed = true; closing = true; clearTimeout(lifetime); binding.signal?.removeEventListener('abort', signalAbort);
    openingAbort?.(); pulse();
    disposing = (async () => {
      const owned = socket;
      if (!owned) return;
      try { if (owned.readyState !== 3) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 300); owned.once('close', () => { clearTimeout(timer); resolve(); }); owned.close(); }); } catch { fault = true; }
      if (owned.readyState !== 3) { owned.terminate(); fault = true; }
    })();
    return disposing;
  }
  const ready = (async () => {
    if (binding.signal?.aborted) throw unavailable();
    binding.signal?.addEventListener('abort', signalAbort, { once: true });
    socket = await new Promise<ReaderSocket>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: ReaderSocket) => {
        if (settled) { if (value) { value.on('error', () => {}); try { value.close(); value.terminate(); } catch { /* late opening cannot publish */ } } return; }
        settled = true; clearTimeout(timer); openingAbort = null;
        if (error || disposed) { if (value) { value.on('error', () => {}); try { value.close(); value.terminate(); } catch { /* invalid opening cannot publish */ } } reject(error ?? unavailable()); }
        else resolve(value!);
      };
      openingAbort = () => finish(unavailable());
      const timer = setTimeout(() => finish(unavailable()), Math.max(1, deadline - Date.now()));
      Promise.resolve().then(() => { if (disposed || binding.signal?.aborted) throw unavailable(); return open('wss://api.openai.com/v1/realtime?model=' + SYNTHESIS_MODEL, binding.key); }).then(value => finish(undefined, value), () => finish(unavailable()));
    });
    // The factory may have settled just before disposal, while this await's
    // continuation was still queued. A cached no-socket dispose cannot close
    // this newly assigned value, so retire it directly before installing setup.
    if (disposed || binding.signal?.aborted) {
      socket.on('error', () => {});
      try { socket.close(); socket.terminate(); } catch { /* this request can never consume the arriving socket */ }
      throw unavailable();
    }
    opened = socket.readyState === 1;
    socket.on('open', () => { opened = true; pulse(); }); socket.on('error', fail);
    socket.on('close', () => { closed = true; if (!closing) fault = true; pulse(); }); socket.on('message', onMessage);
    if (disposed || binding.signal?.aborted) throw unavailable();
    await waitFor(() => opened);
    send(realtimeReaderRequests({ text: '', nonce: binding.nonce, voice: binding.voice, speed: binding.speed }).session);
    await waitFor(() => sessionAcks === 1);
    prepared = true;
  })().catch(async error => { fail(); await dispose(); throw error; });
  // Writer work can still be running when setup fails; its later ready await
  // receives the same rejection without an unhandled-promise side channel.
  void ready.catch(() => {});
  function generate(request: SpeechRequest): Promise<SpeechCapture> {
    if (consumed || disposed || fault || !prepared || request.nonce !== binding.nonce || request.voice !== binding.voice || request.speed !== binding.speed || request.key !== binding.key || request.signal !== binding.signal || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 20_000) {
      fail(); void dispose(); return Promise.reject(invalid());
    }
    consumed = true; generating = true; deadline = absoluteDeadline ?? Date.now() + Math.min(55_000, Math.max(1, request.deadlineMs ?? 55_000));
    responseInstructions = 'Say exactly the following:\n' + request.text;
    // This send is synchronous: no connection, ACK or other setup await is
    // inserted after the caller's fresh source/cost dispatch acknowledgement.
    try { send(realtimeReaderRequests(request).response); }
    catch (error) { fail(); void dispose(); return Promise.reject(error); }
    return (async () => {
      try { await waitFor(() => done && audioDone === 1 && transcriptDone === 1 && bytes > 0); }
      finally { await dispose(); }
      if (fault || binding.signal?.aborted || !closed || itemCount !== 1 || partCount !== 1 || !done || audioDone !== 1 || transcriptDone !== 1) throw invalid();
      const pcm = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
      return { pcm, transcript, finalTranscript, usage, protocolVerified: true };
    })();
  }
  return { ready, generate, dispose };
}

export function createRealtimeReader(open: OpenReaderSocket = openReaderSocket): SynthesisAdapter {
  return async request => {
    const absoluteDeadline = Date.now() + Math.min(55_000, Math.max(1, request.deadlineMs ?? 55_000));
    const prepared = preparedReader(request, open, absoluteDeadline);
    try { await prepared.ready; return await prepared.generate(request); }
    finally { await prepared.dispose(); }
  };
}
