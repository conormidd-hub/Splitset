import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';

import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  streak: Streak;
  /** Sessions in the last seven days, for the small print. */
  last7: number;
};

/** The flame under the trophy cabinet: weeks in a row with a workout. Tap for the calendar. */
export function StreakRow({ streak, last7 }: Props) {
  const { palette } = useTheme();
  const lit = streak.weeks > 0;
  const count = `${streak.weeks}${streak.capped ? '+' : ''}`;
  const sub = !lit
    ? 'A workout this week starts a streak'
    : streak.thisWeek
      ? `This week counts · ${last7} workout${last7 === 1 ? '' : 's'} in the last 7 days`
      : 'Train this week to keep it going';
  return (
    <Pressable
      onPress={() => router.push('/streak')}
      accessibilityRole="button"
      accessibilityLabel={`${count} week streak. ${sub}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.md,
        backgroundColor: palette.surface, borderColor: lit ? palette.amber : palette.hair, borderWidth: 1, borderRadius: radius.lg,
        paddingVertical: space.md, paddingHorizontal: space.lg, opacity: pressed ? 0.85 : 1,
      })}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: lit ? palette.accentSoft : palette.surface2, alignItems: 'center', justifyContent: 'center' }}>
        <SymbolView name={ICONS.flame} tintColor={lit ? palette.amber : palette.mut} size={24} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <T variant="h1" tone={lit ? 'ink' : 'mut'} style={{ fontVariant: ['tabular-nums'] }}>{count}</T>
          <T variant="h3" tone={lit ? 'ink' : 'mut'}>week{streak.weeks === 1 && !streak.capped ? '' : 's'} in a row</T>
        </View>
        <T variant="small" tone="mut" numberOfLines={1}>{sub}</T>
      </View>
      <T tone="mut">›</T>
    </Pressable>
  );
}
