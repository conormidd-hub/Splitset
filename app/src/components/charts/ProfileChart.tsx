import { scaleLinear, type ScaleLinear } from 'd3-scale';
import { area as d3area, curveLinear, line as d3line } from 'd3-shape';
import { memo, useEffect, useMemo, useState } from 'react';
import { PanResponder, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export type ProfileSeries = {
  name: string;
  color: string;
  /** One value per entry of `x`; null leaves a gap. */
  values: (number | null)[];
  kind: 'line' | 'area';
  /** Which y axis the series is scaled to; left by default. The left axis is labelled with the first left series' format, the right one with the first right series'. */
  axis?: 'left' | 'right';
  /** Flip the axis so smaller values sit higher (pace: faster is up, as on a watch). Applies to the whole axis. */
  invert?: boolean;
  format?: (v: number) => string;
};

type Props = {
  /** Distance in metres at each point, non-decreasing. */
  x: number[];
  series: ProfileSeries[];
  /** Index into `x` of the pinned or scrubbed point. */
  cursorIndex: number | null;
  onCursor: (i: number | null) => void;
  height?: number;
  xFormat?: (m: number) => string;
  /** The finger is down on the chart: a parent ScrollView should stop scrolling until `onScrubEnd`. */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
};

const MAX_POINTS = 350;
const M = { top: 6, right: 8, rightAxis: 44, bottom: 18, left: 44 };
const HEADER_HEIGHT = 18;

const defaultXFormat = (m: number) => `${(m / 1000).toFixed(1)} km`;
const defaultYFormat = (v: number) => `${Math.round(v)}`;

type Tick = { pos: number; label: string };
type PathSpec = { key: string; color: string; d: string; areaD: string | null };
type Geometry = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  xPos: (m: number) => number;
  xInvert: (px: number) => number;
  /** y scale per series, in series order. */
  yScales: (ScaleLinear<number, number> | null)[];
  paths: PathSpec[];
  yTicks: Tick[];
  yTicksRight: Tick[];
  xTicks: Tick[];
};

/** `n` evenly spaced distances from x0 to x1 inclusive. */
function evenGrid(x0: number, x1: number, n: number): number[] {
  const out = new Array<number>(n);
  const step = (x1 - x0) / (n - 1);
  for (let k = 0; k < n; k++) out[k] = x0 + step * k;
  return out;
}

/**
 * Values at the grid distances by linear interpolation along `x`. Where one neighbour is null
 * the other is used, so a single missing sample does not open a gap; two nulls make a gap.
 */
function resample(x: number[], values: (number | null)[], grid: number[]): (number | null)[] {
  const out = new Array<number | null>(grid.length);
  let i = 0;
  const n = x.length;
  for (let k = 0; k < grid.length; k++) {
    const g = grid[k];
    while (i < n - 2 && x[i + 1] < g) i++;
    const a = values[i], b = values[Math.min(i + 1, n - 1)];
    if (a == null && b == null) { out[k] = null; continue; }
    if (a == null) { out[k] = b; continue; }
    if (b == null || i + 1 >= n) { out[k] = a; continue; }
    const span = x[i + 1] - x[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (g - x[i]) / span)) : 0;
    out[k] = a + (b - a) * f;
  }
  return out;
}

function extentOf(all: (number | null)[][]): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const vs of all) for (const v of vs) if (v != null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo <= hi ? [lo, hi] : null;
}

function padded(ext: [number, number]): [number, number] {
  const pad = (ext[1] - ext[0]) * 0.08 || Math.max(1, Math.abs(ext[0]) * 0.05);
  return [ext[0] - pad, ext[1] + pad];
}

/** The index into `x` whose distance is nearest to `m`; `x` is non-decreasing. */
function nearestIndex(x: number[], m: number): number {
  let lo = 0, hi = x.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x[mid] < m) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(x[lo - 1] - m) <= Math.abs(x[lo] - m)) return lo - 1;
  return lo;
}

