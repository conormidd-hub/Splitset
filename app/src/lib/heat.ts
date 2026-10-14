import type { RunRoute } from '../api/activities';
import { palettes, type ThemeName } from '../theme/tokens.ts';
import { bboxOf, decodeRoute, mercX, mercY, type Bbox, type MapView } from './geo.ts';
import { groupRoutes, type RouteGroup } from './routeSimilarity.ts';

/**
 * The heat map's data model: every run with a trace, weighted by how often the user runs that
 * route. Weight 0 is a route run once, 1 the most-run route; the theme's ramp below maps it.
 */

export type DecodedRun = RunRoute & {
  pts: [number, number][];
  box: Bbox;
  /** Each point in world pixels at zoom 0, so screen positions are one multiply away. */
  mx: Float64Array;
  my: Float64Array;
};
export type HeatRoute = DecodedRun & {
  count: number;
  weight: number;
  group: string;
  /** The route's most typical run: the trace the heat map draws for the whole route. */
  typical: boolean;
};

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
      return {
        ...r,
        count: c,
        weight: scale > 0 ? Math.log(c) / scale : 0,
        group: g?.key ?? r.activity_id,
        typical: !g || g.representative.id === r.activity_id,
      };
    })
    .sort((a, b) => a.weight - b.weight);
  return { routes, groups };
}

export function weightRoutes(runs: DecodedRun[]): HeatRoute[] {
  return weightRoutesWithGroups(runs).routes;
}

/**
 * One trace per route, for drawing: the route's most typical run when it is in the list, else
 * whichever of its runs is (a date filter can drop the typical one). Stacking every lap of a
 * route only smears GPS drift into a ragged band, and the colour already says how often it is
 * run. Order is kept, so the least-run routes still go down first.
 */
export function oneTracePerRoute(routes: HeatRoute[]): HeatRoute[] {
  const pick = new Map<string, HeatRoute>();
  for (const r of routes) {
    const cur = pick.get(r.group);
    if (!cur || (r.typical && !cur.typical)) pick.set(r.group, r);
  }
  return routes.filter((r) => pick.get(r.group) === r);
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

/**
 * The theme's accent by how often a route is run: faded for a once-off route, the accent itself
 * halfway up, then a deep, intense shade for the staples. The fade is opacity (see heatOpacity);
 * the colour runs once → mid → often. Light mode holds the purple until halfway; dark mode starts
 * from a pale mint so the scale walks the whole green family, ending dark but saturated enough to
 * stay clear on the dark map.
 */
export type HeatRamp = { once: string; mid: string; often: string };
export const HEAT_RAMPS: Record<ThemeName, HeatRamp> = {
  race: { once: palettes.race.accent, mid: palettes.race.accent, often: '#2e1c80' },
  night: { once: '#9eeecb', mid: palettes.night.accent, often: '#009452' },
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp01 = (w: number) => Math.min(1, Math.max(0, w));

/** The ramp colour for a weight in [0, 1]: once to mid over the first half, mid to often over the second. */
export function heatColour(weight: number, ramp: HeatRamp): string {
  const w = clamp01(weight);
  const [from, to, f] = w <= 0.5 ? [ramp.once, ramp.mid, 2 * w] : [ramp.mid, ramp.often, 2 * w - 1];
  const a = hexToRgb(from), b = hexToRgb(to);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Faded right back for a once-off route, solid from halfway up. */
export function heatOpacity(weight: number): number {
  return Math.min(1, 0.25 + 1.5 * clamp01(weight));
}

/**
 * Thin lines that thin further as the map zooms out, the way a road map draws its streets: from
 * zoom 10 (a whole city) to 16 (street level) a once-off route goes 0.6 to 1 px and a staple
 * 1 to 1.75 px, so a zoomed-out city of runs stays a fine web instead of a tangle.
 */
export function heatWidth(weight: number, zoom: number): number {
  const k = clamp01((zoom - 10) / 6);
  const once = 0.6 + 0.4 * k;
  const staple = 1 + 0.75 * k;
  return once + (staple - once) * clamp01(weight);
}

/** The run's box grown by its own width and height on every side, so the run sits in the middle third. */
export function focusBounds(b: Bbox): Bbox {
  const dLat = b[2] - b[0];
  const dLng = b[3] - b[1];
  return [b[0] - dLat, b[1] - dLng, b[2] + dLat, b[3] + dLng];
}
