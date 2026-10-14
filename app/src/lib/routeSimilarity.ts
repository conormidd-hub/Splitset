import type { LatLng } from './geo.ts';
import { bboxOf, clusterByLocation } from './geo.ts';

/**
 * "Trails you run most": group runs that follow the same route.
 *
 * Two runs are the same route when each one's SIGNATURE (its path resampled every 50 m, at most
 * 400 points) lies close to the other's full polyline. `similarity` is the mean, over a's signature
 * points, of the distance to the nearest vertex of b, averaged with the same measure from b to a.
 * Nearest-vertex lookups go through a 100 m grid hash built once per run, so a comparison costs
 * a few thousand distance checks rather than a few million. Runs are grouped greedily against the
 * first member of each group after a cheap 15 % distance gate and a bounding-box gate.
 *
 * Geometry is in local metres. Runs are first clustered by location (the heat map's 30 km
 * clusters) and each cluster gets its own frame, so the longitude scale is right everywhere and a
 * holiday run never shares a frame with home.
 */

export type RouteMember = {
  id: string;
  pts: [number, number][];
  distance_m: number | null;
  moving_time_s: number | null;
  start_time_local: string;
};

export type RouteGroup = {
  key: string;
  members: RouteMember[];
  count: number;
  /** The member whose distance is closest to the group's median: the one to draw. */
  representative: RouteMember;
  typicalDistanceM: number;
  /** Lowest moving time, or null when no member has one. */
  best: RouteMember | null;
  /** Latest start_time_local among the members. */
  lastDate: string;
};

const M_PER_DEG_LAT = 111320;
const SIGNATURE_STEP_M = 50;
const SIGNATURE_CAP = 400;
const CELL_M = 100;
/** Rings of cells searched before giving up; the last covers 800 m. */
const SEARCH_RADII = [1, 2, 4, 8];
/** Distance reported when nothing lies within the search radius; saturates far-off divergence. */
const FAR_M = 1000;
const DISTANCE_GATE = 0.15;
const BOX_GATE_M = 200;

type XY = { x: number; y: number };
type Grid = Map<number, XY[]>;
type Prepared = {
  m: RouteMember;
  xy: XY[];
  sig: XY[];
  grid: Grid;
  box: [number, number, number, number];
  /** The gating distance: the watch distance, else the path length. */
  distance: number;
};

function projector(origin: LatLng): (p: [number, number]) => XY {
  const kx = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return ([lat, lng]) => ({ x: (lng - origin.lng) * kx, y: (lat - origin.lat) * M_PER_DEG_LAT });
}

const cellKey = (ix: number, iy: number) => (ix + 100000) * 200000 + (iy + 100000);

function buildGrid(xy: XY[]): Grid {
  const grid: Grid = new Map();
  for (const p of xy) {
    const k = cellKey(Math.floor(p.x / CELL_M), Math.floor(p.y / CELL_M));
    const cell = grid.get(k);
    if (cell) cell.push(p);
    else grid.set(k, [p]);
  }
  return grid;
}

/** Points every ~50 m along the path (at most 400, spread evenly when the path is longer than 20 km). */
function signature(xy: XY[]): XY[] {
  if (xy.length < 2) return xy.slice();
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
  const total = cum[cum.length - 1];
  if (total <= 0) return [xy[0]];
  const steps = Math.min(SIGNATURE_CAP - 1, Math.max(1, Math.floor(total / SIGNATURE_STEP_M)));
  const step = total / steps;
  const out: XY[] = [];
  let seg = 0;
  for (let k = 0; k <= steps; k++) {
    const target = k === steps ? total : k * step;
    while (seg < xy.length - 2 && cum[seg + 1] < target) seg++;
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? (target - cum[seg]) / len : 0;
    out.push({ x: xy[seg].x + (xy[seg + 1].x - xy[seg].x) * f, y: xy[seg].y + (xy[seg + 1].y - xy[seg].y) * f });
  }
  return out;
}

