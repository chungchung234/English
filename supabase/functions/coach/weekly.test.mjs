import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyLearningPlan } from './weekly.ts';

const session = '11111111-1111-4111-8111-111111111111';
const event = '22222222-2222-4222-8222-222222222222';
const assistant = '33333333-3333-4333-8333-333333333333';
const item = '44444444-4444-4444-8444-444444444444';
const analysis = '55555555-5555-4555-8555-555555555555';
const recall = '66666666-6666-4666-8666-666666666666';
const observation = '77777777-7777-4777-8777-777777777777';
const other = '88888888-8888-4888-8888-888888888888';
const scope = { companionId: 'alex', period_start: '2026-11-03T12:00:00.000Z', period_end: '2026-11-10T12:00:00.000Z', generated_at: '2026-11-10T12:01:00.000Z' };
const events = [
  { id: event, session_id: session, speaker: 'user', text: 'I would like a coffee.', timestamp: '2026-11-09T12:00:00.000Z' },
  { id: assistant, session_id: session, speaker: 'assistant', text: 'What would you like?', timestamp: '2026-11-09T11:59:00.000Z' },
];
const context = () => ({
  items: [{ id: item, expression: 'I would like a coffee.', source_session_id: session, source_analysis_id: analysis, evidence_ids: [event], source_version: 'source-v1' }],
  recalls: [{ id: recall, item_id: item, rating: 'hard', occurred_at: '2026-11-10T11:00:00.000Z', kind: 'delayed' }],
  usage: [{ id: observation, item_id: item, session_id: session, evidence_ids: [event], mode_evidence_ids: [], kind: 'observed', mode: 'undetermined', review_status: 'confirmed', source_version: 'usage-v1', created_at: '2026-11-09T12:00:00.000Z' }],
});

test('weekly goals use exact scope and separate source, delayed recall and reviewed usage metadata', () => {
  const raw = context(), before = structuredClone(raw), result = weeklyLearningPlan(raw, events, scope);
  assert.equal(result.learning_plan.keep.item_id, item);
  assert.equal(result.learning_plan.try.item_id, item);
  assert.match(result.learning_plan.keep.goal, /예문을 가린 뒤/);
  assert.match(result.learning_plan.try.goal, /상황이 맞으면/);
  assert.deepEqual(result.learning_plan_context.scope.source_events.map(source => source.event_id), [event, assistant]);
  assert.equal(result.learning_plan_context.scope.hours, 168);
  assert.equal(result.learning_plan_context.selection, 'user_required');
  assert.equal(result.learning_plan_context.future_calls_included, false);
  assert.equal(result.learning_plan_context.recalls[0].kind, 'delayed');
  assert.equal(result.learning_plan_context.reviewed_usage[0].mode, 'undetermined');
  assert.deepEqual(raw, before);
});

