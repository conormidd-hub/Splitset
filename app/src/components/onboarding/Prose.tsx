import { View } from 'react-native';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Tone = 'ink' | 'ink2' | 'mut';

/**
 * Body text where **like this** comes out bold, so a step can point at the exact words on the
 * intervals.icu page ("tick **Download wellness data**") without a markdown library.
 */
export function Prose({ text, tone = 'ink2', variant = 'body' }: { text: string; tone?: Tone; variant?: 'body' | 'small' }) {
  const parts = text.split('**');
  return (
    <T variant={variant} tone={tone}>
      {parts.map((part, i) => (i % 2 ? <T key={i} variant={variant} tone="ink" weight="700">{part}</T> : part))}
    </T>
  );
}

/** A numbered list of short instructions, each a Prose line. */
export function Numbered({ items }: { items: string[] }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      {items.map((text, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: palette.surface3, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
            <T variant="tiny" tone="ink2" weight="700">{i + 1}</T>
          </View>
          <View style={{ flex: 1 }}>
            <Prose text={text} />
          </View>
        </View>
      ))}
    </View>
  );
}
