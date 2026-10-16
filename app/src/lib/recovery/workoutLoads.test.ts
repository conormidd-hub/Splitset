/// <reference types="node" />

// Build phase 4's scoring path, from rows shaped like the database's to cache rows: F20 and F28 as
// the plan names them, an edit to Monday rescoring Tuesday, a workout in progress, and F26 read
// back from the cache.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toPbHistory } from './pbHistory.ts';
import { C, EXERCISES, fixture, historyRows, iso, MUSCLES, near, score, setsHistory, T0, workoutRows } from './testRows.ts';
import type { LiftSet } from './types.ts';
import { libraryFromRows, recoveryMapFromLoads, scoreLiveWorkout, type MuscleLoadRow, type WorkoutLoads } from './workoutLoads.ts';

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