test('weekly proposals need current-period eligible user sources and never add a later call', () => {
  const empty = weeklyLearningPlan({ items: [], recalls: [], usage: [] }, events, scope);
  assert.equal(empty.learning_plan, null);
  const historical = context(); historical.recalls = []; historical.usage = [];
  const result = weeklyLearningPlan(historical, [{ ...events[0], timestamp: '2026-11-03T11:59:59.999Z' }, events[1]], scope);
  assert.equal(result.learning_plan, null);
  assert.deepEqual(result.learning_plan_context.source_items, []);
  const future = context(); future.usage[0].created_at = '2026-11-10T12:00:00.001Z';
  assert.throws(() => weeklyLearningPlan(future, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
});

test('maximum-length expressions retain full sources and produce selectable bounded goals', () => {
  const raw = context(); raw.items[0].expression = 'a'.repeat(500);
  const result = weeklyLearningPlan(raw, events, scope);
  for (const proposal of Object.values(result.learning_plan)) assert.ok(proposal.goal.length > 0 && proposal.goal.length <= 500);
  assert.equal(result.learning_plan_context.source_items[0].expression, raw.items[0].expression);
  assert.equal(result.learning_plan_context.source_items[0].expression.length, 500);
});

test('weekly source ids from another call or assistant speech fail closed', () => {
  for (const change of [row => row.evidence_ids = [other], row => row.evidence_ids = [assistant], row => row.source_session_id = other]) {
    const raw = context(); change(raw.items[0]);
    assert.throws(() => weeklyLearningPlan(raw, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  }
});

test('unreviewed usage and unsupported interpretation are never promoted into weekly goals', () => {
  for (const change of [row => row.review_status = 'pending', row => row.mode = 'spontaneous', row => row.kind = 'mastered', row => row.mode = 'new_context', row => row.evidence_ids = []]) {
    const raw = context(); change(raw.usage[0]);
    assert.throws(() => weeklyLearningPlan(raw, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  }
  const reviewed = context(); reviewed.usage[0].mode = 'after_hint'; reviewed.usage[0].mode_evidence_ids = [assistant];
  assert.equal(weeklyLearningPlan(reviewed, events, scope).learning_plan_context.reviewed_usage[0].mode, 'after_hint');
});

test('weekly observations require actual in-period same-call evidence ids', () => {
  for (const change of [row => row.evidence_ids = [assistant], row => row.mode_evidence_ids = [other], row => row.session_id = other]) {
    const raw = context(); change(raw.usage[0]);
    assert.throws(() => weeklyLearningPlan(raw, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  }
});

test('reviewed modes require preceding assistant evidence and repetition needs the actual target', () => {
  const raw = context(); raw.usage[0].mode = 'after_hint'; raw.usage[0].mode_evidence_ids = [event];
  assert.throws(() => weeklyLearningPlan(raw, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  raw.usage[0].mode_evidence_ids = [assistant];
  for (const timestamp of [events[0].timestamp, '2026-11-09T12:00:00.001Z']) {
    const later = [events[0], { ...events[1], timestamp }];
    assert.throws(() => weeklyLearningPlan(raw, later, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  }
  raw.usage[0].mode = 'repetition';
  assert.throws(() => weeklyLearningPlan(raw, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  const repeated = [events[0], { ...events[1], text: 'Try this: I would like a coffee.' }];
  assert.equal(weeklyLearningPlan(raw, repeated, scope).learning_plan_context.reviewed_usage[0].mode, 'repetition');
});

test('only delayed in-period self-report ratings influence deterministic ordering', () => {
  const raw = context();
  raw.items.unshift({ ...raw.items[0], id: other });
  const result = weeklyLearningPlan(raw, events, scope);
  assert.equal(result.learning_plan.keep.item_id, item);
  assert.equal(result.learning_plan.try.item_id, other);
  for (const change of [row => row.kind = 'immediate', row => row.rating = 'fluent', row => row.occurred_at = '2026-11-03T11:59:59.999Z']) {
    const bad = context(); change(bad.recalls[0]);
    assert.throws(() => weeklyLearningPlan(bad, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  }
});

test('weekly period, duplicates and malformed bounded service context are validated', () => {
  assert.throws(() => weeklyLearningPlan(context(), events, { ...scope, period_start: '2026-11-02T12:00:00.000Z' }), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  assert.throws(() => weeklyLearningPlan(context(), events, { ...scope, generated_at: '2026-11-10T11:59:59.999Z' }), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  assert.throws(() => weeklyLearningPlan(context(), [...events, events[0]], scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  const duplicates = context(); duplicates.items.push(duplicates.items[0]);
  assert.throws(() => weeklyLearningPlan(duplicates, events, scope), { code: 'LEARNING_PLAN_UNAVAILABLE' });
  const unbounded = context(); unbounded.items[0].expression = 'a'.repeat(130_000);
  assert.throws(() => weeklyLearningPlan(unbounded, events, scope));
});

test('ineligible removed item recalls and usage are not copied into weekly metadata', () => {
  const raw = context(); raw.items = [];
  const result = weeklyLearningPlan(raw, events, scope);
  assert.equal(result.learning_plan, null);
  assert.deepEqual(result.learning_plan_context.recalls, []);
  assert.deepEqual(result.learning_plan_context.reviewed_usage, []);
});
