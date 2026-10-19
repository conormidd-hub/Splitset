// The Today screen's layout: two In focus slots side by side (the left a metric, the right a
// metric or the recovery body figure) above the At a glance tiles. Pure, so it is tested under
// Node; src/api/home.ts stores it on the profile.

/** The right In focus slot can also hold the recovery body figure. */
export const RECOVERY = 'recovery' as const;

/** The Trends screen's charts in order (null: the default set), saved with the home layout. A
 *  built-in chart's id, or `m:` and a metric's id for that metric over time. */
export type Layout<M extends string> = { v: 1; focus: M | null; focus2: M | typeof RECOVERY | null; glance: M[]; trends?: string[] | null };

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
  const o = raw as { v?: unknown; focus?: unknown; focus2?: unknown; glance?: unknown; trends?: unknown };
  if (o.v !== 1 || !Array.isArray(o.glance)) return null;
  let glance: M[] = [];
  for (const id of o.glance) if (isMetric(id) && !glance.includes(id)) glance.push(id);
  if (same(glance, OLD_DEFAULT_GLANCE)) glance = [...defaultGlance];
  const focus2 = !('focus2' in o) ? RECOVERY : o.focus2 === RECOVERY || isMetric(o.focus2) ? (o.focus2 as M | typeof RECOVERY) : null;
  // trends: built-in charts and charted metrics this build knows, once each; anything else is dropped
  let trends: string[] | null = null;
  if (Array.isArray(o.trends)) {
    trends = [];
    for (const id of o.trends) {
      const metric = typeof id === 'string' ? trendMetric(id) : null;
      if ((isBuiltInTrend(id) || (metric != null && isMetric(metric))) && !trends.includes(id as string)) trends.push(id as string);
    }
  }
  return { v: 1, focus: isMetric(o.focus) ? o.focus : null, focus2, glance, trends };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function sameLayout<M extends string>(a: Layout<M>, b: Layout<M>): boolean {
  return a.focus === b.focus && a.focus2 === b.focus2 && same(a.glance, b.glance) && same(a.trends ?? [], b.trends ?? []) && (a.trends == null) === (b.trends == null);
}
