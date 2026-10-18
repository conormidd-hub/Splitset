import { Pressable, View } from 'react-native';

import { T } from '@/components/ui/T';
import { listRows, type FigureTheme, type ListState, type MapMode } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  map: Readonly<Record<MuscleId, ListState>>;
  mode: MapMode;
  theme: FigureTheme;
  nameOf: (id: MuscleId) => string;
  onSelect?: (muscle: MuscleId) => void;
};

/**
 * The figure as text (spec §10's list view): every muscle with its level, F (or L), trainable in
 * and ready in, highest first, Ready ones last. Rows open the same detail sheet as the figure.
 */
export function MuscleList({ map, mode, theme, nameOf, onSelect }: Props) {
  const { palette } = useTheme();
  const session = mode === 'session';
  const cols = { value: 48, level: 78, time: 72 } as const;
  return (
    <View accessibilityLabel="Muscles, highest first">
      <View style={{ flexDirection: 'row', paddingVertical: space.sm, borderBottomWidth: 1, borderColor: palette.hair, gap: space.sm }}>
        <T variant="tiny" tone="mut" weight="700" style={{ flex: 1 }}>Muscle</T>
        <T variant="tiny" tone="mut" weight="700" align="right" style={{ width: cols.value }}>{session ? 'L' : 'F'}</T>
        <T variant="tiny" tone="mut" weight="700" style={{ width: cols.level }}>Level</T>
        <T variant="tiny" tone="mut" weight="700" align="right" style={{ width: cols.time }}>{session ? 'Trainable after' : 'Trainable in'}</T>
        <T variant="tiny" tone="mut" weight="700" align="right" style={{ width: cols.time }}>{session ? 'Ready after' : 'Ready in'}</T>
      </View>
      {listRows(map, mode).map((r) => (
        <Pressable
          key={r.muscle}
          onPress={onSelect ? () => onSelect(r.muscle) : undefined}
          accessibilityRole={onSelect ? 'button' : undefined}
          accessibilityLabel={`${nameOf(r.muscle)}: ${r.label}, ${session ? 'L' : 'F'} ${r.value.toFixed(2)}, trainable ${r.trainable}, ready ${r.ready}`}
          style={({ pressed }) => ({
            flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 10,
            borderBottomWidth: 1, borderColor: palette.hair, opacity: pressed ? 0.6 : 1,
          })}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: theme === 'dark' ? map[r.muscle].fill_dark : map[r.muscle].fill }} />
            <T variant="small" numberOfLines={1} style={{ flex: 1 }}>{nameOf(r.muscle)}</T>
          </View>
          <T variant="small" align="right" style={{ width: cols.value, fontVariant: ['tabular-nums'] }}>{r.value.toFixed(2)}</T>
          <T variant="small" tone={r.level ? 'ink' : 'mut'} style={{ width: cols.level }}>{r.label}</T>
          <T variant="small" tone="ink2" align="right" style={{ width: cols.time }}>{r.trainable}</T>
          <T variant="small" tone="ink2" align="right" style={{ width: cols.time }}>{r.ready}</T>
        </Pressable>
      ))}
    </View>
  );
}
