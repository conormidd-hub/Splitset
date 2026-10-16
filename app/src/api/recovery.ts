import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useExercises, type Exercise } from '@/api/lifting';
import { useProfile } from '@/api/profile';
import { useLatestWeighIn } from '@/api/wellness';
import { useNowHour } from '@/lib/clock';
import { buildLibrary } from '@/lib/recovery/engine';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import { bests, hoursOf, pbHistoryItems, strengthReference, toPbHistory, type PbHistoryRow } from '@/lib/recovery/pbHistory';
import { currentBodyweight, engineKey, exerciseDef, setE1rm } from '@/lib/recovery/sets';
import { thresholdsFor, type Thresholds } from '@/lib/recovery/thresholds';
import type { ExerciseDef, Model } from '@/lib/recovery/types';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export const recoveryKeys = {
  thresholds: (uid: string) => ['thresholds', uid] as const,
  pbHistory: (uid: string, exerciseIds: readonly string[]) => ['pbHistory', uid, ...exerciseIds] as const,
  manualPbs: (uid: string) => ['pbHistory', uid, 'manual'] as const,
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

/**
 * Phase 3's repository function: one user's PB history (pb_history: logged sets with an e1RM
 * plus manual PBs) for a set of exercises, as raw rows. toPbHistory() turns them into the
 * engine's records. Paged, since PostgREST returns at most 1000 rows per request.
 */
export async function fetchPbHistoryRows(uid: string, exerciseIds: readonly string[]): Promise<PbHistoryRow[]> {
  const PAGE = 1000;
  const out: PbHistoryRow[] = [];
  if (!exerciseIds.length) return out;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('pb_history')
      .select('exercise_id, e1rm, at, source, weight_kg, reps, set_type, workout_id, manual_pb_id')
      .eq('user_id', uid)
      .in('exercise_id', [...exerciseIds])
      .order('at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data as PbHistoryRow[]));
    if (data.length < PAGE) return out;
  }
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
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pbHistory', uid] }),
  });
}

export function useDeleteManualPb() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('manual_pbs').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pbHistory', uid] }),
  });
}
