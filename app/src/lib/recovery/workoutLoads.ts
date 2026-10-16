// Build phase 4: from stored rows to the per-workout cache (workout_muscle_loads,
// workout_exercise_loads), the live score of a workout in progress, and the recovery map over the
// cache. Pure: rows in, plain values out; every number comes from the Phase 2 engine. The app
// (src/api/workoutLoads.ts) and app/scripts/recovery-cli.ts (the Python scripts and database
// tests) both call these, so a workout gets the same cache rows wherever it is scored.
//
// The PB history is pb_history: every finished set's stored e1RM plus manual PBs. A workout is
// scored against the records dated before it started, which is what the reference implementation
// gets by appending each workout's records as it goes, so the rows can be computed in any order.

import { buildLibrary, muscleState, scoreWorkout } from './engine.ts';
import { MUSCLE_IDS, type MuscleId } from './library.ts';
import { hoursOf, toPbHistory, type PbHistoryRow } from './pbHistory.ts';
import { engineKey, exerciseDef, type ExerciseMuscleRow, type ExerciseRow } from './sets.ts';
import type { Thresholds } from './thresholds.ts';
import type { ExerciseDef, Library, LiftSet, Model, MuscleState, PbRecord, ScoredWorkout, Side, Term, Workout } from './types.ts';

// ---------------------------------------------------------------- rows

/** A workouts row. */
export interface WorkoutRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  bodyweight_kg: number | null;
}

/** A workout_exercises row: one block of an exercise in a workout. */
export interface WorkoutExerciseRow {
  id: string;
  workout_id: string;
  exercise_id: string;
  position: number;
}

/** A workout_sets row. */
export interface WorkoutSetRow {
  workout_exercise_id: string;
  position: number;
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  seconds: number | null;
  side: string | null;
  completed: boolean;
}

/** One workout's cache, as save_workout_loads() and finish_workout() take it. */
export interface WorkoutLoads {
  workout_id: string;
  muscles: { muscle_id: MuscleId; load: number; recovery_hours: number }[];
  exercises: { exercise_id: string; load: number; pb_source: string; pb_detail: string | null; pb_value: number | null }[];
}

/** A workout_muscle_loads row, as the recovery map reads it. */
export interface MuscleLoadRow {
  muscle_id: string;
  load: number;
  recovery_hours: number;
  finished_at: string;
}

// ---------------------------------------------------------------- library

/** The engine's library from exercises rows and their exercise_muscles, with the maps between
 *  exercise ids and engine keys (slug, or id outside the library). */
export function libraryFromRows(exercises: readonly ExerciseRow[], muscles: readonly ExerciseMuscleRow[]): {
  lib: Library; keyOf: Map<string, string>; idOf: Map<string, string>;
} {
  const byExercise = new Map<string, ExerciseMuscleRow[]>();
  for (const m of muscles) {
    const list = byExercise.get(m.exercise_id);
    if (list) list.push(m);
    else byExercise.set(m.exercise_id, [m]);
  }
  const defs: ExerciseDef[] = [];
  const keyOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  for (const e of exercises) {
    const key = engineKey(e);
    keyOf.set(e.id, key);
    idOf.set(key, e.id);
    const def = exerciseDef(e, byExercise.get(e.id) ?? []);
    if (def) defs.push(def);
  }
  return { lib: buildLibrary(defs), keyOf, idOf };
}

// ---------------------------------------------------------------- workouts

function liftSet(s: WorkoutSetRow, bodyweight: number | null): LiftSet {
  return {
    w: s.weight_kg, r: s.reps, rpe: s.rpe, warmup: s.set_type === 'warmup', seconds: s.seconds,
    side: s.side === 'left' || s.side === 'right' ? (s.side as Side) : null, bodyweight,
  };
}

/**
 * The engine's view of a stored workout: its blocks in order, each with its ticked sets, every
 * set carrying the workout's bodyweight snapshot (D5). Two blocks of one exercise stay two
 * blocks, so the engine keeps one running reference across them (F28). `end` defaults to
 * finished_at; a workout in progress passes now.
 */
export function engineWorkout(
  w: WorkoutRow, blocks: readonly WorkoutExerciseRow[], sets: readonly WorkoutSetRow[],
  keyOf: ReadonlyMap<string, string>, end?: number,
): Workout {
  const mine = blocks.filter((b) => b.workout_id === w.id).sort((a, b) => a.position - b.position);
  const exercises: [string, LiftSet[]][] = [];
  for (const b of mine) {
    const key = keyOf.get(b.exercise_id);
    if (!key) continue;
    const done = sets.filter((s) => s.workout_exercise_id === b.id && s.completed).sort((a, c) => a.position - c.position);
    exercises.push([key, done.map((s) => liftSet(s, w.bodyweight_kg))]);
  }
  const finished = w.finished_at ? hoursOf(w.finished_at) : undefined;
  return { start: hoursOf(w.started_at), end: end ?? finished ?? hoursOf(w.started_at), exercises };
}

