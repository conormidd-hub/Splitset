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
};

type Props = {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (ms: number) => string;
  yMin?: number;
  yMax?: number;
  /** A shaded horizontal band, e.g. the 0.8 to 1.3 comfort zone for ACWR. */
  band?: { from: number; to: number; color: string };
  showLegend?: boolean;
  emptyText?: string;
};

const M = { top: 10, right: 10, bottom: 22, left: 42 };

const defaultX = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

/** One chart for lines, areas, bars and dots over time. Runs on iOS, Android and web. */
export function LineChart({ series, height = 200, yFormat = (v) => `${Math.round(v)}`, xFormat = defaultX, yMin, yMax, band, showLegend = true, emptyText = 'No data yet' }: Props) {
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

  const [x0, x1] = extent(all, (p) => p.x) as [number, number];
  const ys = all.map((p) => p.y as number);
  const lo = yMin ?? Math.min(...ys, band?.from ?? Infinity);
  const hi = yMax ?? Math.max(...ys, band?.to ?? -Infinity);
  const pad = (hi - lo) * 0.08 || 1;
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = Math.max(0, height - M.top - M.bottom);
  const span = x1 - x0 || 86_400_000;
  const xs = scaleTime().domain([new Date(x0 - span * 0.02), new Date(x1 + span * 0.02)]).range([M.left, M.left + plotW]);
  const ysc = scaleLinear().domain([yMin ?? lo - pad, yMax ?? hi + pad]).range([M.top + plotH, M.top]);
  const xt = (ms: number) => xs(new Date(ms));

  const yTicks = ysc.ticks(4);
  const xTicks = xs.ticks(Math.max(2, Math.min(5, Math.floor(plotW / 90))));

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

  const cursorValues = cursor == null ? [] : series.map((s) => {
    const p = s.points.find((q) => q.x === cursor);
    return p && p.y != null ? `${s.name} ${yFormat(p.y)}` : null;
  }).filter(Boolean);

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {showLegend ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginBottom: 4, minHeight: 18 }}>
          {cursor != null ? (
            <T variant="small" tone="ink" weight="600">{xFormat(cursor)} · {cursorValues.join(' · ')}</T>
          ) : (
            series.map((s) => (
              <View key={s.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.color }} />
                <T variant="small" tone="mut">{s.name}</T>
              </View>
            ))
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
                <SvgText x={M.left - 6} y={ysc(t) + 4} fontSize={10} fill={palette.mut} textAnchor="end">{yFormat(t)}</SvgText>
              </G>
            ))}
            {xTicks.map((d) => (
              <SvgText key={`x${+d}`} x={xs(d)} y={height - 6} fontSize={10} fill={palette.mut} textAnchor="middle">{xFormat(+d)}</SvgText>
            ))}
            {series.map((s) => {
              const pts = s.points;
              const kind = s.kind ?? 'line';
              if (kind === 'bars') {
                const bw = Math.max(2, (plotW / Math.max(1, pts.length)) * 0.62);
                return (
                  <G key={s.name}>
                    {pts.map((p) => p.y == null ? null : (
                      <Rect key={p.x} x={xt(p.x) - bw / 2} y={ysc(p.y)} width={bw} height={Math.max(0, ysc(lo - pad) - ysc(p.y))} fill={s.color} opacity={s.opacity ?? 0.85} rx={2} />
                    ))}
                  </G>
                );
              }
              if (kind === 'points') {
                return (
                  <G key={s.name}>
                    {pts.map((p) => p.y == null ? null : <Circle key={p.x} cx={xt(p.x)} cy={ysc(p.y)} r={3} fill={s.color} opacity={s.opacity ?? 0.8} />)}
                  </G>
                );
              }
              const lineGen = d3line<Point>().defined((p) => p.y != null).x((p) => xt(p.x)).y((p) => ysc(p.y as number)).curve(curveMonotoneX);
              const d = lineGen(pts) ?? '';
              const areaD = kind === 'area'
                ? (d3area<Point>().defined((p) => p.y != null).x((p) => xt(p.x)).y0(ysc(lo - pad)).y1((p) => ysc(p.y as number)).curve(curveMonotoneX)(pts) ?? '')
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
