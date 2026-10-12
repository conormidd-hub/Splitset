import { router } from 'expo-router';
import { Pressable } from 'react-native';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** The easy-to-find way in: a gold-trimmed pill for screen headers. */
export function PbButton() {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={() => router.push('/pbs')}
      accessibilityRole="button"
      accessibilityLabel="Personal bests"
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6,
        backgroundColor: palette.surface, borderColor: palette.amber, borderWidth: 1.5,
        borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 7,
        opacity: pressed ? 0.8 : 1,
      })}>
      <T variant="small">🏆</T>
      <T variant="small" weight="800" style={{ color: palette.amber }}>PBs</T>
    </Pressable>
  );
}
