import type { Router } from '../api/routing.ts';
import { clamp, haversineKm, type LatLng, type Pt } from './geo.ts';
import { elevationStats } from './runAnalysis.ts';

/**
 * The course builder: a route drawn point by point, the way Garmin Connect, Komoot and Strava
 * let you draw one. The user places waypoints on the map; each pair is routed on foot along real
 * roads and paths, and the legs are joined into one course with a measured length, an estimated
 * time and the climb and descent from terrain heights.
 *
 * Legs are routed one pair at a time and cached by their two endpoints, so moving one waypoint
 * re-routes only the two legs it belongs to, and undoing a change costs nothing. A pair the
 * router cannot join (a point in a lake, say) becomes a straight, flagged leg: the course still
 * draws, but cannot be saved until the point is moved or removed.
 *
 * Like lib/routeBuilder this module knows nothing about React: the router is injected (Valhalla
 * in the app, a fake in tests) and every function here is pure or a promise over the router.
 * Relative imports carry `.ts` so Node can run it directly.
 */

/** A point the user placed, [lat, lng] like every polyline point in the app. */
export type Waypoint = [number, number];

export type Leg = {
  from: Waypoint;
  to: Waypoint;
  pts: [number, number][];
  distance_m: number;
  duration_s: number;
  /** Terrain height at each of `pts`, or null when the lookup failed. */
  heights: number[] | null;
  /** Why routing failed; the leg is then the straight line from `from` to `to`. */
  error: string | null;
};

export type Course = {
  waypoints: Waypoint[];
  legs: Leg[];
  /** Every leg's points joined, the shared point between legs kept once. */
  pts: [number, number][];
  distance_m: number;
  /** The router's walking time; the screens show the user's own pace instead when they have one. */
  duration_s: number;
  elev_gain_m: number;
  elev_loss_m: number;
  /** Indices of legs that could not be routed. A course with any cannot be saved. */
  unrouted: number[];
  /** Every leg was routed and has heights, so climb and descent are complete. */
  heightsKnown: boolean;
};

type Projector = (lat: number, lng: number) => Pt;

/** Two waypoints closer than this are the same place: a loop is closed, a repeat tap is ignored. */
export const SAME_PLACE_M = 15;
/** Cached legs beyond this many are dropped oldest first. A long drawing session stays well under it. */
const MAX_CACHED_LEGS = 400;
/** Two shape points this close (in degrees, about a tenth of a metre) are one point. */
const SAME_POINT_DEG = 1e-6;

const toLatLng = (w: Waypoint): LatLng => ({ lat: w[0], lng: w[1] });
const metresBetween = (a: Waypoint, b: Waypoint) => haversineKm(toLatLng(a), toLatLng(b)) * 1000;
const samePoint = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < SAME_POINT_DEG && Math.abs(a[1] - b[1]) < SAME_POINT_DEG;
/** Six decimals (about a tenth of a metre): the precision the router returns shapes in. */
const keyOf = (a: Waypoint, b: Waypoint) => `${a[0].toFixed(6)},${a[1].toFixed(6)}>${b[0].toFixed(6)},${b[1].toFixed(6)}`;

