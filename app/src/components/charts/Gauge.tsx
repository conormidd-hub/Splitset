import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

type Props = {
  /** Null draws the track alone. */
  value: number | null;
  max?: number;
  size?: number;
  thickness?: number;
  color: string;
  track: string;
  /** Sits in the middle of the ring: the number and its word. */
  children?: ReactNode;
};

// the ring is open at the bottom, like a speedometer: 270° from seven o'clock round to five
const START = 225;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const s = polar(cx, cy, r, from);
  const e = polar(cx, cy, r, to);
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${e.x} ${e.y}`;
}

/** A score on a ring. Runs on iOS, Android and web. */
export function Gauge({ value, max = 100, size = 160, thickness = 12, color, track, children }: Props) {
  const c = size / 2;
  const r = (size - thickness) / 2;
  const frac = value == null ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Path d={arc(c, c, r, START, START + SWEEP)} stroke={track} strokeWidth={thickness} fill="none" strokeLinecap="round" />
        {frac > 0.005 ? (
          <Path d={arc(c, c, r, START, START + SWEEP * frac)} stroke={color} strokeWidth={thickness} fill="none" strokeLinecap="round" />
        ) : null}
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
    </View>
  );
}
