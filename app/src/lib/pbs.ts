import { startOfMonth } from 'date-fns';

import type { LiftPb, Period, PbPeriods, RunPb } from '@/api/pbs';
import type { SetRow } from '@/stores/activeWorkout';
// relative .ts import (the rest are types or packages), so Node can load this file in tests
import { formatDistance, formatDuration, formatPace, kgToDisplay, LB_PER_KG, type Units } from './units.ts';

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

/** True when the logged weight is relative to bodyweight: the load added to it (bodyweight) or
 *  the assistance taken off it (assisted). The 1RM of such a lift includes bodyweight (D4). */
export function bodyweightRelative(loadMode: string | null | undefined): boolean {
  return loadMode === 'bodyweight' || loadMode === 'assisted';
}

/** Whether a metric is a best at all for the exercise. An assisted lift's weight is the
 *  assistance, so its heaviest (3RM, Heaviest) is its weakest set. */
export function liftMetricApplies(metric: string, loadMode: string | null | undefined): boolean {
  return loadMode !== 'assisted' || (metric !== '3rm' && metric !== 'weight');
}

/** Lifting metrics in the order to headline them. For a bodyweight or assisted lift most reps
 *  comes before the 3RM, which is added load beside a 1RM that includes bodyweight. */
export function liftMetricOrder(loadMode: string | null | undefined): LiftMetric[] {
  const keys = LIFT_METRICS.map((m) => m.key);
  if (!bodyweightRelative(loadMode)) return keys;
  return (['1rm', 'reps', ...keys.filter((k) => k !== '1rm' && k !== 'reps')] as LiftMetric[]).filter((k) => liftMetricApplies(k, loadMode));
}

/** A metric's short label, saying when a 1RM includes bodyweight. */
export function liftMetricShort(metric: LiftMetric, loadMode: string | null | undefined): string {
  const short = LIFT_METRICS.find((m) => m.key === metric)?.short ?? metric;
  return metric === '1rm' && bodyweightRelative(loadMode) ? `${short} incl. BW` : short;
}

/** Which metrics an exercise can have PBs in, by how it is measured, headline first: a bodyweight
 *  lift puts most reps before its 3RM (added load), an assisted lift has only its 1RM. */
export function metricsFor(measure: string, bodyweight: boolean, loadMode?: string | null): LiftMetric[] {
  if (measure === 'weight_reps') {
    if (loadMode === 'assisted') return ['1rm'];
    return bodyweight ? ['1rm', 'reps', '3rm'] : ['1rm', '3rm'];
  }
  if (measure === 'reps') return ['reps'];
  if (measure === 'duration') return ['time'];
  if (measure === 'weight_duration') return ['weight'];
  return [];
}

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

/**
 * A quick load (a total in kg, as a share of the 1RM) as the value the set's weight field takes,
 * rounded to the plates. A bodyweight or assisted lift's 1RM includes bodyweight × bw_factor, so
 * its field gets the load added to that or the assistance taken off it. Null when the total can't
 * be lifted that way (under bodyweight alone, or above it when assisted) or the facts are missing.
 */
export function quickLoad(
  totalKg: number, units: Units, loadMode?: string | null, bwFactor?: number | null, bodyweightKg?: number | null,
): number | null {
  if (!bodyweightRelative(loadMode)) return plateRound(totalKg, units);
  if (bwFactor == null || !bodyweightKg) return null;
  const own = bodyweightKg * bwFactor;
  const kg = plateRound(loadMode === 'bodyweight' ? totalKg - own : own - totalKg, units);
  return kg < 0 ? null : kg || 0;   // no -0
}

/** A set's logged weight with what it means: "+20 kg" on top of bodyweight ("BW" alone), "30 kg
 *  assist" off it ("no assist"), else the weight. Display units, one decimal in lb. */
export function loggedWeight(kg: number, units: Units, loadMode: string | null | undefined): string {
  const v = `${kgToDisplay(kg, units)} ${units === 'imperial' ? 'lb' : 'kg'}`;
  if (loadMode === 'assisted') return kg ? `${v} assist` : 'no assist';
  if (loadMode === 'bodyweight') return kg ? `+${v}` : 'BW';
  return v;
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
 * each set stores (`e1rmOf`, the engine's, as the view reads it). An assisted lift offers no
 * metric that is its heaviest assistance (`liftMetricApplies`).
 */
export function sessionBests(
  sets: SetRow[], measure: string, bodyweight: boolean, e1rmOf: (s: SetRow) => number | null, loadMode?: string | null,
): Partial<Record<LiftMetric, SessionBest>> {
  const out: Partial<Record<LiftMetric, SessionBest>> = {};
  const offer = (metric: LiftMetric, value: number | null, setId: string) => {
    if (value == null || !Number.isFinite(value) || value <= 0 || !liftMetricApplies(metric, loadMode)) return;
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

/** lift_pbs keeps its bests to 0.1 (round(value, 1)), so a session is compared at that precision. */
const tenth = (x: number) => Math.round(x * 10) / 10;

/**
 * Stored PBs for one metric with this session's best folded in: the session is this month and
 * year. `manualAll` is the user's best manual entry, which also counts as the all-time best to
 * beat (the "new PB" moment, spec §3.6). Beating it means beating it at the stored precision, so
 * repeating the stored set (113.33 against 113.3) is not a new PB.
 */
export function mergeSession(stored: PbPeriods<LiftPb> | undefined, session: SessionBest | undefined, manualAll?: number | null) {
  const s = session?.value;
  const month = bestOf(stored?.month?.value, s);
  const year = bestOf(stored?.year?.value, s);
  const prevAll = bestOf(stored?.all?.value, manualAll);
  const all = bestOf(prevAll, s);
  return { month, year, all, beatsAllTime: s != null && prevAll != null && tenth(s) > tenth(prevAll) };
}
