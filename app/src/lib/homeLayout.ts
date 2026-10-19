// The Today screen's layout: two In focus slots side by side (the left a metric, the right a
// metric or the recovery body figure) above the At a glance tiles. Pure, so it is tested under
// Node; src/api/home.ts stores it on the profile.

/** The right In focus slot can also hold the recovery body figure. */
export const RECOVERY = 'recovery' as const;

/**
 * `trends`: the Trends screen's charts in order (null: the default set). A built-in chart's id,
 * `m:` and a metric's id for that metric over time, or `c:` and two metric ids for a comparison.
 * `liftTrends`: the Lift tab's progression charts (null: the main compound lifts), `x:` with an
 * exercise id and a measure. `runTrends`: the Run tab's charts (null: the default set).
 */
export type Layout<M extends string> = {
  v: 1; focus: M | null; focus2: M | typeof RECOVERY | null; glance: M[];
  trends?: string[] | null; liftTrends?: string[] | null; runTrends?: string[] | null;
};

/** The Trends screen's built-in charts, in their default order. */
export const BUILT_IN_TRENDS = [
  'weekly_running', 'training_load', 'acwr', 'fitness_fatigue', 'resting_hr', 'hrv', 'sleep', 'weight', 'cadence', 'hr_per_run', 'lift_volume',
] as const;
export type BuiltInTrend = (typeof BUILT_IN_TRENDS)[number];
export const DEFAULT_TRENDS: string[] = [...BUILT_IN_TRENDS];
const METRIC_TREND = 'm:';
export const metricTrend = (metric: string) => `${METRIC_TREND}${metric}`;
/** The metric a trend charts, or null for a built-in chart. */
export const trendMetric = (id: string): string | null => (id.startsWith(METRIC_TREND) ? id.slice(METRIC_TREND.length) : null);
export const isBuiltInTrend = (v: unknown): v is BuiltInTrend => typeof v === 'string' && (BUILT_IN_TRENDS as readonly string[]).includes(v);

// ---------------------------------------------------------------- comparisons (Trends)
const COMPARE = 'c:';
/** Two metrics on one chart, the first on the left axis and the second on the right. */
export const compareTrend = (a: string, b: string) => `${COMPARE}${a},${b}`;
/** The two metrics a comparison charts, or null when the id is not one. */
export function comparedMetrics(id: string): [string, string] | null {
  if (!id.startsWith(COMPARE)) return null;
  const parts = id.slice(COMPARE.length).split(',');
  return parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1] ? [parts[0], parts[1]] : null;
}

// ---------------------------------------------------------------- the Lift tab's progression charts
/** What a lift's chart follows over time, Strong style: the best estimated 1RM of each workout,
 *  its heaviest weight, its total volume, or its most reps in one set. */
export const LIFT_MEASURES = ['e1rm', 'heaviest', 'volume', 'reps'] as const;
export type LiftMeasure = (typeof LIFT_MEASURES)[number];
const LIFT = 'x:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const liftTrend = (exerciseId: string, measure: LiftMeasure) => `${LIFT}${exerciseId}:${measure}`;
/** The exercise and measure a Lift chart follows, or null when the id is not one. */
export function parseLiftTrend(id: string): { exerciseId: string; measure: LiftMeasure } | null {
  if (!id.startsWith(LIFT)) return null;
  const [exerciseId, measure] = id.slice(LIFT.length).split(':');
  return exerciseId && UUID.test(exerciseId) && (LIFT_MEASURES as readonly string[]).includes(measure) ? { exerciseId, measure: measure as LiftMeasure } : null;
}
/** The main compound lifts the Lift tab charts until its owner changes the list, by library slug,
 *  each with its estimated 1RM. Ones never logged are skipped. */
export const DEFAULT_LIFT_SLUGS = ['squat_bb', 'bench_press_bb', 'deadlift', 'ohp_bb'] as const;

