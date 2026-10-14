import { memo, useEffect, useMemo } from 'react';
import { Circle, G, Path, Text as SvgText } from 'react-native-svg';

import type { RunEffort } from '@/api/segments';
import type { Projector } from '@/components/map/TileMap';
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
};

/**
 * Start and finish dots, the highlighted stretch being turned into a segment, each matched
 * segment's name at its midpoint, and the cursor marker, all above the trail.
 */
export const RouteMarkers = memo(function RouteMarkers({ track, project, efforts, cursor, selection, onProject }: MarkersProps) {
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
      {selStart ? <Circle cx={selStart.x} cy={selStart.y} r={6} fill={palette.accent} stroke={palette.surface} strokeWidth={2} /> : null}
      {selEnd ? <Circle cx={selEnd.x} cy={selEnd.y} r={6} fill={palette.ink} stroke={palette.surface} strokeWidth={2} /> : null}
      {cur ? <Circle cx={cur.x} cy={cur.y} r={6.5} fill={palette.ink} stroke={palette.surface} strokeWidth={2.5} /> : null}
    </>
  );
});
