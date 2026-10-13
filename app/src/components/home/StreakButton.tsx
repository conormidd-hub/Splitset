import { router } from 'expo-router';

import { HeaderPill } from '@/components/ui/HeaderPill';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { heat } from '@/theme/tokens';

/** The green flame under the PBs pill: weeks in a row with a workout. Tap for the calendar. */
export function StreakButton({ streak }: { streak: Streak }) {
  const { palette } = useTheme();
  const lit = streak.weeks > 0;
  const count = `${streak.weeks}${streak.capped ? '+' : ''}`;
  return (
    <HeaderPill
      icon={ICONS.flame}
      label={count}
      colour={lit ? heat.flame : palette.mut}
      onPress={() => router.push('/streak')}
      accessibilityLabel={`${count} week streak`}
      accessibilityHint="Opens the training calendar"
    />
  );
}
