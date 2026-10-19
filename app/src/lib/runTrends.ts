import { addDays, parseISO, subDays } from 'date-fns';

import { isoDate, weekStartIso } from './dates.ts';

/**
 * The Run tab's Trends: runs folded into weeks (Monday to Sunday, like the rest of the app) or
 * charted one point per run with a rolling mean. Units stay metric here (metres, seconds); the
 * charts convert for display. Pure, so it is tested under Node; src/api/runTrends.ts loads the rows.
 */

/** The run columns the charts read. */
export type RunTrendRow = {
  id: string;
  start_time_local: string;
  distance_m: number | null;
  moving_time_s: number | null;
  avg_hr: number | null;
  cadence: number | null;
  elev_gain_m: number | null;
  /** Seconds in each heart-rate zone, zone 1 first (intervals.icu's icu_hr_zone_times). */
  hr_zone_times: number[] | null;
  stride_m: number | null;
  gct_ms: number | null;
  vert_osc_cm: number | null;
  avg_power_w: number | null;
};

/** The same shape as LineChart's Point, so the charts take these as they are. */
export type TrendPoint = { x: number; y: number | null };

/** Noon on a local date, as the charts' x: clear of any DST shift at midnight. */
export const dayMs = (iso: string) => Date.parse(`${iso}T12:00:00`);

/** The Monday of the week a run started in. */
export const weekOf = (startLocal: string) => weekStartIso(new Date(`${startLocal.slice(0, 10)}T12:00:00`));

/** The first day a range chip covers, or null for All: the Monday of the week `days` ago, so the
 *  first weekly bar holds a whole week rather than its last few days. */
export function rangeStart(days: number, today: string): string | null {
  return days > 0 ? weekStartIso(subDays(parseISO(today), days)) : null;
}

/** Which weeks a weekly chart spans: from the range's first week (or, for All, the first run's)
 *  to the current week, so an empty week shows as a gap rather than vanishing. */
export type WeekSpan = { from: string | null; to: string };

/** Every Monday from the week holding `from` to the week holding `to`. */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const last = weekStartIso(parseISO(to));
  for (let d = parseISO(weekStartIso(parseISO(from))), iso = isoDate(d); iso <= last; d = addDays(d, 7), iso = isoDate(d)) out.push(iso);
  return out;
}

function spanWeeks(keys: Iterable<string>, span: WeekSpan): string[] {
  let first = span.from;
  if (!first) for (const k of keys) if (first == null || k < first) first = k;
  return first ? weeksBetween(first, span.to) : [];
}

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * One bar per week: the sum of a value over the week's runs, its largest (the long run), or how
 * many runs there were. Weeks without a run read 0 (none for `max`); with no run at all in the
 * rows it is empty, so the chart says so instead of drawing a flat line.
 */
export function weekly(
  rows: readonly RunTrendRow[], value: (r: RunTrendRow) => number | null | undefined, how: 'sum' | 'max' | 'count', span: WeekSpan,
): TrendPoint[] {
  const byWeek = new Map<string, number>();
  for (const r of rows) {
    const v = how === 'count' ? 1 : value(r);
    if (!usable(v)) continue;
    const wk = weekOf(r.start_time_local);
    const cur = byWeek.get(wk);
    byWeek.set(wk, how === 'max' ? Math.max(cur ?? v, v) : (cur ?? 0) + v);
  }
  if (!byWeek.size) return [];
  return spanWeeks(byWeek.keys(), span).map((wk) => ({ x: dayMs(wk), y: byWeek.get(wk) ?? (how === 'max' ? null : 0) }));
}

export type ZoneWeek = { x: number; /** Seconds in each zone, zone 1 first. */ values: number[] };

/**
 * Time in each heart-rate zone per week, from every run that carries zone times. Zones past
 * `max` fold into the last (intervals.icu's 5a, 5b and 5c are all zone 5), and `folded` says it
 * happened so the legend can read "Z5+". `zones` is how many columns the data fills.
 */
export function weeklyZones(rows: readonly RunTrendRow[], span: WeekSpan, max = 5): { weeks: ZoneWeek[]; zones: number; folded: boolean } {
  const byWeek = new Map<string, number[]>();
  let zones = 0;
  let folded = false;
  for (const r of rows) {
    const z = r.hr_zone_times;
    if (!z?.length || !z.some((s) => s > 0)) continue;
    const wk = weekOf(r.start_time_local);
    const sums = byWeek.get(wk) ?? new Array<number>(max).fill(0);
    z.forEach((s, i) => {
      if (usable(s) && s > 0) sums[Math.min(i, max - 1)] += s;
    });
    byWeek.set(wk, sums);
    zones = Math.max(zones, Math.min(z.length, max));
    if (z.length > max) folded = true;
  }
  if (!byWeek.size) return { weeks: [], zones: 0, folded: false };
  const weeks = spanWeeks(byWeek.keys(), span).map((wk) => ({ x: dayMs(wk), values: (byWeek.get(wk) ?? new Array<number>(max).fill(0)).slice(0, zones) }));
  return { weeks, zones, folded };
}

/** Runs shorter than this are left off the per-run charts: a strides session or a GPS blip
 *  says nothing about the athlete's heart rate or cadence. */
export const MIN_RUN_M = 1000;

/** One point per run that has the value (and is a real run), oldest first. */
export function perRun(rows: readonly RunTrendRow[], value: (r: RunTrendRow) => number | null | undefined, minM = MIN_RUN_M): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (const r of rows) {
    if ((r.distance_m ?? 0) < minM) continue;
    const v = value(r);
    if (!usable(v) || v <= 0) continue;
    out.push({ x: Date.parse(r.start_time_local), y: v });
  }
  return out.sort((a, b) => a.x - b.x);
}

/** A believable running pace, seconds per km: 2:30 to 15:00. Outside it is a walk, a paused
 *  watch or a GPS fault, and one of those would squash every real run into a line. */
export const PACE_RANGE = { fast: 150, slow: 900 } as const;

/** A run's average moving pace in seconds per km, or null when it is not a believable one. */
export function paceOf(r: Pick<RunTrendRow, 'distance_m' | 'moving_time_s'>): number | null {
  if (!usable(r.distance_m) || !usable(r.moving_time_s) || r.distance_m <= 0 || r.moving_time_s <= 0) return null;
  const pace = r.moving_time_s / (r.distance_m / 1000);
  return pace >= PACE_RANGE.fast && pace <= PACE_RANGE.slow ? pace : null;
}

/** Trailing mean over the last `n` values that are there, one per input point. */
export function rollingMean(points: readonly TrendPoint[], n: number): TrendPoint[] {
  const window: number[] = [];
  return points.map((p) => {
    if (p.y != null) {
      window.push(p.y);
      if (window.length > n) window.shift();
    }
    return { x: p.x, y: window.length ? window.reduce((a, b) => a + b, 0) / window.length : null };
  });
}
