/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { liftTrend } from '../homeLayout.ts';
import { parseConstants } from '../recovery/thresholds.ts';
import {
  defaultLiftMeasure, defaultLiftTrends, e1rmOfSet, liftMeasuresFor, progressPoints, progressSummary, rangeStart, workoutBests,
  type ProgressExercise, type ProgressSet,
} from './progression.ts';

const C = parseConstants(JSON.parse(readFileSync(new URL('../../../../data/recovery_constants.json', import.meta.url), 'utf8')));

const ID = {
  bench: '00000000-0000-4000-8000-000000000001',
  squat: '00000000-0000-4000-8000-000000000002',
  pullUp: '00000000-0000-4000-8000-000000000003',
  curl: '00000000-0000-4000-8000-000000000004',
  plank: '00000000-0000-4000-8000-000000000005',
  pushUp: '00000000-0000-4000-8000-000000000006',
};

const ex = (patch: Partial<ProgressExercise>): ProgressExercise => ({
  id: ID.bench, slug: 'bench_press_bb', measure: 'weight_reps', load_mode: 'weight', bw_factor: null, fatigue: null,
  pb_estimate_from: null, pb_estimate_ratio: null, is_unilateral: false, is_bodyweight: false, ...patch,
});
const bench = ex({});
const pullUp = ex({ id: ID.pullUp, slug: 'pull_up', load_mode: 'bodyweight', bw_factor: 1, is_bodyweight: true });

const set = (patch: Partial<ProgressSet> & { at?: string; bw?: number | null; finished?: boolean }): ProgressSet => {
  const { at = '2026-10-01T09:00:00Z', bw = 80, finished = true, ...rest } = patch;
  return {
    workout_id: at, set_type: 'working', weight_kg: 100, reps: 5, rpe: null, e1rm: null, side: null,
    workout: { started_at: at, finished_at: finished ? at : null, bodyweight_kg: bw }, ...rest,
  };
};

test('each kind of lift offers the measures that mean something for it, its default first', () => {
  assert.deepEqual(liftMeasuresFor(bench), ['e1rm', 'heaviest', 'volume', 'reps']);
  assert.deepEqual(liftMeasuresFor(pullUp), ['e1rm', 'heaviest', 'volume', 'reps']);
  // the weight logged on an assisted lift is the help it had: its heaviest is its weakest set
  assert.deepEqual(liftMeasuresFor(ex({ load_mode: 'assisted', bw_factor: 1 })), ['e1rm', 'reps']);
  // the old form's bodyweight lifts have no e1RM, so they lead with reps
  assert.deepEqual(liftMeasuresFor(ex({ load_mode: null, is_bodyweight: true })), ['reps', 'heaviest', 'volume']);
  assert.deepEqual(liftMeasuresFor(ex({ measure: 'reps', load_mode: 'fixed' })), ['reps']);
  assert.deepEqual(liftMeasuresFor(ex({ measure: 'weight_duration', load_mode: 'fixed' })), ['heaviest']);
  assert.deepEqual(liftMeasuresFor(ex({ measure: 'duration', load_mode: 'fixed' })), []);
  assert.equal(defaultLiftMeasure(ex({ measure: 'reps', load_mode: 'fixed' })), 'reps');
  assert.equal(defaultLiftMeasure(ex({ measure: 'duration', load_mode: 'fixed' })), null);
});

test('a set keeps the e1RM it was saved with', () => {
  assert.equal(e1rmOfSet(C, bench, set({ e1rm: 126.5, weight_kg: 1, reps: 1 })), 126.5);
});

test('a set saved before e1RMs were stored gets the engine\'s: Epley, RPE as reps in reserve, the rep cap', () => {
  // 100 × 5: 100 × (1 + 5/30)
  assert.ok(Math.abs(e1rmOfSet(C, bench, set({}))! - 116.6667) < 1e-3);
  // RPE 8 leaves 2 in reserve: 100 × (1 + 7/30)
  assert.ok(Math.abs(e1rmOfSet(C, bench, set({ rpe: 8 }))! - 123.3333) < 1e-3);
  // reps are capped at max_reps (20): 30 reps count as 20
  assert.ok(Math.abs(e1rmOfSet(C, bench, set({ weight_kg: 50, reps: 30 }))! - 50 * (1 + 20 / 30)) < 1e-9);
});

test('a bodyweight lift counts the workout\'s bodyweight snapshot plus the added load', () => {
  // 80 kg bodyweight + 10 kg × 5: 90 × (1 + 5/30) = 105
  assert.ok(Math.abs(e1rmOfSet(C, pullUp, set({ weight_kg: 10, reps: 5, bw: 80 }))! - 105) < 1e-9);
  assert.equal(e1rmOfSet(C, undefined, set({})), null);
});

