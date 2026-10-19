/// <reference types="node" />

// Build phase 8's custom exercises, as the plan lists the tests: "Incline Smith press" from
// incline_bench_bb copies its tiers and estimates its PB through it; a custom curl based on
// db_curl reaches bench in four hops (F30); "pull down lat" surfaces lat_pulldown; no primary is
// rejected and the caps hold; a manual PB of 80 is the first set's reference and a later logged
// 95 takes over (spec §3.6). Every PB comes from the existing engine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  contrastRatio, customSlug, cycleRole, draftOf, editChoices, emptyDraft, EQUIPMENT, fromSimilar, legacyBodyweight, matchExercises, readableTone, rolesList,
  setRole, similarSuggestions, stepFactor, toPayload, validateDraft, withEquipment, type Draft, type EquipmentChoice, type SavedRow,
  type SourceRow,
} from './customExercise.ts';
import { pbBefore, scoreWorkout } from './engine.ts';
import { roleTints } from './screens.ts';
import { exerciseDef, setE1rm, type ExerciseMuscleRow, type ExerciseRow } from './sets.ts';
import { C, EXERCISES, fixture, LIBRARY, MUSCLES, near } from './testRows.ts';
import type { Model, PbRecord } from './types.ts';
import { libraryFromRows } from './workoutLoads.ts';
import { palettes } from '../../theme/tokens.ts';

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

  test('a copy of Farmer\'s walk, stored as weight × time, is logged in seconds', () => {
    const d = fromSimilar(emptyDraft('Overhead carry'), { ...source('farmers_walk'), measure: 'weight_duration' }, roles('farmers_walk'));
    assert.deepEqual([d.loadMode, d.logAs, d.choice, d.equipment], ['fixed', 'seconds', 'timed', 'dumbbell']);
    const p = toPayload(C, d, { slug: 'custom_x', today: TODAY, bodyweightKg: null });
    assert.deepEqual([p.exercise.measure, p.exercise.is_bodyweight], ['duration', false]);
  });

  test('a known best: none for a fixed cost, a weight in weight mode, at most 100 reps', () => {
    // typed, then a fixed-cost chip hides the card: the hidden best can't block Save
    const typed: Draft = { ...emptyDraft('Band pull apart wide'), roles: { rear_delts: 'primary' }, best: { weightKg: 20, reps: 0 } };
    assert.match(validateDraft(C, typed).join(' '), /best/);
    assert.deepEqual(validateDraft(C, withEquipment(typed, 'band')), []);
    // 0 kg in weight mode would be dropped silently (no e1RM); bodyweight and assisted take 0
    const db: Draft = { ...withEquipment(emptyDraft('Floor press'), 'dumbbell'), roles: { chest: 'primary' } };
    assert.match(validateDraft(C, { ...db, best: { weightKg: 0, reps: 8 } }).join(' '), /needs a weight/);
    assert.deepEqual(validateDraft(C, { ...withEquipment(db, 'bodyweight'), best: { weightKg: 0, reps: 20 } }), []);
    assert.deepEqual(validateDraft(C, { ...withEquipment(db, 'assisted'), best: { weightKg: 0, reps: 5 } }), []);
    // manual_pbs' check
    assert.deepEqual(validateDraft(C, { ...db, best: { weightKg: 10, reps: 100 } }), []);
    assert.match(validateDraft(C, { ...db, best: { weightKg: 10, reps: 101 } }).join(' '), /at most 100 reps/);
  });

  test('a name the user already has is refused, whatever its case', () => {
    const d: Draft = { ...emptyDraft(' weighted push-up '), roles: { chest: 'primary' } };
    assert.match(validateDraft(C, d, ['Weighted Push-up']).join(' '), /already have an exercise called weighted push-up/);
    assert.deepEqual(validateDraft(C, d, ['Push-up']), []);
  });
});

/** An exercise saved from a draft, as the database row Edit reads. */
function saved(d: Draft, id = 'x'): SavedRow {
  return { id, ...toPayload(C, d, { slug: `custom_${id}`, today: TODAY, bodyweightKg: 80 }).exercise };
}

