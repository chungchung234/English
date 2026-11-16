import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze({
  external_anonymous_users_enabled: false,
  password_hibp_enabled: true,
});
const fields = Object.keys(TARGETS);
const safeValues = value => Object.fromEntries(fields.map(field => [field, value[field]]));
const validConfig = value => value && typeof value === 'object' && !Array.isArray(value) &&
  fields.every(field => typeof value[field] === 'boolean');
const unchangedExcept = (before, after, field) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every(key => key === field || JSON.stringify(before[key]) === JSON.stringify(after[key]));
};

/**
 * Narrow management operation, separate from deployment and live audio. Only
 * these two booleans may be patched. Configuration responses stay in memory;
 * results never contain SMTP/OAuth credentials, account data or API messages.
 * A failed/ambiguous PATCH is not retried, even when a fresh GET succeeds.
 */
export async function hardenAuth(env, { apply = false } = {}, fetcher = fetch) {
  const report = { status: 'unverified', apply: apply === true, complete: false, steps: [] };
  if (typeof apply !== 'boolean') return { ...report, status: 'invalid_arguments' };
  const ref = env.SUPABASE_PROJECT_REF;
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (typeof ref !== 'string' || !/^[a-z0-9]{20}$/.test(ref) || typeof token !== 'string' || !token.trim()) {
    return { ...report, status: 'invalid_management_configuration' };
  }
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function call(method, body) {
    try {
      const response = await fetcher(endpoint, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) return { status: 'http_rejected', http_status: response.status };
      if (method === 'PATCH') return { status: 'accepted', http_status: response.status };
      const config = await response.json();
      return validConfig(config) ? { status: 'verified', config } : { status: 'invalid_configuration_response' };
    } catch {
      // Fetch errors can include URLs, response details or request credentials.
      return { status: 'transport_or_response_failure' };
    }
  }
  const initial = await call('GET');
  if (initial.status !== 'verified') return { ...report, status: 'initial_read_failed', read_status: initial.status,
    ...(initial.http_status === undefined ? {} : { http_status: initial.http_status }) };
  let current = initial.config;
  report.observed = safeValues(current);
  report.steps = fields.map(field => ({ field, before: current[field], target: TARGETS[field],
    status: current[field] === TARGETS[field] ? 'already_hardened' : 'planned' }));
  if (!apply) return { ...report, status: 'dry_run', complete: fields.every(field => current[field] === TARGETS[field]) };

  for (const step of report.steps) {
    if (step.status === 'already_hardened') continue;
    // Never replay the fetched configuration as a PATCH: it contains secrets
    // and unrelated settings. Each request has exactly one allowlisted field.
    const patched = await call('PATCH', { [step.field]: step.target });
    step.patch_status = patched.status;
    if (patched.http_status !== undefined) step.http_status = patched.http_status;
    const readback = await call('GET');
    if (readback.status !== 'verified') {
      step.status = 'readback_failed'; step.read_status = readback.status;
      return { ...report, status: 'readback_failed' };
    }
    report.observed = safeValues(readback.config);
    step.after = readback.config[step.field];
    if (!unchangedExcept(current, readback.config, step.field)) {
      step.status = 'unrelated_setting_changed';
      return { ...report, status: 'unrelated_setting_changed' };
    }
    current = readback.config;
    if (patched.status !== 'accepted') {
      step.status = patched.status === 'http_rejected' ? 'patch_rejected' : 'patch_outcome_unknown';
      return { ...report, status: 'incomplete' };
    }
    if (current[step.field] !== step.target) {
      step.status = 'readback_mismatch';
      return { ...report, status: 'readback_mismatch' };
    }
    step.status = 'verified';
  }
  report.complete = fields.every(field => current[field] === TARGETS[field]);
  report.status = report.complete ? 'verified' : 'incomplete';
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const work = args.some(value => value !== '--apply') || args.filter(value => value === '--apply').length > 1
    ? Promise.resolve({ status: 'invalid_arguments', apply: false, complete: false, steps: [] })
    : hardenAuth(process.env, { apply: args.includes('--apply') });
  work.then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'dry_run' && !result.complete) process.exitCode = 1;
  }).catch(() => {
    console.error(JSON.stringify({ status: 'operation_failed', complete: false }));
    process.exitCode = 1;
  });
}
