import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { RUN_TYPES } from './activities';
import { todayIso } from '@/lib/dates';
import { rangeStart, type RunTrendRow } from '@/lib/runTrends';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/** The run columns the Run tab's Trends read; heavier than the list's, so only for the range on show. */
const TREND_COLUMNS =
  'id, start_time_local, distance_m, moving_time_s, avg_hr, cadence, elev_gain_m, hr_zone_times, stride_m, gct_ms, vert_osc_cm, avg_power_w' as const;

/** Supabase hands back at most this many rows a request, so longer lists are read in pages. */
const PAGE = 1000;

export const runTrendKeys = {
  /** Every range's rows, to refresh them all at once. */
  allRows: (uid: string) => ['runTrends', uid] as const,
  rows: (uid: string, days: number) => ['runTrends', uid, days] as const,
  dates: (uid: string) => ['runDates', uid] as const,
};

/**
 * Every run in the last `days` days (0: all of them), oldest first, with the columns the Trends
 * charts need. The last range stays on screen while the next loads, so a range chip never blanks
 * the charts.
 */
export function useRunTrendRows(days: number) {
  const uid = useUserId();
  return useQuery({
    queryKey: runTrendKeys.rows(uid, days),
    enabled: !!uid,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<RunTrendRow[]> => {
      const out: RunTrendRow[] = [];
      // from the range's first Monday, the same day its weekly charts start on
      const since = rangeStart(days, todayIso());
      for (let from = 0; ; from += PAGE) {
        let q = supabase
          .from('activities')
          .select(TREND_COLUMNS)
          .eq('user_id', uid)
          .in('type', RUN_TYPES);
        if (since) q = q.gte('start_time_local', `${since}T00:00:00`);
        const { data, error } = await q.order('start_time_local', { ascending: true }).order('id').range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...data);
        if (data.length < PAGE) break;
      }
      return out;
    },
  });
}

/** A run as the calendar needs it: when, what, how far and how long. */
export type RunDate = { id: string; start_time_local: string; name: string | null; distance_m: number | null; moving_time_s: number | null };

/** Every run, newest first, lightly: the Run tab's calendar puts a dot on each one's day. */
export function useRunDates() {
  const uid = useUserId();
  return useQuery({
    queryKey: runTrendKeys.dates(uid),
    enabled: !!uid,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<RunDate[]> => {
      const out: RunDate[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('activities')
          .select('id, start_time_local, name, distance_m, moving_time_s')
          .eq('user_id', uid)
          .in('type', RUN_TYPES)
          .order('start_time_local', { ascending: false })
          .order('id')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...data);
        if (data.length < PAGE) break;
      }
      return out;
    },
  });
}
