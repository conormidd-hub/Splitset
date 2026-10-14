import { router } from 'expo-router';

import { HeaderPill } from '@/components/ui/HeaderPill';
import { ICONS } from '@/lib/icons';
import type { Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { heat } from '@/theme/tokens';

/**
 * The green flame under the PBs pill: weeks in a row with a workout. Tap for the Plan tab's month
 * view; the Plan's own header passes `onPress` to switch views in place.
 */
export function StreakButton({ streak, compact, onPress }: { streak: Streak; compact?: boolean; onPress?: () => void }) {
  const { palette } = useTheme();
  const lit = streak.weeks > 0;
  const count = `${streak.weeks}${streak.capped ? '+' : ''}`;
  return (
    <HeaderPill
      icon={ICONS.flame}
      label={count}
      colour={lit ? heat.flame : palette.mut}
      onPress={onPress ?? (() => router.navigate({ pathname: '/plan', params: { view: 'month', t: String(Date.now()) } }))}
      accessibilityLabel={`${count} week streak`}
      accessibilityHint="Opens the month view of the plan"
      compact={compact}
    />
  );
}
