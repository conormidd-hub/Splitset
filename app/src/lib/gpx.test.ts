import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gpxFilename, toGpx } from './gpx.ts';

const pts: [number, number][] = [[51.5, -0.1], [51.5100004, -0.0999996], [51.51, -0.09]];
const when = new Date('2026-10-21T08:00:00Z');

test('a track with heights, the way Garmin Connect imports a course', () => {
  const gpx = toGpx({ name: 'Fish & Chips <loop>', pts, heights: [12, 15.26, 14], type: 'running', desc: 'Drawn in Splitset', time: when });
  assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Splitset" xmlns="http://www.topografix.com/GPX/1/1"'));
  assert.match(gpx, /<metadata><name>Fish &amp; Chips &lt;loop&gt;<\/name><time>2026-10-21T08:00:00.000Z<\/time><\/metadata>/);
  assert.match(gpx, /<trk>\n\s+<name>Fish &amp; Chips &lt;loop&gt;<\/name>\n\s+<desc>Drawn in Splitset<\/desc>\n\s+<type>running<\/type>\n\s+<trkseg>/);
  const points = gpx.match(/<trkpt /g) ?? [];
  assert.equal(points.length, 3);
  assert.match(gpx, /<trkpt lat="51.500000" lon="-0.100000"><ele>12.0<\/ele><\/trkpt>/);
  assert.match(gpx, /<trkpt lat="51.510000" lon="-0.100000"><ele>15.3<\/ele><\/trkpt>/);   // six decimals, one for height
  assert.ok(gpx.endsWith('    </trkseg>\n  </trk>\n</gpx>\n'));
});

test('no heights, or the wrong number of them, writes no elevations', () => {
  const cases: ((number | null)[] | null | undefined)[] = [undefined, null, [1, 2]];
  for (const heights of cases) {
    const gpx = toGpx({ name: 'Flat', pts, heights, time: when });
    assert.doesNotMatch(gpx, /<ele>/);
    assert.doesNotMatch(gpx, /<desc>|<type>/);
    assert.equal((gpx.match(/<trkpt /g) ?? []).length, 3);
  }
  // a gap in the heights leaves that one point without an elevation
  const gpx = toGpx({ name: 'Gap', pts, heights: [1, null, 3], time: when });
  assert.equal((gpx.match(/<ele>/g) ?? []).length, 2);
});

test('an empty name still makes a valid file', () => {
  const gpx = toGpx({ name: '   ', pts: [], time: when });
  assert.match(gpx, /<name>Route<\/name>/);
  assert.match(gpx, /<trkseg>\n\s+<\/trkseg>/);
});

test('file names are safe slugs', () => {
  assert.equal(gpxFilename('Morning loop · 10 km'), 'morning-loop-10-km.gpx');
  assert.equal(gpxFilename('Café / Thames path!'), 'cafe-thames-path.gpx');
  assert.equal(gpxFilename('···'), 'route.gpx');
  assert.equal(gpxFilename(''), 'route.gpx');
});
