/// <reference types="node" />

// Build phase 5's read side over cache rows shaped like recovery_loads()'s: the F26 week at
// Wednesday 20:00 with its contributing exercises, past moments that never see later workouts,
// the history's sample times, and F20's session view read back from its cache.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scoreWorkout, sessionMap } from './engine.ts';
import { MUSCLE_IDS, type MuscleId } from './library.ts';
import { toPbHistory } from './pbHistory.ts';
import {
  isoOfHours, readSpanHours, recoveryHistory, recoveryMapAt, sampleTimes, sessionMapFromLoads, sessionView,
  type LoadWindow, type RecoveryMap,
} from './read.ts';
import { C, EXERCISES, fixture, historyRows, iso, LIBRARY, MUSCLES, near, score, setsHistory, T0, workoutRows } from './testRows.ts';
import type { LiftSet, Model } from './types.ts';
import { engineWorkout, libraryFromRows } from './workoutLoads.ts';

const { lib, keyOf } = libraryFromRows(EXERCISES, MUSCLES);
const M: Model = { c: C, lib };
const H0 = T0 / 3_600_000;           // fixture hour 0 in engine hours
const at = (h: number) => H0 + h;
const NAMES = new Map(LIBRARY.map((e) => [`id-${e.slug}`, e.name]));

type FixtureWorkout = { start: number; end: number; exercises: [string, LiftSet[]][] };

/** What recovery_loads() would return for these fixture workouts, scored as phase 4 caches them. */
function loadWindow(workouts: FixtureWorkout[], pbs: Parameters<typeof historyRows>[0]): LoadWindow {
  const parts = workouts.map((w, i) => workoutRows(`w${i}`, w));
  const loads = score(parts, [...historyRows(pbs), ...parts.flatMap(setsHistory)]);
  const finished = new Map(parts.map((p) => [p.workout.id, p.workout.finished_at!]));
  return {
    muscles: loads.flatMap((w) => w.muscles.map((m) => ({ ...m, workout_id: w.workout_id, finished_at: finished.get(w.workout_id)! }))),
    exercises: loads.flatMap((w) => w.exercises.map((e) => ({
      ...e, workout_id: w.workout_id, name: NAMES.get(e.exercise_id)!, finished_at: finished.get(w.workout_id)!,
    }))),
  };
}

const F26 = fixture('F26');
const F26_WORKOUTS = F26.inputs.workouts as FixtureWorkout[];
const F26_PBS = F26.inputs.history as Parameters<typeof historyRows>[0];
const F26_LOADS = loadWindow(F26_WORKOUTS, F26_PBS);
const WEDNESDAY_20 = at(68);

describe('recovery_map(user, at)', () => {
  const map = recoveryMapAt(M, keyOf, F26_LOADS, WEDNESDAY_20);

  test('F26 at Wednesday 20:00: hamstrings Very high; quads, glutes, biceps and traps High; the rest as in F26', () => {
    for (const id of ['quads', 'glutes', 'biceps', 'traps'] as const) assert.equal(map[id].label, 'High', id);
    assert.equal(map.hamstrings.label, 'Very high');
    const expect = F26.expect as Record<MuscleId, { level: number[]; F?: number[] }>;
    assert.deepEqual(Object.keys(expect).sort(), [...MUSCLE_IDS].sort());
    for (const [id, want] of Object.entries(expect) as [MuscleId, { level: number[]; F?: number[] }][]) {
      assert.equal(map[id].level, want.level[0], id);
      if (want.F) near(map[id].F, want.F[0]);
    }
  });

  test('every muscle carries the read API\'s fields', () => {
    for (const id of MUSCLE_IDS) {
      assert.deepEqual(Object.keys(map[id]).sort(),
        ['F', 'W', 'advice', 'contributing', 'fill', 'fill_dark', 'label', 'level', 'ready_in_h', 'trainable_in_h'].sort(), id);
    }
    assert.equal(map.hamstrings.fill, C.levels[4].fill);
    assert.equal(map.front_delts.fill_dark, C.ready_fill_dark);   // level 0 takes the ready colour
  });

  test('contributions are role_weight × L_e, largest first, and add up to W', () => {
    for (const id of MUSCLE_IDS) {
      const list = map[id].contributing;
      for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].load >= list[i].load, `${id} out of order`);
      assert.ok(Math.abs(list.reduce((s, x) => s + x.load, 0) - map[id].W) < 1e-9, `${id}: contributions ${list.length}, W ${map[id].W}`);
      for (const x of list) {
        const def = lib.get(keyOf.get(x.exercise_id)!)!;
        assert.ok(def[x.role].includes(id), `${x.exercise} is not ${x.role} for ${id}`);
        const le = F26_LOADS.exercises.find((e) => e.exercise_id === x.exercise_id && e.workout_id === x.workout_id)!.load;
        assert.equal(x.load, C.role_weights[x.role] * le);
      }
    }
    const [top] = map.hamstrings.contributing;
    assert.deepEqual([top.exercise, top.role, top.pb_source, top.workout_date], ['Romanian deadlift (barbell)', 'primary', 'monthly', iso(66)]);
    // Monday's push day still counts towards chest's week, though its fatigue has nearly gone
    assert.ok(map.chest.contributing.some((x) => x.workout_date === iso(18)));
  });

  test('a past moment only sees the workouts finished by then, ready times included', () => {
    const monday = recoveryMapAt(M, keyOf, F26_LOADS, at(0));
    for (const id of MUSCLE_IDS) {
      assert.deepEqual([monday[id].level, monday[id].F, monday[id].ready_in_h, monday[id].contributing.length], [0, 0, 0, 0], id);
    }
    // Wednesday 17:30, before Legs finished at 18:00: the same as if Legs had never happened
    const beforeLegs = recoveryMapAt(M, keyOf, F26_LOADS, at(65.5));
    const withoutLegs = recoveryMapAt(M, keyOf, loadWindow(F26_WORKOUTS.slice(0, 2), F26_PBS), at(65.5));
    assert.deepEqual(stripIds(beforeLegs), stripIds(withoutLegs));
    assert.ok(beforeLegs.hamstrings.level < map.hamstrings.level);
  });

  test('reads (at − lookback − 168 h, at]: older rows and rows after `at` change nothing', () => {
    const span = readSpanHours(M);
    assert.equal(span, 144 + 168);
    const old = { muscle_id: 'hamstrings', load: 50, recovery_hours: 10_000, finished_at: isoOfHours(WEDNESDAY_20 - span), workout_id: 'old' };
    const later = { ...old, finished_at: isoOfHours(WEDNESDAY_20 + 0.25), workout_id: 'later' };
    const padded = { ...F26_LOADS, muscles: [...F26_LOADS.muscles, old, later] };
    assert.deepEqual(recoveryMapAt(M, keyOf, padded, WEDNESDAY_20), map);
  });
});