/** A scored workout as cache rows: every muscle it loaded, and every exercise it scored. */
export function cacheRows(workoutId: string, scored: ScoredWorkout, idOf: ReadonlyMap<string, string>): WorkoutLoads {
  const muscles = MUSCLE_IDS.filter((id) => scored.L_m[id] > 0)
    .map((id) => ({ muscle_id: id, load: scored.L_m[id], recovery_hours: scored.R[id] }));
  const exercises: WorkoutLoads['exercises'] = [];
  for (const [key, d] of Object.entries(scored.detail)) {
    const exercise_id = idOf.get(key);
    if (!exercise_id) continue;
    exercises.push({ exercise_id, load: d.L_e, pb_source: d.pb_source, pb_detail: d.pb_via, pb_value: d.pb_before });
  }
  return { workout_id: workoutId, muscles, exercises };
}

/** Everything scoring needs, as rows. `thresholds` are the user's (constants plus overrides). */
export interface ScoringRows {
  thresholds: Thresholds;
  exercises: readonly ExerciseRow[];
  muscles: readonly ExerciseMuscleRow[];
  workouts: readonly WorkoutRow[];
  blocks: readonly WorkoutExerciseRow[];
  sets: readonly WorkoutSetRow[];
  history: readonly PbHistoryRow[];
}

/**
 * The cache rows of every finished workout in `rows.workouts`, in time order (by finished_at):
 * each scored by the engine against the PB history dated before it started. This is the
 * recompute rule's scoring (§14) and finishing's, for one workout or many.
 */
export function scoreFinishedWorkouts(rows: ScoringRows): WorkoutLoads[] {
  const { lib, keyOf, idOf } = libraryFromRows(rows.exercises, rows.muscles);
  const m: Model = { c: rows.thresholds, lib };
  const history = toPbHistory(rows.history, (id) => keyOf.get(id));
  return rows.workouts
    .filter((w) => w.finished_at)
    .sort((a, b) => Date.parse(a.finished_at!) - Date.parse(b.finished_at!))
    .map((w) => cacheRows(w.id, scoreWorkout(m, engineWorkout(w, rows.blocks, rows.sets, keyOf), history, w.bodyweight_kg), idOf));
}

// ---------------------------------------------------------------- a workout in progress

/** The logger's view of a workout in progress (src/stores/activeWorkout.ts), as far as scoring needs it. */
export interface LiveWorkout {
  startedAt: string;
  bodyweightKg: number | null;
  exercises: readonly {
    exerciseId: string;
    slug?: string | null;
    sets: readonly {
      weightKg: number | null; reps: number | null; rpe: number | null; seconds: number | null;
      setType: string; side?: string | null; completed: boolean;
    }[];
  }[];
}

/**
 * A workout in progress, scored on the fly (build phase 4): its ticked sets, with t_w = now.
 * Nothing is cached until Finish.
 */
export function scoreLiveWorkout(m: Model, w: LiveWorkout, history: readonly PbRecord[], now: number): ScoredWorkout {
  const exercises: [string, LiftSet[]][] = w.exercises.map((b) => [
    engineKey({ id: b.exerciseId, slug: b.slug ?? null }),
    b.sets.filter((s) => s.completed).map((s) => ({
      w: s.weightKg, r: s.reps, rpe: s.rpe, warmup: s.setType === 'warmup', seconds: s.seconds,
      side: s.side === 'left' || s.side === 'right' ? (s.side as Side) : null, bodyweight: w.bodyweightKg,
    })),
  ]);
  return scoreWorkout(m, { start: hoursOf(w.startedAt), end: now, exercises }, history, w.bodyweightKg);
}

// ---------------------------------------------------------------- the recovery map over the cache

/**
 * Every muscle's state at `now` (hours) from cached rows: each row is one term of spec §8
 * (t_w, L, R). Rows of any user's workouts and activities can be mixed in; pass one user's.
 */
export function recoveryMapFromLoads(m: Model, rows: readonly MuscleLoadRow[], now: number): Record<MuscleId, MuscleState> {
  return Object.fromEntries(MUSCLE_IDS.map((id) => {
    const terms: Term[] = rows
      .filter((r) => r.muscle_id === id && r.load > 0)
      .map((r) => [hoursOf(r.finished_at), r.load, r.recovery_hours] as const);
    return [id, muscleState(m, terms, now)];
  })) as Record<MuscleId, MuscleState>;
}
