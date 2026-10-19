// Build phase 4 in the app: score a workout as it finishes and cache its loads in the same
// transaction (finish_workout), and the recompute rule of spec §14 (save_workout_loads).
// Plain async functions, not hooks, because the workout store's save queue calls them too.
// The scoring is src/lib/recovery/workoutLoads.ts, the same code the Python scripts use.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { activityChanges, CARDIO_TYPES, type ActivityLoadRow, type ActivityRow } from '@/lib/recovery/cardio';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import { historyScope, type PbHistoryRow } from '@/lib/recovery/pbHistory';
import { mergeOwed, recomputeQueue, serialQueue, unscoredFrom, type From, type OwedStore } from '@/lib/recovery/pending';
import type { ExerciseMuscleRow, ExerciseRow } from '@/lib/recovery/sets';
import { thresholdsFor, type Thresholds } from '@/lib/recovery/thresholds';
import {
  libraryFromRows, scoreFinishedWorkouts, type WorkoutExerciseRow, type WorkoutLoads, type WorkoutRow, type WorkoutSetRow,
} from '@/lib/recovery/workoutLoads';
import { queryClient } from '@/lib/query';
import { storage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;
/** Workouts per request: each carries its blocks and sets. */
const WORKOUT_PAGE = 100;
/** Workouts per save_workout_loads call. */
const SAVE_BATCH = 50;
/** Ids per in() filter, so the request URL stays short. */
const ID_CHUNK = 100;

export const loadKeys = {
  all: (uid: string) => ['workoutLoads', uid] as const,
};

/** While a cache writer runs, the figure says "updating…" (Phase 6). `recomputing` counts only the
 *  recompute rule (Settings says "Rescoring your workouts…"); the catch-up keeps its own error. */
export const useRecomputeStatus = create<{ running: number; recomputing: number; lastError: string | null; catchUpError: string | null }>(
  () => ({ running: 0, recomputing: 0, lastError: null, catchUpError: null }),
);

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
 * plus manual PBs), for some exercises or, with null, all of them, and only before `before` when
 * given. toPbHistory() turns the rows into the engine's records.
 */
export async function fetchPbHistoryRows(uid: string, exerciseIds: readonly string[] | null, before?: string): Promise<PbHistoryRow[]> {
  if (exerciseIds && !exerciseIds.length) return [];
  return paged<PbHistoryRow>((a, b) => {
    let q = supabase.from('pb_history')
      .select('exercise_id, e1rm, at, source, weight_kg, reps, set_type, workout_id, manual_pb_id')
      .eq('user_id', uid);
    if (exerciseIds) q = q.in('exercise_id', [...exerciseIds]);
    if (before) q = q.lt('at', before);
    // every set of a workout shares its `at`; set_id (logged) and manual_pb_id (manual) make the
    // order total, so a page boundary inside one workout can't repeat or skip its sets
    return q.order('at', { ascending: true }).order('set_id', { ascending: true }).order('manual_pb_id', { ascending: true })
      // view columns are typed nullable; pb_history's are never null in practice
      .range(a, b) as unknown as PromiseLike<{ data: PbHistoryRow[] | null; error: unknown }>;
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
    return q.order('started_at').order('id').range(a, b) as unknown as PromiseLike<{ data: WorkoutWithSets[] | null; error: unknown }>;
  }, WORKOUT_PAGE);
  return {
    workouts: rows.map(({ id, started_at, finished_at, bodyweight_kg }) => ({ id, started_at, finished_at, bodyweight_kg })),
    blocks: rows.flatMap((w) => w.workout_exercises.map(({ id, workout_id, exercise_id, position }) => ({ id, workout_id, exercise_id, position }))),
    sets: rows.flatMap((w) => w.workout_exercises.flatMap((b) => b.workout_sets)),
  };
}

/** Scores stored workouts with the engine against the whole PB history. */
async function scoreStored(uid: string, thresholds: Thresholds, workouts: Awaited<ReturnType<typeof fetchWorkouts>>): Promise<WorkoutLoads[]> {
  if (!workouts.workouts.length) return [];
  const [library, history] = await Promise.all([fetchLibraryRows(), fetchPbHistoryRows(uid, null)]);
  return scoreFinishedWorkouts({ thresholds, ...library, ...workouts, history });
}

