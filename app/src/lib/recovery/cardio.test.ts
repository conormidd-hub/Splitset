/// <reference types="node" />

// Build phase 10's cardio, as the plan states the test: a 90-minute run with 60 minutes hard is
// 6 + 1.5 = 7.5 equivalent sets × 0.30 = 2.25, so quads and calves 2.25, hamstrings and glutes
// 0.90, adductors 0.45, and at t = 0 quads is High. Plus: no heart rate means every minute is
// easy, which types count, cardio off, and the run in the tap detail's contributions.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  activityChanges, activityLoads, cardioKind, equivalentSets, scoreActivity, type ActivityLoadRow, type ActivityRow, type ScoredActivity,
} from './cardio.ts';
import { recoveryMapAt } from './read.ts';
import { C, EXERCISES, MUSCLES, near } from './testRows.ts';
import { thresholdsFor } from './thresholds.ts';
import type { Model } from './types.ts';
import { libraryFromRows } from './workoutLoads.ts';

const { lib, keyOf } = libraryFromRows(EXERCISES, MUSCLES);
const M: Model = { c: C, lib };
const START = '2026-10-18T06:00:00.000Z';

/** A 90-minute run with 60 minutes in zones 3 and up (zone 1 first, seconds). */
const LONG_RUN: ActivityRow = {
  id: 'i1', type: 'Run', name: 'Long run', start_time: START, moving_time_s: 90 * 60, elapsed_time_s: 90 * 60,
  hr_zone_times: [600, 1200, 1800, 1200, 600, 0, 0],
};

describe('equivalent sets', () => {
  test('a 90-minute run with 60 minutes hard: 6 + 1.5 = 7.5 sets × 0.30 = 2.25', () => {
    const e = equivalentSets(M, LONG_RUN);
    assert.deepEqual([e.hardMin, e.easyMin], [60, 30]);
    near(e.sets, 7.5);
    const s = scoreActivity(M, LONG_RUN)!;
    near(s.load, 2.25);
    const L = Object.fromEntries(s.muscles.map((m) => [m.muscle_id, m.load]));
    assert.deepEqual(Object.keys(L).sort(), ['adductors', 'calves', 'glutes', 'hamstrings', 'quads']);
    near(L.quads, 2.25);
    near(L.calves, 2.25);
    near(L.hamstrings, 0.9);
    near(L.glutes, 0.9);
    near(L.adductors, 0.45);
    assert.equal(s.end, Date.parse(START) / 3_600_000 + 1.5);
  });

  test('at t = 0 (the run\'s end) quads is High', () => {
    const s = scoreActivity(M, LONG_RUN)!;
    const loads = { muscles: s.muscles.map((m) => ({ ...m, finished_at: new Date(s.end * 3_600_000).toISOString(), workout_id: null, activity_id: s.activity_id })),
      exercises: [], activities: [{ activity_id: 'i1', name: 'Long run', type: 'Run', finished_at: new Date(s.end * 3_600_000).toISOString() }] };
    const map = recoveryMapAt(M, keyOf, loads, s.end);
    assert.equal(map.quads.label, 'High');
    // the tap detail lists the run: "Long run", its date, its role, load 2.25
    const [q] = map.quads.contributing;
    assert.deepEqual([q.exercise, q.role, q.workout_id], ['Long run', 'primary', 'i1']);
    near(q.load, 2.25);
    assert.equal(map.hamstrings.contributing[0].role, 'secondary');
    assert.ok(Math.abs(map.quads.contributing.reduce((t, x) => t + x.load, 0) - map.quads.W) < 1e-9);
  });

  test('with no heart-rate data every minute is easy: 90 minutes = 4.5 sets = 1.35', () => {
    for (const zones of [null, [], [0, 0, 0, 0, 0]]) {
      const s = scoreActivity(M, { ...LONG_RUN, hr_zone_times: zones })!;
      near(s.sets, 4.5);
      near(s.load, 1.35);
    }
  });

  test('hard minutes are capped at the moving time: 100 minutes in zone 3 of a 90-minute run is 90 hard', () => {
    const e = equivalentSets(M, { ...LONG_RUN, hr_zone_times: [0, 0, 6000, 0, 0] });
    assert.deepEqual([e.hardMin, e.easyMin], [90, 0]);
    near(e.sets, 9);
  });

  test('sets come from the moving time (else the elapsed time), t_w from the elapsed time (else the moving time)', () => {
    const elapsedOnly = scoreActivity(M, { ...LONG_RUN, moving_time_s: null, elapsed_time_s: 3600, hr_zone_times: null })!;
    near(elapsedOnly.sets, 3);   // 60 easy minutes
    near(elapsedOnly.end, Date.parse(START) / 3_600_000 + 1);
    const paused = scoreActivity(M, { ...LONG_RUN, moving_time_s: 5400, elapsed_time_s: 6000, hr_zone_times: null })!;
    near(paused.sets, 4.5);   // 90 moving minutes, all easy
    near(paused.end, Date.parse(START) / 3_600_000 + 6000 / 3600);
    const movingOnly = scoreActivity(M, { ...LONG_RUN, elapsed_time_s: null })!;
    near(movingOnly.end, Date.parse(START) / 3_600_000 + 1.5);
    const none = scoreActivity(M, { ...LONG_RUN, moving_time_s: null, elapsed_time_s: null })!;
    assert.deepEqual([none.sets, none.muscles], [0, []]);
  });
});

