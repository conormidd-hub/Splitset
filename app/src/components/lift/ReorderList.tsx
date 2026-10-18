import { useState } from 'react';
import { Animated, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const ROW_H = 52;
const GAP = space.xs;
const STEP = ROW_H + GAP;

/** Where a row dragged by dy from `from` lands among n rows. */
export function dropIndex(from: number, dy: number, n: number): number {
  return Math.max(0, Math.min(n - 1, from + Math.round(dy / STEP)));
}

/** The row being dragged and where the pointer went down, for the gesture's callbacks; one drag
 *  at a time. The distance is worked out from absolute positions: the gesture is rebuilt when the
 *  list re-renders mid-drag, and a rebuilt gesture's own translation starts again from 0. */
const live = { from: -1, y0: 0, dy: 0 };
const setLive = (from: number, y0 = 0) => { live.from = from; live.y0 = y0; live.dy = 0; };
const moveLive = (y: number) => { live.dy = y - live.y0; return live.dy; };

/**
 * The workout's exercises collapsed to their names, for moving them: drag a row up or down and
 * drop it, then Done. Screen readers move a row with the adjustable actions instead.
 */
export function ReorderList({ items, onMove, onDragging, onDone }: {
  items: { id: string; name: string; sets: number }[];
  onMove: (id: string, toIndex: number) => void;
  onDragging: (dragging: boolean) => void;
  onDone: () => void;
}) {
  const { palette } = useTheme();
  const [dy] = useState(() => new Animated.Value(0));
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const pan = (i: number) => Gesture.Pan()
    .runOnJS(true)
    .minDistance(2)
    // the touch-down point, before onDragging re-renders the list and rebuilds this gesture
    .onBegin((e) => { setLive(i, e.absoluteY); onDragging(true); })
    .onStart(() => {
      dy.setValue(0);
      setDragging(i);
      setOver(i);
    })
    .onUpdate((e) => {
      const d = moveLive(e.absoluteY);
      dy.setValue(d);
      const to = dropIndex(live.from, d, items.length);
      setOver((o) => (o === to ? o : to));
    })
    .onEnd((e) => {
      const from = live.from;
      if (from < 0) return;
      const to = dropIndex(from, moveLive(e.absoluteY), items.length);
      if (to !== from) onMove(items[from].id, to);
    })
    .onFinalize(() => {
      setLive(-1);
      setDragging(null);
      setOver(null);
      onDragging(false);
    });

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <T variant="h3" style={{ flex: 1 }}>Reorder exercises</T>
        <Button title="Done" small onPress={onDone} />
      </View>
      <T variant="small" tone="mut">Drag an exercise up or down, then tap Done.</T>
      <View style={{ gap: GAP }}>
        {items.map((it, i) => {
          const isDragged = dragging === i;
          // the drop line sits above the row it lands before, or below the last row
          const lineAbove = dragging != null && over === i && over < dragging;
          const lineBelow = dragging != null && over === i && over > dragging;
          return (
            <GestureDetector key={it.id} gesture={pan(i)}>
              <Animated.View
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={`${it.name}, ${i + 1} of ${items.length}`}
                accessibilityHint="Drag up or down to move it"
                accessibilityActions={[{ name: 'increment', label: 'Move down' }, { name: 'decrement', label: 'Move up' }]}
                onAccessibilityAction={(e) => {
                  if (e.nativeEvent.actionName === 'increment' && i < items.length - 1) onMove(it.id, i + 1);
                  if (e.nativeEvent.actionName === 'decrement' && i > 0) onMove(it.id, i - 1);
                }}
                style={{
                  height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md,
                  borderRadius: radius.md, backgroundColor: isDragged ? palette.accentSoft : palette.surface,
                  borderWidth: 1, borderColor: isDragged ? palette.accent : palette.hair,
                  borderTopWidth: lineAbove ? 3 : 1, borderTopColor: lineAbove ? palette.accent : isDragged ? palette.accent : palette.hair,
                  borderBottomWidth: lineBelow ? 3 : 1, borderBottomColor: lineBelow ? palette.accent : isDragged ? palette.accent : palette.hair,
                  zIndex: isDragged ? 10 : 0,
                  transform: isDragged ? [{ translateY: dy }] : [],
                  cursor: 'grab',
                } as never}>
                <T tone="mut" weight="700">≡</T>
                <T weight="600" numberOfLines={1} style={{ flex: 1 }}>{it.name}</T>
                <T variant="small" tone="mut">{it.sets} set{it.sets === 1 ? '' : 's'}</T>
              </Animated.View>
            </GestureDetector>
          );
        })}
      </View>
    </View>
  );
}
