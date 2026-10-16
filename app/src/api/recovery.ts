import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useExercises, type Exercise } from '@/api/lifting';
import { useProfile } from '@/api/profile';
import { useLatestWeighIn } from '@/api/wellness';
import { fetchLibraryRows, fetchPbHistoryRows, fetchThresholds, loadKeys, recomputeInBackground } from '@/api/workoutLoads';
import { useNowHour, useNowMinute } from '@/lib/clock';
import { buildLibrary, sessionMap } from '@/lib/recovery/engine';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import { bests, hoursOf, pbHistoryItems, strengthReference, toPbHistory } from '@/lib/recovery/pbHistory';
import {
  historyWindow, isoOfHours, readSpanHours, readWindow, recoveryHistory, recoveryMapAt, sessionMapFromLoads, sessionView,
  type LoadWindow, type RecoveryMap, type RecoverySample, type SessionMap,
} from '@/lib/recovery/read';
import { currentBodyweight, engineKey, exerciseDef, setE1rm } from '@/lib/recovery/sets';
import { thresholdsFor, type Thresholds } from '@/lib/recovery/thresholds';
import type { ExerciseDef, Model } from '@/lib/recovery/types';
import { libraryFromRows, scoreLiveWorkout } from '@/lib/recovery/workoutLoads';
import { queryClient } from '@/lib/query';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { useActiveWorkout } from '@/stores/activeWorkout';

export { fetchPbHistoryRows } from '@/api/workoutLoads';
export type { Contribution, RecoveryMap, RecoveryMuscle, RecoverySample, SessionMap, SessionMapMuscle } from '@/lib/recovery/read';

export const recoveryKeys = {
  thresholds: (uid: string) => ['thresholds', uid] as const,
  pbHistory: (uid: string, exerciseIds: readonly string[]) => ['pbHistory', uid, ...exerciseIds] as const,
  manualPbs: (uid: string) => ['pbHistory', uid, 'manual'] as const,
  allHistory: (uid: string) => ['pbHistory', uid, 'all'] as const,
  libraryRows: () => ['libraryRows'] as const,
  // under loadKeys.all, so finishing a workout, the recompute rule and deletes refresh them
  loads: (uid: string, from: string, to: string | null) => [...loadKeys.all(uid), 'window', from, to] as const,
  session: (uid: string, workoutId: string) => [...loadKeys.all(uid), 'session', workoutId] as const,
};

/** The signed-in user's thresholds: the constants file with their user_thresholds rows on top.
 *  The defaults stand in while the overrides load, or if they fail to. */
export function useThresholds(): Thresholds {
  const uid = useUserId();
  const q = useQuery({
    queryKey: recoveryKeys.thresholds(uid),
    enabled: !!uid,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('user_thresholds').select('user_id, key, value').eq('user_id', uid);
      if (error) throw error;
      return thresholdsFor(DEFAULT_THRESHOLDS, uid, data);
    },
  });
  return q.data ?? DEFAULT_THRESHOLDS;
}

/** The bodyweight a workout snapshots now (D5): profile or latest weigh-in, whichever is newer,
 *  else the constants' default. `ready` is false until both sources have loaded. */
export function useCurrentBodyweight() {
  const c = useThresholds();
  const profile = useProfile();
  const weighIn = useLatestWeighIn();
  const ready = profile.isFetched && weighIn.isFetched;
  return { ...currentBodyweight(c, profile.data, weighIn.data), ready };
}

/** The engine's library, built from the exercises the user can see (muscles are not needed for
 *  PB references, so they are left out until Phase 4 scores workouts). */
export function libraryOf(exercises: readonly Exercise[] | undefined) {
  const defs = new Map<string, ExerciseDef>();
  const keyOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const e of exercises ?? []) {
    const key = engineKey(e);
    keyOf.set(e.id, key);
    nameOf.set(key, e.name);
    const def = exerciseDef(e);
    if (def) defs.set(key, def);
  }
  return { lib: buildLibrary(defs.values()), keyOf, nameOf };
}

