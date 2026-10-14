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

/** The detail columns the run screen reads directly; polyline and samples come through useTrack instead. */
export type ActivitySummaryDetails = Pick<ActivityDetails, 'has_streams' | 'splits' | 'best_efforts' | 'fetched_at'>;
export type ActivityWithDetails = Activity & { activity_details: ActivitySummaryDetails | null };

export function useActivity(id: string | undefined) {
  return useQuery({
    queryKey: keys.activity(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<ActivityWithDetails> => {
      const { data, error } = await supabase
        .from('activities')
        .select('*, activity_details(has_streams, splits, best_efforts, fetched_at)')
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

/** A run's GPS trace with the few activity columns the heat map labels and filters on. */
export type RunRoute = {
  activity_id: string;
  polyline: string;
  bbox: [number, number, number, number] | null;
  /** activity_details.fetched_at: the segment scan watermark compares against this. */
  fetched_at: string;
  type: string;
  name: string | null;
  start_time_local: string;
  distance_m: number | null;
  moving_time_s: number | null;
  avg_hr: number | null;
  elev_gain_m: number | null;
};

type RunRouteRow = {
  activity_id: string;
  polyline: string;
  bbox: number[] | null;
  fetched_at: string;
  activities: {
    type: string;
    name: string | null;
    start_time_local: string;
    distance_m: number | null;
    moving_time_s: number | null;
    avg_hr: number | null;
    elev_gain_m: number | null;
  };
};

const ROUTE_PAGE = 500;

/**
 * Every run that has a route, oldest first. Fetched in pages of 500 so the Supabase row cap never
 * truncates it; a season of running is a few megabytes of polylines, cached for the session.
 */
export function useRunRoutes() {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.runRoutes(uid),
    enabled: !!uid,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<RunRoute[]> => {
      const out: RunRoute[] = [];
      for (let from = 0; ; from += ROUTE_PAGE) {
        const { data, error } = await supabase
          .from('activity_details')
          .select(
            'activity_id, polyline, bbox, fetched_at, activities!inner(type, name, start_time_local, distance_m, moving_time_s, avg_hr, elev_gain_m)',
          )
          .eq('user_id', uid)
          .not('polyline', 'is', null)
          .in('activities.type', RUN_TYPES)
          .order('activity_id')
          .range(from, from + ROUTE_PAGE - 1);
        if (error) throw error;
        for (const row of data as unknown as RunRouteRow[]) {
          out.push({
            activity_id: row.activity_id,
            polyline: row.polyline,
            bbox: row.bbox && row.bbox.length === 4 ? (row.bbox as [number, number, number, number]) : null,
            fetched_at: row.fetched_at,
            type: row.activities.type,
            name: row.activities.name,
            start_time_local: row.activities.start_time_local,
            distance_m: row.activities.distance_m,
            moving_time_s: row.activities.moving_time_s,
            avg_hr: row.activities.avg_hr,
            elev_gain_m: row.activities.elev_gain_m,
          });
        }
        if (data.length < ROUTE_PAGE) break;
      }
      return out.sort((a, b) => a.start_time_local.localeCompare(b.start_time_local));
    },
  });
}
