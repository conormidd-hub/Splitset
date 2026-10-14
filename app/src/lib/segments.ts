import type { Bbox } from './geo.ts';
import { bboxOf } from './geo.ts';
import type { Track } from './runAnalysis.ts';

/**
 * Strava-style segments, matched entirely on the device.
 *
 * A segment is a stretch of path (its own thinned polyline, cut from a run). Matching asks, for one
 * run's `Track`: where did this run enter the segment's start circle, follow the whole path in order
 * and cross its end line? Each such pass is an `Effort` with a start/end index into the run's
 * polyline and an elapsed time read from the interpolated per-point times. Nothing here touches the
 * database; `api/segments.ts` persists efforts and the UI ranks them for medals.
 *
 * All geometry is done in a local metres frame centred on the segment start:
 * x = dlng * 111320 * cos(lat0), y = dlat * 111320. Good to better than 0.1 % over a few km.
 */

export type SegmentDef = { id: string; pts: [number, number][]; distance_m: number; bbox: Bbox };
export type Effort = { start_idx: number; end_idx: number; elapsed_s: number; started_at_s: number };

const M_PER_DEG_LAT = 111320;
/** Control points along the resampled segment path are this far apart. */
const CONTROL_STEP_M = 25;
/** Search window for the next segment edge, relative to the current progress along the path. */
const WINDOW_BACK_M = 30;
const WINDOW_AHEAD_M = 80;
/** The window is widened in these steps to bridge GPS gaps before counting a miss. */
const WINDOW_WIDEN_M = [160, 240, 320, 400];
const MAX_MISSES = 3;
/** Progress falling this far behind its best counts as turning back. */
const MAX_REGRESSION_M = 100;
const MIN_PROGRESS_FRACTION = 0.95;
const MIN_COVERAGE_FRACTION = 0.9;
/** Shortest segment the UI lets a user save. */
export const MIN_SEGMENT_M = 200;

type XY = { x: number; y: number };

export function expandBbox(b: Bbox, metres: number): Bbox {
  const dLat = metres / M_PER_DEG_LAT;
  const midLat = ((b[0] + b[2]) / 2) * (Math.PI / 180);
  const dLng = metres / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(midLat)));
  return [b[0] - dLat, b[1] - dLng, b[2] + dLat, b[3] + dLng];
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Local metre frame around (lat0, lng0). */
function projector(lat0: number, lng0: number): (p: [number, number]) => XY {
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return ([lat, lng]) => ({ x: (lng - lng0) * kx, y: (lat - lat0) * M_PER_DEG_LAT });
}