function buildGeometry(x: number[], series: ProfileSeries[], width: number, height: number, xFormat: (m: number) => string): Geometry | null {
  if (width <= 0 || x.length < 2) return null;
  const x0 = x[0], x1 = x[x.length - 1];
  if (!(x1 > x0)) return null;
  const hasRight = series.some((s) => s.axis === 'right');
  const plotLeft = M.left, plotRight = width - (hasRight ? M.rightAxis : M.right);
  const plotTop = M.top, plotBottom = height - M.bottom;
  const plotW = Math.max(1, plotRight - plotLeft);
  if (plotBottom <= plotTop) return null;

  const xs = scaleLinear().domain([x0, x1]).range([plotLeft, plotRight]);
  const leftSeries = series.filter((s) => s.axis !== 'right');
  const rightSeries = series.filter((s) => s.axis === 'right');
  const leftExt = extentOf(leftSeries.map((s) => s.values));
  const rightExt = extentOf(rightSeries.map((s) => s.values));
  const leftRange: [number, number] = leftSeries.some((s) => s.invert) ? [plotTop, plotBottom] : [plotBottom, plotTop];
  const rightRange: [number, number] = rightSeries.some((s) => s.invert) ? [plotTop, plotBottom] : [plotBottom, plotTop];
  const yLeft = leftExt ? scaleLinear().domain(padded(leftExt)).range(leftRange) : null;
  const yRight = rightExt ? scaleLinear().domain(padded(rightExt)).range(rightRange) : null;
  const yScales = series.map((s) => (s.axis === 'right' ? yRight : yLeft));

  const n = Math.max(2, Math.min(MAX_POINTS, Math.round(plotW)));
  const grid = evenGrid(x0, x1, n);
  const paths: PathSpec[] = [];
  series.forEach((s, si) => {
    const ysc = yScales[si];
    if (!ysc) return;
    const vs = resample(x, s.values, grid);
    const lineGen = d3line<number | null>().defined((v) => v != null).x((_, k) => xs(grid[k])).y((v) => ysc(v as number)).curve(curveLinear);
    const d = lineGen(vs) ?? '';
    if (!d) return;
    const areaD = s.kind === 'area'
      ? (d3area<number | null>().defined((v) => v != null).x((_, k) => xs(grid[k])).y0(plotBottom).y1((v) => ysc(v as number)).curve(curveLinear)(vs) ?? null)
      : null;
    paths.push({ key: `${si}:${s.name}`, color: s.color, d, areaD });
  });

  const leftFmt = leftSeries[0]?.format ?? defaultYFormat;
  const rightFmt = rightSeries[0]?.format ?? defaultYFormat;
  const yTicks: Tick[] = yLeft ? yLeft.ticks(3).map((t) => ({ pos: yLeft(t), label: leftFmt(t) })) : [];
  const yTicksRight: Tick[] = yRight ? yRight.ticks(3).map((t) => ({ pos: yRight(t), label: rightFmt(t) })) : [];
  const xTicks: Tick[] = xs.ticks(Math.max(2, Math.min(5, Math.floor(plotW / 80)))).map((t) => ({ pos: xs(t), label: xFormat(t) }));

  return {
    width, height, plotLeft, plotRight, plotTop, plotBottom,
    xPos: (m) => xs(m),
    xInvert: (px) => xs.invert(Math.min(plotRight, Math.max(plotLeft, px))),
    yScales, paths, yTicks, yTicksRight, xTicks,
  };
}

