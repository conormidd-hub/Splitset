import { router, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { T } from '@/components/ui/T';
import { PERIODS } from '@/lib/pbs';
import { useTheme } from '@/theme/ThemeProvider';
import { radius } from '@/theme/tokens';

export type PbCell = { value: string; sub?: string };
export type PbRow = {
  key: string;
  label: string;
  /** Month, year, all time. */
  cells: [PbCell, PbCell, PbCell];
  /** The all-time best was set this month. */
  isNew?: boolean;
  /** Draw attention to this row, e.g. the rep range being lifted right now. */
  highlight?: boolean;
  href?: Href;
};

/** PBs as rows against Month / Year / All time columns. The all-time column is always shown. */
export function PbTable({ rows, compact }: { rows: PbRow[]; compact?: boolean }) {
  const { palette } = useTheme();
  const labelWidth = compact ? 56 : 72;
  return (
    <View>
      <View style={{ flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: palette.hair }}>
        <View style={{ width: labelWidth }} />
        {PERIODS.map((p) => (
          <T key={p.value} variant="label" tone="mut" style={{ flex: 1, textAlign: 'right' }}>{p.label}</T>
        ))}
      </View>
      {rows.map((r) => {
        const body = (
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', paddingVertical: compact ? 6 : 8, paddingHorizontal: r.highlight ? 6 : 0,
              marginHorizontal: r.highlight ? -6 : 0, borderRadius: radius.sm,
              backgroundColor: r.highlight ? palette.accentSoft : 'transparent',
            }}>
            <View style={{ width: labelWidth }}>
              <T variant="small" weight="700" tone={r.highlight ? 'accent' : 'ink'}>{r.label}</T>
              {r.isNew ? <T variant="tiny" weight="700" style={{ color: palette.amber }}>NEW PB</T> : null}
            </View>
            {r.cells.map((c, i) => (
              <View key={i} style={{ flex: 1, alignItems: 'flex-end' }}>
                <T
                  variant={i === 2 ? 'body' : 'small'}
                  weight={i === 2 ? '700' : '500'}
                  tone={c.value === '–' ? 'mut' : i === 2 ? 'ink' : 'ink2'}
                  style={{ fontVariant: ['tabular-nums'] }}>
                  {c.value}
                </T>
                {c.sub && !compact ? <T variant="tiny" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{c.sub}</T> : null}
              </View>
            ))}
          </View>
        );
        return r.href ? (
          <Pressable key={r.key} onPress={() => router.push(r.href!, { withAnchor: true })} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
            {body}
          </Pressable>
        ) : (
          <View key={r.key}>{body}</View>
        );
      })}
    </View>
  );
}
