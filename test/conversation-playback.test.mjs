import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationPlaybackCollector, createConversationPlaybackDelivery, createConversationPlaybackOutbox } from '../web/conversation-playback.js';
import { createQualifiedTurnControls } from '../web/qualified-turn-controls.js';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = n => `https://service.example|${uid(n)}`;
const scope = owner(1), session = uid(10);
function memoryStorage() {
  const rows = new Map();
  return {
    async put(account, row) {
      const key = account + '|' + row.id, existing = rows.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row)) throw Error('Immutable receipt changed');
      rows.set(key, structuredClone(row));
    },
    async list(account) { return [...rows].filter(([key]) => key.startsWith(account + '|')).map(([, value]) => structuredClone(value)); },
    async remove(account, id) { rows.delete(account + '|' + id); },
    rows,
  };
}
function fixture({ revision = 4, account = scope, companion = 'alex', sessionId = session } = {}) {
  const storage = memoryStorage(), outbox = createConversationPlaybackOutbox('isolated-fixture', { storage });
  const transcript = new Map(), providers = new Map();
  const collector = createConversationPlaybackCollector({ scope: account, companionId: companion, sessionId, outbox });
  function row(n, speaker, providerId, state = 'server') {
    const value = { id: uid(n), event_key: `${speaker}:${providerId}:0`, speaker, text: 'Private source speech kept only in the raw transcript.',
      occurred_at: new Date(Date.UTC(2026, 10, 14, 0, 0, n)).toISOString(), storage: state };
    transcript.set(value.event_key, value); providers.set(value.id, providerId); return value;
  }
  return { storage, outbox, transcript, providers, collector, row,
    observe: (ids, value = revision) => collector.observe(ids, value), capture: () => collector.capture(transcript, providers),
    pending: () => outbox.list(account) };
}
function validAck(body) { return { session_id: body.p_session_id, acknowledged_ids: body.p_event_ids, discarded_ids: [], reason: null }; }

test('the real floor requires playback completion, not generation done, before shared evidence is queued', async t => {
  const f = fixture(), requests = [];
  f.row(20, 'user', 'caller'); f.row(21, 'assistant', 'reply-item');
  const floor = createQualifiedTurnControls({ send: event => requests.push(event), instructions: () => 'Approved fixture instructions.',
    openingInstructions: () => 'Approved opening.', hasRecentVoice: () => true, now: () => 1000, graceMs: 0 });
  t.after(() => floor.dispose());
  const emit = event => { floor.event(event); f.observe(floor.acceptedItemIds()); };
  emit({ type: 'session.updated', session: { audio: { input: { turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: false } } } } });
  floor.availability(true);
  emit({ type: 'input_audio_buffer.speech_started', item_id: 'caller' }); floor.voice(1000);
  emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'caller' });
  emit({ type: 'input_audio_buffer.committed', item_id: 'caller' });
  emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'caller', transcript: 'A synthetic story.' });
  floor.start();
  const create = requests.find(event => event.type === 'response.create'); assert(create);
  emit({ type: 'response.created', response: { id: 'reply', metadata: create.response.metadata } });
  emit({ type: 'response.output_item.added', response_id: 'reply', item: { id: 'reply-item', type: 'message', role: 'assistant' } });
  emit({ type: 'output_audio_buffer.started', response_id: 'reply' });
  emit({ type: 'response.done', response: { id: 'reply', status: 'completed', output: [{ id: 'reply-item', type: 'message', role: 'assistant', content: [{ type: 'audio' }] }] } });
  assert.deepEqual(floor.acceptedItemIds(), ['caller']); assert.equal((await f.capture()).queued, 0);
  emit({ type: 'output_audio_buffer.stopped', response_id: 'reply' });
  assert.deepEqual(floor.acceptedItemIds(), ['caller', 'reply-item']); assert.equal((await f.capture()).queued, 1);
  floor.retireContext(); f.observe(floor.acceptedItemIds());
  assert.equal((await f.capture()).queued, 0); assert.equal((await f.pending()).length, 1);
});

test('queues only accepted played assistant and nearest qualified caller after both raw writes are ACKed', async () => {
  const f = fixture();
  const user = f.row(20, 'user', 'qualified-user', 'device');
  const noise = f.row(21, 'user', 'raw-noise');
  const assistant = f.row(22, 'assistant', 'played-assistant', 'device');
  const original = structuredClone([...f.transcript.values()]);
  f.observe(['qualified-user', 'played-assistant']);
  assert.deepEqual(await f.capture(), { queued: 0, failed: 0 });
  user.storage = 'server'; assert.equal((await f.capture()).queued, 0);
  assistant.storage = 'server'; assert.equal((await f.capture()).queued, 1);
  const [queued] = await f.pending();
  assert.deepEqual(queued.event_ids, [assistant.id]); assert.deepEqual(queued.qualified_user_ids, [user.id]);
  assert.equal(queued.companion_id, 'alex'); assert.equal(queued.expected_memory_revision, 4);
  assert(!JSON.stringify([...f.storage.rows.values()]).includes('Private source speech'));
  assert(!queued.qualified_user_ids.includes(noise.id));
  assert.deepEqual([...f.transcript.values()].map(({ storage, ...row }) => row), original.map(({ storage, ...row }) => row));
  assert.equal((await f.capture()).queued, 0, 'successfully persisted evidence is not duplicated');
});

