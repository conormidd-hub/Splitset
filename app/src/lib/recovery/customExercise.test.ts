/// <reference types="node" />

// Build phase 8's custom exercises, as the plan lists the tests: "Incline Smith press" from
// incline_bench_bb copies its tiers and estimates its PB through it; a custom curl based on
// db_curl reaches bench in four hops (F30); "pull down lat" surfaces lat_pulldown; no primary is
// rejected and the caps hold; a manual PB of 80 is the first set's reference and a later logged
// 95 takes over (spec §3.6). Every PB comes from the existing engine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  customSlug, cycleRole, draftOf, emptyDraft, fromSimilar, matchExercises, rolesList, setRole, similarSuggestions, stepFactor,
  toPayload, validateDraft, withEquipment, type Draft, type SourceRow,
} from './customExercise.ts';
import { pbBefore, scoreWorkout } from './engine.ts';
import type { ExerciseMuscleRow, ExerciseRow } from './sets.ts';
import { C, EXERCISES, fixture, LIBRARY, MUSCLES, near } from './testRows.ts';
import type { Model, PbRecord } from './types.ts';
import { libraryFromRows } from './workoutLoads.ts';

const SOURCES: SourceRow[] = EXERCISES.map((e) => {
  const lib = LIBRARY.find((l) => `id-${l.slug}` === e.id)!;
  return { ...e, name: lib.name, equipment: (lib as unknown as { equipment: string }).equipment };
});
const source = (slug: string) => SOURCES.find((s) => s.slug === slug)!;
const roles = (slug: string) => MUSCLES.filter((m) => m.exercise_id === `id-${slug}`);
const TODAY = '2026-10-18';

/** The engine's model with one more exercise saved from a draft, as the database would hold it. */
function withCustom(d: Draft, id = 'id-custom'): { m: Model; slug: string } {
  const slug = customSlug('0b1c2d3e-0000-4000-a000-000000000001');
  const p = toPayload(C, d, { slug, today: TODAY, bodyweightKg: null });
  const row: ExerciseRow = { id, ...p.exercise };
  const muscles: ExerciseMuscleRow[] = p.muscles.map((m) => ({ exercise_id: id, ...m }));
  const { lib } = libraryFromRows([...EXERCISES, row], [...MUSCLES, ...muscles]);
  return { m: { c: C, lib }, slug };
}
const benchHistory: PbRecord[] = [{ slug: 'bench_press_bb', e1rm: 120, at: -168, source: 'logged' }];

describe('starting from a similar exercise', () => {
  test('"Incline Smith press" from incline_bench_bb copies its tiers and resolves an estimated PB through it', () => {
    const d = fromSimilar(emptyDraft('Incline Smith press'), source('incline_bench_bb'), roles('incline_bench_bb'));
    assert.deepEqual(d.roles, { chest: 'primary', front_delts: 'secondary', triceps: 'secondary' });
    assert.deepEqual([d.loadMode, d.fatigue, d.equipment, d.similar], ['weight', 'standard', 'barbell', 'incline_bench_bb']);
    const { m, slug } = withCustom(d);
    const ref = pbBefore(m, slug, 0, benchHistory);
    // bench 120 × incline 0.80 × this one 1.0, then the estimate's 0.90 (spec §3.4)
    near(ref.pb!, 120 * 0.8 * 1.0 * 0.9);
    assert.deepEqual([ref.source, ref.detail], ['estimated', 'bench_press_bb']);
  });

  test('F30: a custom curl based on db_curl resolves through four hops to bench', () => {
    const f30 = fixture('F30');
    const d = fromSimilar(emptyDraft('Drag curl'), source('db_curl'), roles('db_curl'));
    const { m, slug } = withCustom(d);
    const ref = pbBefore(m, slug, 0, benchHistory);
    const want = f30.expect as { pb: number; source: string; via: string };
    near(ref.pb!, want.pb);
    assert.deepEqual([ref.source, ref.detail], [want.source, want.via]);
  });

  test('less / about the same / more set the ratio', () => {
    const base = fromSimilar(emptyDraft('Smith row'), source('barbell_row'), roles('barbell_row'));
    for (const [ratio, want] of [['less', 0.6], ['same', 1.0], ['more', 1.3]] as const) {
      assert.equal(toPayload(C, { ...base, ratio }, { slug: 'custom_x', today: TODAY, bodyweightKg: null }).exercise.pb_estimate_ratio, want);
    }
  });

  test('the name pre-suggests exercises from its keyword\'s family', () => {
    const named = SOURCES.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
    const press = similarSuggestions('Incline Smith press', named);
    assert.ok(press.length === 3 && press.every((e) => /press/i.test(e.name)));
    assert.ok(similarSuggestions('Spider curls', named).every((e) => /curl/i.test(e.name)));
    assert.ok(similarSuggestions('Trap bar RDL', named).every((e) => /deadlift|rdl/i.test(`${e.name} ${e.slug}`)));
  });
});

describe('did you mean', () => {
  const named = SOURCES.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
  test('"pull down lat" surfaces lat_pulldown', () => {
    assert.equal(matchExercises('pull down lat', named)[0].slug, 'lat_pulldown');
  });
  test('other spellings', () => {
    assert.equal(matchExercises('bench press barbell', named)[0].slug, 'bench_press_bb');
    assert.equal(matchExercises('skull crusher', named)[0].slug, 'skullcrusher');
    assert.deepEqual(matchExercises('zz', named), []);
    assert.deepEqual(matchExercises('underwater basket weaving', named), []);
  });
});

