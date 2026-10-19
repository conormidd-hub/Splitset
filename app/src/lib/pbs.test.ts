/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { LiftPb, PbPeriods } from '@/api/pbs';
import { setRowE1rm, type ExerciseFacts, type SetRow } from './lifting/setRow.ts';
import {
  liftMetricOrder, liftMetricShort, loggedWeight, mergeSession, metricsFor, plateRound, quickLoad, sessionBests,
} from './pbs.ts';
import { parseConstants } from './recovery/thresholds.ts';

const C = parseConstants(JSON.parse(readFileSync(new URL('../../../data/recovery_constants.json', import.meta.url), 'utf8')));
const bench: ExerciseFacts = { exerciseId: 'e1', measure: 'weight_reps', slug: 'bench_press_bb', loadMode: 'weight', bwFactor: null };
const assistedPullUp: ExerciseFacts = { exerciseId: 'e2', measure: 'weight_reps', slug: 'assisted_pull_up', loadMode: 'assisted', bwFactor: 1 };
const set = (patch: Partial<SetRow>): SetRow => ({
  id: 's1', workoutExerciseId: 'we1', exerciseId: 'e1', position: 0, setType: 'working', weightKg: 100, reps: 4, rpe: null,
  seconds: null, completed: true, completedAt: '2026-10-16T09:00:00Z', notes: null, updatedAt: 'x', ...patch,
});
const e1rmOf = (facts: ExerciseFacts) => (s: SetRow) => setRowE1rm(C, facts, s, 80);
/** A stored all-time best as lift_pbs gives it: round(value, 1)::real. */
const storedAll = (value: number): PbPeriods<LiftPb> => ({
  all: {
    user_id: 'u1', exercise_id: 'e1', metric: '1rm', period: 'all', value: Math.fround(value), weight_kg: null, reps: null,
    seconds: null, set_id: 'old', workout_id: 'w0', achieved_at: '2026-01-01T00:00:00Z',
  },
});
const best = (facts: ExerciseFacts, s: SetRow) => sessionBests([s], facts.measure, false, e1rmOf(facts), facts.loadMode)['1rm'];

test('repeating the stored set is not a new PB: the session is compared at lift_pbs precision', () => {
  // 100 × 4 is 113.33, stored as 113.3; 100 × 5 @RPE 8 is 123.33, stored as 123.3; 100 × 3 is 110.00000000000001
  assert.equal(mergeSession(storedAll(113.3), best(bench, set({ reps: 4 }))).beatsAllTime, false);
  assert.equal(mergeSession(storedAll(123.3), best(bench, set({ reps: 5, rpe: 8 }))).beatsAllTime, false);
  assert.equal(mergeSession(storedAll(110), best(bench, set({ reps: 3 }))).beatsAllTime, false);
  assert.equal(mergeSession(storedAll(113.2), best(bench, set({ reps: 4 }))).beatsAllTime, true);
  assert.equal(mergeSession(storedAll(113.3), { value: 113.4, setId: 's1' }).beatsAllTime, true);
});

test('the best manual entry counts as the all-time best to beat', () => {
  const m = mergeSession(storedAll(120), { value: 125, setId: 's1' }, 130);
  assert.equal(m.all, 130);
  assert.equal(m.beatsAllTime, false);
  assert.equal(mergeSession(storedAll(120), { value: 130.1, setId: 's1' }, 130).beatsAllTime, true);
});

test('with nothing stored, the session is every period and not a PB to beat', () => {
  assert.deepEqual(mergeSession(undefined, { value: 100, setId: 's1' }), { month: 100, year: 100, all: 100, beatsAllTime: false });
});

test('session bests skip warm-ups and unticked sets; the 1RM is the set e1RM from the engine', () => {
  const sets = [
    set({ id: 'w', setType: 'warmup', weightKg: 140, reps: 1 }),
    set({ id: 'u', completed: false, weightKg: 150, reps: 1 }),
    set({ id: 'a', weightKg: 100, reps: 5, rpe: 8 }),
    set({ id: 'b', weightKg: 110, reps: 2 }),
  ];
  const out = sessionBests(sets, 'weight_reps', false, e1rmOf(bench));
  assert.equal(out['1rm']!.setId, 'a');
  assert.ok(Math.abs(out['1rm']!.value - 100 * (1 + 7 / 30)) < 1e-9);
  // the 3RM takes 3 or more reps with weight on the bar
  assert.deepEqual(out['3rm'], { value: 100, setId: 'a' });
  assert.equal(out.reps, undefined);
});

test('a bodyweight lift with no added weight is a reps PB', () => {
  const out = sessionBests([set({ weightKg: 0, reps: 12 })], 'weight_reps', true, () => null);
  assert.deepEqual(out.reps, { value: 12, setId: 's1' });
  assert.equal(out['3rm'], undefined);
  assert.deepEqual(sessionBests([set({ weightKg: null, reps: 20 })], 'reps', false, () => null).reps, { value: 20, setId: 's1' });
});