/** The exercise and every exercise its PB estimate can reach, as exercise ids. */
function estimateChain(c: Thresholds, exercises: readonly Exercise[], exerciseId: string): string[] {
  const bySlug = new Map(exercises.filter((e) => e.slug).map((e) => [e.slug!, e]));
  const ids = [exerciseId];
  let cur = exercises.find((e) => e.id === exerciseId);
  for (let hops = 0; cur?.pb_estimate_from && hops < c.pb.estimate_max_hops; hops++) {
    cur = bySlug.get(cur.pb_estimate_from);
    if (cur) ids.push(cur.id);
  }
  return ids;
}

/**
 * Everything the PB section of an exercise screen shows: the reference a session starting now
 * would use and where it comes from, the best of the PB window and of all time, and the history
 * list. Null reference for exercises that need none (fixed-cost sets) or that the engine cannot
 * weigh.
 */
export function useStrengthReference(exerciseId: string | undefined) {
  const uid = useUserId();
  const c = useThresholds();
  const exercises = useExercises();
  const nowMs = useNowHour();
  const chain = exerciseId && exercises.data ? estimateChain(c, exercises.data, exerciseId) : [];
  const rows = useQuery({
    queryKey: recoveryKeys.pbHistory(uid, chain),
    enabled: !!uid && chain.length > 0,
    queryFn: () => fetchPbHistoryRows(uid, chain),
  });
  const exercise = exercises.data?.find((e) => e.id === exerciseId);
  if (!exercise || !rows.data) return { isLoading: exercises.isLoading || rows.isLoading, data: null };

  const { lib, keyOf, nameOf } = libraryOf(exercises.data);
  const m: Model = { c, lib };
  const key = engineKey(exercise);
  const def = lib.get(key);
  const history = toPbHistory(rows.data, (id) => keyOf.get(id));
  const now = hoursOf(nowMs);
  const reference = def && def.load_mode !== 'fixed' ? strengthReference(m, key, now, history, (k) => nameOf.get(k)) : null;
  return {
    isLoading: false,
    data: { reference, fixed: def?.load_mode === 'fixed', ...bests(m, history, key, now), items: pbHistoryItems(rows.data, exercise.id) },
  };
}

/** The user's manual PBs, best e1RM per exercise: the "new PB" moment counts them. */
export function useManualBests() {
  const uid = useUserId();
  return useQuery({
    queryKey: recoveryKeys.manualPbs(uid),
    enabled: !!uid,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase.from('manual_pbs').select('exercise_id, e1rm').eq('user_id', uid);
      if (error) throw error;
      const best = new Map<string, number>();
      for (const r of data) if (!best.has(r.exercise_id) || r.e1rm > best.get(r.exercise_id)!) best.set(r.exercise_id, r.e1rm);
      return best;
    },
  });
}

export type KnownBest = { exercise: Exercise; weightKg: number; reps: number; datedAt: string; bodyweightKg: number };

/** "Add a known best": weight × reps on a date, with its e1RM from the engine (bodyweight and
 *  assisted exercises use today's bodyweight, as a logged set would). */
export function useAddManualPb() {
  const uid = useUserId();
  const c = useThresholds();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ exercise, weightKg, reps, datedAt, bodyweightKg }: KnownBest) => {
      const e1rm = setE1rm(c, exerciseDef(exercise), { weightKg, reps, rpe: null }, bodyweightKg);
      if (e1rm == null) throw new Error('That weight and reps give no estimated 1RM for this exercise.');
      const { error } = await supabase.from('manual_pbs').insert({
        user_id: uid, exercise_id: exercise.id, weight_kg: weightKg, reps, e1rm, dated_at: datedAt,
      });
      if (error) throw error;
      return datedAt;
    },
    onSuccess: (datedAt) => {
      qc.invalidateQueries({ queryKey: ['pbHistory', uid] });
      recomputeInBackground(uid, dayBefore(datedAt));   // spec §14: a manual PB moves later references
    },
  });
}

