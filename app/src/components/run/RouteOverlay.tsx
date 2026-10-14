import { memo, useEffect, useMemo } from 'react';
import { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';

import type { RunEffort } from '@/api/segments';
import type { Projector } from '@/components/map/TileMap';
import { indexAtDist } from '@/lib/runAnalysis';
import { KM_PER_MILE, type Units } from '@/lib/units';
import { pathD, type Pt } from '@/lib/geo';
import type { Track } from '@/lib/runAnalysis';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * The run map's layers around the Trail: segment bands drawn BELOW it (so the metric colours stay
 * readable) and markers, labels and the cursor drawn ABOVE it. Both are named memo components, so
 * they may hold hooks inside TileMap's render prop, and both re-project the track only when the
 * projector changes (camera or size), never on a cursor move.
 */

/** The stretch chosen in create-segment mode: the start index and, once set, the end index. */
export type Selection = { start: number; end: number | null };

const BAND_WIDTH = 14;
const BAND_OPACITY = 0.3;
/** Labels sit this many pixels above the band's midpoint. */
const LABEL_RISE = 9;
const LABEL_MAX_CHARS = 18;

function useScreenPts(track: Track, project: Projector): Pt[] {
  return useMemo(() => track.pts.map(([lat, lng]) => project(lat, lng)), [track, project]);
}

/** Effort indices refer to the polyline the scan saw; clamp in case the details row changed since. */
function span(startIdx: number, endIdx: number, n: number): [number, number] {
  const clampIdx = (i: number) => Math.max(0, Math.min(n - 1, i));
  return [clampIdx(Math.min(startIdx, endIdx)), clampIdx(Math.max(startIdx, endIdx))];
}

const shorten = (s: string) => (s.length > LABEL_MAX_CHARS ? `${s.slice(0, LABEL_MAX_CHARS - 1)}…` : s);

type BandsProps = { track: Track; project: Projector; efforts: RunEffort[] };

