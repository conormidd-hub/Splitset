import { TextInput, View, type TextInputProps } from 'react-native';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { fontSize, radius, space } from '@/theme/tokens';

type Props = TextInputProps & {
  label?: string;
  hint?: string;
  error?: string | null;
};

export function TextField({ label, hint, error, style, ...input }: Props) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      {label ? <T variant="label" tone="mut">{label}</T> : null}
      <TextInput
        placeholderTextColor={palette.mut}
        {...input}
        style={[
          {
            backgroundColor: palette.surface2, color: palette.ink, borderRadius: radius.md,
            borderWidth: 1, borderColor: error ? palette.neg : palette.hair,
            paddingHorizontal: space.md, paddingVertical: 12, fontSize: fontSize.body,
          },
          style,
        ]}
      />
      {error ? <T variant="small" tone="neg">{error}</T> : hint ? <T variant="small" tone="mut">{hint}</T> : null}
    </View>
  );
}
