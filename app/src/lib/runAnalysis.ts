import { haversineKm } from './geo.ts';
import { formatElevation, formatPace, secPerKm } from './units.ts';

/**
 * Per-point analysis of a recorded run.
 *
 * A run arrives in two halves that were sampled differently:
 *   - the polyline carries the SHAPE: GPS fixes thinned to roughly one point every 12 m of watch
 *     distance (longer runs are index-subsampled, so a marathon is ~24 m apart);
 *   - `activity_details.samples` carries the METRICS: time, distance, heart rate, altitude and
 *     (from the revised sync) cadence, one row every 10 s.
 * The two are aligned by watch distance: every polyline point gets a distance, and each metric is
 * read off the samples at that distance. `buildTrack` is the only place that does this; the UI,
 * the segment matcher and the route grouping all consume the resulting `Track`.
 *
 * Everything here is pure and runs in Node as well as in the app, so the pure modules import each
 * other with explicit `.ts` extensions (`node src/lib/runAnalysis.ts` works).
 */

export type Samples = {
  /** Seconds since the start of the activity. Strictly increasing. */
  t: number[];
  /** Watch distance in metres at each sample. Non-decreasing; flat while stopped. */
  d: number[];
  hr: (number | null)[] | null;
  alt: (number | null)[] | null;
  /** Full steps per minute (already doubled for per-leg devices by the sync). */
  cad?: (number | null)[] | null;
  /** Watch distance at each POLYLINE point (same length as the decoded polyline), when the sync wrote it. */
  route_d?: number[] | null;
};

export type Track = {
  pts: [number, number][];
  /** Watch distance (metres) at each point. Monotonic, ends at the activity distance. */
  dist: number[];
  /** Seconds since start at each point; null when there are no samples. */
  t: number[] | null;
  alt: (number | null)[];
  hr: (number | null)[];
  cad: (number | null)[];
  /** Moving pace in s/km at each point (stops excluded); null where unknown or slower than 20 min/km. */
  pace: (number | null)[];
  /** Grade in percent over ~100 m of distance; null without altitude. */
  grade: (number | null)[];
  totalDist: number;
  totalTime: number | null;
  /** Mean geometric distance between consecutive polyline points (metres); 0 without a polyline. */
  spacingM: number;
  hasAlt: boolean;
  hasHr: boolean;
  hasCad: boolean;
  hasPace: boolean;
};

export type Metric = 'pace' | 'hr' | 'cad' | 'alt';

export const METRICS: { key: Metric; label: string; short: string }[] = [
  { key: 'pace', label: 'Pace', short: 'Pace' },
  { key: 'hr', label: 'Heart rate', short: 'HR' },
  { key: 'cad', label: 'Cadence', short: 'Cad' },
  { key: 'alt', label: 'Elevation', short: 'Elev' },
];

type Nullable = (number | null)[];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A pair of consecutive samples counts as stopped under 3 m of distance or 0.5 m/s. */
const STOP_MIN_M = 3;
const STOP_MIN_MPS = 0.5;
/** Pace slower than this is treated as unknown (walking a dog, fiddling with the watch). */
const PACE_MAX_S_PER_KM = 1200;
/** Half of the distance window the grade is measured over. */
const GRADE_HALF_WINDOW_M = 50;
/** Altitude must move this far from the running reference before it counts as climb or descent. */
const ELEV_HYSTERESIS_M = 3;

// ---------------------------------------------------------------- small numeric helpers

/** First index whose value is >= x (xs non-decreasing); xs.length when none. */
function lowerBound(xs: number[], x: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Running maximum, so a distance array can be trusted to be non-decreasing. */
function monotone(xs: number[]): number[] {
  const out = new Array<number>(xs.length);
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const v = isNum(xs[i]) ? xs[i] : m;
    m = Math.max(m, v);
    out[i] = m === -Infinity ? 0 : m;
  }
  return out;
}

/** Cumulative great-circle distance along the polyline, in metres. */
function cumulativeMetres(pts: [number, number][]): number[] {
  const out = new Array<number>(pts.length);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      acc += haversineKm({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] }) * 1000;
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Value of a sampled series at distance `x`.
 *
 * `xs` is the non-decreasing distance of each sample (it may plateau while stopped). Between two
 * samples the value is interpolated linearly, but never across a null: if one neighbour is null
 * the other (the nearest non-null within one sample) is used, and if both are null the result is
 * null. When `x` lands exactly on a sample, or on a plateau of equal distances, the FIRST sample
 * at that distance is used: the moment the runner arrived there. That arrival convention is what
 * the segment matcher relies on for its end times.
 */
