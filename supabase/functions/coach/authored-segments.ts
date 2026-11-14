import { AppError, bytes } from './core.ts';
import { createPreparedRealtimeReader, fidelityTokens, MAX_PCM_BYTES, pcmToBase64, realtimeReaderRequests, SYNTHESIS_OUTPUT_CAP, textDigest, verifySpeechCapture, wordsMatch, type PreparedSpeech, type PreparedSpeechBinding, type PrepareSynthesisAdapter, type SpeechCapture, type SpeechRequest, type SynthesisAdapter } from './verified-speech.ts';
import type { PlaybackOwner } from './authored-dialogue.ts';

export const SPEECH_SEGMENT_PLAN_VERSION = 'verified-speech-segments-v1';
export const MAX_SPEECH_SEGMENTS = 16;
export const SEGMENT_SYNTHESIS_DEADLINE_MS = 55_000;
export type SpeechSegmentPart = { index: number; startByte: number; endByte: number; textSha256: string };
export type SpeechSegmentPlan = { version: typeof SPEECH_SEGMENT_PLAN_VERSION; count: number; textByteLength: number; textSha256: string; parts: SpeechSegmentPart[] };
export type SegmentAudioResult = { protocol: 'authored_dialogue_v1'; manifest: Record<string, unknown>; pcmBase64: string };
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
const invalid = () => new AppError(502, 'SYNTHESIS_SEGMENT_INVALID', 'The spoken response could not be verified.');
export const speechSegmentNonce = (parentNonce: string, index: number) => parentNonce + ':' + index;

