import type { LatLng } from './geo.ts';
import { clamp } from './geo.ts';
import { elevationStats } from './runAnalysis.ts';
import type { RoutedPath, Router } from '../api/routing.ts';

/**
 * Route generation: "a 10 km loop from here" or "from here to there, about 8 km".
 *
 * The routing engine is injected as a `Router` (Valhalla in the app, a fake in tests), so this
 * module is pure maths and promises. Every candidate it returns is a real routed path along roads
 * and trails with a measured length and an estimated walking/running time; heights come from the
 * same router and are folded into climb and descent with `elevationStats`.
 *
 * The core trick for hitting a target length is a fixed-point iteration on one geometric parameter
 * (a radius for loops, a detour offset for point-to-point): route, measure, scale the parameter by
 * the ratio target/measured (clamped so one odd snap cannot explode it), repeat. Road networks are
 * roughly self-similar at the few-kilometre scale, so two or three rounds land within a few per
 * cent of the target almost everywhere.
 */

export type Candidate = {
  pts: [number, number][];
  distance_m: number;
  duration_s: number;
  elev_gain_m: number;
  elev_loss_m: number;
  kind: 'loop' | 'point_to_point';
  label: string;
};

const EARTH_RADIUS_M = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** A candidate within this fraction of the target is good enough to stop iterating. */
const TARGET_TOLERANCE = 0.08;
/** Routing rounds per geometric guess. */
const MAX_ITERATIONS = 3;
/** The per-round correction factor is clamped to this range. */
const SCALE_MIN = 0.6;
const SCALE_MAX = 1.6;
/** Loop waypoints sit at target / this from the start: a 90-degree sector triangle on a real road
 *  network routes to roughly its straight perimeter (2 + sqrt 2 = 3.41 radii) times a detour factor. */
const LOOP_RADIUS_DIVISOR = 3.3;
/** Half-angle of the sector the two loop waypoints span around the loop's bearing. */
const LOOP_HALF_ANGLE_DEG = 45;
/** Four loop directions, offset from the cardinals so a grid city does not route two loops down
 *  the same avenue. Deterministic: the same start and target always yield the same candidates. */
const LOOP_BEARINGS = [17, 107, 197, 287];
/** A direct route shorter than this fraction of the target earns detour candidates. */
const DETOUR_THRESHOLD = 0.85;

/**
 * The point `metres` away from `from` along the initial bearing `bearingDeg` (degrees clockwise
 * from north), on a spherical earth. Longitude is normalised to [-180, 180).
 */
export function destinationPoint(from: LatLng, bearingDeg: number, metres: number): LatLng {
  const delta = metres / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(from.lat);
  const lambda1 = toRad(from.lng);
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(clamp(sinPhi2, -1, 1));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);
  const lng = ((toDeg(lambda2) + 540) % 360) - 180;
  return { lat: toDeg(phi2), lng };
}

