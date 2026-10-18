/// <reference types="node" />

// Build phase 4's scoring path, from rows shaped like the database's to cache rows: F20 and F28 as
// the plan names them, an edit to Monday rescoring Tuesday, a workout in progress, and F26 read
// back from the cache.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scoreWorkout } from './engine.ts';
import { toPbHistory } from './pbHistory.ts';
import { C, EXERCISES, fixture, historyRows, iso, MUSCLES, near, score, setsHistory, T0, workoutRows } from './testRows.ts';
import { withOverride } from './thresholds.ts';
import type { LiftSet } from './types.ts';
import {
  cacheRows, engineWorkout, libraryFromRows, recoveryMapFromLoads, scoreFinishedWorkouts, scoreLiveWorkout,
  type MuscleLoadRow, type ScoringRows, type WorkoutLoads,
} from './workoutLoads.ts';

const muscleLoad = (w: WorkoutLoads, id: string) => w.muscles.find((m) => m.muscle_id === id);

describe('finished workouts → cache rows', () => {
  test('F20: the push day caches chest 2.48, triceps 3.584, front delts 1.952, side delts 1.734, traps 0.462, nothing else', () => {
    const f = fixture('F20');
    const push = workoutRows('push', { start: -1, end: 0, exercises: f.inputs.exercises as [string, LiftSet[]][] });
    const [loads] = score([push], historyRows(f.inputs.history as never));
    const expect = f.expect as { L_m: Record<string, number>; R: Record<string, number>; L_e: Record<string, number> };
    assert.deepEqual(loads.muscles.map((m) => m.muscle_id).sort(), Object.keys(expect.L_m).sort());
    for (const [id, want] of Object.entries(expect.L_m)) near(muscleLoad(loads, id)?.load, want);
    for (const [id, want] of Object.entries(expect.R)) near(muscleLoad(loads, id)?.recovery_hours, want);
    for (const [slug, want] of Object.entries(expect.L_e)) near(loads.exercises.find((e) => e.exercise_id === `id-${slug}`)?.load, want);
    // references as they stood before the session: lateral raise 13, though the session raised it to 15
    const lateral = loads.exercises.find((e) => e.exercise_id === 'id-lateral_raise_db')!;
    assert.deepEqual([lateral.pb_source, lateral.pb_detail, lateral.pb_value], ['monthly', 'logged', 13]);
  });

  test('F28: bench in two blocks of one workout caches one row, 0.6181', () => {
    const f = fixture('F28');
    const [loads] = score([workoutRows('w28', { start: -1, end: 0, exercises: f.inputs.exercises as [string, LiftSet[]][] })],
                          historyRows(f.inputs.history as never));
    const bench = loads.exercises.filter((e) => e.exercise_id === 'id-bench_press_bb');
    assert.equal(bench.length, 1);
    near(bench[0].load, 0.6181);
  });

  test('workouts come back in time order, unfinished ones left out', () => {
    const a = workoutRows('later', { start: 47, end: 48, exercises: [['bench_press_bb', [{ w: 60, r: 5 }]]] });
    const b = workoutRows('earlier', { start: 23, end: 24, exercises: [['bench_press_bb', [{ w: 60, r: 5 }]]] });
    const c = workoutRows('open', { start: 70, end: 71, exercises: [['bench_press_bb', [{ w: 60, r: 5 }]]] }, false);
    assert.deepEqual(score([a, b, c], []).map((w) => w.workout_id), ['earlier', 'later']);
  });

  test('a stored set with negative reps adds nothing, so no cache row goes below zero (finish_workout checks load >= 0)', () => {
    const pb = historyRows([{ slug: 'bench_press_bb', e1rm: 120, at: -168, source: 'logged' }]);
    const [clean] = score([workoutRows('w', { start: -1, end: 0, exercises: [['bench_press_bb', [{ w: 90, r: 8 }]]] })], pb);
    const [typo] = score([workoutRows('w', { start: -1, end: 0, exercises: [['bench_press_bb', [{ w: 90, r: 8 }, { w: 90, r: -8 }]]] })], pb);
    assert.deepEqual(typo, clean);
    assert.ok([...typo.muscles, ...typo.exercises].every((r) => r.load >= 0));
  });
});

