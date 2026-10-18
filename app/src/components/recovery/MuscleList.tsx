import { Pressable, View } from 'react-native';

import { T } from '@/components/ui/T';
import { listLine, listRows, type FigureTheme, type ListState, type MapMode } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  map: Readonly<Record<MuscleId, ListState>>;
  mode: MapMode;
  theme: FigureTheme;
  nameOf: (id: MuscleId) => string;
  onSelect?: (muscle: MuscleId) => void;
  /** Two lines a row, the numbers under the name, for a phone (listCompact). */
  compact?: boolean;
};

/**
 * The figure as text (spec §10's list view): every muscle with its level, F (or L), trainable in
 * and ready in, highest first, Ready ones last. Rows open the same detail sheet as the figure.
 * Wide, the numbers are columns; compact, they sit on a second line so the name always fits.
 */
export function MuscleList({ map, mode, theme, nameOf, onSelect, compact = false }: Props) {
  const { palette } = useTheme();
  const session = mode === 'session';
  const cols = { value: 48, level: 78, time: 72 } as const;
  const symbol = session ? 'L' : 'F';
  const swatch = (muscle: MuscleId) => (
    <View style={{ width: 12, height: 12, borderRadius: 3, flexShrink: 0, backgroundColor: theme === 'dark' ? map[muscle].fill_dark : map[muscle].fill }} />
  );
  return (
    <View accessibilityLabel="Muscles, highest first">
      <View style={{ flexDirection: 'row', paddingVertical: space.sm, borderBottomWidth: 1, borderColor: palette.hair, gap: space.sm }}>
        <T variant="tiny" tone="mut" weight="700" style={{ flex: 1 }}>Muscle</T>
        {compact ? (
          <T variant="tiny" tone="mut" weight="700">Level</T>
        ) : (
          <>
            <T variant="tiny" tone="mut" weight="700" align="right" style={{ width: cols.value }}>{symbol}</T>
            <T variant="tiny" tone="mut" weight="700" style={{ width: cols.level }}>Level</T>
            <T variant="tiny" tone="mut" weight="700" align="right" style={{ width: cols.time }}>{session ? 'Trainable after' : 'Trainable in'}</T>
            <T variant="tiny" tone="mut" weight="700" align="right" style={{ width: cols.time }}>{session ? 'Ready after' : 'Ready in'}</T>
          </>
        )}
      </View>
      {listRows(map, mode).map((r) => (
        <Pressable
          key={r.muscle}
          onPress={onSelect ? () => onSelect(r.muscle) : undefined}
          accessibilityRole={onSelect ? 'button' : undefined}
          accessibilityLabel={`${nameOf(r.muscle)}: ${r.label}, ${listLine(r, mode, ', ')}`}
          style={({ pressed }) => ({
            flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: compact ? 2 : space.sm,
            paddingVertical: 10, borderBottomWidth: 1, borderColor: palette.hair, opacity: pressed ? 0.6 : 1,
          })}>
          {compact ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                {swatch(r.muscle)}
                <T variant="small" numberOfLines={1} style={{ flex: 1 }}>{nameOf(r.muscle)}</T>
                <T variant="small" tone={r.level ? 'ink' : 'mut'}>{r.label}</T>
              </View>
              <T variant="tiny" tone="ink2" style={{ marginLeft: 12 + space.sm, fontVariant: ['tabular-nums'] }}>
                {listLine(r, mode)}
              </T>
            </>
          ) : (
            <>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                {swatch(r.muscle)}
                <T variant="small" numberOfLines={1} style={{ flex: 1 }}>{nameOf(r.muscle)}</T>
              </View>
              <T variant="small" align="right" style={{ width: cols.value, fontVariant: ['tabular-nums'] }}>{r.value.toFixed(2)}</T>
              <T variant="small" tone={r.level ? 'ink' : 'mut'} style={{ width: cols.level }}>{r.label}</T>
              <T variant="small" tone="ink2" align="right" style={{ width: cols.time }}>{r.trainable}</T>
              <T variant="small" tone="ink2" align="right" style={{ width: cols.time }}>{r.ready}</T>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
}