type Latest = {
  geom: Geometry | null;
  x: number[];
  onCursor: (i: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
};

/**
 * What the one-time PanResponder reads at event time: the current geometry, callbacks and the
 * last index sent, so `onCursor` only fires when the index changes. Held in state like TileMap's
 * Animated value rather than a ref, because the compiler lint forbids handing ref-reading
 * closures to PanResponder.create.
 */
class Scrubber {
  private latest: Latest = { geom: null, x: [], onCursor: () => {} };
  private lastSent: number | null = null;
  sync(latest: Latest) {
    this.latest = latest;
  }
  pin(i: number | null) {
    this.lastSent = i;
  }
  start(px: number) {
    this.latest.onScrubStart?.();
    this.move(px);
  }
  move(px: number) {
    const { geom, x, onCursor } = this.latest;
    if (!geom || x.length < 2) return;
    const i = nearestIndex(x, geom.xInvert(px));
    if (i === this.lastSent) return;
    this.lastSent = i;
    onCursor(i);
  }
  end() {
    this.latest.onScrubEnd?.();
  }
}

/** Grid, axes and series paths. Re-rendered only when the geometry object changes. */
const StaticLayer = memo(function StaticLayer({ geom, hair, mut }: { geom: Geometry; hair: string; mut: string }) {
  return (
    <G>
      {geom.yTicks.map((t, i) => (
        <G key={`y${i}`}>
          <Line x1={geom.plotLeft} x2={geom.plotRight} y1={t.pos} y2={t.pos} stroke={hair} strokeWidth={1} />
          <SvgText x={geom.plotLeft - 5} y={t.pos + 3.5} fontSize={10} fill={mut} textAnchor="end">{t.label}</SvgText>
        </G>
      ))}
      {geom.yTicksRight.map((t, i) => (
        <SvgText key={`r${i}`} x={geom.plotRight + 5} y={t.pos + 3.5} fontSize={10} fill={mut} textAnchor="start">{t.label}</SvgText>
      ))}
      {geom.xTicks.map((t, i) => (
        <SvgText key={`x${i}`} x={t.pos} y={geom.height - 5} fontSize={10} fill={mut} textAnchor={i === 0 ? 'start' : i === geom.xTicks.length - 1 ? 'end' : 'middle'}>{t.label}</SvgText>
      ))}
      {geom.paths.map((p) => (
        <G key={p.key}>
          {p.areaD ? <Path d={p.areaD} fill={p.color} opacity={0.16} /> : null}
          <Path d={p.d} fill="none" stroke={p.color} strokeWidth={p.areaD ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
        </G>
      ))}
    </G>
  );
});

/** One vertical line plus one dot per series at the cursor. Cheap enough to re-render every move. */
function CursorLayer({ geom, series, x, index, ink }: { geom: Geometry; series: ProfileSeries[]; x: number[]; index: number; ink: string }) {
  const cx = geom.xPos(x[index]);
  return (
    <G>
      <Line x1={cx} x2={cx} y1={geom.plotTop} y2={geom.plotBottom} stroke={ink} strokeWidth={1} strokeDasharray="3 3" />
      {series.map((s, si) => {
        const v = s.values[index];
        const ysc = geom.yScales[si];
        if (v == null || !ysc) return null;
        return <Circle key={`${si}:${s.name}`} cx={cx} cy={ysc(v)} r={4} fill={s.color} stroke={ink} strokeWidth={1.5} />;
      })}
    </G>
  );
}

/**
 * A distance-based profile: elevation as an area, other metrics as lines, sharing one cursor
 * with the map and the stats strip. A tap pins the nearest point; a horizontal drag scrubs. The
 * data is resampled to about one point per pixel so a 2400-sample run draws as a few hundred.
 */
export function ProfileChart({ x, series, cursorIndex, onCursor, height = 130, xFormat = defaultXFormat, onScrubStart, onScrubEnd }: Props) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);

  const geom = useMemo(() => buildGeometry(x, series, width, height, xFormat), [x, series, width, height, xFormat]);

  // The responder is created once; the scrubber hands it the latest props at event time.
  const [scrub] = useState(() => new Scrubber());
  useEffect(() => {
    scrub.sync({ geom, x, onCursor, onScrubStart, onScrubEnd });
  });
  useEffect(() => {
    scrub.pin(cursorIndex);
  }, [scrub, cursorIndex]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 4 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => scrub.start(e.nativeEvent.locationX),
        onPanResponderMove: (e) => scrub.move(e.nativeEvent.locationX),
        onPanResponderRelease: () => scrub.end(),
        onPanResponderTerminate: () => scrub.end(),
      }),
    [scrub],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth((prev) => (prev === w ? prev : w));
  };

  const pinned = cursorIndex != null && cursorIndex >= 0 && cursorIndex < x.length ? cursorIndex : null;
  const header = pinned != null
    ? [xFormat(x[pinned]), ...series.map((s) => {
        const v = s.values[pinned];
        return v == null ? null : `${s.name} ${(s.format ?? defaultYFormat)(v)}`;
      }).filter((s): s is string => s != null)].join(' · ')
    : null;

  return (
    <View onLayout={onLayout}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HEADER_HEIGHT, marginBottom: 2 }}>
        {header != null ? (
          <T variant="small" tone="ink" weight="600" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>{header}</T>
        ) : (
          series.map((s) => (
            <View key={s.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.color }} />
              <T variant="small" tone="mut">{s.name}</T>
            </View>
          ))
        )}
      </View>
      {geom ? (
        <View {...responder.panHandlers} style={{ height }}>
          <Svg width={geom.width} height={height} style={{ pointerEvents: 'none' }}>
            <StaticLayer geom={geom} hair={palette.hair} mut={palette.mut} />
            {pinned != null ? <CursorLayer geom={geom} series={series} x={x} index={pinned} ink={palette.ink2} /> : null}
          </Svg>
        </View>
      ) : (
        <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
          {width > 0 ? <T variant="small" tone="mut">No data</T> : null}
        </View>
      )}
    </View>
  );
}
