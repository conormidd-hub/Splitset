import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Animated, Pressable, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { heat, space } from '@/theme/tokens';

const BUBBLE = 40;
export const TOP_BAR_HEIGHT = 56;
/** How far the page fades out as it slides up under the bar. */
const FADE = 22;

/**
 * Today's top bar, Strava style: Settings on the left, the SPLITSET wordmark in the middle, PBs
 * and the week streak on the right, each a round button. It stays put while the page scrolls up
 * underneath, fading out under its edge, and the wordmark fades away once the page has moved.
 */
export function TodayTopBar({ streak, scrollY }: { streak: Streak | null; scrollY: Animated.Value }) {
  const { palette } = useTheme();
  const wordmark = scrollY.interpolate({ inputRange: [0, 48], outputRange: [1, 0], extrapolate: 'clamp' });
  const lit = !!streak && streak.weeks > 0;
  const count = streak ? `${streak.weeks}${streak.capped ? '+' : ''}` : '';

  return (
    <View style={{ height: TOP_BAR_HEIGHT, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', backgroundColor: palette.bg, zIndex: 2 }}>
      <Bubble label="Settings" onPress={() => router.push('/settings')}>
        <SymbolView name={ICONS.settings} tintColor={palette.ink2} size={19} />
      </Bubble>

      <Animated.View pointerEvents="none" style={{ flex: 1, alignItems: 'center', opacity: wordmark }}>
        <T accessibilityRole="header" accessibilityLabel="SplitSet" style={{ fontSize: 21, fontWeight: '900', letterSpacing: 2 }}>
          <T style={{ fontSize: 21, fontWeight: '900', letterSpacing: 2, color: palette.ink }}>SPLIT</T>
          <T style={{ fontSize: 21, fontWeight: '900', letterSpacing: 2, color: palette.accent }}>SET</T>
        </T>
      </Animated.View>

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Bubble label="Personal bests" onPress={() => router.push('/pbs')}>
          <SymbolView name={ICONS.trophy} tintColor={palette.amber} size={19} />
        </Bubble>
        {streak ? (
          <Bubble
            label={`${count} week streak`}
            hint="Opens the month view of the plan"
            onPress={() => router.navigate({ pathname: '/plan', params: { view: 'month', t: String(Date.now()) } })}>
            {/* the week count sits inside the flame */}
            <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
              <SymbolView name={ICONS.flame} tintColor={lit ? heat.flame : palette.mut} size={30} />
              <T
                accessible={false}
                style={{ position: 'absolute', top: count.length > 2 ? 12 : 11, fontSize: count.length > 2 ? 9 : 11, fontWeight: '900',
                  color: lit ? palette.bg : palette.surface, fontVariant: ['tabular-nums'] }}>
                {count}
              </T>
            </View>
          </Bubble>
        ) : null}
      </View>

      {/* the page fades out as it slides up under the bar */}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: -FADE, height: FADE }}>
        <Svg width="100%" height={FADE}>
          <Defs>
            <LinearGradient id="topbar-fade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={palette.bg} stopOpacity={1} />
              <Stop offset="1" stopColor={palette.bg} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={FADE} fill="url(#topbar-fade)" />
        </Svg>
      </View>
    </View>
  );
}

function Bubble({ label, hint, onPress, children }: { label: string; hint?: string; onPress: () => void; children: ReactNode }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={4}
      style={({ pressed }) => ({
        width: BUBBLE, height: BUBBLE, borderRadius: BUBBLE / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hair, opacity: pressed ? 0.7 : 1,
      })}>
      {children}
    </Pressable>
  );
}
