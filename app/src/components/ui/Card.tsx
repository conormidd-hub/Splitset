import type { ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children?: ReactNode;
  onPress?: () => void;
  tone?: 'surface' | 'accent' | 'neg';
  style?: ViewStyle;
};

export function Card({ title, subtitle, right, children, onPress, tone = 'surface', style }: Props) {
  const { palette } = useTheme();
  const bg = tone === 'accent' ? palette.accentSoft : tone === 'neg' ? palette.negSoft : palette.surface;
  const border = tone === 'accent' ? palette.accentLine : tone === 'neg' ? palette.neg : palette.hair;
  const body = (
    <>
      {title || right ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: children ? space.sm : 0 }}>
          <View style={{ flex: 1 }}>
            {title ? <T variant="h3">{title}</T> : null}
            {subtitle ? <T variant="small" tone="mut">{subtitle}</T> : null}
          </View>
          {right}
        </View>
      ) : null}
      {children}
    </>
  );
  const base: ViewStyle = {
    backgroundColor: bg,
    borderColor: border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
  };
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [base, { opacity: pressed ? 0.85 : 1 }, style]}>
        {body}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{body}</View>;
}
