import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useSyncNow } from '@/api/sync';
import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { heat, space, withAlpha } from '@/theme/tokens';

const BUBBLE = 44;
export const TOP_BAR_HEIGHT = 60;
/** How far the page fades out as it slides up under the bar. */
const FADE = 22;

/**
 * Today's top bar, Strava style: Settings and Sync on the left, the SPLITSET wordmark in the
 * middle, PBs and the week streak on the right, each a round, see-through button. It stays put while the page scrolls up
 * underneath, fading out under its edge, and the wordmark fades away once the page has moved.
 */
export function TodayTopBar({ streak, scrollY }: { streak: Streak | null; scrollY: Animated.Value }) {
  const { palette } = useTheme();
  const wordmark = scrollY.interpolate({ inputRange: [0, 48], outputRange: [1, 0], extrapolate: 'clamp' });
  const lit = !!streak && streak.weeks > 0;
  const count = streak ? `${streak.weeks}${streak.capped ? '+' : ''}` : '';
  const sync = useSyncNow();
  const syncing = sync.phase === 'starting' || sync.phase === 'waiting' || sync.phase === 'running';

  return (
    <View style={{ height: TOP_BAR_HEIGHT, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', backgroundColor: palette.bg, zIndex: 2 }}>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Bubble label="Settings" onPress={() => router.push('/settings')}>
          <SymbolView name={ICONS.settings} tintColor={palette.ink2} size={21} />
        </Bubble>
        <Bubble
          label={syncing ? 'Syncing' : sync.phase === 'failed' ? 'Sync failed, try again' : 'Sync now'}
          hint="Fetches new activities and wellness from intervals.icu"
          onPress={() => { if (!syncing) void sync.start(); }}>
          {syncing ? <ActivityIndicator size="small" color={palette.accent} />
            : <SymbolView name={ICONS.sync} tintColor={sync.phase === 'failed' ? palette.neg : palette.ink2} size={21} />}
        </Bubble>
      </View>

      <Animated.View pointerEvents="none" style={{ flex: 1, alignItems: 'center', opacity: wordmark }}>
        <T accessibilityRole="header" accessibilityLabel="SplitSet" style={{ fontSize: 21, fontWeight: '900', letterSpacing: 2 }}>
          <T style={{ fontSize: 21, fontWeight: '900', letterSpacing: 2, color: palette.ink }}>SPLIT</T>
          <T style={{ fontSize: 21, fontWeight: '900', letterSpacing: 2, color: palette.accent }}>SET</T>
        </T>
      </Animated.View>

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Bubble label="Personal bests" onPress={() => router.push('/pbs')}>
          <SymbolView name={ICONS.trophy} tintColor={palette.amber} size={21} />
        </Bubble>
        {streak ? (
          <Bubble
            label={`${count} week streak`}
            hint="Opens the month view of the plan"
            onPress={() => router.navigate({ pathname: '/plan', params: { view: 'month', t: String(Date.now()) } })}>
            {/* the week count sits in the middle of the flame's body, in the text colour: it reads in the
                web icon's hollow core and on the solid iOS flame alike */}
            <View style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}>
              <SymbolView name={ICONS.flame} tintColor={lit ? heat.flame : palette.mut} size={34} />
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingTop: 7 }}>
                <T
                  accessible={false}
                  numberOfLines={1}
                  style={{ fontSize: count.length > 2 ? 10 : 12, lineHeight: 14, fontWeight: '900', color: lit ? palette.ink : palette.mut,
                    fontVariant: ['tabular-nums'], textAlign: 'center' }}>
                  {count}
                </T>
              </View>
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
        backgroundColor: withAlpha(palette.surface, 0.55), borderWidth: 1, borderColor: withAlpha(palette.hair, 0.6), opacity: pressed ? 0.7 : 1,
      })}>
      {children}
    </Pressable>
  );
}
