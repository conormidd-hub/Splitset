import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import { Pressable, useWindowDimensions } from 'react-native';

import { MetricTile, TILE_HEIGHT } from './MetricTile';
import { ReorderGrid, type ScrollLink } from './ReorderGrid';
import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import { METRICS, snapshot, type MetricId, type MetricInputs } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  ids: MetricId[];
  inputs: MetricInputs;
  editing: boolean;
  onReorder: (ids: MetricId[]) => void;
  onRemove: (id: MetricId) => void;
  onAdd: () => void;
  onDragChange: (dragging: boolean) => void;
  scroll?: ScrollLink;
};

/** The At a glance tiles: two across on a phone, three on a wide screen, reorderable while editing. */
export function GlanceGrid({ ids, inputs, editing, onReorder, onRemove, onAdd, onDragChange, scroll }: Props) {
  const { width: windowW } = useWindowDimensions();
  const snaps = useMemo(() => new Map(ids.map((id) => [id, snapshot(id, inputs)] as const)), [ids, inputs]);
  const snap = (id: MetricId) => snaps.get(id) ?? snapshot(id, inputs);

  if (!ids.length && !editing) {
    return <DashedTile tall label="Add to At a glance" hint="Pick the numbers you want to see every day." onPress={onAdd} />;
  }

  return (
    <ReorderGrid
      keys={ids}
      editing={editing}
      tileHeight={TILE_HEIGHT}
      initialWidth={windowW - 2 * space.lg}
      renderTile={(id, ctx) => <MetricTile snapshot={snap(id)} editing={ctx.editing} lifted={ctx.lifted} onRemove={() => onRemove(id)} />}
      tileLabel={(id) => { const s = snap(id); return [METRICS[id].label, s.text, s.unit].filter(Boolean).join(' '); }}
      onPress={(id) => router.push((snap(id).href ?? `/metric/${id}`) as Href, { withAnchor: true })}
      onReorder={onReorder}
      onDragChange={onDragChange}
      scroll={scroll}
      trailing={editing ? <DashedTile label="Add" onPress={onAdd} /> : undefined}
    />
  );
}

/** The "+ Add" cell at the end of the grid, and the empty state when nothing is chosen yet. */
function DashedTile({ label, hint, tall, onPress }: { label: string; hint?: string; tall?: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: tall ? undefined : 1, minHeight: tall ? TILE_HEIGHT : undefined,
        borderWidth: 1.5, borderStyle: 'dashed', borderColor: palette.accentLine, borderRadius: radius.md,
        alignItems: 'center', justifyContent: 'center', gap: 4, padding: space.md,
        opacity: pressed ? 0.7 : 1,
      })}>
      <SymbolView name={ICONS.plus} tintColor={palette.accent} size={22} />
      <T variant="small" tone="accent" weight="700">{label}</T>
      {hint ? <T variant="small" tone="mut" align="center">{hint}</T> : null}
    </Pressable>
  );
}
