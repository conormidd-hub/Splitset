import type { RunRoute } from '../api/activities';
import { bboxOf, decodeRoute, mercX, mercY, type Bbox, type MapView } from './geo.ts';
import { groupRoutes, type RouteGroup } from './routeSimilarity.ts';

/**
 * The heat map's data model: every run with a trace, weighted by how often the user runs that
 * route. Weight 0 is a route run once, 1 the most-run route; the colour ramp below maps it.
 */

export type DecodedRun = RunRoute & {
  pts: [number, number][];
  box: Bbox;
  /** Each point in world pixels at zoom 0, so screen positions are one multiply away. */
  mx: Float64Array;
  my: Float64Array;
};
export type HeatRoute = DecodedRun & { count: number; weight: number; group: string };

/** Runs with a usable trace, decoded once. */
export function decodeRuns(routes: RunRoute[] | undefined): DecodedRun[] {
  return (routes ?? []).flatMap((r) => {
    const pts = decodeRoute(r.polyline);
    const box = r.bbox ?? bboxOf(pts);
    if (pts.length < 2 || !box) return [];
    const mx = new Float64Array(pts.length), my = new Float64Array(pts.length);
    pts.forEach(([lat, lng], i) => {
      mx[i] = mercX(lng);
      my[i] = mercY(lat);
    });
    return [{ ...r, pts, box, mx, my }];
  });
}

/** Newest first: the order the route grouping anchors on, shared by every screen that groups. */
export function newestFirst<T extends { start_time_local: string }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => b.start_time_local.localeCompare(a.start_time_local));
}

const toMember = (r: DecodedRun) => ({
  id: r.activity_id, pts: r.pts, distance_m: r.distance_m, moving_time_s: r.moving_time_s, start_time_local: r.start_time_local,
});

/**
 * Group runs by route and turn each group's size into a 0..1 weight on a log scale, so a route
 * run 50 times and one run 100 times both read as "hot" while once-off routes stay cool. The
 * routes come back least-run first, so drawing in order leaves the hot routes on top; the groups
 * come back keyed the way `HeatRoute.group` refers to them.
 */
export function weightRoutesWithGroups(runs: DecodedRun[]): { routes: HeatRoute[]; groups: Map<string, RouteGroup> } {
  const groupList = groupRoutes(newestFirst(runs).map(toMember));
  const groups = new Map<string, RouteGroup>();
  const groupOf = new Map<string, RouteGroup>();
  let max = 1;
  for (const g of groupList) {
    groups.set(g.key, g);
    for (const m of g.members) groupOf.set(m.id, g);
    if (g.count > max) max = g.count;
  }
  const scale = Math.log(max);
  const routes = runs
    .map((r) => {
      const g = groupOf.get(r.activity_id);
      const c = g?.count ?? 1;
      return { ...r, count: c, weight: scale > 0 ? Math.log(c) / scale : 0, group: g?.key ?? r.activity_id };
    })
    .sort((a, b) => a.weight - b.weight);
  return { routes, groups };
}

export function weightRoutes(runs: DecodedRun[]): HeatRoute[] {
  return weightRoutesWithGroups(runs).routes;
}

/** Projects a run's points with the camera a tap was measured against; see nearestRoute. */
type Projector = (lat: number, lng: number) => { x: number; y: number };

/**
 * The route under a tap: the run whose trail passes closest to the point in screen pixels, or
 * null when nothing is within `maxPx`. Routes whose box is clear of the point are skipped, and
 * points are stepped so roughly one in every few screen pixels is tested, which keeps a tap on
 * two hundred long runs to a few thousand multiplies.
 */
export function nearestRoute(routes: HeatRoute[], project: Projector, view: MapView, pt: { x: number; y: number }, maxPx = 18): HeatRoute | null {
  const world = 2 ** view.zoom;
  let best: HeatRoute | null = null;
  let bestD = maxPx * maxPx;
  for (const r of routes) {
    const a = project(r.box[0], r.box[1]);
    const b = project(r.box[2], r.box[3]);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (pt.x < Math.min(a.x, b.x) - maxPx || pt.x > Math.max(a.x, b.x) + maxPx) continue;
    if (pt.y < Math.min(a.y, b.y) - maxPx || pt.y > Math.max(a.y, b.y) + maxPx) continue;
    // the same frame `project` uses, read off its result for the first point
    const p0 = project(r.pts[0][0], r.pts[0][1]);
    const tlx = r.mx[0] * world - p0.x, tly = r.my[0] * world - p0.y;
    const n = r.pts.length;
    const stride = Math.max(1, Math.floor(n / Math.max(8, (2 * (w + h)) / 4)));
    for (let i = 0; i < n; i += stride) {
      const dx = r.mx[i] * world - tlx - pt.x, dy = r.my[i] * world - tly - pt.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  return best;
}

/** Cool to hot: a route run once is blue, the most-run route red. Fixed hex so it reads on light and dark tiles. */
export const HEAT_RAMP = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#dc2626'];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The ramp colour for a weight in [0, 1]. */
export function heatColour(weight: number): string {
  const t = Math.min(1, Math.max(0, weight)) * (HEAT_RAMP.length - 1);
  const i = Math.min(HEAT_RAMP.length - 2, Math.floor(t));
  const f = t - i;
  const a = hexToRgb(HEAT_RAMP[i]), b = hexToRgb(HEAT_RAMP[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Faint for a once-off route, solid for a staple. */
export function heatOpacity(weight: number): number {
  return 0.35 + 0.55 * Math.min(1, Math.max(0, weight));
}

/** The run's box grown by its own width and height on every side, so the run sits in the middle third. */
export function focusBounds(b: Bbox): Bbox {
  const dLat = b[2] - b[0];
  const dLng = b[3] - b[1];
  return [b[0] - dLat, b[1] - dLng, b[2] + dLat, b[3] + dLng];
}
