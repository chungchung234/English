// Focused browser verification of semantic cues and honest recall self-report.
// The host transport is deliberately controlled here; real RPC/outbox/account
// replay invariants remain covered by post-call.browser and enhancements.browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { practiceCue } from '../web/learning-enhancements.js';

const target = 'Could you repeat that more slowly?';
const source = { id: 'item', expression: target, original: 'Please say again slow.', reason: `Say ${target}`, next_scenario: 'Ask a friend to slow down.' };
assert.equal(practiceCue(source).kind, 'source');
assert.equal(practiceCue(source, '상대방에게 천천히 말해 달라고 부탁하기').kind, 'goal');
for (const goal of [target, `"COULD YOU REPEAT THAT MORE SLOWLY"를 말하기`, `Could you repeat that more slowly를 사용하기`]) {
  assert.equal(practiceCue(source, goal).kind, 'source', 'answer copied into a goal is not a semantic cue');
}
assert.equal(practiceCue({ ...source, original: target }).kind, 'scenario');
assert.equal(practiceCue({ ...source, original: target, next_scenario: target }).kind, 'choice');
assert.equal(practiceCue({ expression: "I'm tired", original: '', reason: "I'm tired = 피곤해요" }, "I'm tired를 사용해 보기").kind, 'choice', 'Korean particles do not bypass target concealment');
assert.equal(practiceCue({ expression: target, original: '', reason: `정답은 ${target}` }).kind, 'choice', 'generated explanation is never passed off as original intent');

const port = Number(process.env.RESEARCH_RECALL_TEST_PORT || 4194);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port), PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error(`server exited ${code}`))); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(`${base}/research-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto(`${base}/research-fixture`);
  await page.evaluate(async item => {
    const { createLearningEnhancements } = await import('/learning-enhancements.js');
    const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value || ''; if (className) node.className = className; return node; };
    const button = (label, fn) => { const node = text('button', label); node.onclick = async () => { if (node.disabled) return; node.disabled = true; try { await fn(); } finally { if (node.isConnected && node.dataset.keepDisabled !== 'true') node.disabled = false; } }; return node; };
    window.resetRecall = () => {
      window.fixture = { current: true, saved: false, suppressed: false, pending: [], calls: [], confirms: 0, resolve: null };
      const state = window.fixture;
      const controller = createLearningEnhancements({ text, button, status: value => text('p', value), pending: () => state.pending, suppressed: () => state.suppressed, itemOf: () => item,
        submit: (...args) => { state.calls.push(args); return new Promise(resolve => { state.resolve = resolve; }); } });
      controller.setSnapshot({ schedules: [{ item_id: item.id, revision: 7, goal: '' }] });
      const recall = controller.buildRecall(item, { attemptId: 'attempt-1', current: () => state.current, saved: () => state.saved, close: () => { state.current = false; }, confirm: () => { state.confirms++; state.saved = true; } });
      document.body.replaceChildren(recall.box); window.recall = recall;
    };
    window.resetRecall();
  }, source);
  const action = name => page.locator(`[data-action="${name}"]`);
  assert.equal(await page.locator('[data-practice-cue]').textContent(), source.original);
  assert.match(await page.locator('body').innerText(), /자동 전사/);
  assert(!(await page.locator('body').innerText()).includes(target));
  assert.equal(await page.evaluate(() => fixture.calls.length), 0, 'viewing the cue does not record learning');
  await action('reveal-delayed-expression').click();
  assert(await page.locator('[data-practice-expression]').isVisible());
  assert(await action('recall-independent').isDisabled());
  await page.evaluate(() => { const node = document.querySelector('[data-action="recall-independent"]'); node.disabled = false; return node.onclick(); });
  assert.equal(await page.evaluate(() => fixture.calls.length), 0, 'revealed state guards callback as well as button appearance');
  await action('recall-assisted').click();
  assert(await action('reveal-delayed-expression').isDisabled(), 'help cannot race an in-flight report');
  await page.evaluate(() => fixture.resolve(null));
  await page.waitForFunction(() => !document.querySelector('[data-action="recall-assisted"]').disabled);
  assert(await action('recall-independent').isDisabled(), 'failed save cannot erase prior help');

  await page.evaluate(() => resetRecall());
  await action('recall-independent').click();
  await page.evaluate(() => { const node = document.querySelector('[data-action="recall-independent"]'); node.disabled = false; return node.onclick(); });
  assert.equal(await page.evaluate(() => fixture.calls.length), 1, 'in-flight duplicate cannot create another report');
  assert.deepEqual(await page.evaluate(() => fixture.calls[0]), ['learning_recall', source, { p_item_id: 'item', p_expected_revision: 7, p_rating: 'independent' }, { attemptId: 'attempt-1' }]);
  await page.evaluate(() => { fixture.pending.push({ id: 'durable-pending' }); fixture.resolve(null); });
  await page.waitForFunction(() => document.body.innerText.includes('서버 반영 대기'));
  assert(await action('recall-assisted').isDisabled(), 'pending durable action prevents a second rating');
  assert.equal(await page.evaluate(() => fixture.confirms), 0, 'pending is not server-confirmed success');
  await page.evaluate(() => { const node = document.querySelector('[data-action="recall-hard"]'); node.disabled = false; return node.onclick(); });
  assert.equal(await page.evaluate(() => fixture.calls.length), 1, 'pending guard survives a stale control reference');

  for (const field of ['current', 'suppressed']) {
    await page.evaluate(field => { resetRecall(); fixture[field] = field === 'suppressed'; }, field);
    await action('recall-independent').click();
    assert.equal(await page.evaluate(() => fixture.calls.length), 0, `${field} scope/source check runs before dispatch`);
  }
  await page.evaluate(() => resetRecall());
  await action('recall-assisted').click();
  await page.evaluate(() => { fixture.current = false; fixture.resolve({ outcome: 'applied' }); });
  await page.waitForTimeout(20);
  assert.equal(await page.evaluate(() => fixture.confirms), 0, 'a late response cannot confirm another account or attempt');

  await page.evaluate(() => resetRecall());
  await action('recall-hard').click();
  await page.evaluate(() => fixture.resolve({ outcome: 'applied' }));
  await page.waitForFunction(() => fixture.saved);
  await page.evaluate(() => { const node = document.querySelector('[data-action="recall-assisted"]'); node.disabled = false; return node.onclick(); });
  assert.equal(await page.evaluate(() => fixture.calls.length), 1, 'confirmed attempt cannot be submitted a second time');
  assert.deepEqual(errors, []);
  console.log('PASS: labelled, target-safe semantic cues; optional help; sticky assisted classification; pending, replay, stale scope and source guards.');
} finally { await browser.close(); server.kill('SIGTERM'); }
