import { useId, type ReactNode } from 'react';
import { Animated, Pressable, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme/ThemeProvider';
import { space, withAlpha } from '@/theme/tokens';

export const BUBBLE = 44;
export const TOP_BAR_HEIGHT = 60;
/** How far the page fades out as it slides up under a bar. */
export const FADE = 22;

/**
 * A screen's top bar, Strava style: round see-through buttons on the left and right, something in
 * the middle (Today's wordmark), and the page fading out as it slides up under the bar's edge.
 * `centreOpacity` fades the middle away once the page has moved.
 */
export function ScreenTopBar({ left, centre, right, centreOpacity }: {
  left?: ReactNode; centre?: ReactNode; right?: ReactNode;
  centreOpacity?: Animated.AnimatedInterpolation<number> | number;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ height: TOP_BAR_HEIGHT, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', backgroundColor: palette.bg, zIndex: 2 }}>
      <View style={{ flexDirection: 'row', gap: space.sm }}>{left}</View>
      <Animated.View pointerEvents="none" style={{ flex: 1, alignItems: 'center', paddingHorizontal: space.sm, opacity: centreOpacity ?? 1 }}>
        {centre}
      </Animated.View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>{right}</View>
      <EdgeFade />
    </View>
  );
}

/** The page fading out under a bar: hung just below the bar's bottom edge. */
export function EdgeFade({ height = FADE }: { height?: number }) {
  const { palette } = useTheme();
  // SVG ids are global to the document, and Today, Lift and Run each keep a bar mounted
  const id = `fade-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: -height, height }}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={palette.bg} stopOpacity={1} />
            <Stop offset="1" stopColor={palette.bg} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/** One of a top bar's round, see-through buttons. */
export function Bubble({ label, hint, onPress, children, disabled }: {
  label: string; hint?: string; onPress: () => void; children: ReactNode; disabled?: boolean;
}) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={disabled ? { disabled: true } : undefined}
      hitSlop={4}
      style={({ pressed }) => ({
        width: BUBBLE, height: BUBBLE, borderRadius: BUBBLE / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        backgroundColor: withAlpha(palette.surface, 0.55), borderWidth: 1, borderColor: withAlpha(palette.hair, 0.6),
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}>
      {children}
    </Pressable>
  );
}