function interpAt(xs: number[], ys: Nullable, x: number): number | null {
  const n = xs.length;
  if (n === 0) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[lowerBound(xs, xs[n - 1])];
  const k = lowerBound(xs, x); // xs[k] >= x and xs[k - 1] < x
  if (xs[k] === x) return ys[k];
  const y0 = ys[k - 1], y1 = ys[k];
  if (y0 == null && y1 == null) return null;
  if (y0 == null) return y1;
  if (y1 == null) return y0;
  const f = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
  return y0 + f * (y1 - y0);
}

const nulls = (n: number): Nullable => new Array<number | null>(n).fill(null);
const anyNum = (xs: Nullable) => xs.some(isNum);

// ---------------------------------------------------------------- pace and grade

/**
 * Moving pace per consecutive pair of samples.
 *
 * Pair k spans samples k and k+1 with dd metres over dt seconds. It is "stopped" when dd < 3 m or
 * slower than 0.5 m/s. The pace of pair k is sum(dd)/sum(dt) over the MOVING pairs among k-1, k
 * and k+1, so a stop never drags the reading down and a single noisy 10 s step is smoothed; it is
 * null when all three pairs are stopped or when slower than 20 min/km. Returned with the distance
 * at the middle of each pair, ready to be interpolated onto the polyline.
 */
function pairPace(t: number[], d: number[]): { x: number[]; pace: Nullable } {
  const m = Math.max(0, t.length - 1);
  const dd = new Array<number>(m), dt = new Array<number>(m), moving = new Array<boolean>(m);
  const x = new Array<number>(m);
  for (let k = 0; k < m; k++) {
    dd[k] = d[k + 1] - d[k];
    dt[k] = t[k + 1] - t[k];
    moving[k] = dd[k] >= STOP_MIN_M && dt[k] > 0 && dd[k] / dt[k] >= STOP_MIN_MPS;
    x[k] = (d[k] + d[k + 1]) / 2;
  }
  const pace: Nullable = new Array(m).fill(null);
  for (let k = 0; k < m; k++) {
    let sd = 0, st = 0;
    for (let w = Math.max(0, k - 1); w <= Math.min(m - 1, k + 1); w++) {
      if (!moving[w]) continue;
      sd += dd[w];
      st += dt[w];
    }
    if (sd <= 0 || st <= 0) continue;
    const p = 1000 / (sd / st);
    pace[k] = p > PACE_MAX_S_PER_KM ? null : p;
  }
  return { x, pace };
}

/**
 * Grade in percent at each point: the altitude difference between the points ~50 m behind and
 * ~50 m ahead (by distance) divided by the distance between them. Altitude is first smoothed with
 * a 3-point moving average so a single barometric blip does not read as a wall. Clamped to ±50 %.
 */
function gradeOf(dist: number[], alt: Nullable): Nullable {
  const n = dist.length;
  const out = nulls(n);
  if (!anyNum(alt)) return out;
  const smooth: Nullable = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let w = Math.max(0, i - 1); w <= Math.min(n - 1, i + 1); w++) {
      const v = alt[w];
      if (isNum(v)) { s += v; c++; }
    }
    smooth[i] = c ? s / c : null;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.min(n - 1, lowerBound(dist, dist[i] - GRADE_HALF_WINDOW_M));
    const b = Math.min(n - 1, lowerBound(dist, dist[i] + GRADE_HALF_WINDOW_M));
    const ha = smooth[a], hb = smooth[b];
    const span = dist[b] - dist[a];
    if (ha == null || hb == null || span < 20) continue;
    out[i] = Math.max(-50, Math.min(50, ((hb - ha) / span) * 100));
  }
  return out;
}

// ---------------------------------------------------------------- the track

function validSamples(s: Samples | null): s is Samples {
  return !!s && Array.isArray(s.t) && Array.isArray(s.d) && s.t.length >= 2 && s.d.length === s.t.length;
}