test('playback revision is frozen before delayed source ACK and cannot be promoted after forgetting', async () => {
  const f = fixture(); f.row(20, 'user', 'u'); f.row(21, 'assistant', 'a', 'device');
  assert.equal(f.observe(['u', 'a'], 7), true);
  assert.equal(f.observe(['u', 'a'], 8), false, 'duplicate floor updates need no new capture or delivery work');
  [...f.transcript.values()].at(-1).storage = 'server'; await f.capture();
  const [record] = await f.pending(); assert.equal(record.expected_memory_revision, 7);
  let request;
  const delivery = createConversationPlaybackDelivery({ outbox: f.outbox, getScope: () => scope,
    send: async body => { request = body; return { session_id: session, acknowledged_ids: [], discarded_ids: body.p_event_ids, reason: 'stale_revision' }; } });
  assert.deepEqual(await delivery.flush(), { delivered: 1 });
  assert.equal(request.p_expected_memory_revision, 7); assert.equal((await f.pending()).length, 0);
  assert.equal(f.transcript.size, 2, 'discarding optional continuity evidence cannot remove raw source speech');
});

test('legacy or omitted-context playback with an unknown revision remains ineligible', async () => {
  const f = fixture(); f.row(20, 'user', 'u'); f.row(21, 'assistant', 'a');
  f.observe(['u', 'a'], null); f.observe(['u', 'a'], 9);
  assert.equal((await f.capture()).queued, 0); assert.deepEqual(await f.pending(), []);
});

test('a newer assistant cannot relabel an older caller quote after a memory revision boundary', async () => {
  const f = fixture(); f.row(20, 'user', 'old-user'); f.observe(['old-user'], 4);
  f.row(21, 'assistant', 'later-assistant'); f.observe(['old-user', 'later-assistant'], 5);
  assert.equal((await f.capture()).queued, 0);
  f.row(22, 'user', 'new-user'); f.row(23, 'assistant', 'new-assistant');
  f.observe(['old-user', 'later-assistant', 'new-user', 'new-assistant'], 5);
  assert.equal((await f.capture()).queued, 1);
  const [row] = await f.pending();
  assert.deepEqual(row.event_ids, [uid(23)]); assert.deepEqual(row.qualified_user_ids, [uid(22)]);
  assert.equal(row.expected_memory_revision, 5);
});

test('an unacknowledged or unresolved nearest caller is deferred instead of pairing an older source', async () => {
  const f = fixture(); f.row(20, 'user', 'old-user'); f.row(21, 'assistant', 'first');
  const latest = f.row(22, 'user', 'latest-user', 'device'); f.row(23, 'assistant', 'second');
  f.observe(['old-user', 'first', 'latest-user', 'second']);
  assert.equal((await f.capture()).queued, 1);
  latest.storage = 'server'; assert.equal((await f.capture()).queued, 1);
  assert.deepEqual((await f.pending()).find(row => row.id === uid(23)).qualified_user_ids, [uid(22)]);

  const delayed = fixture(); delayed.row(20, 'user', 'old'); delayed.row(23, 'assistant', 'new-answer');
  delayed.observe(['old', 'late-transcript', 'new-answer']); assert.equal((await delayed.capture()).queued, 0);
  delayed.row(22, 'user', 'late-transcript'); assert.equal((await delayed.capture()).queued, 1);
  assert.deepEqual((await delayed.pending())[0].qualified_user_ids, [uid(22)]);
});

test('unplayed/cancelled assistant text and raw noise cannot become conversation playback evidence', async () => {
  const f = fixture(); f.row(20, 'user', 'u'); f.row(21, 'assistant', 'cancelled'); f.row(22, 'assistant', 'completed-but-unplayed');
  f.observe(['u']); assert.equal((await f.capture()).queued, 0);
  f.row(23, 'assistant', 'fully-played'); f.observe(['u', 'fully-played']);
  assert.equal((await f.capture()).queued, 1); assert.deepEqual((await f.pending())[0].event_ids, [uid(23)]);
});

