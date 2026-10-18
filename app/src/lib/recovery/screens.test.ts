/// <reference types="node" />

// Build phase 7's screen helpers: the next-ready strip and Train next on the F26 week at
// Wednesday 20:00, the workout summary's rows for the F20 push day, an exercise's role figure and
// load split, and the generated library order.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { muscleFallbackName } from './figure.ts';
import { MUSCLE_IDS } from './library.ts';
import { LIBRARY_ORDER, MUSCLE_GROUPS } from './libraryOrder.ts';
import { recoveryMapAt, sessionMapFromLoads } from './read.ts';
import {
  loadSplit, mixHex, mostTired, nextReady, NEXT_READY_HOURS, roleFigure, roleTints, sessionRows, trainNext, type TrainExercise,
} from './screens.ts';
import { C, EXERCISES, fixture, LIBRARY, loadWindow, MUSCLES, T0, type FixtureWorkout } from './testRows.ts';
import { libraryFromRows } from './workoutLoads.ts';

const { lib, keyOf } = libraryFromRows(EXERCISES, MUSCLES);
const H0 = T0 / 3_600_000;
const f26 = fixture('F26');
const F26_MAP = recoveryMapAt({ c: C, lib }, keyOf, loadWindow(f26.inputs.workouts as FixtureWorkout[], f26.inputs.history as never), H0 + 68);
const roles = (slug: string) => MUSCLES.filter((m) => m.exercise_id === `id-${slug}`);
const TRAIN: TrainExercise[] = LIBRARY.map((e) => ({
  id: `id-${e.slug}`, name: e.name, slug: e.slug, primary: e.primary, split: (e as unknown as { load_split: Record<string, number> }).load_split,
}));

describe('the generated library order', () => {
  test('matches data/exercise_library.json', () => {
    assert.deepEqual(LIBRARY_ORDER, LIBRARY.map((e) => e.slug), 'run npm run gen:library-order');
    assert.deepEqual(Object.keys(MUSCLE_GROUPS).sort(), [...MUSCLE_IDS].sort());
    assert.equal(MUSCLE_GROUPS.hamstrings, 'Legs');
  });
});

describe('the Recovery screen', () => {
  test('next ready: muscles becoming trainable in the next 24 h, soonest first (F26 at Wednesday 20:00)', () => {
    const strip = nextReady(C, F26_MAP);
    assert.deepEqual(strip.map((r) => r.muscle), ['traps', 'biceps', 'glutes', 'quads']);
    assert.ok(strip.every((r) => r.in_h > 0 && r.in_h <= NEXT_READY_HOURS));
    // hamstrings need a little over a day, so they are not in the strip
    assert.ok(F26_MAP.hamstrings.trainable_in_h! > NEXT_READY_HOURS);
  });

  test('the most tired muscles', () => {
    assert.deepEqual(mostTired(F26_MAP, 2), ['hamstrings', 'quads']);
  });

  test('train next: Ready muscles by body region, three primary exercises each by load split, then library order', () => {
    const next = trainNext(F26_MAP, TRAIN);
    assert.deepEqual(next.map((t) => t.muscle), ['front_delts', 'side_delts', 'forearms', 'abs', 'obliques']);
    const slugs = (m: string) => next.find((t) => t.muscle === m)!.exercises.map((e) => e.slug);
    assert.deepEqual(slugs('side_delts'), ['lateral_raise_cable', 'lateral_raise_machine', 'lateral_raise_db']);
    assert.deepEqual(slugs('front_delts'), ['front_raise_db', 'front_raise_cable', 'arnold_press']);
    assert.ok(next.every((t) => t.exercises.length === 3 && t.exercises.every((e) => e.primary.includes(t.muscle))));
  });

  test('exercises outside the library are never suggested', () => {
    const custom: TrainExercise = { id: 'mine', name: 'My raise', slug: null, primary: ['side_delts'], split: { side_delts: 100 } };
    assert.ok(!trainNext(F26_MAP, [custom, ...TRAIN]).some((t) => t.exercises.some((e) => e.id === 'mine')));
  });
});

describe('the workout summary', () => {
  test('F20: a row per loaded muscle, heaviest first, in the plan\'s words', () => {
    const f20 = fixture('F20');
    const rows = loadWindow([{ start: -1, end: 0, exercises: f20.inputs.exercises as FixtureWorkout['exercises'] }], f20.inputs.history as never);
    const session = sessionMapFromLoads({ c: C, lib }, rows.muscles);
    const out = sessionRows(session, muscleFallbackName);
    assert.deepEqual(out.map((r) => r.muscle), ['triceps', 'chest', 'front_delts', 'side_delts', 'traps']);
    assert.equal(out[1].text, 'Chest · load 2.48 · High · trainable in 24 h · ready in 2.2 days');
    assert.equal(out[0].text, 'Triceps · load 3.58 · Very high · trainable in 1.8 days · ready in 2.9 days');
    assert.equal(out[4].text, 'Traps · load 0.46 · Low · trainable now · ready in 14 h');   // 30.65 × (1 − 0.25 / 0.462)
  });
});

describe('an exercise\'s muscles', () => {
  test('roles take three tints of one colour; other muscles stay the ready colour', () => {
    const tints = roleTints('#4b33b3', C.ready_fill);
    assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
    const map = roleFigure(roles('push_up'), tints, C.ready_fill);
    assert.equal(map.chest.fill, tints.primary);
    assert.equal(map.triceps.fill, tints.secondary);
    assert.equal(map.abs.fill, tints.tertiary);
    assert.equal(map.lats.fill, C.ready_fill);
    assert.ok(new Set(Object.values(tints)).size === 3);
  });

  test('load split: the stored one, else spec §6 from the roles, summing to 100', () => {
    const bench = LIBRARY.find((e) => e.slug === 'bench_press_bb') as unknown as { load_split: Record<string, number> };
    assert.deepEqual(loadSplit(C, bench.load_split, roles('bench_press_bb')), [
      { muscle: 'chest', pct: 56 }, { muscle: 'triceps', pct: 22 }, { muscle: 'front_delts', pct: 22 }]);
    assert.deepEqual(loadSplit(C, null, roles('bench_press_bb')).map((p) => p.pct).sort(), [22, 22, 56]);
    // every library exercise: the formula gives exactly the stored split
    for (const e of LIBRARY as unknown as { slug: string; load_split: Record<string, number> }[]) {
      const got = Object.fromEntries(loadSplit(C, null, roles(e.slug)).map((p) => [p.muscle, p.pct]));
      assert.deepEqual(got, e.load_split, e.slug);
      assert.equal(Object.values(got).reduce((s, x) => s + x, 0), 100, e.slug);
    }
    assert.deepEqual(loadSplit(C, null, []), []);
  });
});
