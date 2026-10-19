/// <reference types="node" />

// Shared by the recovery tests: the library, constants and fixtures as the seeded database holds
// them, and fixture workouts as the rows the logger stores. Test-only; nothing in the app imports it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { setE1rm, exerciseDef, type ExerciseMuscleRow, type ExerciseRow } from './sets.ts';
import type { PbHistoryRow } from './pbHistory.ts';
import { parseConstants } from './thresholds.ts';
import type { ExerciseDef, LiftSet } from './types.ts';
import type { LoadWindow } from './read.ts';
import {
  scoreFinishedWorkouts, type ScoringRows, type WorkoutExerciseRow, type WorkoutLoads, type WorkoutRow, type WorkoutSetRow,
} from './workoutLoads.ts';

type LibEntry = ExerciseDef & { name: string; log_as: string };
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const LIBRARY = (read('../../../../data/exercise_library.json') as { exercises: LibEntry[] }).exercises;
export const C = parseConstants(read('../../../../data/recovery_constants.json'));
export const FIXTURES = (read('../../../../data/load_model_fixtures.json') as {
  fixtures: { id: string; inputs: Record<string, unknown>; expect: Record<string, unknown> }[];
}).fixtures;
export const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;

/** The exercises and exercise_muscles rows the seeded database holds for the library. */
export const EXERCISES: ExerciseRow[] = LIBRARY.map((e) => ({
  id: `id-${e.slug}`, slug: e.slug, measure: e.load_mode === 'fixed' ? (e.log_as === 'seconds' ? 'duration' : 'reps') : 'weight_reps',
  load_mode: e.load_mode, bw_factor: e.bw_factor ?? null, fatigue: e.fatigue,
  pb_estimate_from: e.pb_estimate?.from ?? null, pb_estimate_ratio: e.pb_estimate?.ratio ?? null, is_unilateral: !!e.unilateral,
}));
export const MUSCLES: ExerciseMuscleRow[] = LIBRARY.flatMap((e) =>
  (['primary', 'secondary', 'tertiary'] as const).flatMap((role) => e[role].map((m) => ({ exercise_id: `id-${e.slug}`, muscle_id: m, role }))));

export const T0 = Date.parse('2026-10-05T00:00:00Z');   // a Monday: fixture hour 0
export const iso = (h: number) => new Date(T0 + h * 3_600_000).toISOString();

/** Rows for a fixture workout ({start, end, exercises: [slug, sets][]}), as the logger stores it. */
export function workoutRows(id: string, w: { start: number; end: number; exercises: [string, LiftSet[]][] }, finished = true) {
  const workout: WorkoutRow = { id, started_at: iso(w.start), finished_at: finished ? iso(w.end) : null, bodyweight_kg: null };
  const blocks: WorkoutExerciseRow[] = [];
  const sets: (WorkoutSetRow & { exercise_id: string })[] = [];
  w.exercises.forEach(([slug, list], i) => {
    const block = { id: `${id}-b${i}`, workout_id: id, exercise_id: `id-${slug}`, position: i };
    blocks.push(block);
    list.forEach((s, j) => sets.push({
      workout_exercise_id: block.id, exercise_id: block.exercise_id, position: j, set_type: s.warmup ? 'warmup' : 'working',
      weight_kg: s.w ?? null, reps: s.r ?? null, rpe: s.rpe ?? null, seconds: s.seconds ?? null, side: s.side ?? null, completed: true,
    }));
  });
  return { workout, blocks, sets };
}

/** pb_history rows for a fixture's PB records (hours relative to T0), or for stored sets. */
export const historyRows = (records: { slug: string; e1rm: number; at: number; source: string }[]): PbHistoryRow[] =>
  records.map((r) => ({
    exercise_id: `id-${r.slug}`, e1rm: r.e1rm, at: iso(r.at), source: r.source, weight_kg: null, reps: null, set_type: null,
    workout_id: null, manual_pb_id: null,
  }));

export function setsHistory(rows: ReturnType<typeof workoutRows>): PbHistoryRow[] {
  const byId = new Map(EXERCISES.map((e) => [e.id, e]));
  const out: PbHistoryRow[] = [];
  for (const s of rows.sets) {
    const e1rm = setE1rm(C, exerciseDef(byId.get(s.exercise_id)!), { weightKg: s.weight_kg, reps: s.reps, rpe: s.rpe }, rows.workout.bodyweight_kg);
    if (e1rm != null) out.push({ exercise_id: s.exercise_id, e1rm, at: rows.workout.finished_at!, source: 'logged', weight_kg: s.weight_kg,
                                 reps: s.reps, set_type: s.set_type, workout_id: rows.workout.id, manual_pb_id: null });
  }
  return out;
}

export function score(parts: ReturnType<typeof workoutRows>[], history: PbHistoryRow[]): WorkoutLoads[] {
  const rows: ScoringRows = {
    thresholds: C, exercises: EXERCISES, muscles: MUSCLES, history,
    workouts: parts.map((p) => p.workout), blocks: parts.flatMap((p) => p.blocks), sets: parts.flatMap((p) => p.sets),
  };
  return scoreFinishedWorkouts(rows);
}

export const near = (got: number | undefined, want: number) => assert.ok(got != null && Math.abs(got - want) <= 0.01, `got ${got}, want ${want}`);

const NAMES = new Map(LIBRARY.map((e) => [`id-${e.slug}`, e.name]));

export type FixtureWorkout = { start: number; end: number; exercises: [string, LiftSet[]][] };

/** What recovery_loads() would return for these fixture workouts, scored as phase 4 caches them. */
export function loadWindow(workouts: FixtureWorkout[], pbs: Parameters<typeof historyRows>[0]): LoadWindow {
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
