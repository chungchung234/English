import { bytes, fingerprint, transcriptFingerprint, type TranscriptEvent } from './core.ts';
import { CONVERSATION_CHECKPOINT_VERSION, validateConversationCheckpoint } from './live-context.ts';

export const DIALOGUE_RAW_WINDOW_BYTES = 24_000;
export const DIALOGUE_CHECKPOINT_CHUNK_BYTES = 48_000;
export type QualifiedCheckpoint = { version: typeof CONVERSATION_CHECKPOINT_VERSION; summary: string; covered_ids: string[]; policy_fingerprint: string; source_digest?: unknown };
type JobRow = { request_key: string; result: Record<string, any> };
const samePrefix = (ids: string[], events: TranscriptEvent[]) => ids.length <= events.length && ids.every((id, index) => id.toLowerCase() === events[index].id.toLowerCase());
export function safeCheckpoint(value: unknown, events: TranscriptEvent[], policyFingerprint: string): QualifiedCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, any>, ids = item.covered_ids ?? item.covered_event_ids;
  if (item.version !== CONVERSATION_CHECKPOINT_VERSION || item.policy_fingerprint !== policyFingerprint || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids.map(id => id.toLowerCase())).size !== ids.length || !samePrefix(ids, events)) return null;
  try { return { version: CONVERSATION_CHECKPOINT_VERSION, ...validateConversationCheckpoint({ summary: item.summary }), covered_ids: [...ids], policy_fingerprint: policyFingerprint, ...(item.source_digest !== undefined ? { source_digest: item.source_digest } : {}) }; } catch { return null; }
}

// Old qualified checkpoints have no independent coverage digest in their
// result. Reconstruct their existing hash chain against the CURRENT exact raw
// rows instead of trusting covered_ids alone. Missing ancestors fail closed to
// a fresh bounded summary, never to old opaque provider state.
export async function verifiedLegacyCheckpoint(rows: JobRow[], events: TranscriptEvent[], expected: { prefix: string; revision: number; model: string; promptVersion: string; omitted: boolean; policyFingerprint: string }): Promise<QualifiedCheckpoint | null> {
  const candidates = rows.filter(row => row && typeof row.request_key === 'string' && row.request_key.startsWith(expected.prefix) && row.result &&
    row.result.revision === expected.revision && row.result.model === expected.model && row.result.prompt_version === expected.promptVersion && row.result.checkpoint_version === CONVERSATION_CHECKPOINT_VERSION && row.result.event_filter === 'qualified:v1' && (row.result.learning_omitted === true) === expected.omitted &&
    Array.isArray(row.result.covered_ids) && samePrefix(row.result.covered_ids, events));
  candidates.sort((a, b) => a.result.covered_ids.length - b.result.covered_ids.length || a.request_key.localeCompare(b.request_key));
  const valid: JobRow[] = [];
  for (const row of candidates) {
    if (new Set(row.result.covered_ids).size !== row.result.covered_ids.length) continue;
    try { validateConversationCheckpoint({ summary: row.result.checkpoint?.summary }); } catch { continue; }
    for (const previous of [null, ...valid]) {
      const covered = previous?.result.covered_ids ?? [];
      if (covered.length >= row.result.covered_ids.length || !covered.every((id: string, index: number) => id === row.result.covered_ids[index])) continue;
      const fresh = events.slice(covered.length, row.result.covered_ids.length);
      const key = expected.prefix + await fingerprint([await transcriptFingerprint(fresh), previous?.result ?? null]);
      if (row.request_key === key) { valid.push(row); break; }
    }
  }
  const result = valid.at(-1)?.result;
  return result ? { version: CONVERSATION_CHECKPOINT_VERSION, summary: result.checkpoint.summary, covered_ids: [...result.covered_ids], policy_fingerprint: expected.policyFingerprint } : null;
}

export async function compactQualifiedHistory(events: TranscriptEvent[], previous: QualifiedCheckpoint | null, policyFingerprint: string,
  summarize: (fresh: TranscriptEvent[], priorSummary: string | null, covered: TranscriptEvent[]) => Promise<string>,
  store: (checkpoint: QualifiedCheckpoint, covered: TranscriptEvent[]) => Promise<void>, rawBytes = DIALOGUE_RAW_WINDOW_BYTES) {
  let checkpoint = safeCheckpoint(previous, events, policyFingerprint), offset = checkpoint?.covered_ids.length ?? 0;
  // A single saved turn can be larger than the normal rolling target. Retain it
  // whole; never manufacture a shorter source quote or end a call for crossing
  // the soft rolling-window target.
  while (bytes(JSON.stringify(events.slice(offset))) > rawBytes && events.length - offset > 1) {
    const remaining = events.slice(offset); let take = 0, chunk: TranscriptEvent[] = [];
    while (take < remaining.length - 1 && bytes(JSON.stringify([...chunk, remaining[take]])) <= DIALOGUE_CHECKPOINT_CHUNK_BYTES) {
      chunk.push(remaining[take++]);
      if (bytes(JSON.stringify(remaining.slice(take))) <= rawBytes) break;
    }
    // UTF-8 size can exceed the soft chunk target for one valid saved turn.
    // Carry that source whole; adding the following turn must not turn an
    // otherwise valid long call into a permanently uncompactable history.
    if (!chunk.length) chunk = [remaining[0]];
    const covered = events.slice(0, offset + chunk.length), summary = await summarize(chunk, checkpoint?.summary ?? null, covered);
    const validated = validateConversationCheckpoint({ summary });
    checkpoint = { version: CONVERSATION_CHECKPOINT_VERSION, summary: validated.summary, covered_ids: covered.map(event => event.id), policy_fingerprint: policyFingerprint };
    await store(checkpoint, covered); offset = covered.length;
  }
  return { checkpoint, events: events.slice(offset), rolledOver: (checkpoint?.covered_ids.length ?? 0) !== (previous?.covered_ids.length ?? 0) };
}