/** The rows save_activity_loads() writes for a scored activity, as read back (t_w as Postgres spells it). */
const rowsOf = (s: ScoredActivity, finishedAt = new Date(s.end * 3_600_000).toISOString().replace('.000Z', '+00:00')): ActivityLoadRow[] =>
  s.muscles.map((x) => ({ activity_id: s.activity_id, ...x, finished_at: finishedAt }));

describe('which activities the catch-up and the recompute send (activityChanges)', () => {
  const scored = scoreActivity(M, LONG_RUN)!;

  test('a new run is sent scored; a run whose rows match its score is not sent again', () => {
    assert.deepEqual(activityChanges(M, [LONG_RUN], []), [{ activity_id: 'i1', muscles: scored.muscles }]);
    assert.deepEqual(activityChanges(M, [LONG_RUN], rowsOf(scored)), []);
  });

  test('a run changed after it was first scored is sent again', () => {
    // its zones arrived with a later sync: cached at 1.35 with none, now 2.25
    const noZones = scoreActivity(M, { ...LONG_RUN, hr_zone_times: null })!;
    const [late] = activityChanges(M, [LONG_RUN], rowsOf(noZones));
    near(late.muscles.find((x) => x.muscle_id === 'quads')!.load, 2.25);
    // cropped: same moving time, so the same loads, but a later end
    const cropped = { ...LONG_RUN, elapsed_time_s: 100 * 60 };
    assert.deepEqual(activityChanges(M, [cropped], rowsOf(scored)), [{ activity_id: 'i1', muscles: scored.muscles }]);
    // a new start time moves t_w too
    assert.equal(activityChanges(M, [{ ...LONG_RUN, start_time: '2026-10-18T07:00:00.000Z' }], rowsOf(scored)).length, 1);
    // retyped Run → Ride: other muscles
    const [ride] = activityChanges(M, [{ ...LONG_RUN, type: 'Ride' }], rowsOf(scored));
    assert.deepEqual(ride.muscles.map((x) => x.muscle_id).sort(), ['calves', 'glutes', 'hamstrings', 'quads']);
  });

  test('a run retyped to Walk (no longer countable) is sent with no muscles, which clears its rows', () => {
    const other = scoreActivity(M, { ...LONG_RUN, id: 'i2' })!;
    assert.deepEqual(activityChanges(M, [{ ...LONG_RUN, id: 'i2' }], [...rowsOf(scored), ...rowsOf(other)]), [{ activity_id: 'i1', muscles: [] }]);
  });

  test('a run with no moving or elapsed time and no rows is left alone; one that has rows is cleared', () => {
    const empty = { ...LONG_RUN, moving_time_s: 0, elapsed_time_s: 0 };
    assert.deepEqual(activityChanges(M, [empty], []), []);
    assert.deepEqual(activityChanges(M, [empty], rowsOf(scored)), [{ activity_id: 'i1', muscles: [] }]);
  });

  test('with cardio off every activity with rows is cleared and nothing is scored', () => {
    const off: Model = { c: thresholdsFor(C, 'u', [{ user_id: 'u', key: 'cardio.enabled_default', value: false }]), lib };
    assert.deepEqual(activityChanges(off, [LONG_RUN, { ...LONG_RUN, id: 'i3' }], rowsOf(scored)), [{ activity_id: 'i1', muscles: [] }]);
  });

  test('new thresholds (a base-hours override) send every run again', () => {
    const slower: Model = { c: thresholdsFor(C, 'u', [{ user_id: 'u', key: 'base_recovery_hours.quads', value: 60 }]), lib };
    assert.equal(activityChanges(slower, [LONG_RUN], rowsOf(scored)).length, 1);
  });
});

describe('which activities count', () => {
  test('the five kinds and their variants; walks, workouts, lifting, tennis and golf don\'t', () => {
    assert.deepEqual(['Run', 'VirtualRun', 'TrailRun', 'Ride', 'VirtualRide', 'GravelRide', 'Swim', 'OpenWaterSwim', 'Hike', 'Rowing'].map(cardioKind),
      ['run', 'run', 'run', 'ride', 'ride', 'ride', 'swim', 'swim', 'hike', 'row']);
    for (const t of ['Walk', 'Workout', 'WeightTraining', 'Tennis', 'Golf', '', null]) assert.equal(cardioKind(t), null, String(t));
    const swim = scoreActivity(M, { ...LONG_RUN, type: 'Swim', name: 'Pool' })!;
    assert.deepEqual(swim.muscles.map((m) => m.muscle_id).sort(), ['front_delts', 'lats', 'traps', 'triceps']);
  });

  test('cardio off (a user\'s cardio.enabled_default override) scores nothing', () => {
    const acts = [LONG_RUN, { ...LONG_RUN, id: 'i2', type: 'Walk' }];
    assert.equal(activityLoads(M, acts).length, 1);
    const off: Model = { c: thresholdsFor(C, 'u', [{ user_id: 'u', key: 'cardio.enabled_default', value: false }]), lib };
    assert.deepEqual(activityLoads(off, acts), []);
  });

  test('recovery follows the engine: R from the muscle\'s base hours and its load', () => {
    const s = scoreActivity(M, LONG_RUN)!;
    const calves = s.muscles.find((m) => m.muscle_id === 'calves')!;
    near(calves.recovery_hours, 24 * Math.min(2, 0.5 + 0.3 * 2.25));   // calves recover from 24 h
  });
});
