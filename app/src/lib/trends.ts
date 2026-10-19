import { addDays, parseISO } from 'date-fns';

import type { ActivityListRow } from '@/api/activities';
import { isRun } from '@/api/activities';
import type { WellnessDay } from '@/api/wellness';
import type { Point } from '@/components/charts/LineChart';
import { isoDate, todayIso, weekStartIso } from './dates';
import type { MetricId } from './metrics';

export const dayMs = (iso: string) => Date.parse(`${iso}T12:00:00`);

/** The metrics that are weekly totals: charted one value per week rather than day by day. */
export const WEEKLY_METRICS: ReadonlySet<MetricId> = new Set<MetricId>(['weekly_distance', 'weekly_time', 'sessions', 'lift_volume']);

/** Daily values summed into weeks, one point per Monday, oldest first. */
export function weeklyTotals(daily: readonly { date: string; value: number | null }[]): Point[] {
  const weeks = new Map<string, number>();
  for (const d of daily) {
    if (d.value == null) continue;
    const wk = weekStartIso(new Date(dayMs(d.date)));
    weeks.set(wk, (weeks.get(wk) ?? 0) + d.value);
  }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wk, v]) => ({ x: dayMs(wk), y: v }));
}

/** Trailing mean over the previous `n` non-null values, aligned to each input point. */
export function rolling(points: Point[], n: number): Point[] {
  const window: number[] = [];
  return points.map((p) => {
    if (p.y != null) {
      window.push(p.y);
      if (window.length > n) window.shift();
    }
    return { x: p.x, y: window.length ? window.reduce((a, b) => a + b, 0) / window.length : null };
  });
}

export function wellnessSeries(rows: WellnessDay[], key: keyof WellnessDay, transform: (v: number) => number = (v) => v): Point[] {
  return rows.map((r) => {
    const v = r[key];
    return { x: dayMs(r.date), y: typeof v === 'number' ? transform(v) : null };
  });
}

/** Weekly running km (bars) from an activity list. */
export function weeklyRunKm(rows: ActivityListRow[]): Point[] {
  const m = new Map<string, number>();
  for (const a of rows) {
    if (!isRun(a.type) || !a.distance_m) continue;
    const wk = weekStartIso(new Date(a.start_time_local));
    m.set(wk, (m.get(wk) ?? 0) + a.distance_m / 1000);
  }
  return [...m.entries()].sort().map(([wk, km]) => ({ x: dayMs(wk), y: Math.round(km * 10) / 10 }));
}

/** Weekly sum of any numeric activity field (load, time). */
export function weeklySum(rows: ActivityListRow[], pick: (a: ActivityListRow) => number | null | undefined): Point[] {
  const m = new Map<string, number>();
  for (const a of rows) {
    const v = pick(a);
    if (v == null) continue;
    const wk = weekStartIso(new Date(a.start_time_local));
    m.set(wk, (m.get(wk) ?? 0) + v);
  }
  return [...m.entries()].sort().map(([wk, v]) => ({ x: dayMs(wk), y: Math.round(v * 10) / 10 }));
}

/** One point per run of at least `minKm`, for scatter-style views. */
export function runPoints(rows: ActivityListRow[], pick: (a: ActivityListRow) => number | null | undefined, minKm = 4): Point[] {
  return rows
    .filter((a) => isRun(a.type) && (a.distance_m ?? 0) >= minKm * 1000)
    .map((a) => {
      const v = pick(a);
      return { x: Date.parse(a.start_time_local), y: v == null ? null : v };
    });
}

/** Acute:chronic ratio from daily load: 7-day mean over 28-day mean, zero-filled days. */
export function acwr(rows: ActivityListRow[]): { load: Point[]; acute: Point[]; chronic: Point[]; ratio: Point[] } {
  if (!rows.length) return { load: [], acute: [], chronic: [], ratio: [] };
  const byDay = new Map<string, number>();
  for (const a of rows) {
    const d = a.start_time_local.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + (a.load ?? 0));
  }
  const days = [...byDay.keys()].sort();
  const last = todayIso();
  const load: Point[] = [];
  // walk local calendar dates: mixing UTC parsing with local stepping repeats a day at a DST change
  for (let d = parseISO(days[0]), iso = days[0]; iso <= last; d = addDays(d, 1), iso = isoDate(d)) {
    load.push({ x: dayMs(iso), y: byDay.get(iso) ?? 0 });
  }
  const mean = (n: number): Point[] => load.map((p, i) => {
    const slice = load.slice(Math.max(0, i - n + 1), i + 1);
    return { x: p.x, y: slice.reduce((s, q) => s + (q.y ?? 0), 0) / slice.length };
  });
  const acute = mean(7);
  const chronic = mean(28);
  const ratio = acute.map((p, i) => ({ x: p.x, y: (chronic[i].y ?? 0) >= 8 ? (p.y ?? 0) / (chronic[i].y as number) : null }));
  return { load, acute, chronic, ratio };
}

/** Riegel prediction: time at distance d2 from a time at d1. */
export function riegel(t1: number, d1: number, d2: number, k = 1.06): number {
  return t1 * Math.pow(d2 / d1, k);
}
