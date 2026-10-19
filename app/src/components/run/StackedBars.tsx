import { scaleLinear, scaleTime } from 'd3-scale';
import { useState } from 'react';
import { Pressable, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export type StackedBar = { x: number; /** One value per layer, bottom first. */ values: number[] };

type Props = {
  bars: StackedBar[];
  /** Each layer's name and colour, bottom first. */
  layers: { name: string; color: string }[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (ms: number) => string;
  /** The tapped bar's date in the readout; defaults to xFormat. */
  cursorFormat?: (ms: number) => string;
  /** A layer's value in the readout; defaults to yFormat. */
  valueFormat?: (v: number) => string;
  emptyText?: string;
};

// the same margins as LineChart, so a stacked card lines up with the cards around it
const M = { top: 10, right: 10, bottom: 22, left: 42 };

const defaultX = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

/**
 * Bars over time, each split into coloured layers stacked from the bottom: time in each
 * heart-rate zone per week. Drawn to match LineChart (axes, legend, tap a bar to read it).
 */
export function StackedBars({ bars, layers, height = 190, yFormat = (v) => `${Math.round(v)}`, xFormat = defaultX, cursorFormat, valueFormat, emptyText = 'No data yet' }: Props) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  const totals = bars.map((b) => b.values.reduce((s, v) => s + v, 0));
  const max = Math.max(0, ...totals);
  if (!bars.length || max <= 0) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
        <T tone="mut">{emptyText}</T>
      </View>
    );
  }

  const x0 = bars[0].x, x1 = bars[bars.length - 1].x;
  const span = x1 - x0 || 7 * 86_400_000;
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = Math.max(0, height - M.top - M.bottom);
  const xs = scaleTime().domain([new Date(x0 - span * 0.04), new Date(x1 + span * 0.04)]).range([M.left, M.left + plotW]);
  const ys = scaleLinear().domain([0, max * 1.08]).range([M.top + plotH, M.top]);
  const xt = (ms: number) => xs(new Date(ms));
  const bw = Math.max(2, (plotW / Math.max(1, bars.length)) * 0.62);
  const yTicks = ys.ticks(4);
  const xTicks = xs.ticks(Math.max(2, Math.min(5, Math.floor(plotW / 90))));

  const onPress = (e: GestureResponderEvent) => {
    const px = e.nativeEvent.locationX;
    let best = 0;
    bars.forEach((b, i) => {
      if (Math.abs(xt(b.x) - px) < Math.abs(xt(bars[best].x) - px)) best = i;
    });
    setCursor(best);
  };

  const fmt = valueFormat ?? yFormat;
  const picked = cursor != null ? bars[cursor] : null;

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginBottom: 4, minHeight: 18 }}>
        {picked ? (
          <T variant="small" tone="ink" weight="600">
            {(cursorFormat ?? xFormat)(picked.x)} · {layers.map((l, i) => `${l.name} ${fmt(picked.values[i] ?? 0)}`).join(' · ')}
          </T>
        ) : (
          layers.map((l) => (
            <View key={l.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: l.color }} />
              <T variant="small" tone="mut">{l.name}</T>
            </View>
          ))
        )}
      </View>
      {width > 0 ? (
        <Pressable onPressIn={onPress} onPress={() => cursor != null && setCursor(null)}>
          <Svg width={width} height={height}>
            {yTicks.map((t) => (
              <G key={`y${t}`}>
                <Line x1={M.left} x2={M.left + plotW} y1={ys(t)} y2={ys(t)} stroke={palette.hair} strokeWidth={1} />
                <SvgText x={M.left - 6} y={ys(t) + 4} fontSize={10} fill={palette.mut} textAnchor="end">{yFormat(t)}</SvgText>
              </G>
            ))}
            {xTicks.map((d) => (
              <SvgText key={`x${+d}`} x={xs(d)} y={height - 6} fontSize={10} fill={palette.mut} textAnchor="middle">{xFormat(+d)}</SvgText>
            ))}
            {bars.map((b, bi) => {
              let base = 0;
              return (
                <G key={b.x} opacity={cursor == null || cursor === bi ? 1 : 0.45}>
                  {b.values.map((v, i) => {
                    if (v <= 0) return null;
                    const top = ys(base + v), bottom = ys(base);
                    base += v;
                    return <Rect key={i} x={xt(b.x) - bw / 2} y={top} width={bw} height={Math.max(0, bottom - top)} fill={layers[i]?.color ?? palette.mut} />;
                  })}
                </G>
              );
            })}
          </Svg>
        </Pressable>
      ) : (
        <View style={{ height }} />
      )}
    </View>
  );
}
