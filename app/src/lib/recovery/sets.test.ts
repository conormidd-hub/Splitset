/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { buildLibrary, scoreExercise } from './engine.ts';
import { currentBodyweight, engineKey, exerciseDef, setE1rm, type ExerciseRow } from './sets.ts';
import { parseConstants, withOverride } from './thresholds.ts';
import type { ExerciseDef } from './types.ts';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const LIBRARY = (read('../../../../data/exercise_library.json') as { exercises: (ExerciseDef & { name: string })[] }).exercises;
const C = parseConstants(read('../../../../data/recovery_constants.json'));
const near = (got: number | null, want: number) => assert.ok(got != null && Math.abs(got - want) <= 0.01, `got ${got}, want ${want}`);

/** An exercises row for a library slug, as the database holds it after seeding. */
function row(slug: string, id = `id-${slug}`): ExerciseRow {
  const e = LIBRARY.find((x) => x.slug === slug)!;
  return {
    id, slug, measure: e.load_mode === 'fixed' ? 'duration' : 'weight_reps', load_mode: e.load_mode, bw_factor: e.bw_factor ?? null,
    fatigue: e.fatigue, pb_estimate_from: e.pb_estimate?.from ?? null, pb_estimate_ratio: e.pb_estimate?.ratio ?? null,
    is_unilateral: !!e.unilateral,
  };
}
const bench = exerciseDef(row('bench_press_bb'));
const set = (weightKg: number | null, reps: number | null, rpe: number | null = null) => ({ weightKg, reps, rpe });

describe('setE1rm: the e1RM a set stores', () => {
  test('F02: 115 × 3 stores 126.5 and 125 × 1 stores 125.0', () => {
    near(setE1rm(C, bench, set(115, 3), null), 126.5);
    near(setE1rm(C, bench, set(125, 1), null), 125.0);
  });

  test('F04: RPE 8 adds two reps in reserve, 100 × 5 → 123.33', () => {
    near(setE1rm(C, bench, set(100, 5, 8), null), 123.33);
  });

  test('F03: reps are capped at 20, 60 × 20 → 100', () => {
    near(setE1rm(C, bench, set(60, 25), null), 100);
  });

  test('F31: a pull-up uses the workout snapshot (78) over the current bodyweight (82)', () => {
    const pullUp = exerciseDef(row('pull_up'));
    near(setE1rm(C, pullUp, set(10, 5), 78, 82), 88 * (1 + 5 / 30));
    near(setE1rm(C, pullUp, set(10, 5), null, 82), 92 * (1 + 5 / 30));
    near(setE1rm(C, pullUp, set(null, 5), null), C.bodyweight_default_kg * (1 + 5 / 30));
  });

  test('assisted: assistance at or above bodyweight gives no e1RM', () => {
    const assisted = exerciseDef(row('assisted_pull_up'));
    near(setE1rm(C, assisted, set(30, 8), 80), 50 * (1 + 8 / 30));
    assert.equal(setE1rm(C, assisted, set(80, 8), 80), null);
  });

  test('no e1RM without reps, without weight in weight mode, or for fixed-cost sets', () => {
    assert.equal(setE1rm(C, bench, set(100, null), null), null);
    assert.equal(setE1rm(C, bench, set(null, 5), null), null);
    assert.equal(setE1rm(C, bench, set(0, 5), null), null);
    assert.equal(setE1rm(C, exerciseDef(row('plank')), set(null, null), null), null);
    assert.equal(setE1rm(C, null, set(100, 5), null), null);
  });

  test('a user override of the e1RM constants flows through', () => {
    near(setE1rm(withOverride(C, 'e1rm.max_reps', 10), bench, set(60, 20), null), 60 * (1 + 10 / 30));
  });

  test('is exactly the e1RM the engine records for the same sets', () => {
    const lib = buildLibrary(LIBRARY);
    const sets = [{ w: 60, r: 12, warmup: true }, { w: 100, r: 5, rpe: 8 }, { w: 110, r: 3 }, { w: 90, r: 8, rpe: 9.5 }];
    const scored = scoreExercise({ c: C, lib }, 'bench_press_bb', sets, 0, [], 80);
    sets.forEach((s, n) => assert.equal(setE1rm(C, bench, set(s.w, s.r, s.rpe ?? null), null), scored.records[n].e1rm));
  });
});

describe('exerciseDef: rows to library entries', () => {
  test('a library row keeps its mode, factor, fatigue, estimate link and muscles by role', () => {
    const def = exerciseDef(row('incline_bench_db'), [
      { exercise_id: 'id-incline_bench_db', muscle_id: 'chest', role: 'primary' },
      { exercise_id: 'id-incline_bench_db', muscle_id: 'front_delts', role: 'secondary' },
      { exercise_id: 'id-other', muscle_id: 'quads', role: 'primary' },
    ]);
    assert.deepEqual(def, {
      slug: 'incline_bench_db', load_mode: 'weight', bw_factor: null, fatigue: 'standard',
      primary: ['chest'], secondary: ['front_delts'], tertiary: [], pb_estimate: { from: 'bench_press_bb', ratio: 0.32 }, unilateral: false,
    });
  });

  test('outside the library: weight × reps is plain weight mode keyed by id; anything else has none', () => {
    const custom: ExerciseRow = {
      id: 'c1', slug: null, measure: 'weight_reps', load_mode: null, bw_factor: null, fatigue: null,
      pb_estimate_from: null, pb_estimate_ratio: null, is_unilateral: false,
    };
    assert.equal(engineKey(custom), 'c1');
    assert.deepEqual(exerciseDef(custom), {
      slug: 'c1', load_mode: 'weight', bw_factor: null, fatigue: 'standard', primary: [], secondary: [], tertiary: [],
      pb_estimate: null, unilateral: false,
    });
    assert.equal(exerciseDef({ ...custom, measure: 'duration' }), null);
    assert.equal(exerciseDef({ ...custom, measure: 'distance_duration' }), null);
  });
});

describe('currentBodyweight', () => {
  const profile = (kg: number | null, at: string | null) => ({ bodyweight_kg: kg, bodyweight_updated_at: at });
  test('the newer of the profile entry and the latest weigh-in wins', () => {
    assert.deepEqual(currentBodyweight(C, profile(80, '2026-10-10T08:00:00Z'), { weight_kg: 82, date: '2026-10-12' }),
      { kg: 82, source: 'weigh-in', date: '2026-10-12' });
    assert.deepEqual(currentBodyweight(C, profile(80, '2026-10-13T08:00:00Z'), { weight_kg: 82, date: '2026-10-12' }),
      { kg: 80, source: 'profile', date: '2026-10-13T08:00:00Z' });
  });
  test('a profile entry made on the day of a weigh-in wins', () => {
    assert.equal(currentBodyweight(C, profile(80, '2026-10-12T06:00:00Z'), { weight_kg: 82, date: '2026-10-12' }).source, 'profile');
  });
  test('either alone, else the default from the constants', () => {
    assert.equal(currentBodyweight(C, profile(80, '2026-10-13T08:00:00Z'), null).kg, 80);
    assert.equal(currentBodyweight(C, profile(null, null), { weight_kg: 82, date: '2025-10-18' }).kg, 82);
    assert.deepEqual(currentBodyweight(C, null, null), { kg: C.bodyweight_default_kg, source: 'default', date: null });
    assert.equal(currentBodyweight(C, null, { weight_kg: null, date: '2025-10-18' }).source, 'default');
  });
});
