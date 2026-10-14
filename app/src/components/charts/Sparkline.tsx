import { scaleLinear } from 'd3-scale';
import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape';
import { useState } from 'react';
import { View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import type { Point } from './LineChart';

type Props = {
  points: Point[];
  /** Fixed width; left out, the line fills its parent and measures itself. */
  width?: number;
  height?: number;
  color: string;
  strokeWidth?: number;
  /** A soft fill under the line. */
  area?: boolean;
  /** A dot on the last point. */
  dot?: boolean;
  style?: ViewStyle;
};

type XY = { x: number; y: number };

/**
 * A line with no axes, for the In focus card and the corner of a tile. Days without a reading are
 * skipped rather than drawn as gaps: a sparkline is about the shape, not the holes.
 */
export function Sparkline({ points, width, height = 56, color, strokeWidth = 2, area = false, dot = false, style }: Props) {
  const [measured, setMeasured] = useState(0);
  const w = width ?? measured;
  const onLayout = width == null ? (e: LayoutChangeEvent) => setMeasured(e.nativeEvent.layout.width) : undefined;
  const pts = points.filter((p): p is XY => p.y != null && Number.isFinite(p.y));

  if (pts.length < 2 || w <= 0) {
    return <View onLayout={onLayout} style={[{ width: width ?? '100%', height }, style]} />;
  }

  // keep the stroke (and the dot's halo) inside the box
  const pad = strokeWidth / 2 + (dot ? strokeWidth + 4 : 0) + 1;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const sx = scaleLinear().domain([x0, x1 === x0 ? x0 + 1 : x1]).range([pad, w - pad]);
  const sy = scaleLinear().domain([y0, y1]).range([height - pad, pad]);
  const line = d3line<XY>().x((p) => sx(p.x)).y((p) => sy(p.y)).curve(curveMonotoneX)(pts) ?? '';
  const fill = area ? d3area<XY>().x((p) => sx(p.x)).y0(height).y1((p) => sy(p.y)).curve(curveMonotoneX)(pts) ?? '' : null;
  const last = pts[pts.length - 1];

  return (
    <View onLayout={onLayout} style={[{ width: width ?? '100%', height }, style]}>
      <Svg width={w} height={height}>
        {fill ? <Path d={fill} fill={color} opacity={0.12} /> : null}
        <Path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
        {dot ? (
          <>
            <Circle cx={sx(last.x)} cy={sy(last.y)} r={strokeWidth + 4} fill={color} opacity={0.2} />
            <Circle cx={sx(last.x)} cy={sy(last.y)} r={strokeWidth + 1} fill={color} />
          </>
        ) : null}
      </Svg>
    </View>
  );
}
