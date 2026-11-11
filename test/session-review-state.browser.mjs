// Actual shipped HTML/CSS and session-review/session-feedback modules in Chromium.
// Async inputs are controlled fixtures; no account, model, or database is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = Number(process.env.SESSION_REVIEW_STATE_PORT || 49205);
const base = `http://127.0.0.1:${port}`;
const html = (await readFile('web/index.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error('Server exited: ' + code))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(base + '/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(base);
  await page.evaluate(async () => {
    const { createSessionReview } = await import('/session-review.js');
    const $ = id => document.getElementById(id);
    $('setup').hidden = true; $('workspace').hidden = false;
    document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.id !== 'review-panel');
    $('review-panel').dataset.mode = 'session';
    const fixture = window.reviewFixture = {
      context: { scope: 'account-a', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', active: true },
      ids: { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      eventIds: { a: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', b: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      sources: [], requests: [], retries: { a: 0, b: 0 }, rows: [], quoteGate: null
    };
    fixture.deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
    fixture.analysis = name => ({
      id: 'analysis-' + name, session_id: fixture.ids[name], kind: 'session',
      content: { strengths: [{ text: name === 'a' ? '어제 한 일을 설명했어요.' : '내일의 계획을 설명했어요.', evidence_ids: [fixture.eventIds[name]] }],
        corrections: [{ original: name === 'a' ? 'I go yesterday.' : 'I go tomorrow.', improved: name === 'a' ? 'I went yesterday.' : 'I will go tomorrow.', reason: name === 'a' ? '지난 일에는 과거형을 써요.' : '계획에는 미래 표현을 쓸 수 있어요.', category: 'error', evidence_ids: [fixture.eventIds[name]] }] }
    });
    fixture.row = name => ({ id: fixture.eventIds[name], session_id: fixture.ids[name], speaker: 'user', text: name === 'a' ? 'I go yesterday.' : 'I go tomorrow.' });
    fixture.controller = createSessionReview({
      context: () => fixture.context,
      getRows: ids => { fixture.requests.push(ids); return fixture.quoteGate && ids.includes(fixture.eventIds.a) ? fixture.quoteGate.promise : fixture.rows; },
      showSource: ids => fixture.sources.push({ sessionId: fixture.context.sessionId, ids }),
      onExit: () => { fixture.context.active = false; }, onViewed: () => {}
    });
    fixture.select = (name, status, extra = {}) => {
      fixture.context.sessionId = fixture.ids[name]; fixture.rows = [fixture.row(name)];
      fixture.controller.update({ sessionId: fixture.ids[name], status, ...(status === 'ready' ? { analysis: fixture.analysis(name) } : {}), ...extra });
    };
    fixture.select('a', 'ready');
  });
  const view = () => page.locator('#review-panel').getAttribute('data-session-view');
  await page.locator('#session-feedback-open').click();
  await page.locator('[data-source-quote]').waitFor({ state: 'visible' });
  assert.match(await page.locator('#session-feedback-content').innerText(), /I went yesterday\./);
  assert.equal(await view(), 'feedback');

  // A changed source version invalidates the displayed result without silently
  // changing pages or leaving an old correction looking current.
  await page.evaluate(() => window.reviewFixture.select('a', 'pending'));
  assert.equal(await view(), 'feedback', 'stale feedback refresh does not navigate');
  assert.equal(await page.locator('#session-feedback-content').isVisible(), false, 'old corrections are hidden while replacement feedback is pending');
  assert.match(await page.locator('#session-feedback-page-status').innerText(), /학습 노트 준비 중/);
  await page.evaluate(() => window.reviewFixture.select('a', 'failed', { message: '대화가 바뀌어 학습 노트를 다시 확인해야 해요.' }));
  assert.equal(await view(), 'feedback', 'failed refresh does not navigate');
  assert.equal(await page.locator('#session-feedback-content').isVisible(), false);
  assert.match(await page.locator('#session-feedback-page-status').innerText(), /대화가 바뀌어/);
  await page.evaluate(() => window.reviewFixture.select('a', 'ready'));
  assert(await page.locator('#session-feedback-content').isVisible(), 'the same confirmed result can be restored after a transient failure');
  assert.equal(await page.locator('#session-feedback-unavailable').isVisible(), false);

  // A retry belonging to one call must not lock the next call, or unlock its
  // different in-flight retry when the older promise eventually rejects.
  await page.evaluate(() => {
    const f = window.reviewFixture; f.retryA = f.deferred(); f.retryB = f.deferred();
    f.select('a', 'failed', { message: 'A 학습 노트를 확인하지 못했어요.', retry: () => { f.retries.a++; return f.retryA.promise; } });
  });
  await page.locator('#session-feedback-page-retry').click();
  assert(await page.locator('#session-feedback-page-retry').isDisabled());
  await page.evaluate(() => {
    const f = window.reviewFixture;
    f.select('b', 'failed', { message: 'B 학습 노트를 확인하지 못했어요.', retry: () => { f.retries.b++; return f.retryB.promise; } });
  });
  assert.equal(await view(), 'transcript', 'a new call starts on its own transcript');
  assert(await page.locator('#session-feedback-retry').isEnabled(), 'A pending retry does not disable B retry');
  assert(await page.locator('#session-feedback-page-retry').isEnabled(), 'both retry surfaces reset for B');
  await page.locator('#session-feedback-retry').click();
  assert(await page.locator('#session-feedback-retry').isDisabled());
  await page.evaluate(async () => { const f = window.reviewFixture; f.retryA.reject(Error('Late A failure')); await Promise.resolve(); await Promise.resolve(); });
  assert(await page.locator('#session-feedback-retry').isDisabled(), 'late A settlement does not unlock the current B request');
  assert.match(await page.locator('#session-feedback-status-note').innerText(), /^B /, 'late A failure cannot replace B message');
  await page.evaluate(async () => { const f = window.reviewFixture; f.retryB.resolve(); await Promise.resolve(); await Promise.resolve(); });
  assert(await page.locator('#session-feedback-retry').isEnabled(), 'B settlement releases its own retry');
  assert.deepEqual(await page.evaluate(() => window.reviewFixture.retries), { a: 1, b: 1 });

  // Source lookups and queued source navigation are scoped to the rendered call.
  await page.evaluate(() => {
    const f = window.reviewFixture; f.requests = []; f.quoteGate = f.deferred(); f.select('a', 'ready');
  });
  await page.waitForFunction(() => window.reviewFixture.requests.some(ids => ids.includes(window.reviewFixture.eventIds.a)));
  await page.evaluate(() => {
    const f = window.reviewFixture; f.controller.openFeedback();
    document.querySelector('[data-feedback-source]').click();
    f.select('b', 'ready');
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.reviewFixture.sources), [], 'A queued source navigation is invalidated when B is selected');
  await page.locator('#session-feedback-open').click();
  await page.locator('[data-source-quote]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-source-quote]').innerText(), /I go tomorrow\./);
  await page.evaluate(async () => { const f = window.reviewFixture; f.quoteGate.resolve([f.row('a')]); await Promise.resolve(); await Promise.resolve(); });
  assert.doesNotMatch(await page.locator('#session-feedback-content').innerText(), /yesterday/, 'late A quote promise cannot populate B feedback');
  assert.match(await page.locator('[data-source-quote]').innerText(), /I go tomorrow\./);
  assert.equal(await view(), 'feedback', 'late source results do not navigate');
  await page.locator('[data-feedback-source]').first().click();
  await page.waitForFunction(() => window.reviewFixture.sources.length === 1);
  assert.deepEqual(await page.evaluate(() => window.reviewFixture.sources), [{ sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ids: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] }], 'the current source link still navigates to the correct source');
  assert.deepEqual(errors, []);
  console.log('3 session-review browser regression groups PASS: stale/failed feedback hides old corrections without navigation; per-session retry ownership; stale source promise and queued navigation isolation. Real shipped HTML/CSS/modules; controlled local inputs.');
} finally { await browser.close(); server.kill('SIGTERM'); }
