import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable } from 'react-native';

import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { heat, radius, space } from '@/theme/tokens';

/** The green flame under the PBs pill: weeks in a row with a workout. Tap for the calendar. */
export function StreakButton({ streak }: { streak: Streak }) {
  const { palette } = useTheme();
  const lit = streak.weeks > 0;
  const count = `${streak.weeks}${streak.capped ? '+' : ''}`;
  const colour = lit ? heat.flame : palette.mut;
  return (
    <Pressable
      onPress={() => router.push('/streak')}
      accessibilityRole="button"
      accessibilityLabel={`${count} week streak`}
      accessibilityHint="Opens the training calendar"
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: palette.surface, borderColor: colour, borderWidth: 1.5,
        borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6,
        opacity: pressed ? 0.8 : 1,
      })}>
      <SymbolView name={ICONS.flame} tintColor={colour} size={16} />
      <T variant="small" weight="800" style={{ color: colour, fontVariant: ['tabular-nums'] }}>{count}</T>
    </Pressable>
  );
}
