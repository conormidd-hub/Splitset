/**
 * GPX 1.1 for a route or course, the file Garmin Connect imports as a Course (and every other
 * planner reads). One track with one segment, every point with its terrain height when known,
 * so the watch and Garmin's course page both show the profile.
 */

export type GpxTrack = {
  name: string;
  pts: [number, number][];
  /** One height per point, in metres; anything else (or null) writes no elevations. */
  heights?: (number | null)[] | null;
  desc?: string;
  /** Garmin reads "running", "cycling", "hiking"... from the track type. */
  type?: string;
  /** The metadata time stamp; now when absent. */
  time?: Date;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toGpx(t: GpxTrack): string {
  const hs = t.heights && t.heights.length === t.pts.length ? t.heights : null;
  const time = (t.time ?? new Date()).toISOString();
  const name = esc(t.name.trim() || 'Route');
  const lines: (string | null)[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Splitset" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    `  <metadata><name>${name}</name><time>${time}</time></metadata>`,
    '  <trk>',
    `    <name>${name}</name>`,
    t.desc ? `    <desc>${esc(t.desc)}</desc>` : null,
    t.type ? `    <type>${esc(t.type)}</type>` : null,
    '    <trkseg>',
    ...t.pts.map(([lat, lng], i) => {
      const h = hs?.[i];
      const ele = typeof h === 'number' && Number.isFinite(h) ? `<ele>${h.toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">${ele}</trkpt>`;
    }),
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ];
  return `${lines.filter((l) => l != null).join('\n')}\n`;
}

/** "Morning loop · 10 km" becomes "morning-loop-10-km.gpx". */
export function gpxFilename(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'route'}.gpx`;
}