describe('editing keeps how sets are logged and weighed (notes 23.3 item 9)', () => {
  const made = (choice: EquipmentChoice) => saved({ ...withEquipment(emptyDraft(`My ${choice}`), choice), roles: { chest: 'primary' } });

  test('Edit offers only equipment with the same measure and load mode', () => {
    assert.deepEqual(editChoices(made('dumbbell')), ['barbell', 'dumbbell', 'machine', 'cable', 'smith']);
    assert.deepEqual(editChoices(made('bodyweight')), ['bodyweight']);
    assert.deepEqual(editChoices(made('assisted')), ['assisted']);
    assert.deepEqual(editChoices(made('band')), ['band']);
    assert.deepEqual(editChoices(made('timed')), ['timed']);
    // whichever is picked, the stored sets' e1RMs keep their meaning
    for (const k of Object.keys(EQUIPMENT) as EquipmentChoice[]) {
      const row = made(k);
      for (const e of editChoices(row)) {
        const p = toPayload(C, withEquipment(draftOf(row, [{ muscle_id: 'chest', role: 'primary' }]), e), { slug: 'custom_x', today: TODAY, bodyweightKg: 80 });
        assert.deepEqual([p.exercise.load_mode, p.exercise.measure], [row.load_mode, row.measure], `${k} → ${e}`);
      }
    }
  });

  test('a similar exercise picked while editing lends its muscles and fatigue, not how sets are logged', () => {
    // a band one given Face pull (cable, weight × reps) stays fixed and logged as reps
    const band = saved({ ...withEquipment(emptyDraft('Banded face pull'), 'band'), roles: { rear_delts: 'primary' } });
    const d = fromSimilar(draftOf(band, [{ muscle_id: 'rear_delts', role: 'primary' }]), source('face_pull'), roles('face_pull'), true);
    assert.deepEqual([d.loadMode, d.logAs, d.choice, d.equipment, d.similar], ['fixed', 'reps', 'band', 'band', 'face_pull']);
    assert.deepEqual(d.roles, { rear_delts: 'primary', traps: 'secondary', side_delts: 'tertiary' });
    const p = toPayload(C, d, { slug: 'custom_x', today: TODAY, bodyweightKg: 80 });
    assert.deepEqual([p.exercise.load_mode, p.exercise.measure], ['fixed', 'reps']);
    // a weight × reps one given Plank (fixed, timed) stays weight × reps
    const cable = saved({ ...withEquipment(emptyDraft('Cable crunch'), 'cable'), roles: { abs: 'primary' } });
    const c = fromSimilar(draftOf(cable, [{ muscle_id: 'abs', role: 'primary' }]), source('plank'), roles('plank'), true);
    assert.deepEqual([c.loadMode, c.logAs, c.choice, c.equipment], ['weight', 'reps', 'cable', 'cable']);
    // a bodyweight one keeps its factor when given Pull-up (1.0)
    const rows = saved({ ...withEquipment(emptyDraft('Ring row'), 'bodyweight'), roles: { lats: 'primary' } });
    assert.equal(fromSimilar(draftOf(rows, [{ muscle_id: 'lats', role: 'primary' }]), source('pull_up'), roles('pull_up'), true).bwFactor, 0.65);
    // creating, everything is copied as before
    const fresh = fromSimilar(emptyDraft('Hold'), source('plank'), roles('plank'));
    assert.deepEqual([fresh.loadMode, fresh.logAs, fresh.choice], ['fixed', 'seconds', 'timed']);
  });
});