/** One translucent accent band per matched segment effort, under the trail. */
export const SegmentBands = memo(function SegmentBands({ track, project, efforts }: BandsProps) {
  const { palette } = useTheme();
  const screen = useScreenPts(track, project);
  const paths = useMemo(() => {
    const n = screen.length;
    if (n < 2) return [];
    return efforts.flatMap((e) => {
      const [a, b] = span(e.start_idx, e.end_idx, n);
      const d = b > a ? pathD(screen.slice(a, b + 1), 1) : '';
      return d ? [{ key: e.id, d }] : [];
    });
  }, [efforts, screen]);
  return (
    <>
      {paths.map((p) => (
        <Path key={p.key} d={p.d} fill="none" stroke={palette.accent} strokeOpacity={BAND_OPACITY} strokeWidth={BAND_WIDTH} strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </>
  );
});

type MarkersProps = {
  track: Track;
  project: Projector;
  efforts: RunEffort[];
  cursor: number | null;
  selection: Selection | null;
  /** Reports the projector this layer was drawn with, so the card can map a tap back to a point. */
  onProject?: (project: Projector) => void;
  /** Distance markers every kilometre, or every mile for imperial. */
  units: Units;
};

/** Markers no closer than this on screen; when the map is zoomed out only every 2nd, 5th, 10th... is drawn. */
const MARKER_GAP_PX = 30;
const MARKER_STEPS = [1, 2, 5, 10, 20, 50];

/** Marks closer than this share one label (laps of a loop put several on the same spot). */
const MERGE_PX = 12;
/** Marker pill height; the width grows with the label. */
const MARK_H = 13;

/**
 * Screen positions of the whole-unit distance marks, thinned to a readable spacing, with marks
 * that land on the same spot merged into one label such as "3·8".
 */
function distanceMarks(track: Track, screen: Pt[], units: Units): { label: string; at: Pt }[] {
  const unitM = units === 'imperial' ? KM_PER_MILE * 1000 : 1000;
  const count = Math.floor(track.totalDist / unitM);
  if (count < 1 || screen.length < 2) return [];
  const all: { n: number; at: Pt }[] = [];
  for (let k = 1; k <= count; k++) {
    const i = indexAtDist(track, k * unitM);
    if (i >= 0 && i < screen.length) all.push({ n: k, at: screen[i] });
  }
  let step = 1;
  if (all.length >= 2) {
    let spacing = 0;
    for (let j = 1; j < all.length; j++) spacing += Math.hypot(all[j].at.x - all[j - 1].at.x, all[j].at.y - all[j - 1].at.y);
    spacing /= all.length - 1;
    step = MARKER_STEPS.find((st) => spacing * st >= MARKER_GAP_PX) ?? MARKER_STEPS[MARKER_STEPS.length - 1];
  }
  const groups: { ns: number[]; at: Pt }[] = [];
  for (const m of all) {
    if (m.n % step !== 0) continue;
    const near = groups.find((g) => Math.hypot(g.at.x - m.at.x, g.at.y - m.at.y) < MERGE_PX);
    if (near) near.ns.push(m.n);
    else groups.push({ ns: [m.n], at: m.at });
  }
  return groups.map((g) => ({ label: g.ns.join('·'), at: g.at }));
}

/**
 * Start and finish dots, the highlighted stretch being turned into a segment, each matched
 * segment's name at its midpoint, and the cursor marker, all above the trail.
 */
export const RouteMarkers = memo(function RouteMarkers({ track, project, efforts, cursor, selection, onProject, units }: MarkersProps) {
  const { palette } = useTheme();
  const screen = useScreenPts(track, project);
  useEffect(() => {
    onProject?.(project);
  }, [project, onProject]);

  const n = screen.length;
  if (n < 2) return <></>;
  const first = screen[0], last = screen[n - 1];

  let selectedD = '';
  let selStart: Pt | null = null, selEnd: Pt | null = null;
  if (selection) {
    selStart = screen[Math.max(0, Math.min(n - 1, selection.start))];
    if (selection.end != null) {
      selEnd = screen[Math.max(0, Math.min(n - 1, selection.end))];
      const [a, b] = span(selection.start, selection.end, n);
      if (b > a) selectedD = pathD(screen.slice(a, b + 1), 1);
    }
  }
  const cur = cursor != null && cursor >= 0 && cursor < n ? screen[cursor] : null;
  const marks = distanceMarks(track, screen, units);

  return (
    <>
      {selectedD ? (
        <>
          <Path d={selectedD} fill="none" stroke={palette.accent} strokeOpacity={BAND_OPACITY} strokeWidth={BAND_WIDTH} strokeLinejoin="round" strokeLinecap="round" />
          <Path d={selectedD} fill="none" stroke={palette.ink} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
        </>
      ) : null}
      <Circle cx={first.x} cy={first.y} r={5.5} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
      <Circle cx={last.x} cy={last.y} r={5.5} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />
      {efforts.map((e) => {
        const [a, b] = span(e.start_idx, e.end_idx, n);
        const at = screen[Math.floor((a + b) / 2)];
        const label = shorten(e.segments.name);
        return (
          <G key={e.id}>
            <SvgText x={at.x} y={at.y - LABEL_RISE} fontSize={10} fontWeight="700" textAnchor="middle" fill={palette.surface} stroke={palette.surface} strokeWidth={3} strokeLinejoin="round">{label}</SvgText>
            <SvgText x={at.x} y={at.y - LABEL_RISE} fontSize={10} fontWeight="700" textAnchor="middle" fill={palette.ink}>{label}</SvgText>
          </G>
        );
      })}
      {marks.map((m) => {
        // small, quiet pills in the surface colour with a hairline ring, like the tiles' own labels
        const w = Math.max(MARK_H, 5 + m.label.length * 5.2);
        return (
          <G key={`km${m.label}`}>
            <Rect x={m.at.x - w / 2} y={m.at.y - MARK_H / 2} width={w} height={MARK_H} rx={MARK_H / 2} fill={palette.surface} fillOpacity={0.92} stroke={palette.ink2} strokeOpacity={0.55} strokeWidth={0.8} />
            <SvgText x={m.at.x} y={m.at.y + 3} fontSize={8.5} fontWeight="600" textAnchor="middle" fill={palette.ink2}>{m.label}</SvgText>
          </G>
        );
      })}
      {selStart ? <Circle cx={selStart.x} cy={selStart.y} r={6} fill={palette.accent} stroke={palette.surface} strokeWidth={2} /> : null}
      {selEnd ? <Circle cx={selEnd.x} cy={selEnd.y} r={6} fill={palette.ink} stroke={palette.surface} strokeWidth={2} /> : null}
      {cur ? <Circle cx={cur.x} cy={cur.y} r={6.5} fill={palette.ink} stroke={palette.surface} strokeWidth={2.5} /> : null}
    </>
  );
});