// ---------------------------------------------------------------- one cache writer at a time

/** The recompute rule and the catch-ups all run through this queue (src/lib/recovery/pending.ts),
 *  so two never replace the same rows at once and each reads the thresholds when its turn comes. */
const serial = serialQueue();

let markLoaded = () => {};
/** Settles once what a previous session owed has been read from storage (or that failed). */
const loaded = new Promise<void>((resolve) => { markLoaded = resolve; });

/** What the recompute rule still owes each user on this device, kept across restarts so a run
 *  that failed or was cut short is done again. */
const useOwedRecomputes = create<{ owed: Record<string, From> }>()(persist(() => ({ owed: {} }), {
  name: 'splitset-owed-recomputes',
  storage: createJSONStorage(() => storage),
  // a recompute asked for before the stored state loaded is owed as well
  merge: (stored, current) => ({ ...current, owed: mergeOwed((stored as { owed?: Record<string, From> } | undefined)?.owed ?? {}, current.owed) }),
  onRehydrateStorage: () => () => markLoaded(),
}));
// no writer starts before then, so no run clears an owed range it didn't cover; and none waits
// on a storage that never answers
void serial(() => loaded);
setTimeout(() => markLoaded(), 5_000);

const owedStore: OwedStore = {
  get: (uid) => useOwedRecomputes.getState().owed[uid],
  set: (uid, from) => useOwedRecomputes.setState((s) => {
    const owed = { ...s.owed };
    if (from === undefined) delete owed[uid];
    else owed[uid] = from;
    return { owed };
  }),
};

// ---------------------------------------------------------------- imported activities (build phase 10)

const ACTIVITY_COLUMNS = 'id, type, name, start_time, moving_time_s, elapsed_time_s, hr_zone_times';

/** All of the user's countable activities (runs, rides, swims, hikes, rows). */
async function fetchActivities(uid: string): Promise<ActivityRow[]> {
  return paged<ActivityRow>((a, b) => supabase.from('activities').select(ACTIVITY_COLUMNS).eq('user_id', uid).in('type', [...CARDIO_TYPES])
    .order('start_time').order('id').range(a, b) as unknown as PromiseLike<{ data: ActivityRow[] | null; error: unknown }>);
}

/**
 * Brings the user's activity rows in line with their activities (activityChanges): scores the
 * new ones and any changed since they were scored, clears the ones that no longer count. With
 * cardio off (the user's cardio.enabled_default) it clears every activity row instead, without
 * reading the activities. Returns how many activities it wrote.
 */
async function saveActivityChanges(uid: string, c: Thresholds): Promise<number> {
  if (!c.cardio.enabled_default) {
    const { data, error } = await supabase.rpc('clear_activity_loads');
    if (error) throw error;
    return data ?? 0;
  }
  const [acts, rows] = await Promise.all([
    fetchActivities(uid),
    paged<ActivityLoadRow>((a, b) => supabase.from('workout_muscle_loads').select('activity_id, muscle_id, load, recovery_hours, finished_at')
      .eq('user_id', uid).eq('source', 'activity').order('id').range(a, b)),
  ]);
  const changes = activityChanges({ c, lib: new Map() }, acts, rows);
  for (let i = 0; i < changes.length; i += SAVE_BATCH) {
    const { error } = await supabase.rpc('save_activity_loads', { p: changes.slice(i, i + SAVE_BATCH) as never });
    if (error) throw error;
  }
  return changes.length;
}

/** Per user, the finished workouts this session found to score nothing (empty, or only legacy or
 *  unmapped exercises): they never get cache rows, so the catch-up stops reading their blocks.
 *  Editing a custom exercise rescores from its first use itself, and the next start looks again. */
const unscorable = new Map<string, Set<string>>();

/**
 * Where the recompute rule must start so every finished workout has cache rows (pending.ts
 * unscoredFrom): one finished by an older app has none, since only finish_workout() writes them.
 */
