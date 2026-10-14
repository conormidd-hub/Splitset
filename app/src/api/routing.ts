import polyline from '@mapbox/polyline';

import type { LatLng } from '../lib/geo.ts';
import { haversineKm } from '../lib/geo.ts';

/**
 * Pedestrian routing and terrain heights from a Valhalla server.
 *
 * The default is the public OpenStreetMap instance (CORS `*`, no key); set
 * `EXPO_PUBLIC_VALHALLA_URL` to point at another. This module speaks plain `fetch` and knows nothing
 * about React, so the route builder can be driven from Node with a fake `Router` in tests and with
 * `valhalla` in the app. Relative imports carry `.ts` so Node can run it directly.
 */

export type RoutedPath = { pts: [number, number][]; distance_m: number; duration_s: number };
export type Router = {
  route: (points: LatLng[]) => Promise<RoutedPath>;
  heights: (pts: [number, number][]) => Promise<number[]>;
};

export const ROUTING_PROVIDER = 'Valhalla · OpenStreetMap';

// Dot access on process.env so Expo inlines the value at bundle time.
const BASE_URL = (process.env.EXPO_PUBLIC_VALHALLA_URL || 'https://valhalla1.openstreetmap.de').replace(/\/+$/, '');

/** A waypoint that snapped further than this from where it was asked for is not on any path. */
const MAX_SNAP_M = 300;
/** The height endpoint is asked for at most this many points, spread evenly along the path. */
const MAX_HEIGHT_POINTS = 400;
/** Valhalla encodes route shapes with six decimals, not Google's five. */
const SHAPE_PRECISION = 6;

type ValhallaLocation = { lat: number; lon: number; type?: string; original_index?: number };
type RouteResponse = {
  trip?: {
    summary?: { length?: number; time?: number };
    legs?: { shape?: string }[];
    locations?: ValhallaLocation[];
  };
  error?: string;
};
type HeightResponse = { height?: (number | null)[]; error?: string };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: (T & { error?: string }) | null = null;
  try {
    json = (await res.json()) as T & { error?: string };
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(json?.error ? `Routing: ${json.error}` : `Routing failed (${res.status})`);
  if (!json) throw new Error('Routing: empty response');
  return json;
}

/**
 * Metres from `p` to the nearest point of the path (point-to-edge, local metre frame around p).
 * Used to measure how far a waypoint was snapped onto the road network.
 */
function distToPathM(p: LatLng, pts: [number, number][]): number {
  if (!pts.length) return Infinity;
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180), ky = 111320;
  let ax = (pts[0][1] - p.lng) * kx, ay = (pts[0][0] - p.lat) * ky;
  let best = Math.hypot(ax, ay);
  for (let i = 1; i < pts.length; i++) {
    const bx = (pts[i][1] - p.lng) * kx, by = (pts[i][0] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // p is the origin, so its foot on the edge is at fraction -(a . d) / |d|^2
    const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + dx * f, ay + dy * f);
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/**
 * Route through `points` on foot. The first and last are `break` locations, the rest `through`, so
 * Valhalla returns one leg and never U-turns at a waypoint. Legs are decoded at precision 6 and
 * concatenated (dropping each later leg's first point, which repeats the previous leg's last).
 *
 * Throws when the server reports no route, or when any waypoint was snapped more than 300 m from
 * where it was requested. The public server echoes the REQUESTED coordinates in `trip.locations`
 * (verified: 0 m difference even when the start was 124 m off any path), so the snap is measured
 * against the returned shape: the first/last shape point for the break locations and the nearest
 * edge of the shape for through locations. `trip.locations` is still checked in case a server
 * does return snapped coordinates.
 */
async function route(points: LatLng[]): Promise<RoutedPath> {
  if (points.length < 2) throw new Error('Routing needs at least two points');
  const locations = points.map((p, i) => ({
    lat: p.lat,
    lon: p.lng,
    type: i === 0 || i === points.length - 1 ? 'break' : 'through',
  }));
  const json = await post<RouteResponse>('/route', {
    locations,
    costing: 'pedestrian',
    units: 'kilometers',
    directions_type: 'none',
  });
  const trip = json.trip;
  if (!trip?.legs?.length || !trip.summary) throw new Error(json.error ? `Routing: ${json.error}` : 'No route found');

  const snapped = trip.locations ?? [];
  snapped.forEach((loc, k) => {
    const idx = typeof loc.original_index === 'number' ? loc.original_index : k;
    const asked = points[idx];
    if (!asked || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return;
    if (haversineKm(asked, { lat: loc.lat, lng: loc.lon }) * 1000 > MAX_SNAP_M) {
      throw new Error('A point is too far from any road or path');
    }
  });

  const pts: [number, number][] = [];
  trip.legs.forEach((leg, k) => {
    if (!leg.shape) return;
    const decoded = polyline.decode(leg.shape, SHAPE_PRECISION);
    pts.push(...(k > 0 && pts.length ? decoded.slice(1) : decoded));
  });
  if (pts.length < 2) throw new Error('No route found');

  const last = points.length - 1;
  points.forEach((asked, i) => {
    const snapM =
      i === 0 ? haversineKm(asked, { lat: pts[0][0], lng: pts[0][1] }) * 1000
      : i === last ? haversineKm(asked, { lat: pts[pts.length - 1][0], lng: pts[pts.length - 1][1] }) * 1000
      : distToPathM(asked, pts);
    if (snapM > MAX_SNAP_M) throw new Error('A point is too far from any road or path');
  });
  return { pts, distance_m: (trip.summary.length ?? 0) * 1000, duration_s: trip.summary.time ?? 0 };
}

/** Cumulative great-circle distance along pts, metres. */
function cumulative(pts: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1] + haversineKm({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] }) * 1000);
  }
  return out;
}