/**
 * Join a polyline and its samples into one per-point track.
 *
 * Distance per polyline point, in order of preference:
 *   1. `samples.route_d`, the watch distance at each kept GPS fix (written by the revised sync);
 *   2. cumulative haversine along the polyline rescaled so the last point equals the last sample's
 *      distance, when that scale factor is within [0.85, 1.2] (GPS and the footpod/wheel agree
 *      roughly, so stretching one onto the other is safe);
 *   3. otherwise unscaled haversine clamped to the sample total (treadmill-ish or GPS-dropout runs
 *      where the two disagree badly);
 *   4. plain haversine when there are no samples at all (then there is no time and no metric).
 * Metrics are read from the samples at each point's distance (see `interpAt`), pace from the
 * per-pair moving pace (see `pairPace`), and grade from the interpolated altitude.
 *
 * With no polyline (treadmill, virtual run) the track is samples-only: one entry per sample with
 * `pts` empty, so the charts and stats still work and the UI skips the map. Returns null only when
 * there is neither a polyline nor usable samples.
 */
export function buildTrack(pts: [number, number][], samples: Samples | null): Track | null {
  const hasSamples = validSamples(samples);
  const n = pts.length;
  if (n === 0 && !hasSamples) return null;

  if (n === 0) {
    const s = samples as Samples;
    const d = monotone(s.d);
    const count = d.length;
    const alt = s.alt && s.alt.length === count ? s.alt : nulls(count);
    const hr = s.hr && s.hr.length === count ? s.hr : nulls(count);
    const cad = s.cad && s.cad.length === count ? s.cad : nulls(count);
    const pp = pairPace(s.t, d);
    const pace = d.map((x) => interpAt(pp.x, pp.pace, x));
    const grade = gradeOf(d, alt);
    const totalDist = d[count - 1];
    return finish({ pts: [], dist: d, t: s.t.slice(), alt, hr, cad, pace, grade, totalDist, totalTime: s.t[count - 1] - s.t[0], spacingM: count > 1 ? totalDist / (count - 1) : 0 });
  }

  const hav = cumulativeMetres(pts);
  let dist: number[];
  if (hasSamples && samples.route_d && samples.route_d.length === n) {
    dist = monotone(samples.route_d);
  } else if (hasSamples) {
    const total = samples.d[samples.d.length - 1];
    const havTotal = hav[n - 1];
    const scale = havTotal > 0 ? total / havTotal : 1;
    dist = scale >= 0.85 && scale <= 1.2 ? hav.map((v) => v * scale) : hav.map((v) => Math.min(v, total));
  } else {
    dist = hav;
  }
  const spacingM = n > 1 ? hav[n - 1] / (n - 1) : 0;

  if (!hasSamples) {
    return finish({ pts, dist, t: null, alt: nulls(n), hr: nulls(n), cad: nulls(n), pace: nulls(n), grade: nulls(n), totalDist: dist[n - 1], totalTime: null, spacingM });
  }

  const sd = monotone(samples.d);
  const count = sd.length;
  const t = dist.map((x) => interpAt(sd, samples.t, x) as number);
  const pick = (series: Nullable | null | undefined) =>
    series && series.length === count ? dist.map((x) => interpAt(sd, series, x)) : nulls(n);
  const alt = pick(samples.alt);
  const hr = pick(samples.hr);
  const cad = pick(samples.cad);
  const pp = pairPace(samples.t, sd);
  const pace = dist.map((x) => interpAt(pp.x, pp.pace, x));
  const grade = gradeOf(dist, alt);
  return finish({ pts, dist, t, alt, hr, cad, pace, grade, totalDist: dist[n - 1], totalTime: samples.t[count - 1] - samples.t[0], spacingM });
}

function finish(core: Omit<Track, 'hasAlt' | 'hasHr' | 'hasCad' | 'hasPace'>): Track {
  return { ...core, hasAlt: anyNum(core.alt), hasHr: anyNum(core.hr), hasCad: anyNum(core.cad), hasPace: anyNum(core.pace) };
}

export function metricValues(track: Track, m: Metric): (number | null)[] {
  switch (m) {
    case 'pace': return track.pace;
    case 'hr': return track.hr;
    case 'cad': return track.cad;
    case 'alt': return track.alt;
  }
}

export function hasMetric(track: Track, m: Metric): boolean {
  switch (m) {
    case 'pace': return track.hasPace;
    case 'hr': return track.hasHr;
    case 'cad': return track.hasCad;
    case 'alt': return track.hasAlt;
  }
}

/** Index of the track point nearest to distance `d` (metres). */
export function indexAtDist(track: Track, d: number): number {
  const xs = track.dist;
  const n = xs.length;
  if (n === 0) return 0;
  const k = lowerBound(xs, d);
  if (k <= 0) return 0;
  if (k >= n) return n - 1;
  return d - xs[k - 1] <= xs[k] - d ? k - 1 : k;
}