/** Distance from p to the nearest gridded point, searching outward ring by ring; FAR_M when none. */
function nearestDistance(grid: Grid, p: XY): number {
  const cx = Math.floor(p.x / CELL_M), cy = Math.floor(p.y / CELL_M);
  let best = Infinity;
  for (const R of SEARCH_RADII) {
    for (let ix = cx - R; ix <= cx + R; ix++) {
      for (let iy = cy - R; iy <= cy + R; iy++) {
        const cell = grid.get(cellKey(ix, iy));
        if (!cell) continue;
        for (const q of cell) {
          const dx = q.x - p.x, dy = q.y - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
      }
    }
    // A vertex just outside the block can still be nearer than a corner-cell hit, so only stop
    // once the best found is within the radius every outer cell lies beyond.
    if (best <= (R * CELL_M) ** 2) return Math.sqrt(best);
  }
  return Math.min(FAR_M, Math.sqrt(best));
}

/** Mean nearest distance from each signature point to the grid; Infinity as soon as it cannot stay under `bail`. */
function directionalMean(sig: XY[], grid: Grid, bail: number): number {
  if (!sig.length) return Infinity;
  const limit = bail * sig.length;
  let sum = 0;
  for (const p of sig) {
    sum += nearestDistance(grid, p);
    if (sum > limit) return Infinity;
  }
  return sum / sig.length;
}

/** Symmetric similarity in metres (lower is more alike); Infinity once it is certain to exceed `threshold`. */
function similarity(a: Prepared, b: Prepared, threshold: number): number {
  const ab = directionalMean(a.sig, b.grid, 2 * threshold);
  if (!Number.isFinite(ab)) return Infinity;
  const ba = directionalMean(b.sig, a.grid, 2 * threshold - ab);
  if (!Number.isFinite(ba)) return Infinity;
  return (ab + ba) / 2;
}

function prepare(m: RouteMember, project: (p: [number, number]) => XY): Prepared {
  const xy = m.pts.map(project);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, length = 0;
  for (let i = 0; i < xy.length; i++) {
    const p = xy[i];
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
    if (i > 0) length += Math.hypot(p.x - xy[i - 1].x, p.y - xy[i - 1].y);
  }
  const distance = m.distance_m != null && m.distance_m > 0 ? m.distance_m : length;
  return { m, xy, sig: signature(xy), grid: buildGrid(xy), box: [minx, miny, maxx, maxy], distance };
}

function passesGates(a: Prepared, b: Prepared): boolean {
  const longer = Math.max(a.distance, b.distance);
  if (longer <= 0 || Math.abs(a.distance - b.distance) / longer > DISTANCE_GATE) return false;
  return (
    a.box[0] - BOX_GATE_M <= b.box[2] && b.box[0] - BOX_GATE_M <= a.box[2] &&
    a.box[1] - BOX_GATE_M <= b.box[3] && b.box[1] - BOX_GATE_M <= a.box[3]
  );
}

function toGroup(members: Prepared[]): RouteGroup {
  const distances = members.map((p) => p.distance).sort((a, b) => a - b);
  const mid = distances.length >> 1;
  const median = distances.length % 2 ? distances[mid] : (distances[mid - 1] + distances[mid]) / 2;
  let representative = members[0];
  for (const p of members) if (Math.abs(p.distance - median) < Math.abs(representative.distance - median)) representative = p;
  let best: Prepared | null = null;
  for (const p of members) {
    const mt = p.m.moving_time_s;
    if (mt != null && mt > 0 && (best === null || mt < (best.m.moving_time_s as number))) best = p;
  }
  let lastDate = members[0].m.start_time_local;
  for (const p of members) if (p.m.start_time_local > lastDate) lastDate = p.m.start_time_local;
  return {
    key: members[0].m.id,
    members: members.map((p) => p.m),
    count: members.length,
    representative: representative.m,
    typicalDistanceM: median,
    best: best ? best.m : null,
    lastDate,
  };
}

/**
 * Group runs by route. Each run joins the first existing group whose FIRST member passes the
 * distance gate (within 15 %), the box gate (boxes within 200 m of touching) and has similarity
 * <= `thresholdM`; otherwise it starts a group. Input order decides which member is "first", so
 * pass runs newest first to make the latest run the anchor. Groups come back most-run first, then
 * most recent. Runs with fewer than two points are ignored.
 */
export function groupRoutes(runs: RouteMember[], thresholdM = 35): RouteGroup[] {
  const usable = runs.filter((r) => r.pts.length >= 2);
  const clusters = clusterByLocation(usable, (r) => bboxOf(r.pts) as [number, number, number, number]);
  const groups: RouteGroup[] = [];
  for (const cluster of clusters) {
    const project = projector(cluster.center);
    const prepared = cluster.items.map((r) => prepare(r, project));
    const local: { first: Prepared; members: Prepared[] }[] = [];
    for (const p of prepared) {
      let home: { first: Prepared; members: Prepared[] } | null = null;
      for (const g of local) {
        if (!passesGates(p, g.first)) continue;
        if (similarity(p, g.first, thresholdM) <= thresholdM) { home = g; break; }
      }
      if (home) home.members.push(p);
      else local.push({ first: p, members: [p] });
    }
    for (const g of local) groups.push(toGroup(g.members));
  }
  return groups.sort((a, b) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));
}