/** `count` points spread evenly by distance along pts, with their distances. */
function resampleEven(pts: [number, number][], cum: number[], count: number): { pts: [number, number][]; cum: number[] } {
  const total = cum[cum.length - 1];
  const outPts: [number, number][] = [];
  const outCum: number[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? (target - cum[seg]) / len : 0;
    outPts.push([pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * f, pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * f]);
    outCum.push(target);
  }
  return { pts: outPts, cum: outCum };
}

/** Linear interpolation of ys (at xs, increasing) onto `targets`. */
function interpolate(xs: number[], ys: number[], targets: number[]): number[] {
  let k = 0;
  return targets.map((x) => {
    while (k < xs.length - 2 && xs[k + 1] < x) k++;
    const span = xs[k + 1] - xs[k];
    const f = span > 0 ? Math.max(0, Math.min(1, (x - xs[k]) / span)) : 0;
    return ys[k] + (ys[k + 1] - ys[k]) * f;
  });
}

/**
 * Terrain height in metres at every point of `pts`, aligned 1:1 with the input. Paths longer than
 * 400 points are resampled evenly for the request and the heights interpolated back by distance.
 * Gaps the server reports as null are filled from their neighbours.
 */
async function heights(input: [number, number][]): Promise<number[]> {
  if (!input.length) return [];
  const pts = input.length === 1 ? [input[0], input[0]] : input;
  const cum = cumulative(pts);
  const sent = pts.length > MAX_HEIGHT_POINTS ? resampleEven(pts, cum, MAX_HEIGHT_POINTS) : { pts, cum };
  const json = await post<HeightResponse>('/height', { shape: sent.pts.map(([lat, lon]) => ({ lat, lon })) });
  const raw = json.height;
  if (!Array.isArray(raw) || raw.length !== sent.pts.length) throw new Error(json.error ? `Heights: ${json.error}` : 'Height lookup failed');
  const filled = raw.map((h) => (typeof h === 'number' && Number.isFinite(h) ? h : null));
  let last: number | null = null;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] == null) filled[i] = last;
    else last = filled[i];
  }
  for (let i = filled.length - 1; i >= 0; i--) {
    if (filled[i] == null) filled[i] = last;
    else last = filled[i];
  }
  const hs = filled.map((h) => h ?? 0);
  const aligned = sent.pts === pts ? hs : interpolate(sent.cum, hs, cum);
  return aligned.slice(0, input.length);
}

export const valhalla: Router = { route, heights };