test('a workout\'s bests skip warm-ups and wait for the workout to finish', () => {
  const e1rmOf = (s: ProgressSet) => e1rmOfSet(C, bench, s);
  const rows = [
    set({ at: '2026-10-08T09:00:00Z', weight_kg: 140, reps: 3, set_type: 'warmup' }),
    set({ at: '2026-10-08T09:00:00Z', weight_kg: 100, reps: 5 }),
    set({ at: '2026-10-08T09:00:00Z', weight_kg: 105, reps: 3, e1rm: 115.5 }),
    set({ at: '2026-10-01T09:00:00Z', weight_kg: 95, reps: 8 }),
    set({ at: '2026-10-15T09:00:00Z', weight_kg: 200, reps: 1, finished: false }),
  ];
  const bests = workoutBests(rows, e1rmOf);
  assert.deepEqual(bests.map((b) => b.workoutId), ['2026-10-01T09:00:00Z', '2026-10-08T09:00:00Z']);
  const [first, second] = bests;
  // 95 × 8 → 95 × (1 + 8/30) = 120.33…, kept to 0.1 as lift_pbs does
  assert.equal(first.e1rm, 120.3);
  assert.equal(first.volume, 760);
  assert.equal(second.heaviest, 105);
  assert.equal(second.reps, 5);
  assert.equal(second.e1rm, 116.7);
  assert.equal(second.volume, 815);
});

test('one-side sets count half their volume, as the workout summaries do', () => {
  const rows = [set({ side: 'left', weight_kg: 20, reps: 10 }), set({ side: 'right', weight_kg: 20, reps: 10 })];
  assert.equal(workoutBests(rows, () => null)[0].volume, 200);
});

test('points follow the chosen measure in the user\'s units, from the start of the range', () => {
  const bests = workoutBests([
    set({ at: '2026-06-01T09:00:00Z', weight_kg: 100, reps: 5, e1rm: 116.7 }),
    set({ at: '2026-10-01T09:00:00Z', weight_kg: 110, reps: 3, e1rm: 121 }),
  ], (s) => s.e1rm);
  const oct1 = Date.parse('2026-10-01T09:00:00Z');
  assert.deepEqual(progressPoints(bests, 'heaviest', 'metric', null).map((p) => p.y), [100, 110]);
  assert.deepEqual(progressPoints(bests, 'reps', 'imperial', null).map((p) => p.y), [5, 3]);
  assert.deepEqual(progressPoints(bests, 'e1rm', 'imperial', rangeStart(oct1 + 86_400_000, 30)), [{ x: oct1, y: 266.8 }]);
  assert.equal(rangeStart(oct1, null), null);
});

test('the summary gives the latest, the best and the change since the first point', () => {
  assert.deepEqual(progressSummary([{ x: 1, y: 100 }, { x: 2, y: 112.5 }, { x: 3, y: 110 }]), { latest: 110, best: 112.5, change: 10 });
  assert.equal(progressSummary([]), null);
});

test('the default charts are the main compound lifts that have been logged, each on its e1RM', () => {
  const exercises = [
    bench,
    ex({ id: ID.squat, slug: 'squat_bb' }),
    ex({ id: ID.curl, slug: 'curl_db' }),
  ];
  const logged = [
    { exercise_id: ID.bench, completed_sets: 40 },
    { exercise_id: ID.curl, completed_sets: 90 },
    { exercise_id: ID.squat, completed_sets: 0 },
  ];
  assert.deepEqual(defaultLiftTrends(exercises, logged), [liftTrend(ID.bench, 'e1rm')]);
});

test('without any main lift logged, the most-logged chartable lifts stand in', () => {
  const exercises = [
    ex({ id: ID.curl, slug: 'curl_db' }),
    ex({ id: ID.plank, slug: 'plank', measure: 'duration', load_mode: 'fixed' }),
    ex({ id: ID.pushUp, slug: 'push_up_legacy', measure: 'reps', load_mode: null }),
    pullUp,
  ];
  const logged = [
    { exercise_id: ID.curl, completed_sets: 30 },
    { exercise_id: ID.plank, completed_sets: 99 },
    { exercise_id: ID.pushUp, completed_sets: 50 },
    { exercise_id: ID.pullUp, completed_sets: 10 },
    { exercise_id: null, completed_sets: 5 },
  ];
  assert.deepEqual(defaultLiftTrends(exercises, logged), [
    liftTrend(ID.pushUp, 'reps'), liftTrend(ID.curl, 'e1rm'), liftTrend(ID.pullUp, 'e1rm'),
  ]);
  assert.deepEqual(defaultLiftTrends(exercises, logged, undefined, 1), [liftTrend(ID.pushUp, 'reps')]);
  assert.deepEqual(defaultLiftTrends(exercises, []), []);
});