test('an assisted lift has no 3RM: more assistance is not a PB', () => {
  assert.deepEqual(metricsFor('weight_reps', false, 'assisted'), ['1rm']);
  const out = sessionBests([set({ exerciseId: 'e2', weightKg: 40, reps: 5 })], 'weight_reps', false, e1rmOf(assistedPullUp), 'assisted');
  assert.equal(out['3rm'], undefined);
  assert.ok(Math.abs(out['1rm']!.value - 40 * (1 + 5 / 30)) < 1e-9);
  // last month 35 kg assistance × 5; today 40 kg × 5 is weaker, and says so
  const before = best(assistedPullUp, set({ weightKg: 35, reps: 5 }))!.value;
  assert.equal(mergeSession(storedAll(before), out['1rm']).beatsAllTime, false);
});

test('which metrics each kind of exercise has, headline first', () => {
  assert.deepEqual(metricsFor('weight_reps', false), ['1rm', '3rm']);
  assert.deepEqual(metricsFor('weight_reps', false, 'weight'), ['1rm', '3rm']);
  assert.deepEqual(metricsFor('weight_reps', true, 'bodyweight'), ['1rm', 'reps', '3rm']);
  assert.deepEqual(metricsFor('reps', true, 'bodyweight'), ['reps']);
  assert.deepEqual(metricsFor('duration', false), ['time']);
  assert.deepEqual(metricsFor('weight_duration', false), ['weight']);
  assert.deepEqual(metricsFor('distance_duration', false), []);
  assert.deepEqual(liftMetricOrder('weight'), ['1rm', '3rm', 'reps', 'time', 'weight']);
  assert.deepEqual(liftMetricOrder('bodyweight'), ['1rm', 'reps', '3rm', 'time', 'weight']);
  assert.deepEqual(liftMetricOrder('assisted'), ['1rm', 'reps', 'time']);
  assert.equal(liftMetricShort('1rm', 'bodyweight'), '1RM incl. BW');
  assert.equal(liftMetricShort('1rm', null), '1RM');
  assert.equal(liftMetricShort('3rm', 'bodyweight'), '3RM');
});

test('quick loads: a weight-mode lift takes the share of its 1RM, rounded to the plates', () => {
  assert.equal(quickLoad(73.5, 'metric'), 72.5);
  assert.equal(quickLoad(73.5, 'metric', 'weight', null, 80), 72.5);
  assert.equal(quickLoad(100, 'imperial'), plateRound(100, 'imperial'));
});

test('quick loads: a bodyweight lift gets the load added to bodyweight, and none below it', () => {
  // pull-up at 80 kg with a 1RM of 105: 50 to 70% are under bodyweight alone
  const pullUp = [50, 60, 70, 80, 90].map((pct) => quickLoad((105 * pct) / 100, 'metric', 'bodyweight', 1, 80));
  assert.deepEqual(pullUp, [null, null, null, 5, 15]);
  // crunch (factor 0.3) with a 1RM of 40: 60% is bodyweight alone
  const crunch = [50, 60, 70, 80, 90].map((pct) => quickLoad((40 * pct) / 100, 'metric', 'bodyweight', 0.3, 80));
  assert.deepEqual(crunch, [null, 0, 5, 7.5, 12.5]);
  assert.ok(Object.is(quickLoad(79, 'metric', 'bodyweight', 1, 80), 0));
  assert.equal(quickLoad(100, 'metric', 'bodyweight', null, 80), null);
});

test('quick loads: an assisted lift gets the assistance, which falls as the share rises', () => {
  // assisted pull-up, 30 kg assistance × 8 at 80 kg: 1RM 50 × (1 + 8/30) = 63.33
  const base = 50 * (1 + 8 / 30);
  const loads = [50, 60, 70, 80, 90].map((pct) => quickLoad((base * pct) / 100, 'metric', 'assisted', 1, 80));
  assert.deepEqual(loads, [47.5, 42.5, 35, 30, 22.5]);
  // more than bodyweight can't be had with assistance
  assert.equal(quickLoad(90, 'metric', 'assisted', 1, 80), null);
});

test('a logged weight says what it is', () => {
  assert.equal(loggedWeight(100, 'metric', 'weight'), '100 kg');
  assert.equal(loggedWeight(100, 'metric', null), '100 kg');
  assert.equal(loggedWeight(20, 'metric', 'bodyweight'), '+20 kg');
  assert.equal(loggedWeight(0, 'metric', 'bodyweight'), 'BW');
  assert.equal(loggedWeight(30, 'metric', 'assisted'), '30 kg assist');
  assert.equal(loggedWeight(0, 'metric', 'assisted'), 'no assist');
  assert.equal(loggedWeight(20, 'imperial', 'bodyweight'), '+44.1 lb');
});