/** Index of the projected point nearest to a screen position; 0 for an empty list. */
export function nearestIndex(screenPts: { x: number; y: number }[], px: number, py: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < screenPts.length; i++) {
    const dx = screenPts[i].x - px, dy = screenPts[i].y - py;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- colour

export type ColourScale = {
  colour: (v: number | null) => string;
  /** Sorted by `v`; a legend draws a gradient through them and labels the first and last. */
  stops: { v: number; colour: string }[];
  label: (v: number) => string;
};

/** The scales also remember how to bin and which end is "worst"; the public type stays as declared. */
type ScaleInternals = ColourScale & { worstEnd?: 'lo' | 'hi'; edges?: number[] };

/** Fixed ramps that read on both the light and the dark basemap. */
const RAMPS: Record<Metric, string[]> = {
  pace: ['#1fb95c', '#e4b63a', '#e2473f'],
  hr: ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#dc2626'],
  cad: ['#e2473f', '#e4b63a', '#1fb95c'],
  alt: ['#60a5fa', '#1d4ed8'],
};
/** Points without a value (GPS gap, sensor dropout). Mid grey, visible on both tile styles. */
const NO_DATA_COLOUR = '#8b8f98';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Colour at fraction `f` in [0, 1] along a multi-stop ramp (linear in sRGB). */
function rampColour(ramp: string[], f: number): string {
  const x = Math.max(0, Math.min(1, f)) * (ramp.length - 1);
  const k = Math.min(ramp.length - 2, Math.floor(x));
  const a = hexToRgb(ramp[k]), b = hexToRgb(ramp[k + 1]);
  const u = x - k;
  return rgbToHex([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
}

function percentileBounds(nums: number[], lo = 0.05, hi = 0.95): [number, number] {
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  return [sorted[Math.floor(lo * (n - 1))], sorted[Math.ceil(hi * (n - 1))]];
}

/**
 * A colour scale for one metric over this run's values.
 *
 * Pace runs fast->slow green->amber->red, cadence low->high red->amber->green and altitude
 * low->high light->dark blue, each clamped to the 5th..95th percentile of the run so one bad GPS
 * second does not own the whole ramp. Heart rate uses the five-colour cool->hot ramp; when
 * `hrZones` (zone upper bounds, >= 3 entries) is given the colour is DISCRETE per zone, values
 * above the last bound being the top zone, otherwise the same percentile stretch. Returns null when
 * there is nothing to colour (no values, or a flat series without zones). `colour(null)` is a
 * neutral grey for points with no reading.
 */
export function colourScale(
  values: (number | null)[],
  m: Metric,
  opts?: { hrZones?: number[] | null; units?: 'metric' | 'imperial' },
): ColourScale | null {
  const nums = values.filter(isNum);
  if (!nums.length) return null;
  const ramp = RAMPS[m];
  const units = opts?.units ?? 'metric';
  const label = (v: number) => formatMetric(m, v, units);

  const zones = m === 'hr' && opts?.hrZones ? [...opts.hrZones].filter(isNum).sort((a, b) => a - b) : [];
  if (zones.length >= 3) {
    const nz = zones.length;
    // zone k is (zones[k-1], zones[k]]; anything above the last bound stays in the top zone
    const zoneOf = (v: number) => {
      let z = 0;
      while (z < nz - 1 && v > zones[z]) z++;
      return z;
    };
    const zoneColour = (z: number) => rampColour(ramp, z / (nz - 1));
    let min = Infinity, max = -Infinity;
    for (const v of nums) { if (v < min) min = v; if (v > max) max = v; }
    const lo = Math.min(min, zones[0] - (zones[1] - zones[0]));
    const hi = Math.max(max, zones[nz - 1], zones[nz - 2] + (zones[nz - 2] - zones[nz - 3]));
    const edges = [lo, ...zones.slice(0, nz - 1), hi];
    const stops = edges.slice(0, nz).map((v, z) => ({ v, colour: zoneColour(z) }));
    stops.push({ v: hi, colour: zoneColour(nz - 1) });
    const scale: ScaleInternals = {
      colour: (v) => (isNum(v) ? zoneColour(zoneOf(v)) : NO_DATA_COLOUR),
      stops,
      label,
      worstEnd: 'hi',
      edges,
    };
    return scale;
  }

  let [p5, p95] = percentileBounds(nums);
  if (p95 - p5 < 1e-9) {
    p5 = Math.min(...nums);
    p95 = Math.max(...nums);
  }
  if (p95 - p5 < 1e-9) return null;
  const span = p95 - p5;
  const scale: ScaleInternals = {
    colour: (v) => (isNum(v) ? rampColour(ramp, (v - p5) / span) : NO_DATA_COLOUR),
    stops: ramp.map((colour, k) => ({ v: p5 + (span * k) / (ramp.length - 1), colour })),
    label,
    worstEnd: m === 'cad' ? 'lo' : 'hi',
  };
  return scale;
}

/**
 * Group point indices into at most 12 colour bins so the trail can be drawn as one SVG path per
 * bin instead of one per point. Bins are even steps across the scale's domain (zone scales bin by
 * zone instead) and come back WORST FIRST: the slow / hot / low-cadence end of the ramp leads so
 * the good bins are painted on top where paths overlap. Points with no value form a leading grey
 * bin. Empty bins are omitted. An index in `indices` colours the trail edge arriving at that point.
 */
export function binColours(values: (number | null)[], scale: ColourScale, bins = 12): { colour: string; indices: number[] }[] {
  const internals = scale as ScaleInternals;
  const stops = scale.stops;
  if (!stops.length) return [];
  let edges = internals.edges;
  if (!edges) {
    const nb = Math.max(1, Math.min(12, Math.round(bins)));
    const lo = stops[0].v, hi = stops[stops.length - 1].v;
    edges = Array.from({ length: nb + 1 }, (_, k) => lo + ((hi - lo) * k) / nb);
  }
  const nb = edges.length - 1;
  const buckets: number[][] = Array.from({ length: nb }, () => []);
  const missing: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNum(v)) { missing.push(i); continue; }
    let k = 0;
    while (k < nb - 1 && v > edges[k + 1]) k++;   // (lo, hi] bins, matching zoneOf
    buckets[k].push(i);
  }
  const order = internals.worstEnd === 'lo' ? buckets.map((_, k) => k) : buckets.map((_, k) => nb - 1 - k);
  const out: { colour: string; indices: number[] }[] = [];
  if (missing.length) out.push({ colour: scale.colour(null), indices: missing });
  for (const k of order) {
    if (!buckets[k].length) continue;
    out.push({ colour: scale.colour((edges[k] + edges[k + 1]) / 2), indices: buckets[k] });
  }
  return out;
}

/**
 * Total climb and descent with hysteresis: altitude is smoothed with a 3-point moving average
 * (nulls skipped), then every move of at least 3 m away from a running reference is booked as gain
 * or loss and the reference jumps to the new altitude. Jitter below 3 m never accumulates.
 */
export function elevationStats(heights: (number | null)[]): { gain: number; loss: number } {
  const vals = heights.filter(isNum);
  const n = vals.length;
  if (n < 2) return { gain: 0, loss: 0 };
  const smooth = vals.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let s = 0;
    for (let w = a; w <= b; w++) s += vals[w];
    return s / (b - a + 1);
  });
  let ref = smooth[0], gain = 0, loss = 0;
  for (const h of smooth) {
    if (h - ref >= ELEV_HYSTERESIS_M) { gain += h - ref; ref = h; }
    else if (ref - h >= ELEV_HYSTERESIS_M) { loss += ref - h; ref = h; }
  }
  return { gain, loss };
}

/** "4:41 /km", "162 bpm", "178 spm", "24 m" (or the imperial equivalents); an en dash for null. */
export function formatMetric(m: Metric, v: number | null, units: 'metric' | 'imperial'): string {
  if (!isNum(v)) return '–';
  switch (m) {
    case 'pace': return formatPace(v, units);
    case 'hr': return `${Math.round(v)} bpm`;
    case 'cad': return `${Math.round(v)} spm`;
    case 'alt': return formatElevation(v, units);
  }
}

/**
 * Median pace (s/km) over the newest ten runs that have a distance and a moving time, so the
 * estimated time for a route is the user's own, not the router's walking speed. Null without runs.
 */
export function typicalPaceSecPerKm(rows: { distance_m: number | null; moving_time_s: number | null }[] | undefined): number | null {
  if (!rows) return null;
  const paces = rows
    .map((r) => (r.distance_m != null && r.distance_m >= 1000 ? secPerKm(r.distance_m, r.moving_time_s) : null))
    .filter((p): p is number => p != null)
    .slice(0, 10)
    .sort((a, b) => a - b);
  if (!paces.length) return null;
  const mid = paces.length >> 1;
  return paces.length % 2 ? paces[mid] : (paces[mid - 1] + paces[mid]) / 2;
}
