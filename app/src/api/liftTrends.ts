import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { liftKeys, type WorkoutSummary } from '@/api/lifting';
import type { ProgressSet } from '@/lib/lifting/progression';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/** A finished workout as the Lift tab lists it. */
export type WorkoutListRow = Pick<WorkoutSummary, 'id' | 'name' | 'started_at' | 'duration_s' | 'sets_completed' | 'volume_kg'>;

const LIST_COLUMNS = 'id, name, started_at, duration_s, sets_completed, volume_kg';
/** Workouts per page of the History tab. */
const HISTORY_PAGE = 30;
/** Rows per request when reading everything (the API returns at most 1000 at a time). */
const READ_PAGE = 1000;

async function paged<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await page(from, from + READ_PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < READ_PAGE) return out;
  }
}

// Every key here sits under one invalidateWorkoutData() already refreshes (workouts, exerciseHistory),
// so a finished, edited or deleted workout moves them too.

/** The History tab: finished workouts, newest first, a page at a time. */
export function useWorkoutPages() {
  const uid = useUserId();
  return useInfiniteQuery({
    queryKey: [...liftKeys.workouts(uid), 'pages'],
    enabled: !!uid,
    initialPageParam: 0,
    getNextPageParam: (last: WorkoutListRow[], pages) => (last.length < HISTORY_PAGE ? undefined : pages.length * HISTORY_PAGE),
    queryFn: async ({ pageParam }): Promise<WorkoutListRow[]> => {
      const { data, error } = await supabase
        .from('workout_summaries')
        .select(LIST_COLUMNS)
        .eq('user_id', uid)
        .not('finished_at', 'is', null)
        .order('started_at', { ascending: false })
        .order('id')
        .range(pageParam, pageParam + HISTORY_PAGE - 1);
      if (error) throw error;
      return data;
    },
  });
}

/** Every finished workout, for the calendar that finds one by its day. Read once it is first opened. */
export function useWorkoutDays(enabled: boolean) {
  const uid = useUserId();
  return useQuery({
    queryKey: [...liftKeys.workouts(uid), 'days'],
    enabled: !!uid && enabled,
    queryFn: () => paged<WorkoutListRow>((from, to) => supabase
      .from('workout_summaries')
      .select(LIST_COLUMNS)
      .eq('user_id', uid)
      .not('finished_at', 'is', null)
      .order('started_at', { ascending: false })
      .order('id')
      .range(from, to)),
  });
}

/**
 * Every completed working set of one exercise with its workout's start, finish and bodyweight
 * snapshot: what its progression chart is drawn from (src/lib/lifting/progression.ts). All of it,
 * so changing the chart's range needs no new read.
 */
export function useLiftProgress(exerciseId: string | undefined) {
  const uid = useUserId();
  return useQuery({
    queryKey: [...liftKeys.exerciseHistory(uid, exerciseId ?? ''), 'progress'],
    enabled: !!uid && !!exerciseId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ProgressSet[]> => {
      const rows = await paged((from, to) => supabase
        .from('workout_sets')
        .select('workout_id, set_type, weight_kg, reps, rpe, e1rm, side, workout:workouts!inner(started_at, finished_at, bodyweight_kg)')
        .eq('user_id', uid)
        .eq('exercise_id', exerciseId!)
        .eq('completed', true)
        .neq('set_type', 'warmup')
        .order('id')
        .range(from, to));
      return rows as unknown as ProgressSet[];
    },
  });
}