describe('the recompute rule', () => {
  test('editing a set on Monday changes Tuesday\'s cached curls, which estimate from bench', () => {
    const monday = (w: number) => workoutRows('mon', { start: 17, end: 18, exercises: [['bench_press_bb', [{ w, r: 5 }, { w, r: 5 }]]] });
    const tuesday = workoutRows('tue', { start: 41, end: 42, exercises: [['bb_curl', [{ w: 30, r: 10 }, { w: 30, r: 10 }]]] });
    const rescore = (w: number) => {
      const mon = monday(w);
      return score([mon, tuesday], setsHistory(mon)).find((x) => x.workout_id === 'tue')!;
    };
    const before = rescore(100);
    const after = rescore(120);
    const curl = (x: WorkoutLoads) => x.exercises.find((e) => e.exercise_id === 'id-bb_curl')!;
    assert.deepEqual([curl(before).pb_source, curl(before).pb_detail], ['estimated', 'bench_press_bb']);
    near(curl(before).pb_value!, 100 * (1 + 5 / 30) * 0.85 * 0.45 * 0.9);
    near(curl(after).pb_value!, 120 * (1 + 5 / 30) * 0.85 * 0.45 * 0.9);
    assert.ok(muscleLoad(after, 'biceps')!.load < muscleLoad(before, 'biceps')!.load, 'a higher reference makes the same curls lighter');
  });

  test('a full recompute over a long, shuffled history gives exactly what scoring each workout against everything gives', () => {
    // a small seeded generator, so the history is the same on every run
    let seed = 7;
    const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const shuffle = <T>(xs: T[]) => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
    // estimate chains (sumo deadlift → deadlift → squat, curls → row), bodyweight, assisted and fixed modes
    const pool = ['bench_press_bb', 'incline_bench_db', 'sumo_deadlift', 'deadlift', 'squat_bb', 'bb_curl', 'lateral_raise_db', 'pull_up', 'assisted_pull_up', 'plank', 'db_row'];
    const parts: ReturnType<typeof workoutRows>[] = [];
    let h = 0;
    for (let i = 0; i < 240; i++) {
      h += rand() < 0.05 ? 24 * (31 + Math.floor(rand() * 30)) : 20 + Math.floor(rand() * 60);   // now and then a lapse
      const exercises: [string, LiftSet[]][] = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => [pick(pool), Array.from(
        { length: 1 + Math.floor(rand() * 4) },
        () => ({ w: 10 + Math.round(rand() * 120), r: Math.floor(rand() * 12), rpe: rand() < 0.3 ? 6 + Math.round(rand() * 8) / 2 : undefined,
                 warmup: rand() < 0.15, seconds: 30 + Math.floor(rand() * 60), side: rand() < 0.1 ? ('left' as const) : undefined }),
      )]);
      const part = workoutRows(`g${i}`, { start: h, end: h + 1 + rand(), exercises }, rand() > 0.03);
      part.workout.bodyweight_kg = rand() < 0.5 ? 70 + Math.round(rand() * 20) : null;
      for (const s of part.sets) s.completed = rand() > 0.1;
      parts.push(part);
    }
    const manual = Array.from({ length: 40 }, () => ({ slug: pick(pool), e1rm: 60 + Math.round(rand() * 8) * 10, at: Math.floor(rand() * h), source: 'manual' }));
    // ties between a manual and a logged record, so the first-in-history tie-break is exercised
    const logged = parts.filter((p) => p.workout.finished_at).flatMap(setsHistory);
    const ties = logged.filter(() => rand() < 0.05).map((r) => ({ ...r, source: 'manual' }));
    const history = shuffle([...historyRows(manual), ...logged, ...ties]);
    const rows = (thresholds: typeof C): ScoringRows => ({
      thresholds, exercises: EXERCISES, muscles: MUSCLES, history,
      workouts: shuffle(parts.map((p) => p.workout)), blocks: shuffle(parts.flatMap((p) => p.blocks)), sets: shuffle(parts.flatMap((p) => p.sets)),
    });
    // the scoring before the rows were grouped: every workout against every block, set and record
    const reference = (r: ScoringRows): WorkoutLoads[] => {
      const { lib, keyOf, idOf } = libraryFromRows(r.exercises, r.muscles);
      const all = toPbHistory(r.history, (id) => keyOf.get(id));
      return r.workouts.filter((w) => w.finished_at)
        .sort((a, b) => Date.parse(a.finished_at!) - Date.parse(b.finished_at!))
        .map((w) => cacheRows(w.id, scoreWorkout({ c: r.thresholds, lib }, engineWorkout(w, r.blocks, r.sets, keyOf), all, w.bodyweight_kg), idOf));
    };
    for (const thresholds of [C, withOverride(C, 'pb.manual_policy', 'replace_on_log')]) {
      const r = rows(thresholds);
      const got = scoreFinishedWorkouts(r);
      assert.ok(got.length > 200 && got.some((w) => w.exercises.some((e) => e.pb_source === 'estimated'))
        && got.some((w) => w.exercises.some((e) => e.pb_source === 'lapsed')));
      assert.deepEqual(got, reference(r));
    }
  });
});

