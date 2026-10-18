// The Today screen's layout: two In focus slots side by side (the left a metric, the right a
// metric or the recovery body figure) above the At a glance tiles. Pure, so it is tested under
// Node; src/api/home.ts stores it on the profile.

/** The right In focus slot can also hold the recovery body figure. */
export const RECOVERY = 'recovery' as const;

export type Layout<M extends string> = { v: 1; focus: M | null; focus2: M | typeof RECOVERY | null; glance: M[] };

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
  const o = raw as { v?: unknown; focus?: unknown; focus2?: unknown; glance?: unknown };
  if (o.v !== 1 || !Array.isArray(o.glance)) return null;
  let glance: M[] = [];
  for (const id of o.glance) if (isMetric(id) && !glance.includes(id)) glance.push(id);
  if (same(glance, OLD_DEFAULT_GLANCE)) glance = [...defaultGlance];
  const focus2 = !('focus2' in o) ? RECOVERY : o.focus2 === RECOVERY || isMetric(o.focus2) ? (o.focus2 as M | typeof RECOVERY) : null;
  return { v: 1, focus: isMetric(o.focus) ? o.focus : null, focus2, glance };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function sameLayout<M extends string>(a: Layout<M>, b: Layout<M>): boolean {
  return a.focus === b.focus && a.focus2 === b.focus2 && same(a.glance, b.glance);
}