function sentencePieces(text: string): string[] {
  const pieces: string[] = [];
  for (const entry of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    const previous = pieces.at(-1), tail = previous?.trimEnd() ?? '';
    // ICU can separate a name after Dr. or an initial. This is only a transport
    // boundary decision; no character, sentence or answer content is rewritten.
    const abbreviation = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Fig|No)\.$/iu.test(tail) || /\b[A-Z]\.$/u.test(tail) || /(?:e\.g|i\.e)\.$/iu.test(tail);
    if (previous !== undefined && (abbreviation || !previous.trim() || !entry.segment.trim())) pieces[pieces.length - 1] += entry.segment;
    else pieces.push(entry.segment);
  }
  if (!pieces.length || pieces.join('') !== text) throw invalid();
  // Punctuation/emoji-only pieces cannot independently satisfy lexical
  // verification. Keep their exact bytes beside a spoken piece instead of
  // issuing a reader request which can never pass that verification.
  const spoken: string[] = []; let prefix = '';
  for (const piece of pieces) {
    if (!fidelityTokens(piece).length) {
      if (spoken.length) spoken[spoken.length - 1] += piece;
      else prefix += piece;
    } else { spoken.push(prefix + piece); prefix = ''; }
  }
  const readable = spoken.length ? spoken : [text];
  // A bounded number of transport requests does not truncate the full writer.
  // Every remaining sentence stays, verbatim, in the last transport piece.
  const bounded = readable.length <= MAX_SPEECH_SEGMENTS ? readable : [...readable.slice(0, MAX_SPEECH_SEGMENTS - 1), readable.slice(MAX_SPEECH_SEGMENTS - 1).join('')];
  // Value-bearing punctuation must not change lexical meaning at a boundary.
  const full = fidelityTokens(text), split = bounded.flatMap(fidelityTokens);
  return full.length === split.length && full.every((token, index) => token === split[index]) ? bounded : [text];
}
export async function planSpeechSegments(text: string): Promise<SpeechSegmentPlan> {
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw invalid();
  const canonical = encode(text);
  if (decode(canonical) !== text) throw invalid();
  let offset = 0;
  const parts: SpeechSegmentPart[] = [];
  for (const [index, piece] of sentencePieces(text).entries()) {
    if (!piece.trim()) throw invalid();
    const size = encode(piece).byteLength;
    parts.push({ index, startByte: offset, endByte: offset + size, textSha256: await textDigest(piece) }); offset += size;
  }
  return { version: SPEECH_SEGMENT_PLAN_VERSION, count: parts.length, textByteLength: canonical.byteLength, textSha256: await textDigest(text), parts };
}
async function plannedTexts(text: string, plan: SpeechSegmentPlan): Promise<string[]> {
  const canonical = encode(text);
  if (plan?.version !== SPEECH_SEGMENT_PLAN_VERSION || !Number.isSafeInteger(plan.count) || plan.count < 1 || plan.count > MAX_SPEECH_SEGMENTS || !Array.isArray(plan.parts) || plan.parts.length !== plan.count || canonical.byteLength !== plan.textByteLength || await textDigest(text) !== plan.textSha256) throw invalid();
  let offset = 0; const result: string[] = [];
  for (const [index, part] of plan.parts.entries()) {
    if (part.index !== index || part.startByte !== offset || !Number.isSafeInteger(part.endByte) || part.endByte <= offset || part.endByte > canonical.byteLength) throw invalid();
    let piece: string; try { piece = decode(canonical.subarray(offset, part.endByte)); } catch { throw invalid(); }
    if (!piece.trim() || await textDigest(piece) !== part.textSha256) throw invalid();
    result.push(piece); offset = part.endByte;
  }
  if (offset !== canonical.byteLength || result.join('') !== text) throw invalid();
  const full = fidelityTokens(text), split = result.flatMap(fidelityTokens);
  if (full.length !== split.length || full.some((token, index) => token !== split[index])) throw invalid();
  return result;
}
export function segmentedSynthesisReservation(text: string, plan: SpeechSegmentPlan, voice: string, speed: number, nonce: string): number {
  const canonical = encode(text);
  const input = plan.parts.reduce((sum, part) => sum + bytes(JSON.stringify(realtimeReaderRequests({ text: decode(canonical.subarray(part.startByte, part.endByte)), voice, speed, nonce: speechSegmentNonce(nonce, part.index), maxOutputTokens: SYNTHESIS_OUTPUT_CAP }))) + 8192, 0);
  return (input * .60 + SYNTHESIS_OUTPUT_CAP * 20) / 1e6;
}
function partUsage(raw: unknown, cap: number): { input_tokens: number; output_tokens: number; total_tokens: number } | null {
  const value = raw as { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_token_details?: { audio_tokens?: number }; input_tokens_details?: { audio_tokens?: number } } | null;
  const valid = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
  if (typeof value?.output_tokens === 'number' && value.output_tokens > cap) throw new AppError(502, 'SYNTHESIS_OUTPUT_LIMIT', 'The spoken response budget could not be verified.');
  if (!valid(value?.input_tokens) || !valid(value?.output_tokens) || value.output_tokens === 0 || (value.total_tokens !== undefined && (!valid(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens)) || [value.input_token_details?.audio_tokens, value.input_tokens_details?.audio_tokens].some(n => n !== undefined && n !== 0)) return null;
  return { input_tokens: value.input_tokens, output_tokens: value.output_tokens, total_tokens: value.input_tokens + value.output_tokens };
}
export type SegmentSynthesisOptions = {
  text: string; plan: SpeechSegmentPlan; binding: PreparedSpeechBinding; owner: PlaybackOwner; synthesisId: string;
  dispatch(): Promise<void>; onBegin?(): void; onPart(result: SegmentAudioResult): void;
  prepare?: PrepareSynthesisAdapter; synthesize?: SynthesisAdapter; firstPrepared?: PreparedSpeech | null; deadlineMs?: number; deadlineAt?: number;
};
export async function runSpeechSegments(options: SegmentSynthesisOptions): Promise<SpeechCapture> {
  let pieces: string[];
  try { pieces = await plannedTexts(options.text, options.plan); }
  catch (error) { try { await options.firstPrepared?.dispose(); } catch { /* invalid source cannot be consumed */ } throw error; }
  const all: PreparedSpeech[] = options.firstPrepared ? [options.firstPrepared] : [], chunks: Uint8Array[] = [], transcripts: string[] = [], finalTranscripts: string[] = [];
  let remaining = SYNTHESIS_OUTPUT_CAP, byteLength = 0, inputTokens = 0, outputTokens = 0, unknown = false, stopped = false;
  const deadline = Math.min(options.deadlineAt ?? Infinity, Date.now() + Math.min(SEGMENT_SYNTHESIS_DEADLINE_MS, Math.max(1, options.deadlineMs ?? SEGMENT_SYNTHESIS_DEADLINE_MS)));
  const unavailable = () => new AppError(502, 'SYNTHESIS_UNAVAILABLE', 'The spoken response could not be completed.');
  const notStopped = () => { if (stopped || options.binding.signal?.aborted || Date.now() >= deadline) throw unavailable(); };
  let rejectDeadline: (reason: unknown) => void = () => {};
  const ended = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; }); void ended.catch(() => {});
  const closeAll = () => Promise.allSettled(all.map(reader => reader.dispose()));
  const stop = () => { if (stopped) return; stopped = true; rejectDeadline(unavailable()); void closeAll(); };
  const timer = setTimeout(stop, Math.max(1, deadline - Date.now())); options.binding.signal?.addEventListener('abort', stop, { once: true });
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, ended]);
  const create = (index: number, cap: number): PreparedSpeech => {
    notStopped(); const binding = { ...options.binding, nonce: speechSegmentNonce(options.binding.nonce, index), maxOutputTokens: cap, deadlineMs: Math.max(1, deadline - Date.now()) };
    const reader = index === 0 && options.firstPrepared ? options.firstPrepared : options.prepare ? options.prepare(binding) : options.synthesize ? { ready: Promise.resolve(), generate: request => options.synthesize!(request), dispose: async () => {} } as PreparedSpeech : createPreparedRealtimeReader(binding);
    if (!all.includes(reader)) all.push(reader); void reader.ready.catch(() => {}); return reader;
  };
  let current: PreparedSpeech | null = null;
  try {
    current = create(0, remaining);
    for (let index = 0; index < pieces.length; index++) {
      if (!current) throw invalid();
      notStopped(); const cap = remaining, request: SpeechRequest = { ...options.binding, text: pieces[index], nonce: speechSegmentNonce(options.binding.nonce, index), maxOutputTokens: cap, deadlineMs: Math.max(1, deadline - Date.now()) };
      await bounded(current.ready); await bounded(options.dispatch()); notStopped();
      if (index === 0) options.onBegin?.();
      // Prepared.generate sends response.create synchronously after this guard.
      const capture = await bounded(current.generate(request)); notStopped();
      const ownedPcm = new Uint8Array(capture.pcm);
      const clip = await bounded(verifySpeechCapture({ ...capture, pcm: ownedPcm }, pieces[index])); notStopped();
      const usage = partUsage(capture.usage, cap);
      if (!usage && index + 1 < pieces.length) throw new AppError(502, 'SYNTHESIS_USAGE_UNCONFIRMED', 'The spoken response budget could not be verified.');
      if (usage) { inputTokens += usage.input_tokens; outputTokens += usage.output_tokens; remaining -= usage.output_tokens; } else unknown = true;
      if (outputTokens > SYNTHESIS_OUTPUT_CAP || remaining <= 0 && index + 1 < pieces.length) throw new AppError(502, 'SYNTHESIS_OUTPUT_LIMIT', 'The spoken response budget could not be verified.');
      byteLength += clip.byteLength; if (byteLength > MAX_PCM_BYTES) throw invalid();
      chunks.push(ownedPcm); transcripts.push(capture.transcript); finalTranscripts.push(capture.finalTranscript);
      const next = index + 1 < pieces.length ? create(index + 1, remaining) : null;
      if (!next && (!wordsMatch(options.text, transcripts.join(' ')) || !wordsMatch(options.text, finalTranscripts.join(' ')))) throw invalid();
      const part = options.plan.parts[index];
      const result: SegmentAudioResult = { protocol: 'authored_dialogue_v1', manifest: { version: 'verified-pcm-segment-v1', owner: options.owner, synthesisId: options.synthesisId,
        index, count: options.plan.count, startByte: part.startByte, endByte: part.endByte, parentTextSha256: options.plan.textSha256, textSha256: clip.textSha256, pcmSha256: clip.pcmSha256,
        format: 'pcm_s16le', sampleRate: 24000, channels: 1, sourceFrames: clip.sourceFrames, byteLength: clip.byteLength,
        transcriptVerification: { status: 'matched', policyVersion: 'lexical-fidelity-v1', approvedTextSha256: clip.textSha256 }, synthesisSpeed: options.binding.speed }, pcmBase64: pcmToBase64(ownedPcm) };
      // A delivered part is source-authorized transient audio, not a durable
      // parent publication or a claim that the whole response was heard.
      await bounded(options.dispatch()); notStopped(); options.onPart(result);
      current = next;
    }
    const pcm = new Uint8Array(byteLength); let offset = 0; for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.byteLength; }
    const capture: SpeechCapture = { pcm, transcript: transcripts.join(' '), finalTranscript: finalTranscripts.join(' '), usage: unknown ? null : { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }, protocolVerified: true };
    await bounded(verifySpeechCapture(capture, options.text)); notStopped(); return capture;
  } finally { clearTimeout(timer); options.binding.signal?.removeEventListener('abort', stop); await closeAll(); }
}