const hypot = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** Where the perpendicular from p meets the line through a and b, as a fraction of a->b (unclamped). */
function footFraction(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

/** Distance from p to the segment a-b and the clamped fraction of the nearest point along it. */
function distToEdge(p: XY, a: XY, b: XY): { d: number; f: number } {
  const f = Math.max(0, Math.min(1, footFraction(p, a, b)));
  const q = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  return { d: hypot(p, q), f };
}

/** First index whose value is > x (xs increasing). */
function upperBound(xs: number[], x: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Resample a path to points every ~`step` metres (the last lands exactly on the end), returning the
 * points and their cumulative arc length `s`. Consecutive duplicate input points are skipped.
 */
function resamplePath(xy: XY[], step: number): { pts: XY[]; s: number[] } {
  const src: XY[] = [];
  for (const p of xy) {
    const last = src[src.length - 1];
    if (!last || hypot(last, p) > 1e-6) src.push(p);
  }
  if (src.length < 2) return { pts: src, s: src.map(() => 0) };
  const cum = [0];
  for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + hypot(src[i - 1], src[i]));
  const total = cum[cum.length - 1];
  const steps = Math.max(1, Math.ceil(total / step));
  const actual = total / steps;
  const pts: XY[] = [];
  const s: number[] = [];
  let seg = 0;
  for (let k = 0; k <= steps; k++) {
    const target = k === steps ? total : k * actual;
    while (seg < src.length - 2 && cum[seg + 1] < target) seg++;
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? (target - cum[seg]) / len : 0;
    pts.push({ x: src[seg].x + (src[seg + 1].x - src[seg].x) * f, y: src[seg].y + (src[seg + 1].y - src[seg].y) * f });
    s.push(target);
  }
  return { pts, s };
}

/**
 * Find every effort on `seg` within `track`.
 *
 * Tolerance TOL = max(25 m, 1.2 x the run's mean point spacing), so a subsampled marathon trace is
 * judged more gently than a 12 m one. The segment is resampled to control points every ~25 m with
 * arc length `s`; run points are measured point-to-EDGE against that resampled path.
 *
 * Scan: an entry is a run index i inside the start circle (<= TOL of the segment start) whose
 * previous point was outside. From an entry the walk advances j, tracking `progress`: the arc length
 * of the nearest edge among those overlapping (progress - 30, progress + 80] that lies within TOL.
 * If none does, the window is widened stepwise to +400 m (bridging GPS gaps); only then is a miss
 * counted. Three consecutive misses, or progress falling more than 100 m behind its best, abort the
 * attempt and the scan resumes after the entry. Once progress reaches 95 % of the segment length
 * and the run is inside the end circle, the walk continues while the run stays inside the circle and
 * the edge passing closest to the segment end is the finish. Coverage is checked last: at least 90 % of the
 * control points must have come within TOL of a run point, or lie under a run edge longer than 3 x
 * the point spacing (a GPS-gap chord). After an accepted effort the scan resumes AT its end index
 * with the "outside" flag forced, so laps of a loop chain back to back.
 *
 * Times: the start is the point of closest approach to the segment start among the run edges
 * (i-1,i) to (i+2,i+3), the end the closest approach among the edges inside the end circle, each
 * with the time interpolated at that point. If the run leaves the start circle and comes back
 * before making 2 x TOL of progress, the attempt restarts from the later entry (an overshoot or a
 * turnaround just before the start). When the crossing edge is a stopped one (under 3 m or 0.5 m/s), the
 * runner paused there: the start takes the LATER end of the edge and the end the EARLIER, so the
 * pause is excluded. Returns [] when the track has no times or does not reach the segment's box.
 */
export function matchSegment(seg: SegmentDef, track: Track): Effort[] {
  const n = track.pts.length;
  const t = track.t;
  if (n < 2 || seg.pts.length < 2 || !t) return [];
  const TOL = Math.max(25, 1.2 * track.spacingM);
  const trackBox = bboxOf(track.pts);
  if (!trackBox || !bboxIntersects(trackBox, expandBbox(seg.bbox, TOL))) return [];

  const project = projector(seg.pts[0][0], seg.pts[0][1]);
  const { pts: C, s: S } = resamplePath(seg.pts.map(project), CONTROL_STEP_M);
  const L = S[S.length - 1];
  if (C.length < 2 || L <= 0) return [];
  const nE = C.length - 1;
  const start = C[0], end = C[nE];
  const r = track.pts.map(project);
  const dist = track.dist;
  const chordLen = 3 * Math.max(track.spacingM, 1);

  /** Nearest segment edge to p among those overlapping (loS, hiS], if within TOL. */
  const nearestOnPath = (p: XY, loS: number, hiS: number): number | null => {
    const kLo = Math.max(0, upperBound(S, loS) - 1);
    const kHi = Math.min(nE - 1, upperBound(S, hiS) - 1);
    let best = TOL, bestS: number | null = null;
    for (let k = kLo; k <= kHi; k++) {
      const { d, f } = distToEdge(p, C[k], C[k + 1]);
      if (d <= best) { best = d; bestS = S[k] + (S[k + 1] - S[k]) * f; }
    }
    return bestS;
  };

  /** Time at fraction f along run edge (a, a+1); see the doc comment for the stopped-edge rule. */
  const edgeTime = (a: number, f: number, which: 'start' | 'end'): number => {
    const dd = dist[a + 1] - dist[a];
    const dt = t[a + 1] - t[a];
    if (dt <= 0) return t[a];
    const stopped = dd < 3 || dd / dt < 0.5;
    if (stopped) return which === 'start' ? t[a + 1] : t[a];
    return t[a] + f * dt;
  };

  /**
   * The start crossing: of the run edges around the entry point i, the one that passes closest to
   * the segment start, with the time at its nearest point. A turnaround at the start (no edge has a
   * perpendicular foot inside it) still gets the closest approach rather than the entry time.
   */
  const startTime = (i: number): { t: number; idx: number } => {
    let bestA = -1, bestF = 0, bestD = Infinity;
    for (const a of [i - 1, i, i + 1, i + 2]) {
      if (a < 0 || a + 1 >= n) continue;
      const { d, f } = distToEdge(start, r[a], r[a + 1]);
      if (d < bestD) { bestD = d; bestA = a; bestF = f; }
    }
    if (bestA < 0) return { t: t[i], idx: i };
    return { t: edgeTime(bestA, bestF, 'start'), idx: bestA + 1 };
  };

  const attempt = (i: number): Effort | null => {
    const covered = new Uint8Array(C.length);
    const markNear = (p: XY, at: number) => {
      const kLo = Math.max(0, upperBound(S, at - TOL - 1) - 1);
      const kHi = Math.min(nE, upperBound(S, at + TOL + 1));
      for (let k = kLo; k <= kHi; k++) if (!covered[k] && hypot(p, C[k]) <= TOL) covered[k] = 1;
    };
    const markChord = (a: XY, b: XY, sA: number, sB: number) => {
      const kLo = Math.max(0, upperBound(S, Math.min(sA, sB) - 1) - 1);
      const kHi = Math.min(nE, upperBound(S, Math.max(sA, sB) + 1));
      for (let k = kLo; k <= kHi; k++) if (!covered[k] && distToEdge(C[k], a, b).d <= TOL) covered[k] = 1;
    };

    let progress = 0, best = 0, misses = 0;
    markNear(r[i], 0);
    let prev = r[i], prevS = 0;
    for (let j = i + 1; j < n; j++) {
      const p = r[j];
      // Still at the start and the run comes back into the start circle after leaving it (an
      // overshoot, or a turnaround just before the segment): the later pass is the real start.
      if (best < 2 * TOL && j > i + 1 && hypot(p, start) <= TOL && hypot(r[j - 1], start) > TOL) return attempt(j);
      let found = nearestOnPath(p, progress - WINDOW_BACK_M, progress + WINDOW_AHEAD_M);
      for (let w = 0; found === null && w < WINDOW_WIDEN_M.length; w++) {
        found = nearestOnPath(p, progress - WINDOW_BACK_M, progress + WINDOW_WIDEN_M[w]);
      }
      if (found === null) {
        if (++misses >= MAX_MISSES) return null;
        continue;
      }
      misses = 0;
      if (found < best - MAX_REGRESSION_M) return null;
      progress = found;
      if (progress > best) best = progress;
      markNear(p, progress);
      if (hypot(prev, p) > chordLen) markChord(prev, p, prevS, progress);
      prev = p;
      prevS = progress;

      if (progress >= MIN_PROGRESS_FRACTION * L && hypot(p, end) <= TOL) {
        // Finishing: walk on while inside the end circle and take the edge that passes closest to
        // the segment end, with the time at its nearest point.
        let endIdx = j, endT = t[j], bestD = Infinity;
        for (let k = j; k < n; k++) {
          if (k > j) markNear(r[k], L);
          const dEnd = hypot(r[k], end);
          if (k > j && dEnd > TOL) break;
          if (k >= 1) {
            const { d, f } = distToEdge(end, r[k - 1], r[k]);
            if (d < bestD) { bestD = d; endIdx = k; endT = edgeTime(k - 1, f, 'end'); }
          } else if (dEnd < bestD) { bestD = dEnd; endIdx = k; endT = t[k]; }
        }
        if (endIdx <= i) return null;
        let hits = 0;
        for (let k = 0; k < covered.length; k++) hits += covered[k];
        if (hits < MIN_COVERAGE_FRACTION * covered.length) return null;
        const st = startTime(i);
        const elapsed = endT - st.t;
        if (!(elapsed > 0) || endIdx <= i) return null;
        return { start_idx: Math.min(st.idx, endIdx - 1), end_idx: endIdx, elapsed_s: elapsed, started_at_s: st.t };
      }
    }
    return null;
  };

  const efforts: Effort[] = [];
  let i = 0, outside = true;
  while (i < n) {
    if (hypot(r[i], start) <= TOL) {
      if (outside) {
        const e = attempt(i);
        if (e) {
          efforts.push(e);
          i = e.end_idx;
          outside = true;
          continue;
        }
        outside = false;
      }
    } else {
      outside = true;
    }
    i++;
  }
  return efforts;
}

/** The polyline, watch distance and box of the run between two point indices (either order). */
export function subTrack(track: Track, startIdx: number, endIdx: number): { pts: [number, number][]; distance_m: number; bbox: Bbox } {
  const last = track.pts.length - 1;
  const a = Math.max(0, Math.min(startIdx, endIdx, last));
  const b = Math.max(0, Math.min(Math.max(startIdx, endIdx), last));
  const pts = track.pts.slice(a, b + 1);
  const distance_m = track.dist.length ? track.dist[b] - track.dist[a] : 0;
  const bbox = bboxOf(pts) ?? [0, 0, 0, 0];
  return { pts, distance_m, bbox };
}

/** 1 -> gold, 2 -> silver, 3 -> bronze, anything else null. */
export function medalFor(rank: number): 'gold' | 'silver' | 'bronze' | null {
  return rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
}

/**
 * Efforts fastest first with a 1-based rank; equal times rank the earlier date first (an unknown
 * date sorts after a known one). The input array is not mutated.
 */
export function rankEfforts<T extends { elapsed_s: number; started_at: string | null }>(efforts: T[]): (T & { rank: number })[] {
  return [...efforts]
    .sort((a, b) => {
      if (a.elapsed_s !== b.elapsed_s) return a.elapsed_s - b.elapsed_s;
      if (a.started_at === b.started_at) return 0;
      if (a.started_at === null) return 1;
      if (b.started_at === null) return -1;
      return a.started_at < b.started_at ? -1 : 1;
    })
    .map((e, k) => ({ ...e, rank: k + 1 }));
}
