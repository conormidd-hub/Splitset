import { router } from 'expo-router';

import { HeaderPill } from '@/components/ui/HeaderPill';
import { ICONS } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';

/** The easy-to-find way in: a gold-trimmed trophy pill for screen headers. `compact` for a header
 *  that also holds buttons (Lift). */
export function PbButton({ compact = false }: { compact?: boolean } = {}) {
  const { palette } = useTheme();
  return (
    <HeaderPill
      icon={ICONS.trophy}
      label="PBs"
      colour={palette.amber}
      onPress={() => router.push('/pbs')}
      accessibilityLabel="Personal bests"
      compact={compact}
    />
  );
}