describe('a workout in progress', () => {
  test('is scored from its ticked sets with t_w = now', () => {
    const { lib } = libraryFromRows(EXERCISES, MUSCLES);
    const m = { c: C, lib };
    const set = (weightKg: number, completed: boolean) => ({ weightKg, reps: 8, rpe: null, seconds: null, setType: 'working', completed });
    const live = {
      startedAt: iso(-1), bodyweightKg: null,
      exercises: [{ exerciseId: 'id-bench_press_bb', slug: 'bench_press_bb', sets: [set(90, true), set(90, true), set(90, false)] }],
    };
    const history = toPbHistory(historyRows([{ slug: 'bench_press_bb', e1rm: 120, at: -168, source: 'logged' }]), (id) => id.replace(/^id-/, ''));
    const now = (Date.parse(iso(0.5))) / 3_600_000;
    const scored = scoreLiveWorkout(m, live, history, now);
    near(scored.L_e.bench_press_bb, 0.64);   // two ticked sets of F01's 0.32
    assert.equal(scored.end, now);
    near(scored.L_m.chest, 0.64);
  });
});

describe('the recovery map over the cache', () => {
  test('F26: the PPL week read back from cache rows at Wednesday 20:00 gives the preview image\'s levels', () => {
    const f = fixture('F26');
    const workouts = f.inputs.workouts as { start: number; end: number; exercises: [string, LiftSet[]][] }[];
    const parts = workouts.map((w, i) => workoutRows(`ppl${i}`, w));
    const loads = score(parts, [...historyRows(f.inputs.history as never), ...parts.flatMap(setsHistory)]);
    const rows: MuscleLoadRow[] = loads.flatMap((w, i) => w.muscles.map((m) => ({ ...m, finished_at: iso(workouts[i].end) })));
    const { lib } = libraryFromRows(EXERCISES, MUSCLES);
    const map = recoveryMapFromLoads({ c: C, lib }, rows, (T0 / 3_600_000) + 68);
    const expect = f.expect as Record<string, { level: number[]; F?: number[] }>;
    for (const [muscle, want] of Object.entries(expect)) {
      assert.equal(map[muscle as keyof typeof map].level, want.level[0], muscle);
      if (want.F) near(map[muscle as keyof typeof map].F, want.F[0]);
    }
  });
});