/** The day before a date, as an instant: safely before the start of that date in any time zone. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 3_600_000).toISOString();
}

export function useDeleteManualPb() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('manual_pbs').delete().eq('id', id).select('dated_at');
      if (error) throw error;
      return data[0]?.dated_at ?? null;
    },
    onSuccess: (datedAt) => {
      qc.invalidateQueries({ queryKey: ['pbHistory', uid] });
      if (datedAt) recomputeInBackground(uid, dayBefore(datedAt));
    },
  });
}

/**
 * The workout in progress, scored on the fly with t_w = now (build phase 4): its ticked sets
 * against the PB history, and its session view. Null without a workout or before the library
 * and history have loaded. Nothing is cached until Finish.
 */
export function useLiveSession() {
  const uid = useUserId();
  const c = useThresholds();
  const workout = useActiveWorkout((s) => s.workout);
  const nowMs = useNowHour();
  const library = useLibraryRows(!!workout);
  const history = useQuery({
    queryKey: recoveryKeys.allHistory(uid), queryFn: () => fetchPbHistoryRows(uid, null), enabled: !!uid && !!workout,
  });
  if (!workout || !library.data || !history.data) return null;
  const { lib, keyOf } = libraryFromRows(library.data.exercises, library.data.muscles);
  const m: Model = { c, lib };
  const scored = scoreLiveWorkout(m, workout, toPbHistory(history.data, (id) => keyOf.get(id)), hoursOf(nowMs));
  return { scored, session: sessionView(sessionMap(m, scored)) };
}

// ---------------------------------------------------------------- the read side (build phase 5)
//
// recovery_map(user, at), session_map(workout) and recovery_history(user, from, to, step) as
// repository functions (fetch…) and hooks (use…). There is no app server, so this is the "local
// store" of the plan: the cached rows come from recovery_loads() and workout_muscle_loads, and the
// engine works out the rest here (src/lib/recovery/read.ts). Times are ISO strings or epoch ms.

const LIBRARY_STALE_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const NO_LIBRARY = buildLibrary([]);

/** Every exercise the user can see with its muscles by role, cached for ten minutes. */
export function useLibraryRows(enabled = true) {
  return useQuery({ queryKey: recoveryKeys.libraryRows(), queryFn: fetchLibraryRows, staleTime: LIBRARY_STALE_MS, enabled });
}

/** recovery_loads(): the caller's cached loads for workouts finished in (from, to]; to null = no upper bound. */
export async function fetchRecoveryLoads(from: string, to: string | null): Promise<LoadWindow> {
  const { data, error } = await supabase.rpc('recovery_loads', to ? { p_from: from, p_to: to } : { p_from: from });
  if (error) throw error;
  return data as unknown as LoadWindow;
}

/** One workout's workout_muscle_loads rows. */
async function fetchSessionRows(workoutId: string) {
  const { data, error } = await supabase.from('workout_muscle_loads').select('muscle_id, load, recovery_hours').eq('workout_id', workoutId);
  if (error) throw error;
  return data;
}

async function readModel(uid: string) {
  const [c, library] = await Promise.all([
    fetchThresholds(uid),
    queryClient.fetchQuery({ queryKey: recoveryKeys.libraryRows(), queryFn: fetchLibraryRows, staleTime: LIBRARY_STALE_MS }),
  ]);
  const { lib, keyOf } = libraryFromRows(library.exercises, library.muscles);
  return { m: { c, lib } satisfies Model, keyOf };
}

/** recovery_map(user, at = now): every muscle at that instant, with its contributing exercises. */
export async function fetchRecoveryMap(uid: string, at: string | number = Date.now()): Promise<RecoveryMap> {
  const { m, keyOf } = await readModel(uid);
  const t = hoursOf(at);
  const w = readWindow(m, t);
  return recoveryMapAt(m, keyOf, await fetchRecoveryLoads(isoOfHours(w.from), isoOfHours(w.to)), t);
}

