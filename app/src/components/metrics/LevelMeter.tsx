import { View } from 'react-native';

import { T } from '@/components/ui/T';
import type { Tone } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { toneColor } from './helpers';

type Props = {
  /** The step that is lit, 0-based. */
  index: number;
  of: number;
  tone: Tone;
  /** One word under each step, when the scale is worth spelling out (Poor … Superior). */
  labels?: readonly string[];
};

/** A row of short bars filled up to the current step: where a verdict sits on its scale. */
export function LevelMeter({ index, of, tone, labels }: Props) {
  const { palette } = useTheme();
  const fill = toneColor(palette, tone);
  return (
    <View style={{ gap: 3, width: labels ? '100%' : 160, maxWidth: '100%' }}>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {Array.from({ length: of }, (_, i) => (
          <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= index ? fill : palette.surface3 }} />
        ))}
      </View>
      {labels ? (
        <View style={{ flexDirection: 'row', gap: 3 }}>
          {labels.map((l, i) => (
            <T
              key={l}
              variant="tiny"
              tone={i === index ? (tone === 'mut' ? 'ink2' : tone) : 'mut'}
              weight={i === index ? '700' : undefined}
              style={{ flex: 1, textAlign: i === 0 ? 'left' : i === of - 1 ? 'right' : 'center' }}>
              {l}
            </T>
          ))}
        </View>
      ) : null}
    </View>
  );
}
