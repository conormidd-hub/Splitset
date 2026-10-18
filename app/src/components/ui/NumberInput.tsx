import { useState } from 'react';
import { TextInput, type TextStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { fontSize, radius } from '@/theme/tokens';

type Props = {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  integer?: boolean;
  width?: number;
  style?: TextStyle;
  muted?: boolean;
  /** What screen readers call the field, since its label is a separate Text. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/**
 * A compact numeric cell for the set sheet. Shows the stored value until edited. Every caller
 * holds a quantity (weight, reps, seconds, km, a year), so a negative or non-finite number is
 * not passed on; the text reverts to the stored value on blur.
 */
export function NumberInput({ value, onChange, placeholder, integer, width = 72, style, muted, accessibilityLabel, accessibilityHint }: Props) {
  const { palette } = useTheme();
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value == null ? '' : String(value));
  return (
    <TextInput
      value={shown}
      onChangeText={(t) => {
        setText(t);
        const cleaned = t.replace(',', '.').trim();
        if (cleaned === '') return onChange(null);
        const n = integer ? parseInt(cleaned, 10) : parseFloat(cleaned);
        if (Number.isFinite(n) && n >= 0) onChange(n);
      }}
      onBlur={() => setText(null)}
      placeholder={placeholder}
      placeholderTextColor={palette.mut}
      keyboardType={integer ? 'number-pad' : 'decimal-pad'}
      selectTextOnFocus
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={[
        {
          width, textAlign: 'center', paddingVertical: 8, paddingHorizontal: 6,
          backgroundColor: muted ? palette.surface2 : palette.surface3, color: palette.ink,
          borderRadius: radius.sm, fontSize: fontSize.body, fontVariant: ['tabular-nums'], fontWeight: '600',
        },
        style,
      ]}
    />
  );
}
