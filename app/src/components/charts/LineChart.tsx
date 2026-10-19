import { extent } from 'd3-array';
import { scaleLinear, scaleTime } from 'd3-scale';
import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape';
import { useState } from 'react';
import { Pressable, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export type Point = { x: number; y: number | null };
export type Series = {
  name: string;
  color: string;
  points: Point[];
  kind?: 'line' | 'area' | 'bars' | 'points';
  width?: number;
  dashed?: boolean;
  opacity?: number;
  /** False keeps a helper series (dots under a line) out of the legend and the tap readout. */
  legend?: boolean;
  /** 'right' plots it against a second scale with its own labels on the right, so two metrics
   *  of different sizes (HRV against sleep) can share one chart. */
  axis?: 'left' | 'right';
};

type Props = {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (ms: number) => string;
  yMin?: number;
  yMax?: number;
  /** The right axis, used only when a series asks for it: its floor, ceiling and labels. */
  yMinRight?: number;
  yMaxRight?: number;
  yFormatRight?: (v: number) => string;
  /** A shaded horizontal band, e.g. the 0.8 to 1.3 comfort zone for ACWR. */
  band?: { from: number; to: number; color: string };
  /** Names the band in the legend. */
  bandLabel?: string;
  showLegend?: boolean;
  emptyText?: string;
  /** The tapped point's date in the readout; defaults to xFormat. */
  cursorFormat?: (ms: number) => string;
};

const M = { top: 10, right: 10, bottom: 22, left: 42 };
/** The right margin when a second axis needs room for its labels. */
const RIGHT_AXIS = 42;
const WEEK = 7 * 86_400_000;

const defaultX = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

const valued = (list: Series[]) => list.flatMap((s) => s.points.filter((p) => p.y != null));
const isBars = (s: Series) => s.kind === 'bars';

/** One side's y range: its values and the band, with a little headroom either way. */
function yDomain(ys: number[], min: number | undefined, max: number | undefined, bars: boolean, band?: { from: number; to: number }): [number, number] {
  const lo = min ?? Math.min(...ys, band?.from ?? Infinity);
  const hi = max ?? Math.max(...ys, band?.to ?? -Infinity);
  const pad = (hi - lo) * 0.08 || 1;
  // a bar's length is its value, so bars stand on zero unless the caller sets a floor
  return [min ?? (bars && lo >= 0 ? 0 : lo - pad), max ?? hi + pad];
}

/**
 * One chart for lines, areas, bars and dots over time. Runs on iOS, Android and web. A series
 * with `axis: 'right'` gets a second scale, labelled down the right in its colour (the left's
 * labels then take the left series' colour), so two metrics can be compared on one chart.
 */
export function LineChart({
  series, height = 200, yFormat = (v) => `${Math.round(v)}`, xFormat = defaultX, yMin, yMax, yMinRight, yMaxRight, yFormatRight,
  band, bandLabel, showLegend = true, emptyText = 'No data yet', cursorFormat,
}: Props) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  const all = series.flatMap((s) => s.points.filter((p) => p.y != null));
  if (!all.length) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center' }} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        <T tone="mut">{emptyText}</T>
      </View>
    );
  }

  // with a right axis each side scales to its own series; without one the left takes them all
  const dual = series.some((s) => s.axis === 'right');
  const leftSeries = dual ? series.filter((s) => s.axis !== 'right') : series;
  const rightSeries = dual ? series.filter((s) => s.axis === 'right') : [];
  const leftAll = dual ? valued(leftSeries) : all;
  const rightAll = valued(rightSeries);

  const [x0, x1] = extent(all, (p) => p.x) as [number, number];
  const plotW = Math.max(0, width - M.left - (dual ? RIGHT_AXIS : M.right));
  const plotH = Math.max(0, height - M.top - M.bottom);
  const span = x1 - x0 || 86_400_000;
  const xs = scaleTime().domain([new Date(x0 - span * 0.02), new Date(x1 + span * 0.02)]).range([M.left, M.left + plotW]);
  const scale = (domain: [number, number]) => scaleLinear().domain(domain).range([M.top + plotH, M.top]);
  const ysR = rightAll.length ? scale(yDomain(rightAll.map((p) => p.y as number), yMinRight, yMaxRight, rightSeries.some(isBars))) : null;
  // a left side with nothing to show borrows the right's scale, so the grid still lines up
  const ysc = leftAll.length || !ysR ? scale(yDomain(leftAll.map((p) => p.y as number), yMin, yMax, leftSeries.some(isBars), band)) : ysR;
  const xt = (ms: number) => xs(new Date(ms));
  const scaleOf = (s: Series) => (s.axis === 'right' && ysR ? ysR : ysc);

  const yTicks = ysc.ticks(4);
  const xTicks = xs.ticks(Math.max(2, Math.min(5, Math.floor(plotW / 90))));
  // on a two-axis chart each side's labels wear its series' colour, so which is which needs no key
  const sideColour = (list: Series[]) => list.find((s) => s.legend !== false)?.color ?? palette.mut;
  const leftLabel = dual ? sideColour(leftSeries) : palette.mut;
  const rightLabel = sideColour(rightSeries);
  const fmtRight = yFormatRight ?? yFormat;
  const fmtOf = (s: Series) => (dual && s.axis === 'right' ? fmtRight : yFormat);

  const onPress = (e: GestureResponderEvent) => {
    const px = e.nativeEvent.locationX;
    const primary = series.find((s) => s.points.some((p) => p.y != null));
    if (!primary) return;
    let best: Point | null = null;
    for (const p of primary.points) {
      if (p.y == null) continue;
      if (!best || Math.abs(xt(p.x) - px) < Math.abs(xt(best.x) - px)) best = p;
    }
    setCursor(best ? best.x : null);
  };

  /** A series' value at the tapped date. */
  const valueAt = (s: Series, x: number): number | null => {
    const exact = s.points.find((q) => q.x === x);
    if (exact || !dual) return exact?.y ?? null;
    // two metrics need not share dates (a weekly total against a daily mean): take the latest
    // reading at or before the tap, if it is from the same week
    let best: Point | null = null;
    for (const p of s.points) if (p.y != null && p.x <= x && x - p.x < WEEK && (!best || p.x > best.x)) best = p;
    return best?.y ?? null;
  };

  const shown = series.filter((s) => s.legend !== false);
  const cursorValues = cursor == null ? [] : shown.map((s) => {
    const y = valueAt(s, cursor);
    return y != null ? `${s.name} ${fmtOf(s)(y)}` : null;
  }).filter(Boolean);

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {showLegend ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginBottom: 4, minHeight: 18 }}>
          {cursor != null ? (
            <T variant="small" tone="ink" weight="600">{(cursorFormat ?? xFormat)(cursor)} · {cursorValues.join(' · ')}</T>
          ) : (
            <>
              {shown.map((s) => (
                <View key={s.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.color }} />
                  <T variant="small" tone="mut">{s.name}</T>
                </View>
              ))}
              {band && bandLabel ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={{ width: 10, height: 8, borderRadius: 2, backgroundColor: band.color, opacity: 0.35 }} />
                  <T variant="small" tone="mut">{bandLabel}</T>
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {width > 0 ? (
        <Pressable onPressIn={onPress} onPress={() => cursor != null && setCursor(null)}>
          <Svg width={width} height={height}>
            {band ? (
              <Rect x={M.left} y={ysc(band.to)} width={plotW} height={Math.max(0, ysc(band.from) - ysc(band.to))} fill={band.color} opacity={0.18} />
            ) : null}
            {yTicks.map((t) => (
              <G key={`y${t}`}>
                <Line x1={M.left} x2={M.left + plotW} y1={ysc(t)} y2={ysc(t)} stroke={palette.hair} strokeWidth={1} />
                {!dual || leftAll.length ? (
                  <SvgText x={M.left - 6} y={ysc(t) + 4} fontSize={10} fill={leftLabel} textAnchor="end">{yFormat(t)}</SvgText>
                ) : null}
              </G>
            ))}
            {ysR ? ysR.ticks(4).map((t) => (
              <SvgText key={`r${t}`} x={M.left + plotW + 6} y={ysR(t) + 4} fontSize={10} fill={rightLabel} textAnchor="start">{fmtRight(t)}</SvgText>
            )) : null}
            {xTicks.map((d) => (
              <SvgText key={`x${+d}`} x={xs(d)} y={height - 6} fontSize={10} fill={palette.mut} textAnchor="middle">{xFormat(+d)}</SvgText>
            ))}
            {series.map((s) => {
              const pts = s.points;
              const kind = s.kind ?? 'line';
              const ys = scaleOf(s);
              const base = ys.domain()[0];
              if (kind === 'bars') {
                const bw = Math.max(2, (plotW / Math.max(1, pts.length)) * 0.62);
                return (
                  <G key={s.name}>
                    {pts.map((p) => p.y == null ? null : (
                      <Rect key={p.x} x={xt(p.x) - bw / 2} y={ys(p.y)} width={bw} height={Math.max(0, ys(base) - ys(p.y))} fill={s.color} opacity={s.opacity ?? 0.85} rx={2} />
                    ))}
                  </G>
                );
              }
              if (kind === 'points') {
                return (
                  <G key={s.name}>
                    {pts.map((p) => p.y == null ? null : <Circle key={p.x} cx={xt(p.x)} cy={ys(p.y)} r={3} fill={s.color} opacity={s.opacity ?? 0.8} />)}
                  </G>
                );
              }
              const lineGen = d3line<Point>().defined((p) => p.y != null).x((p) => xt(p.x)).y((p) => ys(p.y as number)).curve(curveMonotoneX);
              const d = lineGen(pts) ?? '';
              const areaD = kind === 'area'
                ? (d3area<Point>().defined((p) => p.y != null).x((p) => xt(p.x)).y0(ys(base)).y1((p) => ys(p.y as number)).curve(curveMonotoneX)(pts) ?? '')
                : null;
              return (
                <G key={s.name}>
                  {areaD ? <Path d={areaD} fill={s.color} opacity={0.15} /> : null}
                  <Path d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 2} strokeDasharray={s.dashed ? '4 4' : undefined} opacity={s.opacity ?? 1} strokeLinejoin="round" strokeLinecap="round" />
                </G>
              );
            })}
            {cursor != null ? <Line x1={xt(cursor)} x2={xt(cursor)} y1={M.top} y2={M.top + plotH} stroke={palette.ink2} strokeWidth={1} strokeDasharray="3 3" /> : null}
          </Svg>
        </Pressable>
      ) : (
        <View style={{ height }} />
      )}
    </View>
  );
}