async function unscoredWorkoutsFrom(uid: string): Promise<string | undefined> {
  const [workouts, scored] = await Promise.all([
    paged<{ id: string; started_at: string }>((a, b) => supabase.from('workouts').select('id, started_at')
      .eq('user_id', uid).not('finished_at', 'is', null).order('started_at').order('id').range(a, b)),
    paged<{ workout_id: string }>((a, b) => supabase.from('workout_exercise_loads').select('workout_id')
      .eq('user_id', uid).order('workout_id').order('exercise_id').range(a, b)),
  ]);
  const scoredIds = new Set(scored.map((r) => r.workout_id));
  const known = unscorable.get(uid) ?? new Set<string>();
  const missing = workouts.filter((w) => !scoredIds.has(w.id) && !known.has(w.id));
  if (!missing.length) return undefined;
  const ids = missing.map((w) => w.id);
  const [library, ...blocks] = await Promise.all([
    // recoveryKeys.libraryRows(uid), written out since api/recovery.ts imports this file
    queryClient.fetchQuery({ queryKey: ['libraryRows', uid], queryFn: fetchLibraryRows, staleTime: 10 * 60_000 }),
    ...Array.from({ length: Math.ceil(ids.length / ID_CHUNK) }, (_, i) => paged<{ workout_id: string; exercise_id: string }>((a, b) =>
      supabase.from('workout_exercises').select('workout_id, exercise_id').in('workout_id', ids.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK))
        .order('id').range(a, b))),
  ]);
  const { lib, keyOf } = libraryFromRows(library.exercises, library.muscles);
  const found = unscoredFrom(missing, scoredIds, blocks.flat(), (id) => lib.has(keyOf.get(id) ?? ''));
  for (const id of found.unscorable) known.add(id);
  unscorable.set(uid, known);
  return found.from;
}

let lastCatchUp: { uid: string; at: number } | null = null;
/** How often the catch-up may run on its own, at most. */
const CATCH_UP_EVERY_MS = 10 * 60_000;

/**
 * The catch-up. Brings imported activities in line (scores new and changed ones, clears ones that
 * no longer count, or clears them all when cardio is off), and starts the recompute rule for any
 * finished workout with no cache rows, and for a recompute that failed or was cut short. The
 * Recovery screen and the Today card start it; it runs at most every ten minutes per user unless
 * `force`d, and again on the next start after it fails. Runs in the background and reports
 * through useRecomputeStatus (catchUpError for its own failures).
 */
export async function catchUpActivities(uid: string, force = false): Promise<void> {
  const now = Date.now();
  if (!uid || (!force && lastCatchUp?.uid === uid && now - lastCatchUp.at < CATCH_UP_EVERY_MS)) return;
  lastCatchUp = { uid, at: now };
  retryOwedRecompute(uid);
  useRecomputeStatus.setState((s) => ({ running: s.running + 1 }));
  try {
    // queued behind any recompute, so it reads the thresholds and the rows that one left
    const unscored = await serial(async () => {
      if (await saveActivityChanges(uid, await fetchThresholds(uid))) void queryClient.invalidateQueries({ queryKey: loadKeys.all(uid) });
      return unscoredWorkoutsFrom(uid);
    });
    useRecomputeStatus.setState({ catchUpError: null });
    if (unscored !== undefined) recomputeInBackground(uid, unscored);
  } catch (e) {
    if (lastCatchUp?.uid === uid) lastCatchUp = null;   // the next screen to open tries again
    useRecomputeStatus.setState({ catchUpError: e instanceof Error ? e.message : 'Could not add your activities' });
  } finally {
    useRecomputeStatus.setState((s) => ({ running: s.running - 1 }));
  }
}

// ---------------------------------------------------------------- the recompute rule

