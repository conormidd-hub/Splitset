// The live logger's set and the workout_sets row it saves. Kept apart from the store
// (src/stores/activeWorkout.ts, which needs React Native storage) so Node builds the very same
// row in tests and in app/scripts/recovery-cli.ts. Relative .ts imports, as in src/lib/recovery.

import { exerciseDef, setE1rm, type ExerciseRow } from '../recovery/sets.ts';
import type { Thresholds } from '../recovery/thresholds.ts';

export type SetType = 'warmup' | 'working' | 'drop' | 'failure';
export type Side = 'left' | 'right';

export type SetRow = {
  id: string;
  workoutExerciseId: string;
  exerciseId: string;
  position: number;
  setType: SetType;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  seconds: number | null;
  /** Set when a unilateral exercise is logged one side per set. Absent on sets from before Phase 3. */
  side?: Side | null;
  completed: boolean;
  completedAt: string | null;
  notes: string | null;
  updatedAt: string;
};

/** What the logger knows about an exercise in the workout: enough for the engine to weigh a set.
 *  Everything but the measure is optional, because blocks saved before Phase 3 lack it. */
export type ExerciseFacts = {
  exerciseId: string;
  measure: string;
  slug?: string | null;
  loadMode?: string | null;
  bwFactor?: number | null;
  unilateral?: boolean;
  isBodyweight?: boolean;
};

/** The workout fields a set row needs. */
export type WorkoutRef = { id: string; userId: string; bodyweightKg: number | null };

function asExerciseRow(f: ExerciseFacts): ExerciseRow {
  return {
    id: f.exerciseId, slug: f.slug ?? null, measure: f.measure, load_mode: f.loadMode ?? null, bw_factor: f.bwFactor ?? null,
    fatigue: null, pb_estimate_from: null, pb_estimate_ratio: null, is_unilateral: f.unilateral ?? false,
  };
}

/** The e1RM a logged set stores, through the engine (src/lib/recovery/sets.ts). */
export function setRowE1rm(c: Thresholds, facts: ExerciseFacts | undefined, s: Pick<SetRow, 'weightKg' | 'reps' | 'rpe'>, workoutBodyweight: number | null): number | null {
  if (!facts) return null;
  return setE1rm(c, exerciseDef(asExerciseRow(facts)), s, workoutBodyweight);
}

/** True when the exercise's effective weight depends on bodyweight, so its sets' e1RMs move with the snapshot. */
export function usesBodyweight(facts: ExerciseFacts | undefined): boolean {
  return facts?.loadMode === 'bodyweight' || facts?.loadMode === 'assisted';
}

/** The workout_sets row for a set, e1rm included. */
export function setRowPayload(c: Thresholds, w: WorkoutRef, facts: ExerciseFacts | undefined, s: SetRow, updatedAt: string) {
  return {
    id: s.id, workout_exercise_id: s.workoutExerciseId, workout_id: w.id, exercise_id: s.exerciseId, user_id: w.userId,
    position: s.position, set_type: s.setType, weight_kg: s.weightKg, reps: s.reps, rpe: s.rpe, seconds: s.seconds,
    side: s.side ?? null, e1rm: setRowE1rm(c, facts, s, w.bodyweightKg),
    completed: s.completed, completed_at: s.completedAt, notes: s.notes, updated_at: updatedAt,
  };
}
