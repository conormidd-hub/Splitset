import { useQuery } from '@tanstack/react-query';

import { keys } from './keys';
import { daysAgoIso } from '@/lib/dates';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables } from '@/types/database';

export type WellnessRow = Tables<'wellness'>;

/** Every metric column: the whole row minus the payload. */
export const WELLNESS_COLUMNS =
  'date, resting_hr, hrv, hrv_sdnn, hrv_baseline_low, hrv_baseline_high, weight_kg, body_fat_pct, sleep_s, sleep_score, sleep_quality, vo2max, ctl, atl, ramp_rate, steps, stress, respiration, spo2, readiness, body_battery_max, body_battery_min, floors, avg_sleeping_hr, source' as const;

export type WellnessDay = Pick<
  WellnessRow,
  | 'date' | 'resting_hr' | 'hrv' | 'hrv_sdnn' | 'hrv_baseline_low' | 'hrv_baseline_high' | 'weight_kg' | 'body_fat_pct'
  | 'sleep_s' | 'sleep_score' | 'sleep_quality' | 'vo2max' | 'ctl' | 'atl' | 'ramp_rate' | 'steps' | 'stress' | 'respiration'
  | 'spo2' | 'readiness' | 'body_battery_max' | 'body_battery_min' | 'floors' | 'avg_sleeping_hr' | 'source'
>;

/** The last N days of wellness, oldest first. */
export function useWellness(days = 30) {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.wellness(uid, days),
    enabled: !!uid,
    queryFn: async (): Promise<WellnessDay[]> => {
      const { data, error } = await supabase
        .from('wellness')
        .select(WELLNESS_COLUMNS)
        .eq('user_id', uid)
        .gte('date', daysAgoIso(days))
        .order('date', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

/** Mean of the last `n` non-null values of a metric, or null. */
export function rollingMean(rows: WellnessDay[], key: keyof WellnessDay, n: number): number | null {
  const vals = rows
    .map((r) => r[key])
    .filter((v): v is number => typeof v === 'number')
    .slice(-n);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Latest non-null value with its date. */
export function latest(rows: WellnessDay[], key: keyof WellnessDay): { value: number; date: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][key];
    if (typeof v === 'number') return { value: v, date: rows[i].date };
  }
  return null;
}
