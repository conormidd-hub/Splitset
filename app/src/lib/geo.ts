import polyline from '@mapbox/polyline';

/**
 * Web Mercator maths for the tile maps, plus the small amount of geography the heat map needs.
 * Everything here is pure; the components in src/components/map do the drawing.
 */

export type LatLng = { lat: number; lng: number };
/** [minLat, minLng, maxLat, maxLng], the shape activity_details.bbox uses. */
export type Bbox = [number, number, number, number];
export type MapView = { center: LatLng; zoom: number };
export type Pt = { x: number; y: number };

export const TILE_SIZE = 256;
export const MIN_ZOOM = 2;
/** The Gray Canvas basemap stops at 16; zooming further would show blank tiles. */
export const MAX_ZOOM = 16;

const MAX_LAT = 85.05112878;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Longitude to world pixels at zoom 0, where the whole world is one 256 px tile. */
export function mercX(lng: number): number {
  return ((lng + 180) / 360) * TILE_SIZE;
}

/** Latitude to world pixels at zoom 0. */
export function mercY(lat: number): number {
  const s = Math.sin((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_SIZE;
}

export function unMercX(x: number): number {
  return (x / TILE_SIZE) * 360 - 180;
}

export function unMercY(y: number): number {
  const n = Math.PI - (2 * Math.PI * y) / TILE_SIZE;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Decode a Google encoded polyline into [lat, lng] pairs. */
export function decodeRoute(encoded: string): [number, number][] {
  try {
    return polyline.decode(encoded) as [number, number][];
  } catch {
    return [];
  }
}

export function bboxOf(points: [number, number][]): Bbox | null {
  if (!points.length) return null;
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [minLat, minLng, maxLat, maxLng];
}

export function unionBbox(boxes: Bbox[]): Bbox | null {
  if (!boxes.length) return null;
  return boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])]);
}

/** Midpoint in Mercator space, so the box sits centred on screen rather than skewed by latitude. */
export function bboxCenter(b: Bbox): LatLng {
  return {
    lat: unMercY((mercY(b[0]) + mercY(b[2])) / 2),
    lng: unMercX((mercX(b[1]) + mercX(b[3])) / 2),
  };
}

/** The camera that shows the whole box inside width x height with `pad` pixels to spare. */
export function fitBbox(b: Bbox, width: number, height: number, pad = 24): MapView {
  const dx = Math.max(mercX(b[3]) - mercX(b[1]), 1e-9);
  const dy = Math.max(mercY(b[0]) - mercY(b[2]), 1e-9);
  const w = Math.max(1, width - pad * 2);
  const h = Math.max(1, height - pad * 2);
  const zoom = Math.log2(Math.min(w / dx, h / dy));
  return { center: bboxCenter(b), zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) };
}

/**
 * Map-local pixels back to a coordinate: the inverse of TileMap's projector for camera `cam`
 * drawn into a view of `size`. What a tap or a dragged marker on the map means in the world.
 */
export function unprojectPt(pt: Pt, cam: MapView, size: { width: number; height: number }): LatLng {
  const world = 2 ** cam.zoom;
  const tlx = mercX(cam.center.lng) * world - size.width / 2;
  const tly = mercY(cam.center.lat) * world - size.height / 2;
  return { lat: unMercY((tly + pt.y) / world), lng: unMercX((tlx + pt.x) / world) };
}

