import { useId, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { T } from '@/components/ui/T';
import { METRICS, type ColourScale, type Metric } from '@/lib/runAnalysis';
import { space } from '@/theme/tokens';

const BAR_HEIGHT = 8;

type GradientStop = { offset: number; colour: string };

/**
 * SVG gradient stops from the scale's stops, placed by value across the bar. A stepped scale
 * (heart-rate zones) changes colour abruptly at an interior stop: the colour just below it is
 * not the stop's own, so that colour is repeated at the same offset and the edge stays hard
 * instead of blending two zones. Smooth ramps pass through their stops and get no extra stop.
 */
function gradientStops(scale: ColourScale): GradientStop[] {
  const stops = scale.stops;
  const lo = stops[0].v, hi = stops[stops.length - 1].v;
  const span = hi - lo;
  if (!(span > 0)) return [{ offset: 0, colour: stops[0].colour }, { offset: 1, colour: stops[stops.length - 1].colour }];
  const eps = span * 1e-6;
  const out: GradientStop[] = [];
  stops.forEach((s, k) => {
    const offset = Math.min(1, Math.max(0, (s.v - lo) / span));
    if (k > 0 && k < stops.length - 1) {
      const before = scale.colour(s.v - eps);
      if (before !== s.colour) out.push({ offset, colour: before });
    }
    out.push({ offset, colour: s.colour });
  });
  return out;
}

/** A thin gradient bar through the scale's stops, labelled with the metric and its two ends. */
export function MetricLegend({ scale, metric }: { scale: ColourScale; metric: Metric }) {
  const [width, setWidth] = useState(0);
  // SVG ids are global to the document; two legends on one screen need two gradients.
  const rawId = useId();
  const gradientId = `legend-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;

  const stops = scale.stops;
  if (stops.length < 2) return <></>;
  const lo = stops[0].v;
  const hi = stops[stops.length - 1].v;
  const short = METRICS.find((m) => m.key === metric)?.short ?? metric;

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth((prev) => (prev === w ? prev : w));
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <T variant="tiny" tone="mut" weight="700">{short}</T>
      <T variant="tiny" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{scale.label(lo)}</T>
      <View style={{ flex: 1, height: BAR_HEIGHT }} onLayout={onLayout}>
        {width > 0 ? (
          <Svg width={width} height={BAR_HEIGHT}>
            <Defs>
              <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                {gradientStops(scale).map((s, i) => (
                  <Stop key={i} offset={s.offset} stopColor={s.colour} />
                ))}
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={width} height={BAR_HEIGHT} rx={BAR_HEIGHT / 2} fill={`url(#${gradientId})`} />
          </Svg>
        ) : null}
      </View>
      <T variant="tiny" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{scale.label(hi)}</T>
    </View>
  );
}
