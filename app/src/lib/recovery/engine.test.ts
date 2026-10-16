/// <reference types="node" />

// The fixture runner: every case in data/load_model_fixtures.json against the engine, mirroring
// the five kinds and the comparison rules of scripts/verify_spec_fixtures.py. A fixture's
// extra_exercises and constants_override make a Model for that case only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  buildLibrary, muscleState, pbBefore, scoreExercise, scoreWorkout, scoreWorkouts, sessionMap, termsFor,
} from './engine.ts';
import type { MuscleId } from './library.ts';
import { parseConstants, withOverride } from './thresholds.ts';
import type { ExerciseDef, LiftSet, Model, MuscleState, PbRecord, Workout } from './types.ts';

type Want = number | string | boolean | null;
type ByKey = Record<string, Want>;

interface Common {
  extra_exercises?: ExerciseDef[];
  constants_override?: Record<string, unknown>;
}
interface ExerciseCase {
  inputs: Common & { slug: string; sets: LiftSet[]; history: PbRecord[]; start?: number; bodyweight?: number };
  expect: { pb_source?: string; pb_before?: number; L_e?: number; refs?: Want[]; I?: Want[]; inol?: Want[]; w?: Want[]; records?: Want[] };
}
interface PbCase {
  inputs: Common & { slug: string; at: number; history: PbRecord[] };
  expect: { pb: number; source: string; via?: string };
}
interface ManualTimelineCase {
  inputs: Common & { slug: string; manual: { e1rm: number; day: number }; sessions: { day: number; sets: LiftSet[] }[] };
  expect: { pb_before: Want[]; pb_kind?: Want[]; first_set_I?: Want[] };
}
interface WorkoutCase {
  inputs: Common & { exercises: [string, LiftSet[]][]; history: PbRecord[] };
  expect: {
    L_m_all_zero?: boolean; L_e?: ByKey; L_m?: ByKey; level?: ByKey; R?: ByKey; ready_in_h?: ByKey;
    trainable_in_h?: ByKey; set_refs?: Record<string, Want[]>;
  };
}
interface TimelineCase {
  inputs: Common & { workouts: Workout[]; history: PbRecord[]; muscles: MuscleId[]; at: number[] };
  expect: Partial<Record<MuscleId, Partial<Record<'F' | 'W' | 'level' | 'ready_in_h' | 'trainable_in_h', Want[]>>>>;
}
type Fixture = { id: string; about: string } & (
  | ({ kind: 'exercise' } & ExerciseCase)
  | ({ kind: 'pb' } & PbCase)
  | ({ kind: 'manual_timeline' } & ManualTimelineCase)
  | ({ kind: 'workout' } & WorkoutCase)
  | ({ kind: 'timeline' } & TimelineCase)
);

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const FILE = read('../../../../data/load_model_fixtures.json') as {
  tolerance: number; default_bodyweight_kg: number; fixtures: Fixture[];
};
const LIBRARY = (read('../../../../data/exercise_library.json') as { exercises: ExerciseDef[] }).exercises;
const CONSTANTS = parseConstants(read('../../../../data/recovery_constants.json'));
const HOURS_PER_DAY = 24;

function modelFor(i: Common): Model {
  let c = CONSTANTS;
  for (const [key, value] of Object.entries(i.constants_override ?? {})) c = withOverride(c, key, value);
  return { c, lib: buildLibrary([...LIBRARY, ...(i.extra_exercises ?? [])]) };
}