// ---------------------------------------------------------------- the Run tab's charts
export const RUN_TRENDS = [
  'run_weekly_distance', 'run_weekly_time', 'run_hr_zones', 'run_hr', 'run_pace', 'run_cadence',
  'run_long', 'run_weekly_count', 'run_elevation', 'run_stride', 'run_gct', 'run_vert_osc', 'run_power',
] as const;
export type RunTrend = (typeof RUN_TRENDS)[number];
export const DEFAULT_RUN_TRENDS: string[] = ['run_weekly_distance', 'run_weekly_time', 'run_hr_zones', 'run_hr', 'run_cadence', 'run_pace'];
export const isRunTrend = (v: unknown): v is RunTrend => typeof v === 'string' && (RUN_TRENDS as readonly string[]).includes(v);

/** At a glance before it was cut to four tiles: a layout still exactly this was never customised. */
export const OLD_DEFAULT_GLANCE = ['resting_hr', 'hrv', 'sleep', 'training_status', 'vo2max', 'steps', 'weekly_distance', 'fitness'];
export const DEFAULT_GLANCE = ['resting_hr', 'hrv', 'sleep', 'weekly_distance'];

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A stored layout, or null when it is not one. Unknown ids are dropped and repeats folded. A
 * layout saved before the second slot existed gets the recovery figure there, and one whose At a
 * glance is still the old eight-tile default gets the new four.
 */
export function parseLayout<M extends string>(json: unknown, isMetric: (v: unknown) => v is M, defaultGlance: readonly M[]): Layout<M> | null {
  const raw = typeof json === 'string' ? safeParse(json) : json;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { v?: unknown; focus?: unknown; focus2?: unknown; glance?: unknown; trends?: unknown; liftTrends?: unknown; runTrends?: unknown };
  if (o.v !== 1 || !Array.isArray(o.glance)) return null;
  let glance: M[] = [];
  for (const id of o.glance) if (isMetric(id) && !glance.includes(id)) glance.push(id);
  if (same(glance, OLD_DEFAULT_GLANCE)) glance = [...defaultGlance];
  const focus2 = !('focus2' in o) ? RECOVERY : o.focus2 === RECOVERY || isMetric(o.focus2) ? (o.focus2 as M | typeof RECOVERY) : null;
  // each chart list keeps the charts this build knows, once each; anything else is dropped
  const trends = list(o.trends, (id) => {
    const metric = trendMetric(id);
    const pair = comparedMetrics(id);
    return isBuiltInTrend(id) || (metric != null && isMetric(metric)) || (pair != null && isMetric(pair[0]) && isMetric(pair[1]));
  });
  const liftTrends = list(o.liftTrends, (id) => parseLiftTrend(id) != null);
  const runTrends = list(o.runTrends, isRunTrend);
  return { v: 1, focus: isMetric(o.focus) ? o.focus : null, focus2, glance, trends, liftTrends, runTrends };
}

/** A stored chart list: null when it was never set (the defaults), else its known ids once each. */
function list(v: unknown, known: (id: string) => boolean): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const id of v) if (typeof id === 'string' && known(id) && !out.includes(id)) out.push(id);
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Today's Reset to default: In focus and At a glance from `defaults`; the Trends, Lift and Run
 *  chart lists live on the same layout but are not Today's, so they are kept. */
export function resetHome<M extends string>(layout: Layout<M>, defaults: Layout<M>): Layout<M> {
  return { ...layout, focus: defaults.focus, focus2: defaults.focus2, glance: [...defaults.glance] };
}

const sameList = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) => same(a ?? [], b ?? []) && (a == null) === (b == null);

export function sameLayout<M extends string>(a: Layout<M>, b: Layout<M>): boolean {
  return a.focus === b.focus && a.focus2 === b.focus2 && same(a.glance, b.glance)
    && sameList(a.trends, b.trends) && sameList(a.liftTrends, b.liftTrends) && sameList(a.runTrends, b.runTrends);
}
