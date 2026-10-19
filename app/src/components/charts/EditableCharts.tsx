import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import type { ScrollLink } from '@/components/home/ReorderGrid';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SortableList } from '@/components/ui/SortableList';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { space } from '@/theme/tokens';

/**
 * A list of chart cards laid out the way the owner likes, Home screen style: Edit collapses the
 * cards to their titles, a handle drags one to a new place, ✕ removes it, Add opens the caller's
 * own sheet, and Reset goes back to the defaults. Every change is handed back through `onChange`
 * (the caller saves it). `toolbar` (a range picker) sits beside Edit while not editing.
 */
export function EditableCharts({
  ids, textOf, renderChart, cardRight, onChange, onAdd, onReset, resetText, toolbar, emptyText, scroll, onDragChange,
}: {
  ids: readonly string[];
  textOf: (id: string) => { label: string; subtitle?: string };
  renderChart: (id: string) => ReactNode;
  /** Extra controls in a card's header while not editing. */
  cardRight?: (id: string) => ReactNode;
  onChange: (next: string[]) => void;
  onAdd: () => void;
  /** Back to the defaults (after a confirm). */
  onReset: () => void;
  resetText?: string;
  toolbar?: ReactNode;
  emptyText?: string;
  scroll?: ScrollLink;
  onDragChange?: (dragging: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const remove = (id: string) => onChange(ids.filter((t) => t !== id));
  const move = (id: string, to: number) => {
    const next = ids.filter((t) => t !== id);
    next.splice(to, 0, id);
    onChange(next);
  };
  const reset = async () => {
    if (await confirm('Reset these charts?', resetText ?? 'The charts go back to the default set, in order.', 'Reset', true)) onReset();
  };

  const card = (id: string, handle: ReactNode) => {
    const { label, subtitle } = textOf(id);
    return (
      <Card
        title={label}
        subtitle={subtitle}
        right={editing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            {handle}
            <Pressable onPress={() => remove(id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${label}`}>
              <T tone="neg" weight="700">✕</T>
            </Pressable>
          </View>
        ) : cardRight?.(id)}>
        {editing ? null : renderChart(id)}
      </Card>
    );
  };

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 }}>
        <View style={{ flex: 1 }}>
          {editing ? <T variant="small" tone="mut">Drag a chart by its handle to move it; ✕ removes it.</T> : toolbar}
        </View>
        <Button title={editing ? 'Done' : 'Edit'} variant="ghost" small onPress={() => setEditing((e) => !e)} />
      </View>
      {editing ? (
        <SortableList
          keys={ids}
          itemLabel={(id) => textOf(id).label}
          onMove={move}
          onDragChange={onDragChange}
          scroll={scroll}
          renderItem={(id, { handle }) => card(id, handle)}
        />
      ) : (
        ids.map((id) => <View key={id}>{card(id, null)}</View>)
      )}
      {!ids.length && !editing ? <T tone="mut" align="center">{emptyText ?? 'No charts. Tap Edit, then Add a chart.'}</T> : null}
      {editing ? (
        <View style={{ gap: space.sm }}>
          <Button title="Add a chart" variant="secondary" onPress={onAdd} />
          <Button title="Reset to default" variant="ghost" small onPress={() => { void reset(); }} />
        </View>
      ) : (
        <Button title="Add a chart" variant="ghost" small onPress={() => { setEditing(true); onAdd(); }} />
      )}
    </View>
  );
}