/** session_map(workout): a finished workout's own loads, from its cache rows. */
export async function fetchSessionMap(uid: string, workoutId: string): Promise<SessionMap> {
  const [c, rows] = await Promise.all([fetchThresholds(uid), fetchSessionRows(workoutId)]);
  return sessionMapFromLoads({ c, lib: NO_LIBRARY }, rows);
}

/** recovery_history(user, from, to, step = 24 h): recovery_map at to, to − step, … after from, oldest first. */
export async function fetchRecoveryHistory(uid: string, from: string | number, to: string | number, stepHours = 24): Promise<RecoverySample[]> {
  const { m, keyOf } = await readModel(uid);
  const [f, t] = [hoursOf(from), hoursOf(to)];
  const w = historyWindow(m, f, t);
  return recoveryHistory(m, keyOf, await fetchRecoveryLoads(isoOfHours(w.from), isoOfHours(w.to)), f, t, stepHours);
}

/**
 * recovery_map at `at`, or at now (to the minute) without one. A fixed instant reads exactly its
 * window. "Now" reads from an hour-aligned start with no end, so the clock moving on recomputes
 * the map without refetching; finishing a workout refetches it (loadKeys.all).
 */
export function useRecoveryMap(at?: string | number) {
  const uid = useUserId();
  const c = useThresholds();
  const nowMs = useNowMinute();
  const library = useLibraryRows();
  const atH = hoursOf(at ?? nowMs);
  const span = readSpanHours({ c, lib: NO_LIBRARY });
  const from = isoOfHours(at == null ? Math.floor(nowMs / HOUR_MS) - span - 1 : atH - span);
  const to = at == null ? null : isoOfHours(atH);
  const loads = useQuery({ queryKey: recoveryKeys.loads(uid, from, to), enabled: !!uid, queryFn: () => fetchRecoveryLoads(from, to) });
  const error = library.error ?? loads.error;
  if (!library.data || !loads.data) return { isLoading: library.isLoading || loads.isLoading, error, at: isoOfHours(atH), data: null };
  const { lib, keyOf } = libraryFromRows(library.data.exercises, library.data.muscles);
  return { isLoading: false, error, at: isoOfHours(atH), data: recoveryMapAt({ c, lib }, keyOf, loads.data, atH) };
}

/** session_map of a finished workout. */
export function useSessionMap(workoutId: string | undefined) {
  const uid = useUserId();
  const c = useThresholds();
  const rows = useQuery({
    queryKey: recoveryKeys.session(uid, workoutId ?? ''), enabled: !!uid && !!workoutId, queryFn: () => fetchSessionRows(workoutId!),
  });
  if (!rows.data) return { isLoading: rows.isLoading, error: rows.error, data: null };
  return { isLoading: false, error: rows.error, data: sessionMapFromLoads({ c, lib: NO_LIBRARY }, rows.data) };
}

/** recovery_history from `from` to `to` (ISO or epoch ms), every `stepHours`. */
export function useRecoveryHistory(from: string | number, to: string | number, stepHours = 24) {
  const uid = useUserId();
  const c = useThresholds();
  const library = useLibraryRows();
  const [f, t] = [hoursOf(from), hoursOf(to)];
  const w = historyWindow({ c, lib: NO_LIBRARY }, f, t);
  const [wFrom, wTo] = [isoOfHours(w.from), isoOfHours(w.to)];
  const loads = useQuery({ queryKey: recoveryKeys.loads(uid, wFrom, wTo), enabled: !!uid, queryFn: () => fetchRecoveryLoads(wFrom, wTo) });
  const error = library.error ?? loads.error;
  if (!library.data || !loads.data) return { isLoading: library.isLoading || loads.isLoading, error, data: null };
  const { lib, keyOf } = libraryFromRows(library.data.exercises, library.data.muscles);
  return { isLoading: false, error, data: recoveryHistory({ c, lib }, keyOf, loads.data, f, t, stepHours) };
}
