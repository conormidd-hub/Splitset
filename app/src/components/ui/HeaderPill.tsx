import { SymbolView } from 'expo-symbols';
import { Pressable, type ViewStyle } from 'react-native';

import { T } from './T';
import type { IconName } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  icon: IconName;
  label: string;
  /** The ring and the ink: amber for PBs, green for the streak, grey when there is nothing to show. */
  colour: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** A smaller pill for a header that already has buttons in it. */
  compact?: boolean;
  style?: ViewStyle;
};

/** One size for every pill in a screen's header, so a stack of them lines up: PBs, the streak. */
export const PILL_HEIGHT = 40;
export const PILL_MIN_WIDTH = 92;

export function HeaderPill({ icon, label, colour, onPress, accessibilityLabel, accessibilityHint, compact = false, style }: Props) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        {
          height: compact ? 34 : PILL_HEIGHT, minWidth: compact ? 0 : PILL_MIN_WIDTH,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: compact ? 4 : 6,
          backgroundColor: palette.surface, borderColor: colour, borderWidth: 1.5,
          borderRadius: radius.pill, paddingHorizontal: compact ? space.sm + 2 : space.md,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}>
      <SymbolView name={icon} tintColor={colour} size={compact ? 16 : 20} />
      <T variant={compact ? 'small' : 'h3'} weight="800" style={{ color: colour, fontVariant: ['tabular-nums'] }}>{label}</T>
    </Pressable>
  );
}