describe('editing an exercise the old form made (no slug, no load mode)', () => {
  /** A row as the old ExerciseForm saved it: is_bodyweight from its equipment. */
  const legacy = (equipment: string | null, measure: string, name = 'Legacy move'): SavedRow => ({
    id: 'legacy', name, slug: null, equipment, measure, is_bodyweight: equipment === 'bodyweight', is_unilateral: false,
    load_mode: null, bw_factor: null, fatigue: null, pb_estimate_from: null, pb_estimate_ratio: null,
  });
  const WORDS = ['barbell', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'bodyweight', 'other', null];
  const MEASURES = ['weight_reps', 'reps', 'duration', 'weight_duration'];

  test('every shape keeps its bodyweight flag and saves a load mode its sets score in', () => {
    for (const scored of [false, true]) {
      for (const equipment of WORDS) {
        for (const measure of MEASURES) {
          const at = `${equipment} × ${measure}${scored ? ', with e1RMs stored' : ''}`;
          const row = legacy(equipment, measure);
          let d: Draft = { ...draftOf(row, [], scored), roles: { chest: 'primary' } };
          // weight × reps was always scored in weight mode, so it turns bodyweight only with nothing stored
          const bodyweight = equipment === 'bodyweight' && (measure === 'reps' || (measure === 'weight_reps' && !scored));
          const want = bodyweight ? 'bodyweight' : measure === 'weight_reps' ? 'weight' : 'fixed';
          assert.equal(d.loadMode, want, at);
          // the chip shown selected is one Edit offers (none logs weight × time)
          assert.ok(!d.choice || measure === 'weight_duration' || editChoices(row, scored).includes(d.choice), at);
          // and every chip Edit offers for one the engine scored saves the same load mode
          if (measure === 'weight_reps') for (const k of editChoices(row, scored)) assert.equal(withEquipment(d, k).loadMode, want, `${at} → ${k}`);
          if (bodyweight) {
            // its factor starts unset, so Save asks for one rather than guessing
            assert.match(validateDraft(C, d).join(' '), /bodyweight/, at);
            d = { ...d, bwFactor: 0.65 };
          }
          assert.deepEqual(validateDraft(C, d), [], at);
          const p = toPayload(C, d, { slug: 'custom_legacy', today: TODAY, bodyweightKg: 80 });
          assert.equal(p.exercise.load_mode, want, at);
          assert.equal(p.exercise.is_bodyweight, row.is_bodyweight, at);
          // update_custom_exercise keeps the stored measure
          const def = exerciseDef({ ...row, ...p.exercise, id: row.id, measure }, p.muscles.map((m) => ({ exercise_id: row.id, ...m })));
          assert.equal(def?.load_mode, want, at);
          if (bodyweight) near(setE1rm(C, def, { weightKg: 0, reps: 10, rpe: null }, 80)!, 80 * 0.65 * (1 + 10 / 30));
          // whatever weight × reps had stored is what a set saved now gets: the engine read the old
          // row the same way (no other old shape was ever scored)
          const set = { weightKg: 20, reps: 8, rpe: null };
          if (scored && measure === 'weight_reps') assert.equal(setE1rm(C, def, set, 80), setE1rm(C, exerciseDef(row), set, 80), at);
        }
      }
    }
  });

  test('an old bodyweight "Weighted dip" that stored no e1RM becomes bodyweight, and only Bodyweight is offered', () => {
    const row = legacy('bodyweight', 'weight_reps', 'Weighted dip');
    assert.ok(legacyBodyweight(row));
    const d = draftOf(row, [{ muscle_id: 'chest', role: 'primary' }, { muscle_id: 'triceps', role: 'secondary' }], false);
    assert.deepEqual([d.choice, d.loadMode, d.bwFactor], ['bodyweight', 'bodyweight', null]);
    assert.deepEqual(editChoices(row, false), ['bodyweight']);
    const p = toPayload(C, { ...d, bwFactor: 0.65 }, { slug: 'custom_dip', today: TODAY, bodyweightKg: 80 });
    assert.deepEqual([p.exercise.load_mode, p.exercise.is_bodyweight, p.exercise.bw_factor], ['bodyweight', true, 0.65]);
  });

  test('one that stored e1RMs stays in weight mode, so the next session scores as a fresh reference would', () => {
    // a 20 kg × 8 set (or a known best) stored 25.3 in weight mode; in bodyweight mode at 0.65
    // and 80 kg the same set is 91.2, so switching would leave 25.3 the reference for 30 days
    const row = legacy('bodyweight', 'weight_reps', 'Weighted dip');
    const muscles = [{ muscle_id: 'chest', role: 'primary' }, { muscle_id: 'triceps', role: 'secondary' }];
    const d = draftOf(row, muscles, true);
    assert.deepEqual([d.choice, d.loadMode, d.equipment, d.bwFactor], [null, 'weight', 'bodyweight', null]);
    assert.deepEqual(editChoices(row, true), ['barbell', 'dumbbell', 'machine', 'cable', 'smith']);
    assert.deepEqual(validateDraft(C, d), []);
    const p = toPayload(C, d, { slug: 'custom_dip', today: TODAY, bodyweightKg: 80 });
    assert.deepEqual([p.exercise.load_mode, p.exercise.is_bodyweight, p.exercise.bw_factor, p.exercise.equipment], ['weight', true, null, 'bodyweight']);

    const set = { weightKg: 20, reps: 8, rpe: null };
    const stored = setE1rm(C, exerciseDef(row), set, 80)!;
    near(stored, 20 * (1 + 8 / 30));
    const savedRow: ExerciseRow = { ...row, ...p.exercise, id: 'id-dip', measure: row.measure };
    const { lib } = libraryFromRows([...EXERCISES, savedRow], [...MUSCLES, ...p.muscles.map((m) => ({ exercise_id: 'id-dip', ...m }))]);
    // what a set saved now stores, so the stored one is a fresh reference
    assert.equal(setE1rm(C, lib.get('custom_dip')!, set, 80), stored);
    // the next 3 × 10 loads its muscles against it; a set with no added weight still adds none
    const next = (w: number) => scoreWorkout({ c: C, lib }, { start: 48, end: 49, exercises: [['custom_dip', [{ w, r: 10 }, { w, r: 10 }, { w, r: 10 }]]] },
      [{ slug: 'custom_dip', e1rm: stored, at: 24, source: 'logged' }], 80).detail.custom_dip?.L_e ?? 0;
    assert.ok(next(20) > 0);
    assert.equal(next(0), 0);
  });

  test('an old bodyweight exercise logged as reps can be bodyweight, so its reps count', () => {
    const row = legacy('bodyweight', 'reps', 'Decline push-up');
    assert.deepEqual(editChoices(row), ['bodyweight', 'band']);
    // never scored, so any chip that logs reps will do
    assert.deepEqual(editChoices(legacy('kettlebell', 'reps')), ['bodyweight', 'band']);
    const d: Draft = { ...draftOf(row, [{ muscle_id: 'chest', role: 'primary' }]), bwFactor: 0.65 };
    assert.deepEqual([d.choice, d.loadMode], ['bodyweight', 'bodyweight']);
    const p = toPayload(C, d, { slug: 'custom_decline', today: TODAY, bodyweightKg: 80 });
    const stored: ExerciseRow = { ...p.exercise, id: 'id-decline', measure: 'reps' };
    const { lib } = libraryFromRows([...EXERCISES, stored], [...MUSCLES, ...p.muscles.map((m) => ({ exercise_id: 'id-decline', ...m }))]);
    const manual: PbRecord[] = [{ slug: 'custom_decline', e1rm: 80, at: 0, source: 'manual' }];
    const load = (r: number) =>
      scoreWorkout({ c: C, lib }, { start: 24, end: 25, exercises: [['custom_decline', [{ r }, { r }, { r }]]] }, manual, 80).detail.custom_decline.L_e;
    assert.ok(load(25) > load(5));
  });

  test('with no fatigue class, its equipment\'s default, as choosing its chip gives', () => {
    const fatigue = (equipment: string, measure: string) => draftOf(legacy(equipment, measure), []).fatigue;
    assert.deepEqual(
      [fatigue('cable', 'weight_reps'), fatigue('machine', 'weight_reps'), fatigue('band', 'reps'), fatigue('band', 'weight_reps'),
        fatigue('barbell', 'weight_reps'), fatigue('bodyweight', 'weight_reps')],
      ['low', 'low', 'low', 'low', 'standard', 'standard'],
    );
    assert.equal(draftOf(legacy('cable', 'weight_reps'), []).choice, 'cable');
  });

  test('weight × time is offered no chip and saves a fixed cost; kettlebell keeps its word', () => {
    assert.deepEqual(editChoices(legacy('dumbbell', 'weight_duration')), []);
    const carry = draftOf(legacy('dumbbell', 'weight_duration'), []);
    assert.deepEqual([carry.loadMode, carry.equipment], ['fixed', 'dumbbell']);
    const kb = draftOf(legacy('kettlebell', 'weight_reps'), []);
    assert.deepEqual([kb.choice, kb.loadMode, kb.equipment], [null, 'weight', 'kettlebell']);
  });
});

describe('the role chips', () => {
  test('a selected chip\'s letter reads at 4.5:1 or better on every role tint, in both themes', () => {
    for (const [theme, ready] of [['race', C.ready_fill], ['night', C.ready_fill_dark]] as const) {
      const palette = palettes[theme];
      for (const [role, tint] of Object.entries(roleTints(palette.accent, ready))) {
        const tone = readableTone(tint, palette);
        assert.ok(contrastRatio(palette[tone], tint) >= 4.5, `${theme} ${role}: ${tone} on ${tint}`);
      }
    }
    near(contrastRatio('#000000', '#ffffff'), 21);
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
