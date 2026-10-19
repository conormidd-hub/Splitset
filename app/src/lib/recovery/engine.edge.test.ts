/// <reference types="node" />

// Engine behaviour the fixtures do not pin down: rounding in fmtHours, level boundaries, the
// weekly guard, thresholds flowing through, the §14 edge cases, and purity.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  buildLibrary, displayedLevel, effectiveWeight, fixedCost, fmtHours, levelFor, lookbackHours, muscleLoads,
  muscleState, pbBefore, recoveryHours, rirFromRpe, scoreExercise, scoreWorkout, scoreWorkouts,
} from './engine.ts';
import { MUSCLE_IDS } from './library.ts';
import { parseConstants, withOverride } from './thresholds.ts';
import type { ExerciseDef, LiftSet, Model, PbRecord, Workout } from './types.ts';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const LIBRARY = (read('../../../../data/exercise_library.json') as { exercises: ExerciseDef[] }).exercises;
const C = parseConstants(read('../../../../data/recovery_constants.json'));
const FIXTURES = (read('../../../../data/load_model_fixtures.json') as {
  fixtures: { id: string; inputs: { exercises: [string, LiftSet[]][]; history: PbRecord[] } }[];
}).fixtures;
const m: Model = { c: C, lib: buildLibrary(LIBRARY) };
const near = (got: number | null | undefined, want: number, tol = 0.01) =>
  assert.ok(got != null && Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

/** The F20 push day and its PB history. */
const F20 = FIXTURES.find((f) => f.id === 'F20')!.inputs;
const pushDay = (end: number): Workout => ({ start: end - 1, end, exercises: F20.exercises });

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

describe('fmtHours', () => {
  test('matches the reference, including Python rounding exact halves to even', () => {
    // from scripts/load_model.py fmt_hours, except that up to half an hour reads "< 1 h" (below)
    const cases: [number | null, string][] = [
      [null, '—'], [-3, 'now'], [0, 'now'], [0.75, '1 h'], [1.5, '2 h'], [2.5, '2 h'], [6, '6 h'],
      [12.5, '12 h'], [13.5, '14 h'], [23.4, '23 h'], [23.5, '24 h'], [23.6, '24 h'], [24, '1.0 days'],
      [30, '1.2 days'], [36, '1.5 days'], [53.7, '2.2 days'], [54, '2.2 days'], [60, '2.5 days'], [66, '2.8 days'],
      [102, '4.2 days'], [1000, '41.7 days'],
    ];
    for (const [h, want] of cases) assert.equal(fmtHours(h), want, `fmtHours(${h})`);
  });

  test('a time above zero never reads "0 h": up to half an hour is "< 1 h"', () => {
    for (const h of [0.01, 0.25, 0.3, 0.5]) assert.equal(fmtHours(h), '< 1 h', `fmtHours(${h})`);
    assert.equal(fmtHours(0.51), '1 h');
  });
});

describe('e1RM inputs', () => {
  test('RIR from RPE is clamped to 0..5, and RPE 0 still counts as an RPE', () => {
    assert.equal(rirFromRpe(null), null);
    assert.equal(rirFromRpe(undefined), null);
    assert.equal(rirFromRpe(8), 2);
    assert.equal(rirFromRpe(10), 0);
    assert.equal(rirFromRpe(4), 5);
    assert.equal(rirFromRpe(0), 5);
  });

  test('a fixed set costs base without RPE and is clamped with it', () => {
    assert.equal(fixedCost(m, null), 0.3);
    near(fixedCost(m, 6), 0.2);
    near(fixedCost(m, 2), 0.1);
    near(fixedCost(m, 12), 0.4);
  });

  test('a zero bodyweight snapshot falls back to the current bodyweight', () => {
    const pullUp = m.lib.get('pull_up')!;
    assert.equal(effectiveWeight({ w: 10, r: 5, bodyweight: 0 }, pullUp, 80), 90);
    assert.equal(effectiveWeight({ w: 10, r: 5, bodyweight: 78 }, pullUp, 80), 88);
    assert.equal(effectiveWeight({ r: 5 }, pullUp, 80), 80);
  });
});

describe('levels', () => {
  test('lower bounds are inclusive', () => {
    const at = (F: number) => levelFor(m, F);
    assert.deepEqual([0, 0.2499, 0.25, 0.7499, 0.75, 1.5, 2.4999, 2.5, 3.99, 4, 50].map(at), [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5]);
  });

  test('the weekly guard lifts the level to 4 at the cap, never lowers it', () => {
    assert.equal(displayedLevel(m, 1.0, 7.99), 2);
    assert.equal(displayedLevel(m, 1.0, 8.0), 4);
    assert.equal(displayedLevel(m, 0, 8.0), 4);
    assert.equal(displayedLevel(m, 4.5, 9), 5);
  });

  test('no workouts: Ready now, with the neutral fills', () => {
    const st = muscleState(m, [], 100);
    assert.deepEqual(
      [st.F, st.W, st.level, st.label, st.ready_in_h, st.trainable_in_h, st.fill, st.fill_dark],
      [0, 0, 0, 'Ready', 0, 0, C.ready_fill, C.ready_fill_dark],
    );
  });
});

describe('thresholds flow through', () => {
  test('the lookback window follows the base hours, so raising them never cuts a term short', () => {
    assert.equal(lookbackHours(m), 144);
    const slow: Model = { ...m, c: withOverride(C, 'base_recovery_hours.default', 96) };
    assert.equal(lookbackHours(slow), 192);
  });

  test('base hours 72 stretch the push day chest window from 59.7 h to 89.6 h (build phase 9)', () => {
    const slow: Model = { ...m, c: withOverride(C, 'base_recovery_hours.default', 72) };
    const chest = scoreWorkout(m, pushDay(0), F20.history).L_m.chest;
    near(recoveryHours(m, chest, 'chest'), 59.71);
    near(recoveryHours(slow, chest, 'chest'), 89.57);
    near(recoveryHours(slow, chest, 'lower_back'), recoveryHours(m, chest, 'lower_back'));
  });
});

describe('§14 edge cases', () => {
  test('a set with no effective weight above zero, or no reps, is skipped', () => {
    const assisted = scoreExercise(m, 'assisted_pull_up', [{ w: 90, r: 8 }, { w: 80, r: 8 }], 0, [], 80);
    assert.deepEqual([assisted.L_e, assisted.sets, assisted.records], [0, [], []]);
    const bench = scoreExercise(m, 'bench_press_bb', [{ w: 0, r: 8 }, { w: 60 }, { w: 60, r: 8 }], 0, [], 80);
    assert.equal(bench.sets.length, 1);
    assert.equal(bench.records.length, 1);
  });

  test('a set with negative or non-finite reps is skipped, so it cannot cancel a real set or set a PB', () => {
    const pb: PbRecord[] = [{ slug: 'bench_press_bb', at: -1, e1rm: 120, source: 'logged' }];
    const alone = scoreExercise(m, 'bench_press_bb', [{ w: 90, r: 8 }], 0, pb, 80);
    const typo = scoreExercise(m, 'bench_press_bb', [{ w: 90, r: 8 }, { w: 90, r: -8 }, { w: 140, r: -5 }, { w: 90, r: Number.NaN }], 0, pb, 80);
    near(alone.L_e, 0.32);
    assert.equal(typo.L_e, alone.L_e);
    assert.equal(typo.sets.length, 1);
    assert.deepEqual(typo.records.map((r) => r.e1rm), alone.records.map((r) => r.e1rm));
    assert.equal(typo.best, alone.best);
    // zero reps (a missed attempt) still counts, as notes 17.7 settle
    assert.equal(scoreExercise(m, 'bench_press_bb', [{ w: 90, r: 0 }], 0, pb, 80).records.length, 1);
  });

  test('an exercise missing from the library contributes nothing and does not throw', () => {
    const sc = scoreWorkout(m, { start: -1, end: 0, exercises: [['no_such_lift', [{ w: 50, r: 10 }]]] }, []);
    assert.deepEqual([sc.L_e, sc.records], [{}, []]);
    assert.ok(MUSCLE_IDS.every((id) => sc.L_m[id] === 0));
    assert.ok(MUSCLE_IDS.every((id) => muscleLoads(m, { no_such_lift: 2 })[id] === 0));
    assert.throws(() => scoreExercise(m, 'no_such_lift', [], 0, [], 80), /not in the library/);
  });

  test('a PB-estimate link to an exercise missing from the library ends in calibration', () => {
    const lib = buildLibrary([...LIBRARY, {
      slug: 'custom_orphan', load_mode: 'weight', fatigue: 'standard', primary: ['biceps'], secondary: [], tertiary: [],
      pb_estimate: { from: 'custom_deleted', ratio: 1 },
    }]);
    assert.deepEqual(pbBefore({ ...m, lib }, 'custom_orphan', 0, []), { pb: null, source: 'calibration', detail: null });
  });
});

describe('purity', () => {
  test('scoring never changes its inputs', () => {
    const history = deepFreeze(structuredClone(F20.history));
    const workouts = deepFreeze([pushDay(0), pushDay(24)]);
    const before = JSON.stringify([history, workouts]);
    scoreWorkouts(m, workouts, history);
    scoreWorkout(m, workouts[0], history);
    assert.equal(JSON.stringify([history, workouts]), before);
  });

  test('scoreWorkouts carries each workout\'s PB records into the next, as the reference does', () => {
    const { scored, history } = scoreWorkouts(m, [pushDay(0), pushDay(48)], F20.history);
    const added = scored[0].records.length + scored[1].records.length;
    assert.equal(history.length, F20.history.length + added);
    assert.ok(scored[0].records.every((r) => r.at === 0));
    // the lateral raise (stored PB 13) reached e1RM 15 in the first workout, so the second starts from it
    near(scored[0].detail.lateral_raise_db.pb_before, 13);
    near(scored[1].detail.lateral_raise_db.pb_before, 15);
  });
});