test('local write failure retries exact receipt IDs and revision without affecting transcript state', async () => {
  const f = fixture(); f.row(20, 'user', 'u'); f.row(21, 'assistant', 'a'); f.observe(['u', 'a'], 2);
  const actual = f.outbox.put; let attempts = 0, first;
  f.outbox.put = async (account, value) => { attempts++; first ??= structuredClone(value); assert.deepEqual(value, first); if (attempts === 1) throw Error('disk unavailable'); return actual(account, value); };
  assert.deepEqual(await f.capture(), { queued: 0, failed: 1 });
  f.observe(['u', 'a'], 3);
  assert.deepEqual(await f.capture(), { queued: 1, failed: 0 });
  assert.equal((await f.pending())[0].expected_memory_revision, 2);
  assert([...f.transcript.values()].every(row => row.storage === 'server'));
});

test('delivery preserves exact payload after offline failure and rejects ambiguous or foreign ACKs', async () => {
  const f = fixture(); f.row(20, 'user', 'u'); f.row(21, 'assistant', 'a'); f.observe(['u', 'a']); await f.capture();
  let attempt = 0, first;
  const delivery = createConversationPlaybackDelivery({ outbox: f.outbox, getScope: () => scope, send: async body => {
    first ??= structuredClone(body); assert.deepEqual(body, first); attempt++;
    if (attempt === 1) throw Error('offline');
    if (attempt === 2) return { ...validAck(body), session_id: uid(999) };
    if (attempt === 3) return { ...validAck(body), acknowledged_ids: [uid(998)] };
    if (attempt === 4) return { ...validAck(body), discarded_ids: body.p_event_ids, reason: 'stale_revision' };
    if (attempt === 5) return { ...validAck(body), acknowledged_ids: [], discarded_ids: body.p_event_ids, reason: 'unrecognized' };
    return validAck(body);
  } });
  for (let n = 0; n < 5; n++) { assert.equal((await delivery.flush()).delivered, 0); assert.equal((await f.pending()).length, 1); }
  assert.equal((await delivery.flush()).delivered, 1); assert.equal((await f.pending()).length, 0);
});

test('account changes during a request cannot acknowledge another account or start a stale send', async () => {
  const storage = memoryStorage(), outbox = createConversationPlaybackOutbox('scope-fixture', { storage });
  const record = { id: uid(21), session_id: session, companion_id: 'alex', created_at: '2026-11-14T00:00:00.000Z',
    event_ids: [uid(21)], qualified_user_ids: [uid(20)], expected_memory_revision: 1 };
  await outbox.put(scope, record); await outbox.put(owner(2), { ...record, companion_id: 'mia', session_id: uid(11) });
  let active = scope, release, calls = 0;
  const delivery = createConversationPlaybackDelivery({ outbox, getScope: () => active, send: body => {
    calls++; return new Promise(resolve => { release = () => resolve(validAck(body)); });
  } });
  const first = delivery.flush(); while (!release) await new Promise(resolve => setImmediate(resolve));
  active = owner(2); release(); assert.equal((await first).delivered, 0);
  assert.equal((await outbox.list(scope)).length, 1); assert.equal((await outbox.list(owner(2))).length, 1);
  active = scope; const second = delivery.flush(); while (calls < 2) await new Promise(resolve => setImmediate(resolve));
  release(); assert.equal((await second).delivered, 1);
  assert.equal((await outbox.list(scope)).length, 0); assert.equal((await outbox.list(owner(2))).length, 1);
});

test('the scoped durable wrapper rejects changed retries and keeps service/account/session/companion separate', async () => {
  const storage = memoryStorage(), first = createConversationPlaybackOutbox('durable-fixture', { storage });
  const record = { id: uid(30), session_id: session, companion_id: 'juno', created_at: '2026-11-14T00:00:00.000Z',
    event_ids: [uid(30)], qualified_user_ids: [uid(29)], expected_memory_revision: 4, text: 'Must never persist this extra field.' };
  await first.put(scope, record); await first.put(scope, record);
  await assert.rejects(first.put(scope, { ...record, expected_memory_revision: 5 }), /Immutable/);
  await first.put(owner(2), { ...record, session_id: uid(12), companion_id: 'mia' });
  const alternateService = `https://other.example|${uid(1)}`;
  await first.put(alternateService, { ...record, session_id: uid(13), companion_id: 'alex' });
  const reloaded = createConversationPlaybackOutbox('durable-fixture', { storage });
  assert.equal((await reloaded.list(scope))[0].companion_id, 'juno');
  assert.equal((await reloaded.list(owner(2)))[0].session_id, uid(12));
  assert.equal((await reloaded.list(alternateService))[0].session_id, uid(13));
  assert(!JSON.stringify([...storage.rows.values()]).includes('Must never persist'));
  await assert.rejects(first.put(scope, { ...record, expected_memory_revision: null }), /Invalid/);
});