/** Workout ids differ between two scorings of the same workouts. */
function stripIds(map: RecoveryMap) {
  return Object.fromEntries(MUSCLE_IDS.map((id) => [id, { ...map[id], contributing: map[id].contributing.map(({ workout_id: _, ...x }) => x) }]));
}

describe('recovery_history(user, from, to, step)', () => {
  test('seven days at 24 h is seven samples, ending exactly at `to`', () => {
    const samples = recoveryHistory(M, keyOf, F26_LOADS, WEDNESDAY_20 - 168, WEDNESDAY_20);
    assert.equal(samples.length, 7);
    assert.deepEqual(samples.map((s) => s.at), [144, 120, 96, 72, 48, 24, 0].map((d) => iso(68 - d)));
    assert.deepEqual(samples[6].map, recoveryMapAt(M, keyOf, F26_LOADS, WEDNESDAY_20));
    assert.equal(samples[0].map.chest.level, 0);   // Wednesday a week earlier: nothing yet
  });

  test('sample times', () => {
    assert.equal(sampleTimes(0, 168, 12).length, 14);
    assert.deepEqual(sampleTimes(0, 50, 24), [2, 26, 50]);
    assert.deepEqual(sampleTimes(10, 10, 24), []);
    assert.throws(() => sampleTimes(0, 24, 0), /positive/);
    assert.throws(() => sampleTimes(0, 24 * 2000, 1), /more than/);
  });
});

describe('session_map(workout)', () => {
  test('F20 read back from its cache rows: levels, R, trainable and ready after, as the engine gives them', () => {
    const f = fixture('F20');
    const push = workoutRows('push', { start: -1, end: 0, exercises: f.inputs.exercises as [string, LiftSet[]][] });
    const [loads] = score([push], historyRows(f.inputs.history as never));
    const session = sessionMapFromLoads(M, loads.muscles);

    const expect = f.expect as { level: Record<MuscleId, number>; R: Record<MuscleId, number>;
      ready_in_h: Record<MuscleId, number>; trainable_in_h: Record<MuscleId, number> };
    for (const [id, want] of Object.entries(expect.level) as [MuscleId, number][]) assert.equal(session[id].level, want, id);
    for (const [id, want] of Object.entries(expect.R) as [MuscleId, number][]) near(session[id].R, want);
    for (const [id, want] of Object.entries(expect.ready_in_h) as [MuscleId, number][]) near(session[id].ready_after_h, want);
    for (const [id, want] of Object.entries(expect.trainable_in_h) as [MuscleId, number][]) near(session[id].trainable_after_h, want);
    assert.equal(session.chest.label, 'High');

    const history = toPbHistory(historyRows(f.inputs.history as never), (id) => keyOf.get(id));
    const scored = scoreWorkout(M, engineWorkout(push.workout, push.blocks, push.sets, keyOf), history, null);
    assert.deepEqual(session, sessionView(sessionMap(M, scored)));
  });

  test('a workout with no cache rows is all Ready', () => {
    const session = sessionMapFromLoads(M, []);
    for (const id of MUSCLE_IDS) assert.deepEqual([session[id].L, session[id].level, session[id].ready_after_h], [0, 0, 0], id);
  });
});
