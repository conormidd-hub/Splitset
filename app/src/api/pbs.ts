import { useQuery } from '@tanstack/react-query';

import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Views } from '@/types/database';

export type RunPb = Views<'run_pbs'>;
export type LiftPb = Views<'lift_pbs'>;
export type Period = 'month' | 'year' | 'all';
/** Best per period; a period with nothing logged yet is missing. */
export type PbPeriods<R> = Partial<Record<Period, R>>;

export const pbKeys = {
  run: (uid: string) => ['pbs', 'run', uid] as const,
  lift: (uid: string) => ['pbs', 'lift', uid] as const,
};

/** Fastest 1 km to marathon inside any run, and the longest run: this month, this year, all time. */
export function useRunPbs() {
  const uid = useUserId();
  return useQuery({
    queryKey: pbKeys.run(uid),
    enabled: !!uid,
    queryFn: async (): Promise<Map<string, PbPeriods<RunPb>>> => {
      const { data, error } = await supabase.from('run_pbs').select('*').eq('user_id', uid);
      if (error) throw error;
      const out = new Map<string, PbPeriods<RunPb>>();
      for (const r of data) {
        if (!r.pb || !r.period) continue;
        out.set(r.pb, { ...out.get(r.pb), [r.period]: r });
      }
      return out;
    },
  });
}

/** exercise id -> metric (1rm, 3rm, reps, time, weight) -> best per period. */
export type LiftPbIndex = Map<string, Map<string, PbPeriods<LiftPb>>>;

export function useLiftPbs() {
  const uid = useUserId();
  return useQuery({
    queryKey: pbKeys.lift(uid),
    enabled: !!uid,
    queryFn: async (): Promise<LiftPbIndex> => {
      const { data, error } = await supabase.from('lift_pbs').select('*').eq('user_id', uid);
      if (error) throw error;
      const out: LiftPbIndex = new Map();
      for (const r of data) {
        if (!r.exercise_id || !r.metric || !r.period) continue;
        const byMetric = out.get(r.exercise_id) ?? new Map<string, PbPeriods<LiftPb>>();
        byMetric.set(r.metric, { ...byMetric.get(r.metric), [r.period]: r });
        out.set(r.exercise_id, byMetric);
      }
      return out;
    },
  });
}
