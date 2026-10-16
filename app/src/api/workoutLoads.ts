// Build phase 4 in the app: score a workout as it finishes and cache its loads in the same
// transaction (finish_workout), and the recompute rule of spec §14 (save_workout_loads).
// Plain async functions, not hooks, because the workout store's save queue calls them too.
// The scoring is src/lib/recovery/workoutLoads.ts, the same code the Python scripts use.

import { create } from 'zustand';

import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import type { PbHistoryRow } from '@/lib/recovery/pbHistory';
import type { ExerciseMuscleRow, ExerciseRow } from '@/lib/recovery/sets';
import { thresholdsFor, type Thresholds } from '@/lib/recovery/thresholds';
import {
  scoreFinishedWorkouts, type WorkoutExerciseRow, type WorkoutLoads, type WorkoutRow, type WorkoutSetRow,
} from '@/lib/recovery/workoutLoads';
import { queryClient } from '@/lib/query';
import { supabase } from '@/lib/supabase';

/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;
/** Workouts per request: each carries its blocks and sets. */
const WORKOUT_PAGE = 100;
/** Workouts per save_workout_loads call. */
const SAVE_BATCH = 50;

export const loadKeys = {
  all: (uid: string) => ['workoutLoads', uid] as const,
};

/** While the recompute rule runs, the figure says "updating…" (Phase 6). */
export const useRecomputeStatus = create<{ running: number; lastError: string | null }>(() => ({ running: 0, lastError: null }));

async function paged<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, size = PAGE): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < size) return out;
  }
}

const EXERCISE_COLUMNS = 'id, slug, measure, load_mode, bw_factor, fatigue, pb_estimate_from, pb_estimate_ratio, is_unilateral';

/** The user's thresholds: the constants with their user_thresholds rows on top. */
export async function fetchThresholds(uid: string): Promise<Thresholds> {
  const { data, error } = await supabase.from('user_thresholds').select('user_id, key, value').eq('user_id', uid);
  if (error) throw error;
  return thresholdsFor(DEFAULT_THRESHOLDS, uid, data);
}

/** Every exercise the user can see (global ones and their own) with its muscles by role. */
export async function fetchLibraryRows(): Promise<{ exercises: ExerciseRow[]; muscles: ExerciseMuscleRow[] }> {
  const [exercises, muscles] = await Promise.all([
    paged<ExerciseRow>((a, b) => supabase.from('exercises').select(EXERCISE_COLUMNS).order('id').range(a, b)),
    paged<ExerciseMuscleRow>((a, b) => supabase.from('exercise_muscles').select('exercise_id, muscle_id, role').order('exercise_id').order('muscle_id').range(a, b)),
  ]);
  return { exercises, muscles };
}

/**
 * Phase 3's repository function: one user's PB history (pb_history: logged sets with an e1RM
 * plus manual PBs), for some exercises or, with null, all of them. toPbHistory() turns the rows
 * into the engine's records.
 */
export async function fetchPbHistoryRows(uid: string, exerciseIds: readonly string[] | null): Promise<PbHistoryRow[]> {
  if (exerciseIds && !exerciseIds.length) return [];
  return paged<PbHistoryRow>((a, b) => {
    let q = supabase.from('pb_history')
      .select('exercise_id, e1rm, at, source, weight_kg, reps, set_type, workout_id, manual_pb_id')
      .eq('user_id', uid);
    if (exerciseIds) q = q.in('exercise_id', [...exerciseIds]);
    // view columns are typed nullable; pb_history's are never null in practice
    return q.order('at', { ascending: true }).range(a, b) as unknown as PromiseLike<{ data: PbHistoryRow[] | null; error: unknown }>;
  });
}

type WorkoutWithSets = WorkoutRow & { workout_exercises: (WorkoutExerciseRow & { workout_sets: WorkoutSetRow[] })[] };