/** Initial great-circle bearing from a to b in degrees, [0, 360). */
function bearingDeg(a: LatLng, b: LatLng): number {
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
  const dLambda = toRad(b.lng - a.lng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** "North", "East", "South" or "West", whichever is nearest to the bearing. */
function compassName(bearing: number): string {
  const names = ['North', 'East', 'South', 'West'];
  return names[Math.round((((bearing % 360) + 360) % 360) / 90) % 4];
}

/**
 * Iterate one geometric parameter until the routed length lands within 8 % of `targetM`.
 *
 * `build(param)` turns the current parameter into the list of points to route. After each round
 * the parameter is multiplied by clamp(target / measured, 0.6, 1.6). The best round (closest to the
 * target) is kept even when a later round throws, so a waypoint that snaps into a lake on round two
 * does not throw away a good round one. Rejects only when every round failed.
 */
async function converge(router: Router, targetM: number, initial: number, build: (param: number) => LatLng[]): Promise<RoutedPath> {
  let param = initial;
  let best: RoutedPath | null = null;
  let lastError: unknown = null;
  for (let round = 0; round < MAX_ITERATIONS; round++) {
    let routed: RoutedPath;
    try {
      routed = await router.route(build(param));
    } catch (err) {
      lastError = err;
      break;
    }
    if (!best || Math.abs(routed.distance_m - targetM) < Math.abs(best.distance_m - targetM)) best = routed;
    const measured = routed.distance_m;
    if (measured <= 0) break;
    if (Math.abs(measured - targetM) <= TARGET_TOLERANCE * targetM) break;
    param *= clamp(targetM / measured, SCALE_MIN, SCALE_MAX);
  }
  if (best) return best;
  throw lastError instanceof Error ? lastError : new Error('No route found');
}

/** Attach climb and descent from the router's heights; a failed height lookup leaves them at 0. */
async function toCandidate(router: Router, routed: RoutedPath, kind: Candidate['kind'], label: string): Promise<Candidate> {
  let gain = 0, loss = 0;
  try {
    const hs = await router.heights(routed.pts);
    ({ gain, loss } = elevationStats(hs));
  } catch {
    // Heights are decoration; the route itself is still worth showing.
  }
  return { pts: routed.pts, distance_m: routed.distance_m, duration_s: routed.duration_s, elev_gain_m: gain, elev_loss_m: loss, kind, label };
}

/** Settle a batch of candidate promises, keeping the fulfilled ones nearest the target first. */
async function settle(jobs: Promise<Candidate>[], targetM: number): Promise<Candidate[]> {
  const results = await Promise.allSettled(jobs);
  const ok: Candidate[] = [];
  let firstError: unknown = null;
  for (const r of results) {
    if (r.status === 'fulfilled') ok.push(r.value);
    else if (firstError === null) firstError = r.reason;
  }
  if (!ok.length) {
    throw firstError instanceof Error && !/^Routing needs/.test(firstError.message) ? firstError : new Error('No route found');
  }
  return ok.sort((a, b) => Math.abs(a.distance_m - targetM) - Math.abs(b.distance_m - targetM));
}

/**
 * Loops of roughly `targetM` metres starting and ending at `start`.
 *
 * Four loops are tried in parallel, one per bearing in [17, 107, 197, 287]. For bearing b the loop
 * is routed through two waypoints at bearings b - 45 and b + 45 and radius r, starting from
 * r = target / 3.3; each round rescales r by clamp(target / measured, 0.6, 1.6), at most three
 * rounds, stopping once within 8 %. Directions whose routing fails are dropped silently; the
 * promise rejects with "No route found" only when all four fail. Results are sorted by how close
 * they are to the target and labelled by direction ("North loop", ...).
 */
export async function generateLoops(start: LatLng, targetM: number, router: Router): Promise<Candidate[]> {
  if (!(targetM > 0)) throw new Error('Target distance must be positive');
  const jobs = LOOP_BEARINGS.map(async (b) => {
    const routed = await converge(router, targetM, targetM / LOOP_RADIUS_DIVISOR, (r) => [
      start,
      destinationPoint(start, b - LOOP_HALF_ANGLE_DEG, r),
      destinationPoint(start, b + LOOP_HALF_ANGLE_DEG, r),
      start,
    ]);
    return toCandidate(router, routed, 'loop', `${compassName(b)} loop`);
  });
  return settle(jobs, targetM);
}

/**
 * Routes from `start` to `end`.
 *
 * The direct route is always a candidate ("Direct"). When a target length is given and the direct
 * route is shorter than 85 % of it, two detours are tried in parallel: a waypoint at the midpoint
 * of start-end pushed perpendicular to that line by h = 0.5 * sqrt(target^2 - direct^2) (the
 * offset that makes the two straight legs sum to the target), one to each side, with h iterated
 * like the loop radius. Failed detours are dropped; the promise rejects only when even the direct
 * route cannot be found. Sorted nearest the target first (so "Direct" leads when there is no target).
 */
export async function generatePointToPoint(start: LatLng, end: LatLng, targetM: number | null, router: Router): Promise<Candidate[]> {
  const direct = await router.route([start, end]);
  const directJob = toCandidate(router, direct, 'point_to_point', 'Direct');
  const target = targetM != null && targetM > 0 ? targetM : direct.distance_m;
  const jobs = [directJob];

  if (targetM != null && targetM > 0 && direct.distance_m < DETOUR_THRESHOLD * targetM) {
    const D = direct.distance_m;
    const h0 = 0.5 * Math.sqrt(Math.max(0, targetM * targetM - D * D));
    const mid: LatLng = { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 };
    const along = bearingDeg(start, end);
    for (const side of [90, -90]) {
      const perp = (along + side + 360) % 360;
      jobs.push(
        converge(router, targetM, h0, (h) => [start, destinationPoint(mid, perp, h), end]).then((routed) =>
          toCandidate(router, routed, 'point_to_point', `Detour ${compassName(perp).toLowerCase()}`),
        ),
      );
    }
  }
  return settle(jobs, target);
}
