import { Text, type TextProps, type TextStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { fontSize } from '@/theme/tokens';

type Variant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'small' | 'tiny' | 'label' | 'mono';
type Tone = 'ink' | 'ink2' | 'mut' | 'accent' | 'pos' | 'neg' | 'onAccent';

type Props = TextProps & {
  variant?: Variant;
  tone?: Tone;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
};

const variants: Record<Variant, TextStyle> = {
  display: { fontSize: fontSize.display, fontWeight: '800', letterSpacing: -0.8, lineHeight: 40 },
  h1: { fontSize: fontSize.h1, fontWeight: '700', letterSpacing: -0.4, lineHeight: 30 },
  h2: { fontSize: fontSize.h2, fontWeight: '700', lineHeight: 24 },
  h3: { fontSize: fontSize.h3, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: fontSize.body, lineHeight: 21 },
  small: { fontSize: fontSize.small, lineHeight: 18 },
  tiny: { fontSize: fontSize.tiny, lineHeight: 14 },
  label: { fontSize: fontSize.tiny, lineHeight: 14, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  mono: { fontSize: fontSize.body, lineHeight: 21, fontVariant: ['tabular-nums'] },
};

/** The one text component. Colour comes from the theme, never hard-coded in screens. */
export function T({ variant = 'body', tone = 'ink', weight, align, style, ...rest }: Props) {
  const { palette } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        variants[variant],
        { color: palette[tone] },
        weight ? { fontWeight: weight } : null,
        align ? { textAlign: align } : null,
        style,
      ]}
    />
  );
}