/** Route one pair on foot and look up its heights. Never rejects: a failure is a straight, flagged leg. */
async function routeLeg(router: Router, from: Waypoint, to: Waypoint): Promise<Leg> {
  try {
    const r = await router.route([toLatLng(from), toLatLng(to)]);
    let heights: number[] | null = null;
    try {
      heights = await router.heights(r.pts);
    } catch {
      // Heights are decoration; the leg itself is still worth drawing.
    }
    return { from, to, pts: r.pts, distance_m: r.distance_m, duration_s: r.duration_s, heights, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'No route found';
    return { from, to, pts: [from, to], distance_m: metresBetween(from, to), duration_s: 0, heights: null, error };
  }
}

/**
 * Routed legs by their endpoints. The same pair is never asked for twice while the cache holds
 * it, failures included (the waypoint is wrong, not the server; asking again on every redraw
 * would hammer the public router). `forgetFailures` is for a Try again button after a network blip.
 */
export class LegCache {
  private legs = new Map<string, Promise<Leg>>();
  private readonly router: Router;

  // No parameter property: Node runs these files with types stripped only, which forbids it.
  constructor(router: Router) {
    this.router = router;
  }

  leg(from: Waypoint, to: Waypoint): Promise<Leg> {
    const k = keyOf(from, to);
    let p = this.legs.get(k);
    if (!p) {
      p = routeLeg(this.router, from, to);
      this.legs.set(k, p);
      if (this.legs.size > MAX_CACHED_LEGS) {
        const oldest = this.legs.keys().next().value;
        if (oldest !== undefined) this.legs.delete(oldest);
      }
    }
    return p;
  }

  /** Drop every leg that failed, so the next course build asks the router for it again. */
  async forgetFailures(): Promise<void> {
    for (const [k, p] of [...this.legs]) {
      if ((await p).error) this.legs.delete(k);
    }
  }

  get size(): number {
    return this.legs.size;
  }
}

export function emptyCourse(waypoints: Waypoint[]): Course {
  return { waypoints, legs: [], pts: [], distance_m: 0, duration_s: 0, elev_gain_m: 0, elev_loss_m: 0, unrouted: [], heightsKnown: true };
}

/**
 * Join routed legs into one course. Each later leg's first point repeats the previous leg's last
 * (both are the shared waypoint snapped to the same spot), so it is dropped. Climb and descent
 * come from the heights along the whole joined path when every leg has them; otherwise the legs
 * that do have heights are summed on their own, which only differs at the joins.
 */
export function assembleCourse(waypoints: Waypoint[], legs: Leg[]): Course {
  const pts: [number, number][] = [];
  const heights: number[] = [];
  const unrouted: number[] = [];
  let distance = 0, duration = 0, allHeights = true;
  legs.forEach((leg, i) => {
    if (leg.error) unrouted.push(i);
    distance += leg.distance_m;
    duration += leg.duration_s;
    const dup = pts.length > 0 && leg.pts.length > 0 && samePoint(pts[pts.length - 1], leg.pts[0]);
    pts.push(...(dup ? leg.pts.slice(1) : leg.pts));
    if (leg.heights && leg.heights.length === leg.pts.length) heights.push(...(dup ? leg.heights.slice(1) : leg.heights));
    else allHeights = false;
  });
  let gain = 0, loss = 0;
  if (allHeights && heights.length === pts.length) {
    ({ gain, loss } = elevationStats(heights));
  } else {
    for (const leg of legs) {
      if (!leg.heights) continue;
      const s = elevationStats(leg.heights);
      gain += s.gain;
      loss += s.loss;
    }
  }
  return {
    waypoints, legs, pts, distance_m: distance, duration_s: duration, elev_gain_m: gain, elev_loss_m: loss,
    unrouted, heightsKnown: unrouted.length === 0 && allHeights,
  };
}

/** The course through `waypoints`, every leg routed (or fetched from the cache) in parallel. */
export async function routeCourse(waypoints: Waypoint[], cache: LegCache): Promise<Course> {
  if (waypoints.length < 2) return emptyCourse(waypoints);
  const legs = await Promise.all(waypoints.slice(1).map((to, i) => cache.leg(waypoints[i], to)));
  return assembleCourse(waypoints, legs);
}

// ---------------------------------------------------------------- editing the waypoints

/** The course ends where it began (three or more points, the last within SAME_PLACE_M of the first). */
export function isClosed(w: Waypoint[]): boolean {
  return w.length >= 3 && metresBetween(w[0], w[w.length - 1]) <= SAME_PLACE_M;
}

/** Append a point; a tap on the spot the course already ends at adds nothing. */
export function addWaypoint(w: Waypoint[], p: Waypoint): Waypoint[] {
  if (w.length && metresBetween(w[w.length - 1], p) <= SAME_PLACE_M) return w;
  return [...w, p];
}

/** Put a point into leg `legIndex` (between waypoints legIndex and legIndex + 1). */
export function insertWaypoint(w: Waypoint[], legIndex: number, p: Waypoint): Waypoint[] {
  if (w.length < 2) return addWaypoint(w, p);
  const after = clamp(Math.floor(legIndex), 0, w.length - 2) + 1;
  return [...w.slice(0, after), p, ...w.slice(after)];
}

/** Move point `i`. On a closed course the start and the finish are one place, so moving either moves both. */
export function moveWaypoint(w: Waypoint[], i: number, p: Waypoint): Waypoint[] {
  if (i < 0 || i >= w.length) return w;
  const last = w.length - 1;
  const both = isClosed(w) && (i === 0 || i === last);
  return w.map((x, k) => (k === i || (both && (k === 0 || k === last)) ? p : x));
}

export function removeWaypoint(w: Waypoint[], i: number): Waypoint[] {
  return w.filter((_, k) => k !== i);
}

export function reverseCourse(w: Waypoint[]): Waypoint[] {
  return [...w].reverse();
}

/** Route back to the start from the last point. Nothing to do on a course that already ends there. */
export function closeLoop(w: Waypoint[]): Waypoint[] {
  if (w.length < 2 || isClosed(w)) return w;
  return [...w, w[0]];
}

/** Retrace the course back to the start: A B C becomes A B C B A. */
export function outAndBack(w: Waypoint[]): Waypoint[] {
  if (w.length < 2 || isClosed(w)) return w;
  return [...w, ...w.slice(0, -1).reverse()];
}

/** Waypoints as stored in routes.waypoints, checked shape by shape; null for anything else. */
export function parseWaypoints(json: unknown): Waypoint[] | null {
  if (!Array.isArray(json)) return null;
  const out: Waypoint[] = [];
  for (const p of json) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [lat, lng] = p;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    out.push([lat, lng]);
  }
  return out;
}

// ---------------------------------------------------------------- what is under a tap

/** The waypoint within `maxPx` of the tap, nearest first (the start wins a tie with the finish of a closed course). */
export function nearestWaypoint(w: Waypoint[], project: Projector, pt: Pt, maxPx = 14): number | null {
  let best: number | null = null;
  let bestD = maxPx * maxPx;
  w.forEach((p, i) => {
    const s = project(p[0], p[1]);
    const d = (s.x - pt.x) ** 2 + (s.y - pt.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Squared distance from p to the segment ab, in pixels. */
function distToSegment2(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  const x = a.x + dx * t - p.x, y = a.y + dy * t - p.y;
  return x * x + y * y;
}

/** The leg whose line passes within `maxPx` of the tap, so a point can be added into the middle of a course. */
export function nearestLeg(course: Course, project: Projector, pt: Pt, maxPx = 10): number | null {
  let best: number | null = null;
  let bestD = maxPx * maxPx;
  course.legs.forEach((leg, li) => {
    const s = leg.pts.map(([lat, lng]) => project(lat, lng));
    for (let i = 1; i < s.length; i++) {
      const d = distToSegment2(pt, s[i - 1], s[i]);
      if (d < bestD) {
        bestD = d;
        best = li;
      }
    }
  });
  return best;
}
