// Backend-approved instructions are authority; provider echoes are observations.
// In particular, a speed/floor update or a delayed full-session echo must never
// replace the text later used by response.create. No provider text is logged.
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const validVersion = value => value === null || typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const validRevision = value => value === null || Number.isSafeInteger(value) && value >= 0;
const error = () => Object.assign(new TypeError('Invalid approved voice instructions.'), { code: 'INVALID_VOICE_INSTRUCTIONS' });

function approved(value, defaults = {}) {
  const { instructions, policyVersion = defaults.policyVersion ?? null, memoryRevision = defaults.memoryRevision ?? null } = value || {};
  if (!nonempty(instructions) || !validVersion(policyVersion) || !validRevision(memoryRevision)) throw error();
  return Object.freeze({ instructions, policyVersion, memoryRevision });
}
const publicVersion = (value, generation) => value ? Object.freeze({ generation, policyVersion: value.policyVersion,
  memoryRevision: value.memoryRevision, length: value.instructions.length }) : null;

export function createVoiceInstructions({ onMismatch = () => {} } = {}) {
  let active = null, opening = null, pending = null, observed = null;
  let generation = 0, sequence = 0, initialized = false, disposed = false;
  const reported = new Set();
  const current = token => Boolean(!disposed && pending && pending.token === token && token.baseGeneration === generation);
  const matches = (token, event) => current(token) && event?.type === 'session.updated' && event.session?.instructions === pending.value.instructions;
  function observe(event) {
    if (disposed || !['session.created', 'session.updated'].includes(event?.type) || !nonempty(event.session?.instructions)) return null;
    const text = event.session.instructions;
    const status = active?.instructions === text ? 'matched_authoritative' : pending?.value.instructions === text ? 'matched_pending' : active || pending ? 'mismatched' : 'unapproved';
    observed = Object.freeze({ status, eventType: event.type, generation, length: text.length });
    if (status === 'mismatched') {
      const key = generation + ':' + event.type;
      if (!reported.has(key)) {
        reported.add(key);
        try { onMismatch({ code: 'VOICE_INSTRUCTIONS_MISMATCH', request_type: event.type === 'session.updated' ? 'session.update' : 'unknown' }); }
        catch { /* A diagnostic cannot change the conversation's authority. */ }
      }
    }
    return observed;
  }
  return {
    initialize(value) {
      if (disposed || initialized || pending) return false;
      const next = approved(value);
      if (value.openingInstructions !== undefined && value.openingInstructions !== null && !nonempty(value.openingInstructions)) throw error();
      active = next; opening = value.openingInstructions ?? null;
      initialized = true; generation++; reported.clear(); return true;
    },
    stage(value) {
      if (disposed) throw error();
      const next = approved(value, active || {}), token = Object.freeze({ sequence: ++sequence, baseGeneration: generation });
      pending = { token, value: next }; return token;
    },
    matches,
    commit(token, event) {
      if (!matches(token, event)) return false;
      active = pending.value; pending = null; opening = null; initialized = true; generation++; reported.clear();
      observed = Object.freeze({ status: 'matched_authoritative', eventType: event.type, generation, length: active.instructions.length });
      return true;
    },
    cancel(token) {
      if (!current(token)) return false;
      pending = null; return true;
    },
    observe,
    invalidate() {
      // The caller must do this on a known forget/exclusion/source revocation.
      // A fresh backend-approved memoryless configuration may then be staged;
      // invalidated text must never be restored after a timeout or rollback.
      if (active || opening || pending) generation++;
      active = null; opening = null; pending = null; observed = null; reported.clear();
    },
    dispose() { this.invalidate(); disposed = true; },
    get instructions() { return disposed ? null : active?.instructions ?? null; },
    get openingInstructions() { return disposed ? null : opening; },
    get state() { return Object.freeze({ initialized, disposed, generation,
      authoritative: publicVersion(active, generation), pending: pending ? Object.freeze({ ...publicVersion(pending.value, generation), sequence: pending.token.sequence }) : null,
      observed }); },
  };
}

// For bounded synthetic QA. Runtime authority compares the exact text and does
// not wait on hashing; routine diagnostics only receive fixed codes above.
export async function voiceInstructionsDigest(instructions, subtle = globalThis.crypto?.subtle) {
  if (!nonempty(instructions) || typeof subtle?.digest !== 'function') throw error();
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(instructions));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
