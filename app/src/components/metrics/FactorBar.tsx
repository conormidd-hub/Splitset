import { View } from 'react-native';

import { T } from '@/components/ui/T';
import type { Tone } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';
import { toneColor } from './helpers';

type Props = { label: string; score: number | null; text: string; tone: Tone };

/** One readiness ingredient: its name, what it saw, its 0–100 score, and a bar in its tone. */
export function FactorBar({ label, score, text, tone }: Props) {
  const { palette } = useTheme();
  const fill = toneColor(palette, tone);
  const none = score == null;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <T weight="600" style={{ width: 108 }} numberOfLines={1}>{label}</T>
        <T variant="small" tone="mut" style={{ flex: 1, textAlign: 'right' }} numberOfLines={1}>{none ? 'No data' : text}</T>
        <T variant="mono" weight="700" tone={none ? 'mut' : tone === 'mut' ? 'ink2' : tone} style={{ width: 32, textAlign: 'right' }}>
          {none ? '–' : `${Math.round(score)}`}
        </T>
      </View>
      {none ? (
        <View style={{ height: 8, borderRadius: 4, borderWidth: 1, borderStyle: 'dotted', borderColor: palette.hair }} />
      ) : (
        <View style={{ height: 8, borderRadius: 4, backgroundColor: palette.surface3, overflow: 'hidden' }}>
          <View style={{ width: `${Math.min(100, Math.max(0, score))}%`, height: '100%', borderRadius: 4, backgroundColor: fill }} />
        </View>
      )}
    </View>
  );
}
