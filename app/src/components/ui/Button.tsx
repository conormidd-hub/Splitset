import { ActivityIndicator, Pressable, type ViewStyle } from 'react-native';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
};

export function Button({ title, onPress, variant = 'primary', loading, disabled, small, style }: Props) {
  const { palette } = useTheme();
  const bg = variant === 'primary' ? palette.accent : variant === 'danger' ? palette.negSoft : variant === 'secondary' ? palette.surface2 : 'transparent';
  const fg = variant === 'primary' ? 'onAccent' : variant === 'danger' ? 'neg' : variant === 'ghost' ? 'accent' : 'ink';
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        {
          backgroundColor: bg, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
          paddingVertical: small ? space.sm : 14, paddingHorizontal: space.lg,
          borderWidth: variant === 'secondary' ? 1 : 0, borderColor: palette.hair,
          opacity: off ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? palette.onAccent : palette.ink} />
      ) : (
        <T variant={small ? 'small' : 'h3'} tone={fg} weight="700">{title}</T>
      )}
    </Pressable>
  );
}
