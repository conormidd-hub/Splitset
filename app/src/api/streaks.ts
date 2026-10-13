import { useQuery } from '@tanstack/react-query';

import { keys } from './keys';
import { daysAgoIso } from '@/lib/dates';
import { useUserId } from '@/lib/session';
import type { ActivityLite, WorkoutLite } from '@/lib/streaks';
import { supabase } from '@/lib/supabase';

/** How far back the streak looks: two years is 104 weeks, more than any streak worth a flame. */
export const STREAK_DAYS = 730;

/**
 * The few columns the streak and the calendar need, for two years: every activity and every
 * finished gym workout. Light enough to fetch in one go, so a long streak never has to page.
 */
export function useTrainingSessions() {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.sessions(uid),
    enabled: !!uid,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ activities: ActivityLite[]; workouts: WorkoutLite[]; oldest: string }> => {
      const oldest = daysAgoIso(STREAK_DAYS);
      const [a, w] = await Promise.all([
        supabase
          .from('activities')
          .select('id, start_time_local, type, name, distance_m, moving_time_s')
          .eq('user_id', uid)
          .gte('start_time_local', `${oldest}T00:00:00`)
          .order('start_time_local', { ascending: true }),
        supabase
          .from('workout_summaries')
          .select('id, started_at, activity_id, name, duration_s, sets_completed')
          .eq('user_id', uid)
          .not('finished_at', 'is', null)
          .gte('started_at', `${oldest}T00:00:00`)
          .order('started_at', { ascending: true }),
      ]);
      if (a.error) throw a.error;
      if (w.error) throw w.error;
      return { activities: a.data, workouts: w.data, oldest };
    },
  });
}
