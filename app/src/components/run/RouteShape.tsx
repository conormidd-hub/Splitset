import { SymbolView } from 'expo-symbols';
import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { pathD, type Pt } from '@/lib/geo';
import { ICONS } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { radius } from '@/theme/tokens';

export const ROUTE_SHAPE = 38;

/**
 * A trace (Web Mercator world pixels, as decodeRuns gives them) as SVG path data scaled to fit a
 * `size` box with `pad` to spare, proportions kept and the short side centred. Points under a
 * pixel apart are dropped, so a long run is a hundred-odd segments rather than thousands.
 */
export function outlinePath(mx: ArrayLike<number>, my: ArrayLike<number>, size: number, pad = 4): string {
  const n = Math.min(mx.length, my.length);
  if (n < 2) return '';
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (mx[i] < x0) x0 = mx[i];
    if (mx[i] > x1) x1 = mx[i];
    if (my[i] < y0) y0 = my[i];
    if (my[i] > y1) y1 = my[i];
  }
  const inner = size - 2 * pad;
  const k = inner / (Math.max(x1 - x0, y1 - y0) || 1);
  const ox = pad + (inner - (x1 - x0) * k) / 2;
  const oy = pad + (inner - (y1 - y0) * k) / 2;
  const pts: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: ox + (mx[i] - x0) * k, y: oy + (my[i] - y0) * k };
  return pathD(pts, 1);
}

/**
 * A run's shape in the history, Strava style: its GPS trace drawn small in green on a quiet
 * tile. A run without a trace (a treadmill, or a watch without GPS) shows the run glyph, dimmed.
 */
export const RouteShape = memo(function RouteShape({ track, size = ROUTE_SHAPE }: {
  track: { mx: ArrayLike<number>; my: ArrayLike<number> } | null; size?: number;
}) {
  const { palette } = useTheme();
  const d = useMemo(() => (track ? outlinePath(track.mx, track.my, size) : ''), [track, size]);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: radius.sm, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center' }}>
      {d ? (
        <Svg width={size} height={size}>
          {/* aqua2 is green in both themes, deep enough to read on white */}
          <Path d={d} fill="none" stroke={palette.aqua2} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
        </Svg>
      ) : (
        <View style={{ opacity: 0.5 }}>
          <SymbolView name={ICONS.run} tintColor={palette.mut} size={18} />
        </View>
      )}
    </View>
  );
});