function run(fx: Fixture): { errs: string[]; checked: number } {
  const errs: string[] = [];
  let checked = 0;
  // the reference's cmp(): numbers within the file's tolerance, booleans and strings exactly,
  // and an expected null (or nothing) means "not checked"
  const cmp = (name: string, got: unknown, want: Want | undefined) => {
    if (want == null) return;
    checked += 1;
    const ok = typeof want === 'number' ? typeof got === 'number' && Math.abs(got - want) <= FILE.tolerance : got === want;
    if (!ok) errs.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const m = modelFor(fx.inputs);

  switch (fx.kind) {
    case 'exercise': {
      const { inputs: i, expect: e } = fx;
      const r = scoreExercise(m, i.slug, i.sets, i.start ?? 0, i.history, i.bodyweight ?? FILE.default_bodyweight_kg);
      cmp('pb_source', r.pb_source, e.pb_source);
      cmp('pb_before', r.pb_before, e.pb_before);
      cmp('L_e', r.L_e, e.L_e);
      for (const [key, field] of [['refs', 'ref'], ['I', 'I'], ['inol', 'inol'], ['w', 'w']] as const) {
        (e[key] ?? []).forEach((want, n) => cmp(`${key}[${n}]`, r.sets[n]?.[field], want));
      }
      (e.records ?? []).forEach((want, n) => cmp(`records[${n}]`, r.records[n]?.e1rm, want));
      break;
    }
    case 'pb': {
      const { inputs: i, expect: e } = fx;
      const r = pbBefore(m, i.slug, i.at, i.history);
      cmp('pb', r.pb, e.pb);
      cmp('source', r.source, e.source);
      cmp('via', r.detail, e.via);
      break;
    }
    case 'manual_timeline': {
      const { inputs: i, expect: e } = fx;
      let hist: PbRecord[] = [{ slug: i.slug, e1rm: i.manual.e1rm, at: i.manual.day * HOURS_PER_DAY, source: 'manual' }];
      i.sessions.forEach((sess, n) => {
        const t = sess.day * HOURS_PER_DAY;
        const pb = pbBefore(m, i.slug, t, hist);
        cmp(`pb_before[${n}]`, pb.pb, e.pb_before[n]);
        if (e.pb_kind) cmp(`pb_kind[${n}]`, pb.detail, e.pb_kind[n]);
        const sc = scoreWorkout(m, { start: t, end: t + 1, exercises: [[i.slug, sess.sets]] }, hist);
        hist = hist.concat(sc.records);
        if (e.first_set_I) cmp(`first_set_I[${n}]`, sc.detail[i.slug].sets[0].I, e.first_set_I[n]);
      });
      break;
    }
    case 'workout': {
      const { inputs: i, expect: e } = fx;
      const sc = scoreWorkout(m, { start: -1, end: 0, exercises: i.exercises }, i.history);
      if (e.L_m_all_zero) cmp('L_m all zero', Object.values(sc.L_m).every((v) => v === 0), true);
      const sm = sessionMap(m, sc);
      const each = (want: ByKey | undefined, label: string, got: (key: string) => unknown) => {
        for (const [key, w] of Object.entries(want ?? {})) cmp(`${label}.${key}`, got(key), w);
      };
      each(e.L_e, 'L_e', (slug) => sc.L_e[slug]);
      each(e.L_m, 'L_m', (mus) => sc.L_m[mus as MuscleId]);
      each(e.level, 'level', (mus) => sm[mus as MuscleId].level);
      each(e.R, 'R', (mus) => sc.R[mus as MuscleId]);
      each(e.ready_in_h, 'ready_in_h', (mus) => sm[mus as MuscleId].ready_in_h);
      each(e.trainable_in_h, 'trainable_in_h', (mus) => sm[mus as MuscleId].trainable_in_h);
      for (const [slug, refs] of Object.entries(e.set_refs ?? {})) {
        refs.forEach((want, n) => cmp(`set_refs.${slug}[${n}]`, sc.detail[slug]?.sets[n]?.ref, want));
      }
      break;
    }
    case 'timeline': {
      const { inputs: i, expect: e } = fx;
      const { scored } = scoreWorkouts(m, i.workouts, i.history);
      for (const mus of i.muscles) {
        const terms = termsFor(scored, mus);
        i.at.forEach((t, n) => {
          const st: MuscleState = muscleState(m, terms, t);
          for (const key of ['F', 'W', 'level', 'ready_in_h', 'trainable_in_h'] as const) {
            const want = e[mus]?.[key];
            if (want) cmp(`${mus}.${key}@${t}`, st[key], want[n]);
          }
        });
      }
      break;
    }
    default:
      errs.push(`unknown fixture kind ${String((fx as { kind: unknown }).kind)}`);
  }
  return { errs, checked };
}

let passed = 0;
let comparisons = 0;
for (const fx of FILE.fixtures) {
  test(`${fx.id}  ${fx.about}`, () => {
    const { errs, checked } = run(fx);
    assert.deepEqual(errs, []);
    assert.ok(checked > 0, 'the fixture compared nothing');
    passed += 1;
    comparisons += checked;
  });
}

test('the fixture file holds the 31 cases of spec §13, F01 to F31', () => {
  assert.deepEqual(FILE.fixtures.map((f) => f.id), Array.from({ length: 31 }, (_, n) => `F${String(n + 1).padStart(2, '0')}`));
});

after(() => {
  console.log(`fixtures: ${passed} of ${FILE.fixtures.length} pass (${comparisons} values compared)`);
});
