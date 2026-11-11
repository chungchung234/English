// Focused reading-surface regression: actual browser layout, selection and scroll.
// Storage transport is a fixture; this does not establish hosted call readiness.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const port = Number(process.env.TRANSCRIPT_VIEW_PORT || 49206);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve); server.once('error', reject);
    server.once('exit', code => reject(Error(`Transcript server exited ${code}`)));
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(base + '/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:20px;font:16px/1.6 sans-serif}#post-call-transcript{overflow-anchor:none}.transcript-turn{padding:16px 0;border-bottom:1px solid #ddd}.transcript-turn p{margin:0}.transcript-speaker{font-weight:600}.transcript-text{white-space:pre-wrap;overflow-wrap:anywhere}.transcript-record-info{margin-top:20px}</style><h1>대화 기록</h1><div id="review-content"></div>` }));
  await page.goto(base);
  await page.evaluate(async () => {
    const { createPostCallTranscript } = await import('/post-call-transcript.js');
    const now = Date.UTC(2026, 10, 11, 9);
    window.owner = { scope: 'one', companionId: 'alex', sessionId: 'call-one' };
    window.current = { created_at: new Date(now).toISOString(), time_zone: 'Asia/Seoul', durationMs: 272000, transcriptPhase: 'finalizing', transcript: new Map(Array.from({ length: 60 }, (_, i) => {
      const row = { id: 'event-' + i, event_key: 'key-' + i, speaker: i % 2 ? 'user' : 'assistant', text: `This is utterance ${i}. I am reading this conversation without waiting for feedback.`, occurred_at: new Date(now + i * 10000).toISOString(), storage: 'device' };
      return [row.event_key, row];
    })) };
    window.pending = [];
    window.view = createPostCallTranscript({ context: () => owner, allRows: () => new Promise(resolve => pending.push(resolve)), pendingRows: async () => [] });
    view.select({ id: owner.sessionId, companion_id: 'alex', status: 'active', created_at: current.created_at, time_zone: current.time_zone }, { name: 'Alex', current });
  });
  assert.equal(await page.locator('.transcript-turn').count(), 60);
  assert.match(await page.locator('[data-transcript-meta]').innerText(), /Alex · 4분 32초 · 마지막 대화 확인 중/);
  assert.equal(await page.locator('.transcript-record-info').evaluate(node => node.open), false);
  assert.equal(await page.locator('[data-transcript-events]').isVisible(), true);
  const before = await page.evaluate(() => {
    window.readingNode = document.querySelector('[data-transcript-event-id="event-20"]');
    readingNode.scrollIntoView(); window.scrollBy(0, -40);
    const range = document.createRange(); range.selectNodeContents(readingNode.querySelector('.transcript-text'));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { top: readingNode.getBoundingClientRect().top, selection: selection.toString() };
  });
  await page.evaluate(() => {
    const row = { id: 'late-event', event_key: 'late-key', speaker: 'user', text: 'A delayed utterance inserted before the current reading position.', occurred_at: new Date(Date.UTC(2026, 10, 11, 9, 1, 55)).toISOString(), storage: 'server' };
    current.transcript.set(row.event_key, row);
    for (const item of current.transcript.values()) item.storage = 'server';
    current.transcriptPhase = 'saved'; current.saveDurationMs = 2145; view.changed(current);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await page.evaluate(() => ({ top: readingNode.getBoundingClientRect().top, same: readingNode === document.querySelector('[data-transcript-event-id="event-20"]'), selection: getSelection().toString() }));
  assert(after.same, 'storage update retains the existing utterance node');
  assert.equal(after.selection, before.selection, 'receiving a late utterance retains selected source text');
  assert(Math.abs(after.top - before.top) <= 1, `late earlier text preserves reading anchor (${before.top} -> ${after.top})`);
  assert.match(await page.locator('[data-transcript-meta]').innerText(), /대화 저장됨/);
  assert.equal(await page.evaluate(() => view.getRows().length), 61);
  assert.equal(await page.evaluate(() => view.showSource(['event-30', 'event-31'])), true);
  assert.equal(await page.locator('[data-source-highlight]').count(), 2);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.transcriptEventId), 'event-30');
  assert.equal(await page.evaluate(() => view.showSource(['unrelated-event'])), false);
  assert.equal(await page.locator('[data-source-highlight]').count(), 0);
  await page.locator('.transcript-record-info summary').click();
  assert.match(await page.locator('[data-call-save-duration]').innerText(), /2\.1초/);
  assert.match(await page.locator('[data-session-time]').innerText(), /Asia\/Seoul/);
  // A source link remains actionable while a reopened transcript is loading.
  assert.equal(await page.evaluate(() => {
    window.sourceActive = true;
    return view.showSource(['source-arrives-later'], { isActive: () => sourceActive });
  }), false, 'missing source is queued, not falsely reported as located');
  await page.evaluate(() => {
    const row = { id: 'source-arrives-later', event_key: 'source-late-key', speaker: 'user', text: 'The cited utterance arrived after the source link was clicked.', occurred_at: '2026-11-11T09:15:00.000Z', storage: 'server' };
    current.transcript.set(row.event_key, row); view.changed(current);
  });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.transcriptEventId), 'source-arrives-later');
  assert.equal(await page.locator('[data-source-highlight]').count(), 1);
  const canceledPosition = await page.evaluate(() => {
    view.showSource(['canceled-source'], { isActive: () => sourceActive });
    sourceActive = false;
    return window.scrollY;
  });
  await page.evaluate(() => {
    const row = { id: 'canceled-source', event_key: 'canceled-source-key', speaker: 'user', text: 'The reader already went back to feedback.', occurred_at: '2026-11-11T09:16:00.000Z', storage: 'server' };
    current.transcript.set(row.event_key, row); view.changed(current);
  });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.transcriptEventId), 'source-arrives-later', 'late source cannot steal focus after leaving the source view');
  assert(Math.abs((await page.evaluate(() => window.scrollY)) - canceledPosition) <= 1, 'canceled source cannot scroll the reader');
  await page.evaluate(() => { sourceActive = true; view.showSource(['explicitly-canceled'], { isActive: () => sourceActive }); view.cancelSource(); const row = { id: 'explicitly-canceled', event_key: 'explicit-cancel-key', speaker: 'user', text: 'Canceled navigation.', occurred_at: '2026-11-11T09:17:00.000Z', storage: 'server' }; current.transcript.set(row.event_key, row); view.changed(current); });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.transcriptEventId), 'source-arrives-later');
  // Late data from a prior selection cannot overwrite a new call.
  await page.evaluate(() => {
    owner.sessionId = 'call-two'; view.select({ id: 'call-two', companion_id: 'alex', status: 'ended' }, { name: 'Alex' });
    owner.sessionId = 'call-three'; view.select({ id: 'call-three', companion_id: 'alex', status: 'ended' }, { name: 'Alex' });
    for (const resolve of pending) resolve([{ id: 'foreign-event', session_id: 'call-two', companion_id: 'alex', speaker: 'user', text: 'Should not leak into the selected conversation.' }]);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.locator('.transcript-turn').count(), 0);
  assert.equal(await page.evaluate(() => { owner.scope = 'different-account'; return view.getRows().length; }), 0);
  assert.equal(await page.evaluate(() => view.showSource(['foreign-event'])), false);
  await page.evaluate(() => view.clear());
  assert.equal(await page.locator('#post-call-transcript').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Transcript reading surface: stable rows, selection, late-event scroll anchor, source navigation and scope isolation passed.');
} finally {
  await browser?.close(); server.kill('SIGTERM');
}