/** The box the camera shows in a view of `size`: [minLat, minLng, maxLat, maxLng]. */
export function viewBbox(cam: MapView, size: { width: number; height: number }): Bbox {
  const tl = unprojectPt({ x: 0, y: 0 }, cam, size);
  const br = unprojectPt({ x: size.width, y: size.height }, cam, size);
  return [Math.min(tl.lat, br.lat), Math.min(tl.lng, br.lng), Math.max(tl.lat, br.lat), Math.max(tl.lng, br.lng)];
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const r = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Cluster<T> = {
  items: T[];
  center: LatLng;
  /** Every item's box together. */
  bbox: Bbox;
  /** The box to frame by default: the nearest nine in ten items, so one holiday run does not shrink home to a dot. */
  fit: Bbox;
};

/**
 * Greedy grouping of routes by where they happened. A route joins the first cluster whose
 * running centre is within `radiusKm`, otherwise starts a new one. Biggest cluster first.
 */
export function clusterByLocation<T>(items: T[], boxOf: (t: T) => Bbox, radiusKm = 30): Cluster<T>[] {
  type Work = { items: T[]; boxes: Bbox[]; centers: LatLng[]; sumLat: number; sumLng: number };
  const work: Work[] = [];
  for (const item of items) {
    const box = boxOf(item);
    const c = bboxCenter(box);
    let home = work.find((w) => haversineKm({ lat: w.sumLat / w.items.length, lng: w.sumLng / w.items.length }, c) <= radiusKm);
    if (!home) {
      home = { items: [], boxes: [], centers: [], sumLat: 0, sumLng: 0 };
      work.push(home);
    }
    home.items.push(item);
    home.boxes.push(box);
    home.centers.push(c);
    home.sumLat += c.lat;
    home.sumLng += c.lng;
  }
  return work
    .map((w) => {
      const center = { lat: w.sumLat / w.items.length, lng: w.sumLng / w.items.length };
      const dists = w.centers.map((c) => haversineKm(center, c));
      const sorted = [...dists].sort((a, b) => a - b);
      const cutoff = w.items.length >= 10 ? sorted[Math.floor(sorted.length * 0.9)] : Infinity;
      const near = w.boxes.filter((_, i) => dists[i] <= cutoff);
      return { items: w.items, center, bbox: unionBbox(w.boxes)!, fit: unionBbox(near) ?? unionBbox(w.boxes)! };
    })
    .sort((a, b) => b.items.length - a.items.length);
}

/**
 * SVG path data from projected points, dropping points closer than `minStep` pixels to the last
 * one kept. A 1800-point route becomes a few dozen segments when zoomed out.
 */
export function pathD(points: Pt[], minStep = 1.5): string {
  if (points.length < 2) return '';
  const out: string[] = [`M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];
  let last = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const final = i === points.length - 1;
    if (!final && Math.abs(p.x - last.x) < minStep && Math.abs(p.y - last.y) < minStep) continue;
    out.push(`L${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
    last = p;
  }
  return out.join(' ');
}

/**
 * Like pathD, but drawn as a smooth curve: each kept point becomes the control point of a
 * quadratic from the midpoint before it to the midpoint after it, which irons out GPS zigzag
 * without moving the line off the road. For thin lines, where every wobble shows.
 */
export function smoothPathD(points: Pt[], minStep = 2.5): string {
  if (points.length < 2) return '';
  const kept: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i], last = kept[kept.length - 1];
    if (i < points.length - 1 && Math.abs(p.x - last.x) < minStep && Math.abs(p.y - last.y) < minStep) continue;
    kept.push(p);
  }
  const f = (n: number) => n.toFixed(1);
  if (kept.length === 2) return `M${f(kept[0].x)} ${f(kept[0].y)} L${f(kept[1].x)} ${f(kept[1].y)}`;
  const mid = (a: Pt, b: Pt) => `${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2)}`;
  const out: string[] = [`M${f(kept[0].x)} ${f(kept[0].y)}`, `L${mid(kept[0], kept[1])}`];
  for (let i = 1; i < kept.length - 1; i++) out.push(`Q${f(kept[i].x)} ${f(kept[i].y)} ${mid(kept[i], kept[i + 1])}`);
  const end = kept[kept.length - 1];
  out.push(`L${f(end.x)} ${f(end.y)}`);
  return out.join(' ');
}

// ---------------------------------------------------------------- basemap tiles

/**
 * Esri's Light and Dark Gray Canvas basemaps: free with attribution, no API key, built from
 * OpenStreetMap, HERE and Garmin data. The base layer is roads and water in quiet greys; the
 * reference layer is a transparent overlay of place names, drawn on top. One place to change if
 * the provider ever moves (CARTO's basemaps, the previous choice, now need a key).
 */
export type TileStyle = 'light' | 'dark';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';

/** The image URLs to stack for one tile, bottom first. Note Esri's path order is z/y/x. */
export function tileLayers(style: TileStyle, z: number, x: number, y: number): string[] {
  const tone = style === 'dark' ? 'Dark' : 'Light';
  return [
    `${ESRI}/World_${tone}_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    `${ESRI}/World_${tone}_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
  ];
}

export const TILE_ATTRIBUTION = '© Esri, HERE, Garmin, OpenStreetMap contributors';