describe('muscles', () => {
  test('a tap cycles none → primary → secondary → tertiary → none', () => {
    let r = {};
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      r = cycleRole(C, r, 'chest');
      seen.push((r as Record<string, string>).chest);
    }
    assert.deepEqual(seen, ['primary', 'secondary', 'tertiary', undefined]);
  });

  test('the caps are enforced: a third primary is skipped, and a capped chip is refused', () => {
    let r = cycleRole(C, cycleRole(C, {}, 'chest'), 'triceps');   // two primaries
    r = cycleRole(C, r, 'front_delts');
    assert.equal(r.front_delts, 'secondary');
    assert.deepEqual(setRole(C, r, 'abs', 'primary'), r);
    assert.equal(setRole(C, r, 'abs', 'tertiary').abs, 'tertiary');
  });

  test('a create with no primary is rejected; over the caps too', () => {
    const d: Draft = { ...emptyDraft('Mystery move'), roles: { chest: 'secondary' } };
    assert.match(validateDraft(C, d).join(' '), /primary/);
    const over: Draft = { ...emptyDraft('Too much'), roles: { chest: 'primary', triceps: 'primary', lats: 'primary' } };
    assert.match(validateDraft(C, over).join(' '), /At most 2 primary/);
    assert.deepEqual(validateDraft(C, { ...emptyDraft('Press'), roles: { chest: 'primary' } }), []);
  });
});

describe('equipment, saving and editing', () => {
  test('equipment sets the load mode, logging and default fatigue; bodyweight needs a factor', () => {
    const band = withEquipment(emptyDraft('Band row'), 'band');
    assert.deepEqual([band.loadMode, band.logAs, band.fatigue], ['fixed', 'reps', 'low']);
    const timed = withEquipment(emptyDraft('Hold'), 'timed');
    assert.deepEqual([timed.loadMode, timed.logAs], ['fixed', 'seconds']);
    const bw = withEquipment(emptyDraft('Ring push-up'), 'bodyweight');
    assert.equal(bw.loadMode, 'bodyweight');
    assert.equal(bw.bwFactor, 0.65);
    assert.equal(stepFactor(1.0, 2), 1.0);
    assert.equal(stepFactor(0.3, -3), 0.2);
    assert.equal(stepFactor(0.65, 1), 0.7);
    assert.match(validateDraft(C, { ...bw, roles: { chest: 'primary' }, bwFactor: 1.5 }).join(' '), /bodyweight/);
    // a similar exercise's fatigue class stays when the equipment changes
    const sim = fromSimilar(emptyDraft('x'), source('squat_bb'), roles('squat_bb'));
    assert.equal(withEquipment(sim, 'machine').fatigue, 'high');
  });

  test('the payload: custom slug, group and legacy group from the first primary, load split, known best', () => {
    const d: Draft = { ...withEquipment(emptyDraft('Floor fly'), 'dumbbell'), roles: { chest: 'primary', front_delts: 'tertiary' }, best: { weightKg: 100, reps: 5 } };
    const p = toPayload(C, d, { slug: customSlug('ab-cd'), today: TODAY, bodyweightKg: null });
    assert.equal(p.exercise.slug, 'custom_abcd');
    assert.deepEqual([p.exercise.group, p.exercise.muscle_group, p.exercise.measure, p.exercise.is_bodyweight], ['Chest', 'chest', 'weight_reps', false]);
    assert.deepEqual(p.exercise.load_split, { chest: 83, front_delts: 17 });
    near(p.best!.e1rm, 100 * (1 + 5 / 30));
    assert.equal(p.best!.dated_at, TODAY);
    assert.deepEqual(rolesList(d.roles), p.muscles);
  });

  test('a saved exercise reads back into the same draft for Edit', () => {
    const d = fromSimilar(emptyDraft('Incline Smith press'), source('incline_bench_bb'), roles('incline_bench_bb'));
    const p = toPayload(C, { ...d, ratio: 'more' }, { slug: 'custom_1', today: TODAY, bodyweightKg: null });
    const back = draftOf({ id: 'x', ...p.exercise, name: p.exercise.name }, p.muscles);
    assert.deepEqual({ ...back, best: null }, { ...d, ratio: 'more', best: null });
  });
});

describe('a manual PB on a custom exercise (spec §3.6)', () => {
  test('a manual 80 is the first set\'s reference; a later logged 95 takes over', () => {
    const d: Draft = { ...withEquipment(emptyDraft('Cable press'), 'cable'), roles: { chest: 'primary' } };
    const { m, slug } = withCustom(d);
    const manual: PbRecord[] = [{ slug, e1rm: 80, at: 0, source: 'manual' }];
    const day1 = scoreWorkout(m, { start: 24, end: 25, exercises: [[slug, [{ w: 60, r: 8 }]]] }, manual);
    assert.deepEqual([day1.detail[slug].pb_before, day1.detail[slug].pb_source, day1.detail[slug].pb_via], [80, 'monthly', 'manual']);
    const logged: PbRecord[] = [...manual, { slug, e1rm: 95, at: 25, source: 'logged' }];
    const day2 = scoreWorkout(m, { start: 48, end: 49, exercises: [[slug, [{ w: 60, r: 8 }]]] }, logged);
    assert.deepEqual([day2.detail[slug].pb_before, day2.detail[slug].pb_via], [95, 'logged']);
  });
});
