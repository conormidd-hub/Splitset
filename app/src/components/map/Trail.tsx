import { memo, useMemo } from 'react';
import { Path } from 'react-native-svg';

import type { Projector } from './TileMap';
import { binColours, metricValues, type ColourScale, type Metric, type Track } from '@/lib/runAnalysis';
import { useTheme } from '@/theme/ThemeProvider';

type Props = {
  track: Track;
  project: Projector;
  /** Which metric colours the line; null draws the whole trail in `accent`. */
  metric: Metric | null;
  scale: ColourScale | null;
  /** The wide stroke under the trail, so it reads on busy tiles. Defaults to the theme surface. */
  halo?: string;
  accent: string;
  /** Points closer than this many pixels to the last kept one are skipped. */
  minStep?: number;
};

const MAX_BINS = 12;
/** Chronological stretches are capped here; beyond it the edges are merged per colour instead. */
const MAX_PATHS = 400;
/** Edges whose colour bin differs from most of their neighbours take the neighbours' bin. */
const SMOOTH_WINDOW = 5;
const HALO_WIDTH = 6.5;
const LINE_WIDTH = 3.5;

const fmt = (v: number) => v.toFixed(1);

type Paths = { halo: string; bins: { colour: string; d: string }[] };

/**
 * Thin the projected points the way geo.pathD does, but keep the indices, so each kept edge
 * (k[j-1], k[j]) can be looked up against the per-point metric values.
 */
function thin(screen: { x: number; y: number }[], minStep: number): number[] {
  const n = screen.length;
  if (n < 2) return n ? [0] : [];
  const kept = [0];
  let last = screen[0];
  for (let i = 1; i < n; i++) {
    const p = screen[i];
    const final = i === n - 1;
    if (!final && Math.abs(p.x - last.x) < minStep && Math.abs(p.y - last.y) < minStep) continue;
    kept.push(i);
    last = p;
  }
  return kept;
}

function buildPaths(track: Track, project: Projector, metric: Metric | null, scale: ColourScale | null, minStep: number): Paths {
  const screen = track.pts.map(([lat, lng]) => project(lat, lng));
  const kept = thin(screen, minStep);
  if (kept.length < 2) return { halo: '', bins: [] };

  const halo = kept.map((i, j) => `${j === 0 ? 'M' : 'L'}${fmt(screen[i].x)} ${fmt(screen[i].y)}`).join(' ');
  if (!metric || !scale) return { halo, bins: [] };

  const bins = binColours(metricValues(track, metric), scale, MAX_BINS);
  if (!bins.length) return { halo, bins: [] };

  // bin per point, -1 where the metric is null
  const binOf = new Int16Array(track.pts.length).fill(-1);
  bins.forEach((b, bi) => {
    for (const i of b.indices) if (i >= 0 && i < binOf.length) binOf[i] = bi;
  });

  // Each kept edge takes the bin of its end point (its start as a fallback); gaps where the
  // metric is null carry the last colour forward so the trail never breaks. Leading gaps take the
  // first colour that follows.
  const edgeBin = new Int16Array(kept.length - 1);
  let carry = -1;
  for (let j = 1; j < kept.length; j++) {
    const b = binOf[kept[j]] >= 0 ? binOf[kept[j]] : binOf[kept[j - 1]];
    if (b >= 0) carry = b;
    edgeBin[j - 1] = carry;
  }
  if (edgeBin.length && edgeBin[0] < 0) {
    let first = -1;
    for (let j = 0; j < edgeBin.length; j++) if (edgeBin[j] >= 0) { first = edgeBin[j]; break; }
    for (let j = 0; j < edgeBin.length && edgeBin[j] < 0; j++) edgeBin[j] = first;
  }

  const smoothed = medianBins(edgeBin, SMOOTH_WINDOW);

  // Chronological stretches: one path per run of consecutive edges in the same bin, in track
  // order, so where laps overlap the later lap paints over the earlier one (as a watch does).
  const runs: { colour: string; d: string }[] = [];
  let cur = -1;
  let buf: string[] = [];
  for (let j = 0; j < smoothed.length; j++) {
    const b = smoothed[j];
    if (b < 0) continue;
    const a = screen[kept[j]], z = screen[kept[j + 1]];
    if (b !== cur) {
      if (buf.length) runs.push({ colour: bins[cur].colour, d: buf.join(' ') });
      cur = b;
      buf = [`M${fmt(a.x)} ${fmt(a.y)} L${fmt(z.x)} ${fmt(z.y)}`];
    } else {
      buf.push(`L${fmt(z.x)} ${fmt(z.y)}`);
    }
  }
  if (buf.length) runs.push({ colour: bins[cur].colour, d: buf.join(' ') });
  if (runs.length <= MAX_PATHS) return { halo, bins: runs };

  // Too many colour changes for one SVG: merge the edges per bin instead, worst bin first so the
  // best stretches stay visible on top.
  const parts: string[][] = bins.map(() => []);
  for (let j = 0; j < smoothed.length; j++) {
    const b = smoothed[j];
    if (b < 0) continue;
    const a = screen[kept[j]], z = screen[kept[j + 1]];
    if (j > 0 && smoothed[j - 1] === b) parts[b].push(`L${fmt(z.x)} ${fmt(z.y)}`);
    else parts[b].push(`M${fmt(a.x)} ${fmt(a.y)} L${fmt(z.x)} ${fmt(z.y)}`);
  }
  return {
    halo,
    bins: bins.map((b, bi) => ({ colour: b.colour, d: parts[bi].join(' ') })).filter((p) => p.d.length > 0),
  };
}

/** Median filter over bin indices, so a single odd edge does not break a stretch into three paths. */
function medianBins(edgeBin: Int16Array, window: number): Int16Array {
  const n = edgeBin.length;
  const out = new Int16Array(n);
  const half = Math.floor(window / 2);
  for (let j = 0; j < n; j++) {
    const vals: number[] = [];
    for (let k = Math.max(0, j - half); k <= Math.min(n - 1, j + half); k++) if (edgeBin[k] >= 0) vals.push(edgeBin[k]);
    if (!vals.length) { out[j] = -1; continue; }
    vals.sort((a, b) => a - b);
    out[j] = vals[Math.floor(vals.length / 2)];
  }
  return out;
}

/**
 * A run's trail over the map, coloured by a metric in at most twelve bins and drawn as
 * chronological stretches over one halo stroke, so laps overwrite in track order. Pure geometry
 * once per [track, project, metric, scale], so panning and cursor moves on the parent do not
 * rebuild it.
 */
export const Trail = memo(function Trail({ track, project, metric, scale, halo, accent, minStep = 1.5 }: Props) {
  const { palette } = useTheme();
  const paths = useMemo(() => buildPaths(track, project, metric, scale, minStep), [track, project, metric, scale, minStep]);
  if (!paths.halo) return <></>;
  return (
    <>
      <Path d={paths.halo} fill="none" stroke={halo ?? palette.surface} strokeOpacity={0.9} strokeWidth={HALO_WIDTH} strokeLinejoin="round" strokeLinecap="round" />
      {paths.bins.length ? (
        paths.bins.map((b, i) => (
          <Path key={i} d={b.d} fill="none" stroke={b.colour} strokeWidth={LINE_WIDTH} strokeLinejoin="round" strokeLinecap="round" />
        ))
      ) : (
        <Path d={paths.halo} fill="none" stroke={accent} strokeWidth={LINE_WIDTH} strokeLinejoin="round" strokeLinecap="round" />
      )}
    </>
  );
});
