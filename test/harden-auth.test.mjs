import test from 'node:test';
import assert from 'node:assert/strict';
import { hardenAuth } from '../scripts/harden-auth.mjs';

const env = { SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', SUPABASE_ACCESS_TOKEN: 'management-secret-fixture' };
const initial = () => ({ external_anonymous_users_enabled: true, password_hibp_enabled: false,
  smtp_pass: 'smtp-secret-fixture', external_google_secret: 'oauth-secret-fixture',
  sessions_timebox: 300, mailer_autoconfirm: false });
function fixture({ config = initial(), patchResponse, readback } = {}) {
  const calls = []; let patchCount = 0, readCount = 0;
  return {
    calls,
    async fetch(url, options) {
      assert.equal(url, 'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth');
      assert.equal(options.redirect, 'error');
      calls.push({ method: options.method, body: options.body && JSON.parse(options.body) });
      if (options.method === 'PATCH') {
        patchCount++;
        if (patchResponse) return patchResponse({ count: patchCount, config, patch: JSON.parse(options.body) });
        config = { ...config, ...JSON.parse(options.body) };
        return new Response(null, { status: 204 });
      }
      readCount++;
      return readback ? readback({ config, count: readCount }) : Response.json(config);
    },
  };
}
const noSecrets = result => assert.doesNotMatch(JSON.stringify(result), /management-secret|smtp-secret|oauth-secret|provider-private-error/);

test('default dry run reads exact booleans without patching or exposing unrelated config', async () => {
  const f = fixture(), result = await hardenAuth(env, {}, f.fetch);
  assert.equal(result.status, 'dry_run'); assert.equal(result.complete, false); assert.equal(result.apply, false);
  assert.deepEqual(f.calls, [{ method: 'GET', body: undefined }]);
  assert.deepEqual(result.observed, { external_anonymous_users_enabled: true, password_hibp_enabled: false });
  assert.equal(result.steps.every(step => step.status === 'planned'), true);
  noSecrets(result);
});

test('apply makes isolated allowlisted patches, verifies each and preserves unrelated settings', async () => {
  const f = fixture(), result = await hardenAuth(env, { apply: true }, f.fetch);
  assert.equal(result.status, 'verified'); assert.equal(result.complete, true);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'PATCH', 'GET', 'PATCH', 'GET']);
  assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => call.body),
    [{ external_anonymous_users_enabled: false }, { password_hibp_enabled: true }]);
  assert.deepEqual(result.observed, { external_anonymous_users_enabled: false, password_hibp_enabled: true });
  assert.equal(result.steps.every(step => step.status === 'verified'), true);
  noSecrets(result);
});

test('already hardened state is read-only even with apply', async () => {
  const f = fixture({ config: { ...initial(), external_anonymous_users_enabled: false, password_hibp_enabled: true } });
  const result = await hardenAuth(env, { apply: true }, f.fetch);
  assert.equal(result.complete, true); assert.equal(result.status, 'verified');
  assert.equal(f.calls.length, 1); assert.equal(result.steps.every(step => step.status === 'already_hardened'), true);
});

test('missing or unknown boolean configuration fails closed before any mutation', async () => {
  for (const config of [{ password_hibp_enabled: false }, { ...initial(), password_hibp_enabled: 'false' }, null, []]) {
    const f = fixture({ config }), result = await hardenAuth(env, { apply: true }, f.fetch);
    assert.equal(result.status, 'initial_read_failed'); assert.equal(result.complete, false);
    assert.equal(result.observed, undefined); assert.equal(f.calls.length, 1);
    noSecrets(result);
  }
});

