import { AppError } from './core.ts';
export const POLICY_VERSION = '2026-11-10-v2';
export const RATES: Record<string, { input: number; cached: number; write: number; output: number }> = {
  'text-embedding-3-small': { input: .02, cached: .02, write: .02, output: 0 },
  'gpt-6-luna': { input: .1, cached: .01, write: .125, output: .5 },
  'gpt-6.1-sol': { input: 2, cached: .1, write: 2.5, output: 10 },
};
export function reviewPolicy(kind: 'session' | 'weekly' | 'checkpoint' | 'memory', get: (name: string) => string | undefined) {
  const weekly = kind === 'weekly';
  const model = get(weekly ? 'ANALYSIS_MODEL' : kind === 'memory' ? 'MEMORY_MODEL' : kind === 'checkpoint' ? 'CHECKPOINT_MODEL' : 'COACH_MODEL') || (weekly ? 'gpt-6.1-sol' : 'gpt-6-luna');
  const effort = get(weekly ? 'ANALYSIS_REASONING' : kind === 'memory' ? 'MEMORY_REASONING' : kind === 'checkpoint' ? 'CHECKPOINT_REASONING' : 'COACH_REASONING') || (weekly ? 'medium' : 'low');
  if (!['gpt-6-luna', 'gpt-6.1-sol'].includes(model) || !['low', 'medium', 'high'].includes(effort)) throw new AppError(503, 'CONFIGURATION_REQUIRED', 'Unsupported model or reasoning policy.');
  return { model, effort, maxOutput: weekly ? 12000 : kind === 'memory' ? 1800 : 6000, verbosity: 'low' as const };
}
export function usageEstimate(raw: unknown, model: string) {
  const u = raw as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | undefined;
  const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const input = n(u?.input_tokens), output = n(u?.output_tokens);
  if (input === null || output === null) return { usage: null, estimated_usd: null };
  const cached = n(u?.input_tokens_details?.cached_tokens) ?? 0, writes = n(u?.input_tokens_details?.cache_write_tokens) ?? 0;
  if (cached + writes > input) return { usage: null, estimated_usd: null };
  const r = RATES[model];
  return { usage: { input_tokens: input, output_tokens: output, cached_tokens: cached, cache_write_tokens: writes, reasoning_tokens: n(u?.output_tokens_details?.reasoning_tokens) },
    estimated_usd: ((input - cached - writes) * r.input + cached * r.cached + writes * r.write + output * r.output) / 1e6 };
}
export function spendReservation(inputBytes: number, model: string, maxOutput: number) {
  // Conservative application reservation, not an invoice or provider hard cap.
  return ((inputBytes + 8192) * RATES[model].write + maxOutput * RATES[model].output) / 1e6;
}