/** One run of the recompute rule, from `from`; recomputeFrom queues it. */
async function runRecompute(uid: string, from: From): Promise<number> {
  try {
    const [c, workouts] = await Promise.all([fetchThresholds(uid), fetchWorkouts(uid, { from })]);
    const loads = await scoreStored(uid, c, workouts);
    for (let i = 0; i < loads.length; i += SAVE_BATCH) {
      const { error } = await supabase.rpc('save_workout_loads', { p_loads: loads.slice(i, i + SAVE_BATCH) as never });
      if (error) throw error;
    }
    // imported activities follow the same thresholds (build phase 10): every one whose rows no
    // longer match, whenever it started, and every one that stopped counting
    await saveActivityChanges(uid, c);
    useRecomputeStatus.setState({ lastError: null });
    return loads.length;
  } catch (e) {
    useRecomputeStatus.setState({ lastError: e instanceof Error ? e.message : 'Could not update the recovery map' });
    throw e;
  } finally {
    void queryClient.invalidateQueries({ queryKey: loadKeys.all(uid) });
  }
}

const recomputes = recomputeQueue(serial, owedStore, runRecompute);

/**
 * The recompute rule (spec §14): rescore every finished workout that started at or after `from`
 * (all of them with null), in time order, and replace their cached rows. Returns how many were
 * rewritten. Runs one at a time with the other cache writers: a request made while another waits
 * joins it (from the earlier start), and a range a failed run left is redone by the next run.
 * useRecomputeStatus says when one is queued or running.
 */
export function recomputeFrom(uid: string, from: string | null): Promise<number> {
  useRecomputeStatus.setState((s) => ({ running: s.running + 1, recomputing: s.recomputing + 1 }));
  const done = recomputes.request(uid, from);
  const settled = () => useRecomputeStatus.setState((s) => ({ running: s.running - 1, recomputing: s.recomputing - 1 }));
  done.then(settled, settled);
  return done;
}

/** Starts the recompute rule without waiting for it; a failure is kept in useRecomputeStatus. */
export function recomputeInBackground(uid: string, from: string | null): void {
  void recomputeFrom(uid, from).catch(() => undefined);
}

/** Runs again what the recompute rule still owes the user (a run that failed, or that the app was
 *  closed in the middle of), unless one of theirs is already queued or running. */
export function retryOwedRecompute(uid: string): void {
  void loaded.then(() => {
    const from = recomputes.retryFrom(uid);
    if (from !== undefined) recomputeInBackground(uid, from);
  });
}

/**
 * Finishes a workout whose sets have all been saved: scores it with t_w = finishedAt and calls
 * finish_workout, which sets finished_at and writes its cache in one transaction (D6). If a
 * finished workout started after this one (or that can't be checked), the recompute rule
 * rescores from here on.
 */
export async function finishWorkoutRemote(uid: string, workoutId: string, finishedAt: string): Promise<void> {
  const stored = await fetchWorkouts(uid, { ids: [workoutId] });
  const workout = stored.workouts[0];
  if (!workout) throw new Error('This workout has not reached the server yet');
  // only the history this workout's references can come from: its exercises and their estimate
  // chains, before it started
  const [thresholds, library] = await Promise.all([fetchThresholds(uid), fetchLibraryRows()]);
  const { lib, keyOf } = libraryFromRows(library.exercises, library.muscles);
  const history = await fetchPbHistoryRows(uid, historyScope({ c: thresholds, lib }, keyOf, stored.blocks.map((b) => b.exercise_id)), workout.started_at);
  const [loads] = scoreFinishedWorkouts({ thresholds, ...library, ...stored, workouts: [{ ...workout, finished_at: finishedAt }], history });
  const { error } = await supabase.rpc('finish_workout', {
    p_workout_id: workoutId, p_finished_at: finishedAt, p_loads: { muscles: loads.muscles, exercises: loads.exercises } as never,
  });
  if (error) throw error;
  const later = await supabase.from('workouts').select('id', { count: 'exact', head: true })
    .eq('user_id', uid).not('finished_at', 'is', null).gt('started_at', workout.started_at).neq('id', workoutId);
  if (later.error || later.count) recomputeInBackground(uid, workout.started_at);
  else void queryClient.invalidateQueries({ queryKey: loadKeys.all(uid) });
}
