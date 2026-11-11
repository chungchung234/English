// Optional on older notes; generated only for post-call reviews, never checkpoints.
export const learningFocus = ['lexical', 'grammar', 'pattern', 'pragmatics', 'interaction', 'discourse'] as const;
export const expressionForms = ['general', 'collocation', 'phrasal_verb', 'idiom', 'colloquial', 'slang', 'reduction'] as const;
export const registers = ['unspecified', 'neutral', 'informal', 'formal'] as const;
const short = (maxLength: number) => ({ type: 'string', maxLength });
const properties = {
  focus: { type: 'string', enum: learningFocus }, form: { type: 'string', enum: expressionForms },
  source_quote: short(1000), source_is_question: { type: 'boolean' },
  usage: short(500), register: { type: 'string', enum: registers },
  example: { type: 'object', properties: { prompt: short(300), response: short(300) }, required: ['prompt', 'response'], additionalProperties: false },
  alternative: short(300),
};
export const reviewLearningSchema = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
export function validReviewLearning(value: unknown, quotations: string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const bounded = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max && (x === '' || x.trim().length > 0);
  if (Object.keys(v).sort().join() !== Object.keys(properties).sort().join()
    || !learningFocus.includes(v.focus as typeof learningFocus[number]) || !expressionForms.includes(v.form as typeof expressionForms[number])
    || !registers.includes(v.register as typeof registers[number]) || typeof v.source_is_question !== 'boolean'
    || !bounded(v.source_quote, 1000) || !bounded(v.usage, 500) || !bounded(v.alternative, 300)) return false;
  if (v.source_is_question && !v.source_quote.trim()) return false;
  if (v.source_quote && !quotations.some(quote => quote.includes(v.source_quote as string))) return false;
  const e = v.example as Record<string, unknown>;
  return !!e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).sort().join() === 'prompt,response'
    && bounded(e.prompt, 300) && bounded(e.response, 300) && Boolean(e.prompt.trim()) === Boolean(e.response.trim());
}
