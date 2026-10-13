import { useEffect, useState } from 'react';
import { View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { T } from '@/components/ui/T';
import { heatExtent, heatTier, type HeatTier } from '@/lib/streaks';
import { heat } from '@/theme/tokens';

type Props = {
  /** Sessions in the last seven days. */
  count: number;
  /** The small "3/7 streak heat" under the flames; off for a bare line. */
  caption?: boolean;
  style?: ViewStyle;
};

const SLOT = 9;
const FLAME_W = 6;
const LINE_H = 2;
const FLAMES_H = 16;

/** How each tier burns: how tall, how fast it flickers, how bright, and whether the pale core shows. */
const TIERS: Record<HeatTier, { height: number; period: number; glow: number; core: boolean }> = {
  0: { height: 0, period: 0, glow: 0.3, core: false },
  1: { height: 6, period: 760, glow: 0.6, core: false },
  2: { height: 8, period: 640, glow: 0.7, core: false },
  3: { height: 11, period: 470, glow: 0.85, core: true },
  4: { height: 14, period: 340, glow: 1, core: true },
  5: { height: 15, period: 270, glow: 1, core: true },
};

/** A fixed jitter per flame, so neighbours differ without rolling dice during render. */
function jitter(index: number, salt: number): number {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Streak heat: a thin line of fire under the greeting that burns by how much of the last seven
 * days was spent training. One session lights a seventh of it; each one more lights more and
 * burns hotter; seven, and the whole line is ablaze. Nothing in seven days and it goes cold.
 * The flames are plain views flickering on the UI thread, so they cost nothing to the page.
 */
export function StreakHeat({ count, caption = true, style }: Props) {
  const [width, setWidth] = useState(0);
  const reduced = useReducedMotion();
  const tier = heatTier(count);
  const t = TIERS[tier];
  const slots = width > 0 ? Math.floor((width - FLAME_W) / SLOT) + 1 : 0;
  const burning = tier === 0 ? 0 : Math.max(1, Math.round(slots * heatExtent(count)));
  const litWidth = burning ? Math.min(width, (burning - 1) * SLOT + FLAME_W) : 0;

  return (
    <View style={[{ gap: 2 }, style]} accessibilityRole="image" accessibilityLabel={`Streak heat ${Math.min(7, count)} out of 7: ${count} workout${count === 1 ? '' : 's'} in the last seven days`}>
      <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={{ height: FLAMES_H + LINE_H }}>
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: LINE_H, borderRadius: 1, backgroundColor: heat.cold, opacity: 0.3 }} />
        {litWidth > 0 ? (
          <View style={{ position: 'absolute', left: 0, bottom: 0, width: litWidth, height: LINE_H, borderRadius: 1, backgroundColor: heat.flame, opacity: t.glow }} />
        ) : null}
        {Array.from({ length: burning }, (_, i) => (
          <Flame key={i} index={i} x={i * SLOT} tier={tier} reduced={reduced} />
        ))}
      </View>
      {caption ? (
        <T variant="tiny" tone="mut" align="right" style={{ fontVariant: ['tabular-nums'] }}>
          {Math.min(7, count)}/7 streak heat
        </T>
      ) : null}
    </View>
  );
}

function Flame({ index, x, tier, reduced }: { index: number; x: number; tier: HeatTier; reduced: boolean }) {
  const t = TIERS[tier];
  const h = Math.max(3, Math.round(t.height * (0.6 + 0.4 * jitter(index, 1))));
  const lick = useSharedValue(1);
  const sway = useSharedValue(0);

  useEffect(() => {
    if (reduced || t.period === 0) {
      lick.set(1);
      sway.set(0);
      return;
    }
    const up = t.period * (0.7 + 0.6 * jitter(index, 2));
    const down = t.period * (0.7 + 0.6 * jitter(index, 3));
    const ease = Easing.inOut(Easing.quad);
    lick.set(withDelay(jitter(index, 4) * t.period, withRepeat(withSequence(withTiming(1.15, { duration: up, easing: ease }), withTiming(0.55, { duration: down, easing: ease })), -1, true)));
    sway.set(withRepeat(withSequence(withTiming(1.2, { duration: down * 1.3, easing: ease }), withTiming(-1.2, { duration: up * 1.3, easing: ease })), -1, true));
    return () => {
      cancelAnimation(lick);
      cancelAnimation(sway);
    };
  }, [index, t.period, reduced, lick, sway]);

  const flicker = useAnimatedStyle(() => ({
    transform: [{ translateX: sway.get() }, { scaleY: lick.get() }],
  }));

  return (
    <Animated.View style={[{ position: 'absolute', left: x, bottom: LINE_H, width: FLAME_W, height: h, transformOrigin: 'bottom' }, flicker]}>
      <View style={{ flex: 1, borderRadius: FLAME_W / 2, borderBottomLeftRadius: 1, borderBottomRightRadius: 1, backgroundColor: heat.flame, opacity: t.glow }} />
      {t.core ? (
        <View style={{ position: 'absolute', left: 2, right: 2, bottom: 0, height: Math.max(2, Math.round(h * 0.5)), borderTopLeftRadius: 1.5, borderTopRightRadius: 1.5, backgroundColor: heat.core, opacity: 0.85 }} />
      ) : null}
    </Animated.View>
  );
}
