import { startOfMonth } from 'date-fns';

import type { LiftPb, Period, PbPeriods, RunPb } from '@/api/pbs';
import type { SetRow } from '@/stores/activeWorkout';
import { formatDistance, formatDuration, formatPace, LB_PER_KG, type Units } from './units';

export const PERIODS: { value: Period; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

/** The running PBs, in display order. Keys match run_pbs.pb. */
export const RUN_PBS = [
  { key: '1km', label: '1 km' },
  { key: '1mile', label: '1 mile' },
  { key: '5km', label: '5 km' },
  { key: '10km', label: '10 km' },
  { key: '15km', label: '15 km' },
  { key: 'half', label: 'Half' },
  { key: 'marathon', label: 'Marathon' },
  { key: 'longest', label: 'Longest' },
] as const;

/** Lifting metrics from lift_pbs, in display order. */
export const LIFT_METRICS = [
  { key: '1rm', label: '1RM', short: '1RM' },
  { key: '3rm', label: '3RM', short: '3RM' },
  { key: 'reps', label: 'Most reps', short: 'Reps' },
  { key: 'time', label: 'Longest', short: 'Hold' },
  { key: 'weight', label: 'Heaviest', short: 'Max' },
] as const;
export type LiftMetric = (typeof LIFT_METRICS)[number]['key'];

/** Quick loads in the workout, as a share of the 1RM. */
export const LOAD_PERCENTS = [50, 60, 70, 80, 90];

/** "140 kg", "157.5 kg" or "347 lb": no trailing .0, half kilos kept. */
export function formatLoad(kg: number | null | undefined, units: Units): string {
  if (kg == null || !Number.isFinite(kg)) return '–';
  const v = units === 'imperial' ? Math.round(kg * LB_PER_KG) : Math.round(kg * 10) / 10;
  return `${v} ${units === 'imperial' ? 'lb' : 'kg'}`;
}

/** Round to what can go on a bar: 2.5 kg or 5 lb steps. Takes and returns kg. */
export function plateRound(kg: number, units: Units): number {
  if (units === 'imperial') return (Math.round((kg * LB_PER_KG) / 5) * 5) / LB_PER_KG;
  return Math.round(kg / 2.5) * 2.5;
}

export function formatLiftPb(metric: string, value: number | null | undefined, units: Units): string {
  if (value == null) return '–';
  if (metric === 'reps') return `${value}`;
  if (metric === 'time') return formatDuration(value);
  return formatLoad(value, units);
}

/** Main value and a short note for a running PB: a time and its pace, or a distance and its time. */
export function formatRunPb(row: RunPb | undefined, units: Units): { value: string; sub?: string } {
  if (!row?.seconds || !row.distance_m) return { value: '–' };
  if (row.pb === 'longest') return { value: formatDistance(row.distance_m, units, 1), sub: formatDuration(row.seconds) };
  return { value: formatDuration(row.seconds), sub: formatPace(row.seconds / (row.distance_m / 1000), units) };
}

/** True when the all-time best was set this calendar month: a fresh PB worth flagging. */
export function isNewThisMonth(achieved: string | null | undefined): boolean {
  if (!achieved) return false;
  // run_pbs gives a local wall-clock time, lift_pbs an instant; both compare fine against local midnight
  return new Date(achieved) >= startOfMonth(new Date());
}

export function bestOf(...values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
}

export type SessionBest = { value: number; setId: string };

/**
 * Bests from sets ticked in the workout on screen, by the same rules as the lift_pbs view, so
 * they can be merged with the stored PBs while the workout is still going. The 1RM is the e1RM
 * each set stores (`e1rmOf`, the engine's, as the view reads it).
 */
export function sessionBests(
  sets: SetRow[], measure: string, bodyweight: boolean, e1rmOf: (s: SetRow) => number | null,
): Partial<Record<LiftMetric, SessionBest>> {
  const out: Partial<Record<LiftMetric, SessionBest>> = {};
  const offer = (metric: LiftMetric, value: number | null, setId: string) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return;
    if (!out[metric] || value > out[metric]!.value) out[metric] = { value, setId };
  };
  for (const s of sets) {
    if (!s.completed || s.setType === 'warmup') continue;
    const w = s.weightKg ?? 0;
    const r = s.reps ?? 0;
    if (measure === 'weight_reps') offer('1rm', e1rmOf(s), s.id);
    if (measure === 'weight_reps' && w > 0 && r >= 3) offer('3rm', w, s.id);
    if ((measure === 'reps' || (measure === 'weight_reps' && bodyweight && w === 0)) && r > 0) offer('reps', r, s.id);
    if (measure === 'duration') offer('time', s.seconds, s.id);
    if (measure === 'weight_duration') offer('weight', s.weightKg, s.id);
  }
  return out;
}

/**
 * Stored PBs for one metric with this session's best folded in: the session is this month and
 * year. `manualAll` is the user's best manual entry, which also counts as the all-time best to
 * beat (the "new PB" moment, spec §3.6).
 */
export function mergeSession(stored: PbPeriods<LiftPb> | undefined, session: SessionBest | undefined, manualAll?: number | null) {
  const s = session?.value;
  const month = bestOf(stored?.month?.value, s);
  const year = bestOf(stored?.year?.value, s);
  const prevAll = bestOf(stored?.all?.value, manualAll);
  const all = bestOf(prevAll, s);
  return { month, year, all, beatsAllTime: s != null && prevAll != null && s > prevAll };
}
