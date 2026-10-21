import { haversineKm, type Bbox, type LatLng, type Pt } from './geo.ts';

/**
 * Places for the route builders: an address search (Photon, komoot's OpenStreetMap geocoder) and
 * the cafés inside a map box (the Overpass API over OpenStreetMap). Both are public services with
 * fair-use terms and no key; set EXPO_PUBLIC_GEOCODER_URL or EXPO_PUBLIC_OVERPASS_URL to use
 * another. Plain `fetch`, no React: the parsers are pure and tested with canned answers.
 */

export type Place = {
  /** The place or street-and-number, e.g. "12 Lygon Street". */
  name: string;
  /** Where that is, e.g. "Carlton, Victoria, Australia". */
  detail: string;
  lat: number;
  lng: number;
};

export type Cafe = { id: string; name: string | null; lat: number; lng: number };

export const GEOCODER_PROVIDER = 'Photon · OpenStreetMap';

// Dot access on process.env so Expo inlines the values at bundle time.
const GEOCODER_URL = (process.env.EXPO_PUBLIC_GEOCODER_URL || 'https://photon.komoot.io').replace(/\/+$/, '');
/** Public Overpass servers, tried in order: the main one answers 502 or 504 when it is busy. */
const OVERPASS_URLS = process.env.EXPO_PUBLIC_OVERPASS_URL
  ? [process.env.EXPO_PUBLIC_OVERPASS_URL]
  : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/** Cafés are asked for and drawn from this zoom; further out a city has thousands. */
export const CAFE_ZOOM = 14;
/** At most this many cafés per box. */
const CAFE_LIMIT = 200;
/** The fetched box is this much bigger than the view on every side, snapped to the grid below, so a small pan reuses the last answer. */
const CAFE_BOX_GROW = 0.5;
const CAFE_GRID_DEG = 0.01;

// ---------------------------------------------------------------- address search

type PhotonProps = {
  name?: string;
  housenumber?: string;
  street?: string;
  postcode?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
};
type PhotonFeature = { geometry?: { coordinates?: unknown }; properties?: PhotonProps };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Photon's GeoJSON as places: the name (or street and number), then the locality trail without
 * repeating the name. Exact duplicates (the same spot, the same name) are dropped.
 */
export function parsePhoton(json: unknown): Place[] {
  const features = (json as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const f of features as PhotonFeature[]) {
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    const [lng, lat] = c;
    const p = f.properties ?? {};
    const street = str(p.street);
    const number = str(p.housenumber);
    const streetLine = street ? (number ? `${number} ${street}` : street) : null;
    const name = str(p.name) ?? streetLine;
    if (!name) continue;
    const locality = str(p.district) ?? str(p.city) ?? str(p.county);
    const parts = [name === streetLine ? null : streetLine, locality, str(p.state), str(p.country)]
      .filter((x): x is string => !!x && x !== name);
    const detail = parts.filter((x, i) => parts.indexOf(x) === i).join(', ');
    const key = `${name}|${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, detail, lat, lng });
  }
  return out;
}

/** Addresses and places matching `q`, nearest to `near` first when given. */
export async function searchPlaces(q: string, near: LatLng | null, limit = 6): Promise<Place[]> {
  const params = new URLSearchParams({ q: q.trim(), limit: String(limit) });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lng.toFixed(4));
  }
  const res = await fetch(`${GEOCODER_URL}/api/?${params.toString()}`);
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  return parsePhoton(await res.json());
}

// ---------------------------------------------------------------- cafés

/**
 * The box to fetch cafés for: centred on the view's centre snapped to a 0.01° grid, half again
 * as wide and tall as the view, rounded out to the grid. A pan shorter than a grid step keeps
 * the same box, so the answer is reused; a longer one asks for the next, overlapping box.
 */
export function cafeBox(view: Bbox): Bbox {
  const [s, w, n, e] = view;
  const g = CAFE_GRID_DEG;
  const cLat = Math.round((s + n) / 2 / g) * g;
  const cLng = Math.round((w + e) / 2 / g) * g;
  const hLat = Math.ceil((((n - s) / 2) * (1 + CAFE_BOX_GROW)) / g - 1e-9) * g;
  const hLng = Math.ceil((((e - w) / 2) * (1 + CAFE_BOX_GROW)) / g - 1e-9) * g;
  return [cLat - hLat, cLng - hLng, cLat + hLat, cLng + hLng].map((v) => Math.round(v * 1e6) / 1e6) as Bbox;
}

/** The Overpass QL for every café (node, way or relation) in the box, ways and relations by their centre. */
export function cafeQuery(box: Bbox, limit = CAFE_LIMIT): string {
  const [s, w, n, e] = box;
  return `[out:json][timeout:10];nwr["amenity"="cafe"](${s},${w},${n},${e});out center ${limit};`;
}

type OverpassElement = { type?: string; id?: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: { name?: string } };

export function parseOverpass(json: unknown): Cafe[] {
  const elements = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  const out: Cafe[] = [];
  for (const el of elements as OverpassElement[]) {
    const lat = typeof el.lat === 'number' ? el.lat : el.center?.lat;
    const lng = typeof el.lon === 'number' ? el.lon : el.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number' || typeof el.id !== 'number') continue;
    out.push({ id: `${el.type ?? 'node'}/${el.id}`, name: str(el.tags?.name), lat, lng });
  }
  return out;
}

/** A server that has not answered in this long is left for the next one. */
const OVERPASS_TIMEOUT_MS = 8000;

/** The cafés in `box`, from the first Overpass server that answers in time. */
export async function fetchCafes(box: Bbox): Promise<Cafe[]> {
  const body = `data=${encodeURIComponent(cafeQuery(box))}`;
  let lastError: Error | null = null;
  for (const url of OVERPASS_URLS) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: abort.signal });
      if (!res.ok) throw new Error(`Café lookup failed (${res.status})`);
      return parseOverpass(await res.json());
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Café lookup failed');
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('Café lookup failed');
}

/** The café within `maxPx` of a tap, nearest first. */
export function nearestCafe(cafes: Cafe[], project: (lat: number, lng: number) => Pt, pt: Pt, maxPx = 12): Cafe | null {
  let best: Cafe | null = null;
  let bestD = maxPx * maxPx;
  for (const c of cafes) {
    const s = project(c.lat, c.lng);
    const d = (s.x - pt.x) ** 2 + (s.y - pt.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Two points within 20 m are the same place (a saved home against a tapped start). */
export function samePlace(a: LatLng | null | undefined, b: LatLng | null | undefined): boolean {
  return !!a && !!b && haversineKm(a, b) * 1000 <= 20;
}
