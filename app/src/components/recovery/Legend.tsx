import { View } from 'react-native';

import { T } from '@/components/ui/T';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import { legendRows, type FigureTheme, type MapMode } from '@/lib/recovery/figure';
import type { Thresholds } from '@/lib/recovery/thresholds';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

/** The six levels: swatch, label, range of F (or L) and advice, all from the constants' `levels`. */
export function Legend({ theme, mode, thresholds = DEFAULT_THRESHOLDS }: { theme: FigureTheme; mode: MapMode; thresholds?: Thresholds }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.sm }} accessibilityLabel="Load levels">
      <T variant="label" tone="mut">Load level</T>
      {legendRows(thresholds, theme, mode).map((r) => (
        <View key={r.level} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 22, height: 16, borderRadius: 4, backgroundColor: r.fill, borderWidth: 1, borderColor: palette.hair }} />
          <T variant="small" weight="700" style={{ width: 72 }}>{r.label}</T>
          <T variant="small" tone="mut" style={{ width: 84, fontVariant: ['tabular-nums'] }}>{r.range}</T>
          <T variant="small" tone="ink2" style={{ flex: 1 }}>{r.advice}</T>
        </View>
      ))}
    </View>
  );
}
