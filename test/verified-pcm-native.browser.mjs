// Native Chromium AudioContext/AudioWorklet; PCM and the admitted manifest are
// local fixtures. This does not call a provider, authenticate, or prove hearing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const port = 49547, base = `http://127.0.0.1:${port}`;
const workletSource = await readFile(new URL('../web/verified-pcm-worklet.js', import.meta.url), 'utf8');
const workletSha256 = createHash('sha256').update(workletSource).digest('hex');
const workletPath = `/assets/verified-pcm-worklet.${workletSha256.slice(0, 16)}.js`;
const playerPath = '/web/verified-pcm-playback.js', fixturePath = '/fixture.js';
const probeSource = `
class ReferenceProbe extends AudioWorkletProcessor {
  constructor() { super(); this.frames = 0; this.sumSquares = 0; this.peak = 0; }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const length = outputs[0]?.[0]?.length || input?.length || 128;
    for (let i = 0; i < length; i++) {
      const sample = input?.[i] || 0;
      this.sumSquares += sample * sample; this.peak = Math.max(this.peak, Math.abs(sample));
      if (++this.frames === 1024) {
        this.port.postMessage({ rms: Math.sqrt(this.sumSquares / this.frames), peak: this.peak,
          contextFrame: currentFrame + i + 1, sampleRate });
        this.frames = 0; this.sumSquares = 0; this.peak = 0;
      }
    }
    return true;
  }
}
registerProcessor('fixture-reference-probe-v1', ReferenceProbe);
`;
const probePath = `/assets/pcm-reference-probe.${createHash('sha256').update(probeSource).digest('hex').slice(0, 16)}.js`;
const requests = [], pageErrors = [], cspViolations = [];
const fixtureSource = `
import { createVerifiedPcmPlayback } from '${playerPath}';
const fixture = window.pcmFixture = { cases: [], active: null, pendingUnlock: null, pendingProbe: null };
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('');
fixture.makeOwner = (index = 1) => ({
  scope: 'https://pcm-fixture.invalid|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionId: '11111111-1111-4111-8111-111111111111', companionId: 'alex', callEpoch: index,
  turnNonce: '22222222-2222-4222-8222-' + String(index).padStart(12, '0'),
  turnId: '33333333-3333-4333-8333-' + String(index).padStart(12, '0'),
  assistantEventId: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
  authorityGeneration: 1, expectedMemoryRevision: 7, playbackEpoch: index
});
fixture.makeClip = async (owner, seconds = 1.8) => {
  const sourceFrames = Math.round(24000 * seconds), bytes = new ArrayBuffer(sourceFrames * 2);
  const data = new DataView(bytes);
  for (let i = 0; i < sourceFrames; i++) {
    // Continuous sine plus regular amplitude markers, kept away from clipping.
    const marker = Math.floor(i / 2400) % 2 ? 0.20 : 0.30;
    data.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * marker * 32767), true);
  }
  const textSha256 = await digest(new TextEncoder().encode('Local verified PCM fixture.'));
  return { bytes, textSha256, manifest: {
    version: 'verified-pcm-candidate-v1', owner, textSha256, pcmSha256: await digest(bytes),
    format: 'pcm_s16le', sampleRate: 24000, channels: 1, sourceFrames, byteLength: bytes.byteLength,
    synthesisId: crypto.randomUUID(), synthesisSpeed: 1,
    transcriptVerification: { status: 'matched', policyVersion: 'local-fixture-v1', approvedTextSha256: textSha256 }
  }};
};
fixture.createCase = name => {
  const item = { name, owner: fixture.makeOwner(fixture.cases.length + 1), events: [],
    outputContext: null, contextCount: 0, probe: null, player: null };
  item.currentOwner = item.owner;
  class NativeOutputContext extends AudioContext {
    constructor(options) { super({ ...options, sampleRate: 44100 }); item.outputContext = this; item.contextCount++; }
  }
  item.player = createVerifiedPcmPlayback({
    workletUrl: '${workletPath}', workletSha256: '${workletSha256}',
    AudioContextConstructor: NativeOutputContext,
    isCurrent: owner => JSON.stringify(owner) === JSON.stringify(item.currentOwner),
    canUnlockContext: owner => !item.contextRevoked && (!owner ||
      ['scope', 'sessionId', 'companionId', 'callEpoch', 'authorityGeneration', 'expectedMemoryRevision']
        .every(field => owner[field] === item.currentOwner[field])),
    onEvent: event => {
      const context = item.outputContext;
      let outputTimestamp = null;
      try { outputTimestamp = context?.getOutputTimestamp?.() || null; } catch {}
      item.events.push({ event: structuredClone(event), observed: {
        performanceTime: performance.now(), contextTime: context?.currentTime ?? null,
        contextState: context?.state ?? null, sampleRate: context?.sampleRate ?? null, outputTimestamp
      }});
    }
  });
  fixture.cases.push(item); fixture.active = item; return item.owner;
};
fixture.snapshot = () => {
  const item = fixture.active, context = item.outputContext;
  return { state: item.player.state, events: item.events, contextCount: item.contextCount,
    probeBatches: item.probe?.batches || [], sampleRate: context?.sampleRate,
    currentTime: context?.currentTime, outputTimestamp: context?.getOutputTimestamp?.() || null,
    contextState: context?.state, probeState: item.probe?.context.state };
};
fixture.attachProbe = async () => {
  const item = fixture.active;
  if (!item.player.referenceStream) throw Error('Player must expose the post-gain reference stream');
  const context = new AudioContext({ sampleRate: 48000 });
  // Called directly by the click handler before any await.
  const resumed = context.resume();
  await context.audioWorklet.addModule('${probePath}'); await resumed;
  const source = context.createMediaStreamSource(item.player.referenceStream);
  const node = new AudioWorkletNode(context, 'fixture-reference-probe-v1');
  const muted = context.createGain(); muted.gain.value = 0;
  const probe = item.probe = { context, source, node, muted, batches: [] };
  node.port.onmessage = ({ data }) => probe.batches.push({ ...data, observedAt: performance.now() });
  source.connect(node).connect(muted).connect(context.destination);
};
fixture.dispose = async () => {
  const item = fixture.active;
  item.player.dispose();
  if (item.probe) {
    item.probe.source.disconnect(); item.probe.node.disconnect(); item.probe.node.port.close();
    await item.probe.context.close();
  }
};
document.querySelector('#unlock-output').onclick = () => {
  fixture.pendingUnlock = fixture.active.player.unlockFromGesture();
};
document.querySelector('#unlock-probe').onclick = () => { fixture.pendingProbe = fixture.attachProbe(); };
document.querySelector('#resume-output').onclick = () => {
  const item = fixture.active;
  fixture.pendingManualResume = item.player.resumeFromGesture(item.owner, { candidateId: 'uncertain-user', decisionEpoch: 13 });
};
document.addEventListener('securitypolicyviolation', event => window.fixtureCspViolations.push({
  directive: event.effectiveDirective, blockedURI: event.blockedURI
}));
window.fixtureCspViolations = [];
fixture.ready = true;
`;
const scriptUrls = [fixturePath, playerPath, workletPath, probePath].map(path => base + path).join(' ');
const csp = `default-src 'none'; script-src ${scriptUrls}; connect-src ${base + workletPath}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`;
const server = createServer(async (request, response) => {
  requests.push(request.url);
  try {
    const path = new URL(request.url, base).pathname;
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Native PCM fixture</title><button id="unlock-output">Unlock output</button><button id="unlock-probe">Unlock reference probe</button><button id="resume-output">Resume uncertain audio</button><script type="module" src="${fixturePath}"></script></html>`);
    } else if (path === fixturePath || path === playerPath || path === workletPath || path === probePath) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(path === fixturePath ? fixtureSource : path === workletPath ? workletSource : path === probePath ? probeSource :
        await readFile(new URL('../web/verified-pcm-playback.js', import.meta.url), 'utf8'));
    } else { response.writeHead(404).end(); }
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.pcmFixture?.ready === true);
  assert.equal(await page.evaluate(() => isSecureContext), true, 'loopback fixture must permit native AudioWorklet');

  const snapshot = () => page.evaluate(() => window.pcmFixture.snapshot());
  const createCase = name => page.evaluate(name => window.pcmFixture.createCase(name), name);
  const event = (state, kind) => state.events.filter(entry => entry.event.kind === kind);
  const waitEvent = async (kind, predicate = () => true) => {
    await page.waitForFunction(kind => window.pcmFixture.active.events.some(entry => entry.event.kind === kind), kind);
    const entries = event(await snapshot(), kind);
    assert(entries.some(predicate), `${kind} must match its command/owner contract`);
    return entries.at(-1);
  };
  const unlock = async () => {
    await page.locator('#unlock-output').click();
    assert.equal(await page.evaluate(() => window.pcmFixture.pendingUnlock), true, 'native output must unlock from a real click');
  };
  const prepare = async seconds => page.evaluate(async seconds => {
    const item = window.pcmFixture.active, clip = await window.pcmFixture.makeClip(item.owner, seconds);
    item.clip = clip;
    return item.player.prepare(item.owner, clip.textSha256, clip.manifest, clip.bytes);
  }, seconds);
  const attachProbe = async () => {
    await page.locator('#unlock-probe').click(); await page.evaluate(() => window.pcmFixture.pendingProbe);
    await page.waitForFunction(() => window.pcmFixture.active.probe?.batches.length >= 3);
  };
  const play = () => page.evaluate(() => {
    const item = window.pcmFixture.active; return item.player.play(item.owner);
  });
  const awaitSignal = () => page.waitForFunction(() => window.pcmFixture.active.probe?.batches.slice(-4).some(batch => batch.rms > 0.08));
  const assertReferenceSilent = async label => {
    const from = await page.evaluate(() => window.pcmFixture.active.probe.batches.length);
    await page.waitForFunction(from => window.pcmFixture.active.probe.batches.length >= from + 14, from);
    const batches = (await snapshot()).probeBatches.slice(-8);
    assert.equal(batches.length, 8);
    assert(batches.every(batch => batch.peak < 0.0005), `${label}: post-gain reference must settle to silence`);
  };
  const finish = async (completionsBefore = 0) => {
    // Observe the actual native device clock independently of player events.
    const initial = await snapshot();
    await page.waitForFunction(previous => {
      const context = window.pcmFixture.active.outputContext;
      const timestamp = context?.getOutputTimestamp?.();
      return timestamp?.contextTime > previous;
    }, initial.outputTimestamp?.contextTime || 0);
    await page.waitForFunction(before => window.pcmFixture.active.events.filter(entry => entry.event.kind === 'played_through').length > before, completionsBefore);
    const completed = await waitEvent('played_through');
    const drained = event(await snapshot(), 'render_drained').at(-1);
    assert(drained, 'device completion requires a preceding render-drained boundary');
    assert(Number.isSafeInteger(completed.event.finalContextFrameExclusive) && completed.event.finalContextFrameExclusive > 0);
    assert.equal(completed.event.finalContextFrameExclusive, drained.event.finalContextFrameExclusive);
    assert(completed.event.outputTimestampContextTime * completed.observed.sampleRate >= completed.event.finalContextFrameExclusive,
      'reported output clock must pass the absolute exclusive final output frame');
    assert(completed.observed.outputTimestamp.contextTime * completed.observed.sampleRate >= completed.event.finalContextFrameExclusive,
      'independently sampled native device clock must also pass the completion marker');
    assert.equal(completed.event.evidence, 'client_reported_playback_completed');
    assert.equal((await snapshot()).state.completed, true);
    await page.waitForTimeout(100);
    assert.equal(event(await snapshot(), 'played_through').length, completionsBefore + 1, 'completion is emitted exactly once for the current turn');
    return completed;
  };

  // prepare-only admission failures never instantiate/load an audio graph.
  // Separately authorized user gestures may preload an EMPTY context/worklet.
  const workletRequestsBeforeInvalid = requests.filter(path => path === workletPath).length;
  for (const failure of ['corrupt_pcm', 'wrong_approved_text', 'wrong_owner']) {
    await createCase(failure);
    const result = await page.evaluate(async failure => {
      const item = window.pcmFixture.active, clip = await window.pcmFixture.makeClip(item.owner);
      if (failure === 'corrupt_pcm') new Uint8Array(clip.bytes)[101] ^= 1;
      if (failure === 'wrong_owner') clip.manifest.owner = { ...item.owner, playbackEpoch: item.owner.playbackEpoch + 1 };
      const expectedText = failure === 'wrong_approved_text' ? '0'.repeat(64) : clip.textSha256;
      return item.player.prepare(item.owner, expectedText, clip.manifest, clip.bytes);
    }, failure);
    assert.equal(result, false, `${failure} must be refused before playback`);
    const resultState = await snapshot();
    assert.equal(resultState.contextCount, 0, `${failure} must not create an AudioContext`);
    assert.equal(resultState.events.some(entry => ['ready', 'started', 'played_through'].includes(entry.event.kind)), false);
    await page.evaluate(() => window.pcmFixture.dispose());
  }
  assert.equal(requests.filter(path => path === workletPath).length, workletRequestsBeforeInvalid,
    'invalid manifests/bytes must not load the native worklet');

  await createCase('uninterrupted_completion'); await unlock();
  assert.equal(await prepare(1.25), true); await waitEvent('ready'); await attachProbe();
  assert.equal(event(await snapshot(), 'played_through').length, 0, 'preparing a complete clip is not playback completion');
  assert.equal(await play(), true); const started = await waitEvent('started'); await awaitSignal();
  assert.equal((await snapshot()).sampleRate, 44100, 'native output exercises resampling away from the 24kHz PCM source');
  const completed = await finish();
  assert(completed.observed.contextTime - started.observed.contextTime >= 1.20,
    'a 1.25-second clip cannot complete merely because prepare/play returned');
  await page.evaluate(async () => {
    const item = window.pcmFixture.active;
    item.nextOwner = { ...window.pcmFixture.makeOwner(100), callEpoch: item.owner.callEpoch };
    item.currentOwner = item.nextOwner; // Old nonce no longer owns a turn, same call remains authorized.
    await item.outputContext.suspend();
  });
  await unlock();
  const afterPreflight = await snapshot();
  assert.equal(afterPreflight.contextCount, 1); assert.equal(afterPreflight.contextState, 'running');
  assert.equal(event(afterPreflight, 'started').length, 1); assert.equal(event(afterPreflight, 'played_through').length, 1);
  assert.equal(await play(), false, 'context-only preflight cannot replay the completed old turn');
  await page.evaluate(() => { const item = window.pcmFixture.active; item.owner = item.nextOwner; });
  assert.equal(await prepare(.6), true); assert.equal(await play(), true); await finish(1);
  assert.equal((await snapshot()).contextCount, 1, 'the next separately admitted clip reuses the preflight-unlocked context');
  await page.evaluate(() => window.pcmFixture.dispose());

  await createCase('suspended_output_same_clip_gesture'); await unlock(); assert.equal(await prepare(.6), true);
  await page.evaluate(async () => { await window.pcmFixture.active.outputContext.suspend(); });
  assert.equal(await play(), false, 'suspended output cannot start without resumption');
  assert.equal(event(await snapshot(), 'started').length, 0);
  await unlock(); await finish();
  assert.equal(event(await snapshot(), 'started').length, 1, 'gesture recovery plays the same admitted clip once');
  await page.evaluate(() => window.pcmFixture.dispose());

  await createCase('candidate_pause_resume'); await unlock();
  assert.equal(await prepare(1.8), true); await attachProbe(); assert.equal(await play(), true); await awaitSignal();
  const commandId = await page.evaluate(() => {
    const item = window.pcmFixture.active; return item.player.pauseCandidate(item.owner, 'noise-a', 11);
  });
  const paused = await waitEvent('pause_applied', entry => entry.event.commandId === commandId && entry.event.candidateId === 'noise-a');
  assert(paused.event.cursor.sourceFrame > 0 && paused.event.cursor.sourceFrame < 43200);
  assert.equal((await snapshot()).state.paused, true);
  await assertReferenceSilent('candidate pause');
  assert.deepEqual((await snapshot()).state.cursor, paused.event.cursor, 'source frame and fractional phase freeze while paused');
  assert.equal(event(await snapshot(), 'played_through').length, 0);
  await page.evaluate(() => {
    const item = window.pcmFixture.active; item.player.pauseCandidate(item.owner, 'noise-b', 12);
  });
  assert.equal(await page.evaluate(() => {
    const item = window.pcmFixture.active;
    return item.player.resolveCandidate(item.owner, { kind: 'rejected_noise', candidateId: 'noise-a', decisionEpoch: 11 });
  }), true);
  assert.equal((await snapshot()).state.paused, true, 'rejecting one candidate cannot release another hold');
  assert.equal(event(await snapshot(), 'resume_applied').length, 0);
  assert.equal(await page.evaluate(() => {
    const item = window.pcmFixture.active;
    return item.player.resolveCandidate(item.owner, { kind: 'rejected_echo', candidateId: 'noise-b', decisionEpoch: 12 });
  }), true);
  const resumed = await waitEvent('resume_applied');
  assert.deepEqual(resumed.event.cursor, paused.event.cursor, 'resume starts at the acknowledged source cursor and phase');
  const resumedAtBatch = (await snapshot()).probeBatches.length;
  await page.waitForFunction(from => window.pcmFixture.active.probe.batches.slice(from).some(batch => batch.rms > 0.08), resumedAtBatch);
  const manualFrom = event(await snapshot(), 'pause_applied').length;
  await page.evaluate(() => {
    const item = window.pcmFixture.active; item.player.pauseCandidate(item.owner, 'uncertain-user', 13);
  });
  await page.waitForFunction(from => window.pcmFixture.active.events.filter(entry => entry.event.kind === 'pause_applied').length > from, manualFrom);
  const uncertainCursor = (await snapshot()).state.cursor;
  assert.equal(await page.evaluate(() => {
    const item = window.pcmFixture.active;
    return item.player.resolveCandidate(item.owner, { kind: 'asr_failed', candidateId: 'uncertain-user', decisionEpoch: 13 });
  }), false, 'ASR failure is not a noise decision');
  const resumesBeforeManual = event(await snapshot(), 'resume_applied').length;
  await page.locator('#resume-output').click();
  assert.equal(await page.evaluate(() => window.pcmFixture.pendingManualResume), true);
  await page.waitForFunction(from => window.pcmFixture.active.events.filter(entry => entry.event.kind === 'resume_applied').length > from, resumesBeforeManual);
  const manualResume = event(await snapshot(), 'resume_applied').at(-1);
  assert.deepEqual(manualResume.event.cursor, uncertainCursor, 'explicit user continuation preserves the same native cursor');
  assert.equal(event(await snapshot(), 'candidate_dismissed_by_user').length, 1);
  await finish(); await page.evaluate(() => window.pcmFixture.dispose());

  for (const scenario of ['explicit_clear', 'account_invalidation', 'reconnect_invalidation']) {
    await createCase(scenario); await unlock(); assert.equal(await prepare(1.8), true);
    await attachProbe(); assert.equal(await play(), true); await awaitSignal();
    await page.evaluate(() => {
      const item = window.pcmFixture.active; item.player.pauseCandidate(item.owner, 'late-noise', 21);
    });
    await waitEvent('pause_applied');
    await page.evaluate(scenario => {
      const item = window.pcmFixture.active;
      if (scenario === 'explicit_clear') item.player.cancel(item.owner, 'clear');
      else {
        item.currentOwner = { ...item.owner, callEpoch: item.owner.callEpoch + 1, playbackEpoch: item.owner.playbackEpoch + 1,
          ...(scenario === 'account_invalidation' ? { scope: 'https://pcm-fixture.invalid|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } : {}) };
        item.player.invalidate(scenario === 'account_invalidation' ? 'scope_changed' : 'call_end');
      }
    }, scenario);
    await waitEvent('terminal'); await assertReferenceSilent(scenario);
    const before = await snapshot();
    const late = await page.evaluate(() => {
      const item = window.pcmFixture.active;
      return { resolved: item.player.resolveCandidate(item.owner, { kind: 'rejected_noise', candidateId: 'late-noise', decisionEpoch: 21 }),
        played: item.player.play(item.owner) };
    });
    assert.deepEqual(late, { resolved: false, played: false }, `${scenario}: late rejection/play cannot revive old PCM`);
    await page.locator('#unlock-output').click(); await page.evaluate(() => window.pcmFixture.pendingUnlock);
    await assertReferenceSilent(`${scenario} after another user gesture`);
    const after = await snapshot();
    assert.equal(event(after, 'started').length, event(before, 'started').length);
    assert.equal(event(after, 'resume_applied').length, 0);
    assert.equal(event(after, 'played_through').length, 0);
    assert.equal(after.state.completed, false);
    if (scenario === 'explicit_clear') {
      await page.evaluate(async () => {
        const item = window.pcmFixture.active;
        item.nextOwner = { ...window.pcmFixture.makeOwner(101), callEpoch: item.owner.callEpoch };
        item.currentOwner = item.nextOwner;
        await item.outputContext.suspend();
      });
      await unlock(); await assertReferenceSilent('stopped old turn after next-turn context preflight');
      assert.equal(event(await snapshot(), 'started').length, event(before, 'started').length);
      assert.equal(event(await snapshot(), 'played_through').length, 0);
      assert.equal(await play(), false, 'terminal old turn stays unavailable after context-only unlock');
      await page.evaluate(() => { const item = window.pcmFixture.active; item.owner = item.nextOwner; });
      assert.equal(await prepare(.5), true); assert.equal(await play(), true); await awaitSignal(); await finish();
      assert.equal((await snapshot()).contextCount, 1);
    }
    await page.evaluate(() => window.pcmFixture.dispose());
  }

  cspViolations.push(...await page.evaluate(() => window.fixtureCspViolations));
  assert.deepEqual(pageErrors, [], 'native fixture must have no uncaught browser errors');
  assert.deepEqual(cspViolations, [], 'explicit local module/worklet CSP must permit every required native request');
  assert(requests.includes(workletPath) && requests.includes(probePath), 'both native worklet module routes must actually load');
  assert(requests.every(path => ['/', fixturePath, playerPath, workletPath, probePath, '/favicon.ico'].includes(path)),
    'fixture only serves known local resources');
  console.log('PASS: native Chromium 24→44.1kHz PCM output, real post-gain reference silence on pause/clear, exact acknowledged candidate/user resume cursor/phase, suspended-output gesture recovery, empty-context next-turn preflight after completion/stop without old-turn replay, native output-clock completion, prepare-only strict admission with trusted gesture preload, and terminal account/reconnect invalidation. Local synthetic fixtures only; no provider, authentication, production, or physical-hearing claim.');
  await context.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