/** Workouts with their blocks and sets: finished ones starting at or after `from`, or the given ids. */
async function fetchWorkouts(uid: string, scope: { from?: string | null; ids?: string[] }) {
  const rows = await paged<WorkoutWithSets>((a, b) => {
    let q = supabase.from('workouts')
      .select('id, started_at, finished_at, bodyweight_kg, workout_exercises(id, workout_id, exercise_id, position, workout_sets(workout_exercise_id, position, set_type, weight_kg, reps, rpe, seconds, side, completed))')
      .eq('user_id', uid);
    if (scope.ids) q = q.in('id', scope.ids);
    else {
      q = q.not('finished_at', 'is', null);
      if (scope.from) q = q.gte('started_at', scope.from);
    }
    return q.order('started_at').range(a, b) as unknown as PromiseLike<{ data: WorkoutWithSets[] | null; error: unknown }>;
  }, WORKOUT_PAGE);
  return {
    workouts: rows.map(({ id, started_at, finished_at, bodyweight_kg }) => ({ id, started_at, finished_at, bodyweight_kg })),
    blocks: rows.flatMap((w) => w.workout_exercises.map(({ id, workout_id, exercise_id, position }) => ({ id, workout_id, exercise_id, position }))),
    sets: rows.flatMap((w) => w.workout_exercises.flatMap((b) => b.workout_sets)),
  };
}

/** Scores stored workouts with the engine: everything scoring needs is fetched first. */
async function scoreStored(uid: string, workouts: Awaited<ReturnType<typeof fetchWorkouts>>): Promise<WorkoutLoads[]> {
  if (!workouts.workouts.length) return [];
  const [thresholds, library, history] = await Promise.all([fetchThresholds(uid), fetchLibraryRows(), fetchPbHistoryRows(uid, null)]);
  return scoreFinishedWorkouts({ thresholds, ...library, ...workouts, history });
}

/**
 * The recompute rule (spec §14): rescore every finished workout that started at or after `from`
 * (all of them with null), in time order, and replace their cached rows. Returns how many were
 * rewritten. Runs in the background; useRecomputeStatus says when it is running.
 */
export async function recomputeFrom(uid: string, from: string | null): Promise<number> {
  useRecomputeStatus.setState((s) => ({ running: s.running + 1 }));
  try {
    const loads = await scoreStored(uid, await fetchWorkouts(uid, { from }));
    for (let i = 0; i < loads.length; i += SAVE_BATCH) {
      const { error } = await supabase.rpc('save_workout_loads', { p_loads: loads.slice(i, i + SAVE_BATCH) as never });
      if (error) throw error;
    }
    useRecomputeStatus.setState({ lastError: null });
    return loads.length;
  } catch (e) {
    useRecomputeStatus.setState({ lastError: e instanceof Error ? e.message : 'Could not update the recovery map' });
    throw e;
  } finally {
    useRecomputeStatus.setState((s) => ({ running: s.running - 1 }));
    void queryClient.invalidateQueries({ queryKey: loadKeys.all(uid) });
  }
}

/** Starts the recompute rule without waiting for it; a failure is kept in useRecomputeStatus. */
export function recomputeInBackground(uid: string, from: string | null): void {
  void recomputeFrom(uid, from).catch(() => undefined);
}

/**
 * Finishes a workout whose sets have all been saved: scores it with t_w = finishedAt and calls
 * finish_workout, which sets finished_at and writes its cache in one transaction (D6). If a
 * finished workout started after this one, the recompute rule rescores from here on.
 */
export async function finishWorkoutRemote(uid: string, workoutId: string, finishedAt: string): Promise<void> {
  const stored = await fetchWorkouts(uid, { ids: [workoutId] });
  const workout = stored.workouts[0];
  if (!workout) throw new Error('This workout has not reached the server yet');
  const [loads] = await scoreStored(uid, { ...stored, workouts: [{ ...workout, finished_at: finishedAt }] });
  const { error } = await supabase.rpc('finish_workout', {
    p_workout_id: workoutId, p_finished_at: finishedAt, p_loads: { muscles: loads.muscles, exercises: loads.exercises } as never,
  });
  if (error) throw error;
  const later = await supabase.from('workouts').select('id', { count: 'exact', head: true })
    .eq('user_id', uid).not('finished_at', 'is', null).gt('started_at', workout.started_at).neq('id', workoutId);
  if (later.count) recomputeInBackground(uid, workout.started_at);
  else void queryClient.invalidateQueries({ queryKey: loadKeys.all(uid) });
}
