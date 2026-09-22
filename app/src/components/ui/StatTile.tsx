import type { ReactNode } from 'react';
import { View } from 'react-native';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  label: string;
  value: string;
  sub?: string;
  subTone?: 'mut' | 'pos' | 'neg' | 'accent';
  big?: boolean;
};

/** A number with a label above and a comparison line below. Meant to sit in a Grid. */
export function StatTile({ label, value, sub, subTone = 'mut', big }: Props) {
  const { palette } = useTheme();
  return (
    <View style={{ flexGrow: 1, flexBasis: '30%', minWidth: 96, backgroundColor: palette.surface2, borderRadius: radius.md, padding: space.md, gap: 2 }}>
      <T variant="label" tone="mut">{label}</T>
      <T variant={big ? 'display' : 'h1'} style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
      {sub ? <T variant="small" tone={subTone}>{sub}</T> : null}
    </View>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{children}</View>;
}