test('unsupported HIBP retains the independently verified anonymous change and reports rejection', async () => {
  let config = initial(); const calls = [];
  const result = await hardenAuth(env, { apply: true }, async (_, options) => {
    calls.push(options.method);
    if (options.method === 'GET') return Response.json(config);
    const patch = JSON.parse(options.body);
    if ('password_hibp_enabled' in patch) return Response.json({ message: 'provider-private-error oauth-secret-fixture' }, { status: 422 });
    config = { ...config, ...patch }; return new Response(null, { status: 204 });
  });
  assert.equal(result.complete, false); assert.equal(result.status, 'incomplete');
  assert.equal(result.steps[0].status, 'verified'); assert.equal(result.steps[1].status, 'patch_rejected');
  assert.equal(result.steps[1].http_status, 422);
  assert.deepEqual(result.observed, { external_anonymous_users_enabled: false, password_hibp_enabled: false });
  assert.deepEqual(calls, ['GET', 'PATCH', 'GET', 'PATCH', 'GET']);
  noSecrets(result);
});

test('failed readback does not claim a submitted patch took effect or attempt the next patch', async () => {
  const f = fixture({ readback: ({ config, count }) => count === 1 ? Response.json(config) : new Response('provider-private-error', { status: 503 }) });
  const result = await hardenAuth(env, { apply: true }, f.fetch);
  assert.equal(result.status, 'readback_failed'); assert.equal(result.complete, false);
  assert.equal(result.steps[0].status, 'readback_failed'); assert.equal(result.steps[1].status, 'planned');
  assert.equal(result.steps[0].after, undefined);
  assert.deepEqual(result.observed, { external_anonymous_users_enabled: true, password_hibp_enabled: false });
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  noSecrets(result);
});

test('accepted patch with mismatching fresh configuration fails without retry', async () => {
  const f = fixture({ patchResponse: () => new Response(null, { status: 204 }) });
  const result = await hardenAuth(env, { apply: true }, f.fetch);
  assert.equal(result.status, 'readback_mismatch'); assert.equal(result.complete, false);
  assert.equal(result.steps[0].after, true);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('unrelated configuration changes are detected without echoing config values', async () => {
  const f = fixture({ readback: ({ config, count }) => Response.json(count === 1 ? config : { ...config, smtp_pass: 'another-private-smtp' }) });
  const result = await hardenAuth(env, { apply: true }, f.fetch);
  assert.equal(result.status, 'unrelated_setting_changed'); assert.equal(result.complete, false);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  noSecrets(result); assert.doesNotMatch(JSON.stringify(result), /another-private-smtp/);
});

test('ambiguous PATCH transport failure is not retried or reported as accepted', async () => {
  let config = initial(); const methods = [];
  const result = await hardenAuth(env, { apply: true }, async (_, options) => {
    methods.push(options.method);
    if (options.method === 'GET') return Response.json(config);
    config = { ...config, ...JSON.parse(options.body) };
    throw Error('Bearer management-secret-fixture provider-private-error');
  });
  assert.equal(result.status, 'incomplete'); assert.equal(result.complete, false);
  assert.equal(result.steps[0].status, 'patch_outcome_unknown'); assert.equal(result.steps[0].after, false);
  assert.equal(result.observed.external_anonymous_users_enabled, false);
  assert.deepEqual(methods, ['GET', 'PATCH', 'GET']);
  noSecrets(result);
});

test('management and initial response failures are sanitized and cannot mutate', async () => {
  let calls = 0;
  const unavailable = async () => { calls++; throw Error('management-secret-fixture'); };
  for (const badEnv of [{}, { ...env, SUPABASE_PROJECT_REF: 'https://untrusted.example/' }, { ...env, SUPABASE_ACCESS_TOKEN: '' }]) {
    const result = await hardenAuth(badEnv, { apply: true }, unavailable);
    assert.equal(result.status, 'invalid_management_configuration'); noSecrets(result);
  }
  assert.equal(calls, 0);
  const failed = await hardenAuth(env, { apply: true }, unavailable);
  assert.equal(failed.status, 'initial_read_failed'); assert.equal(calls, 1); noSecrets(failed);
  const malformed = await hardenAuth(env, { apply: true }, async () => new Response('provider-private-error'));
  assert.equal(malformed.status, 'initial_read_failed'); noSecrets(malformed);
  for (const apply of ['true', 'false', 1, null]) {
    const previous = calls;
    const result = await hardenAuth(env, { apply }, unavailable);
    assert.equal(result.status, 'invalid_arguments'); assert.equal(calls, previous);
  }
});
