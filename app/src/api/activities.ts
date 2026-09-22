import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { keys } from './keys';
import { daysAgoIso } from '@/lib/dates';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables } from '@/types/database';

export type Activity = Tables<'activities'>;
export type ActivityDetails = Tables<'activity_details'>;

/** Columns the list screens need; the full row is fetched per activity on demand. */
export const LIST_COLUMNS =
  'id, start_time, start_time_local, type, name, distance_m, moving_time_s, elapsed_time_s, avg_hr, max_hr, load, elev_gain_m, cadence' as const;

export type ActivityListRow = Pick<
  Activity,
  | 'id' | 'start_time' | 'start_time_local' | 'type' | 'name' | 'distance_m' | 'moving_time_s'
  | 'elapsed_time_s' | 'avg_hr' | 'max_hr' | 'load' | 'elev_gain_m' | 'cadence'
>;

export const RUN_TYPES = ['Run', 'VirtualRun', 'TrailRun'] as const;

export type ActivityFilter = 'all' | 'runs' | 'strength' | 'other';

const PAGE = 40;

function applyFilter<T extends { in: (col: string, vals: readonly string[]) => T; not: (col: string, op: string, val: string) => T }>(
  q: T,
  filter: ActivityFilter,
): T {
  if (filter === 'runs') return q.in('type', RUN_TYPES);
  if (filter === 'strength') return q.in('type', ['WeightTraining', 'Workout']);
  if (filter === 'other') return q.not('type', 'in', `(${[...RUN_TYPES, 'WeightTraining', 'Workout'].join(',')})`);
  return q;
}

export function useActivities(filter: ActivityFilter = 'all') {
  const uid = useUserId();
  return useInfiniteQuery({
    queryKey: keys.activities(uid, filter),
    enabled: !!uid,
    initialPageParam: 0,
    getNextPageParam: (last: ActivityListRow[], pages) => (last.length < PAGE ? undefined : pages.length * PAGE),
    queryFn: async ({ pageParam }): Promise<ActivityListRow[]> => {
      let q = supabase
        .from('activities')
        .select(LIST_COLUMNS)
        .eq('user_id', uid)
        .order('start_time', { ascending: false })
        .range(pageParam, pageParam + PAGE - 1);
      q = applyFilter(q, filter);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

/** Everything from the last N days, oldest first, for Today's summaries. */
export function useRecentActivities(days = 14) {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.recentActivities(uid, days),
    enabled: !!uid,
    queryFn: async (): Promise<ActivityListRow[]> => {
      const { data, error } = await supabase
        .from('activities')
        .select(LIST_COLUMNS)
        .eq('user_id', uid)
        .gte('start_time_local', `${daysAgoIso(days)}T00:00:00`)
        .order('start_time', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export type ActivityWithDetails = Activity & { activity_details: ActivityDetails | null };

export function useActivity(id: string | undefined) {
  return useQuery({
    queryKey: keys.activity(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<ActivityWithDetails> => {
      const { data, error } = await supabase
        .from('activities')
        .select('*, activity_details(*)')
        .eq('id', id!)
        .single();
      if (error) throw error;
      return data as unknown as ActivityWithDetails;
    },
  });
}

export function isRun(type: string | null | undefined): boolean {
  return (RUN_TYPES as readonly string[]).includes(type ?? '');
}

/** Human label for an intervals.icu activity type: "VirtualRun" -> "Virtual run". */
export function typeLabel(type: string | null | undefined): string {
  if (!type) return 'Activity';
  const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
