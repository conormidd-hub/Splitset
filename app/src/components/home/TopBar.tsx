import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Animated, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useSyncNow } from '@/api/sync';
import { Bubble, ScreenTopBar } from '@/components/ui/BarButtons';
import { T } from '@/components/ui/T';
import { Wordmark } from '@/components/ui/Wordmark';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { heat } from '@/theme/tokens';

export { TOP_BAR_HEIGHT } from '@/components/ui/BarButtons';

/**
 * Today's top bar, Strava style: Settings and Sync on the left, the SPLITSET wordmark in the
 * middle, PBs and the week streak on the right, each a round, see-through button. It stays put
 * while the page scrolls up underneath, and the wordmark fades away once the page has moved.
 */
export function TodayTopBar({ streak, scrollY }: { streak: Streak | null; scrollY: Animated.Value }) {
  const { palette } = useTheme();
  const wordmark = scrollY.interpolate({ inputRange: [0, 48], outputRange: [1, 0], extrapolate: 'clamp' });
  const count = streak ? `${streak.weeks}${streak.capped ? '+' : ''}` : '';
  const sync = useSyncNow();
  const syncing = sync.phase === 'starting' || sync.phase === 'waiting' || sync.phase === 'running';

  return (
    <ScreenTopBar
      centreOpacity={wordmark}
      centre={<Wordmark maxHeight={16} />}
      left={
        <>
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
        </>
      }
      right={
        <>
          <Bubble label="Personal bests" onPress={() => router.push('/pbs')}>
            <SymbolView name={ICONS.trophy} tintColor={palette.amber} size={21} />
          </Bubble>
          {streak ? (
            <Bubble
              label={`${count} week streak`}
              hint="Opens the month view of the plan"
              onPress={() => router.navigate({ pathname: '/plan', params: { view: 'month', t: String(Date.now()) } })}>
              <StreakFlame count={count} lit={streak.weeks > 0} />
            </Bubble>
          ) : null}
        </>
      }
    />
  );
}

/** A solid flame, drawn here so it is the same shape everywhere (the symbol fonts' flames are
 *  hollow on the web and thin on Android), with the week count in dark ink across its body. */
const FLAME = 'M12 1.5c.6 3.3 2.5 5.2 4.3 7.2 1.9 2.1 3.2 4.3 3.2 7C19.5 19.9 16.2 23 12 23s-7.5-3.1-7.5-7.3c0-2.8 1.4-4.9 3-6.5.2 1.7 1 3 2.4 3.6C9.4 9.2 10.3 5 12 1.5z';
const FLAME_SIZE = 32;

export function StreakFlame({ count, lit }: { count: string; lit: boolean }) {
  const { palette } = useTheme();
  return (
    <View style={{ width: FLAME_SIZE, height: FLAME_SIZE, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={FLAME_SIZE} height={FLAME_SIZE} viewBox="0 0 24 24">
        <Path d={FLAME} fill={lit ? heat.flame : palette.surface3} stroke={lit ? 'none' : palette.mut} strokeWidth={lit ? 0 : 1} />
      </Svg>
      {/* centred on the flame's round body, which sits in its lower half */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: FLAME_SIZE * 0.41, alignItems: 'center' }}>
        <T
          accessible={false}
          numberOfLines={1}
          // sized to the flame, so it barely grows with the system text size (the bubble's label reads the count out)
          maxFontSizeMultiplier={1.15}
          style={{ fontSize: count.length > 2 ? 10 : 12.5, lineHeight: 15, fontWeight: '900', color: lit ? '#0d0d0d' : palette.ink2,
            fontVariant: ['tabular-nums'], textAlign: 'center', letterSpacing: -0.3 }}>
          {count}
        </T>
      </View>
    </View>
  );
}
