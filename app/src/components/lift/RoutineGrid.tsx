import { useState } from 'react';
import { Animated, Modal, Pressable, View, type LayoutRectangle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { RoutineGroup, RoutineWithStructure } from '@/api/lifting';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { groupRoutines, moveRoutine, type Section } from '@/lib/lifting/template';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const GAP = space.sm;
type Move = { id: string; group_id: string | null; position: number };
type Drag = { id: string; x: number; y: number; w: number; h: number };
const keyOf = (s: Section<RoutineWithStructure>) => s.group?.id ?? 'mine';
/** The card being dragged, for the gesture's callbacks (the `drag` state only draws it). One drag
 *  happens at a time, so one slot is enough. */
const live: { drag: Drag | null; x0: number; y0: number } = { drag: null, x0: 0, y0: 0 };
const setLive = (d: Drag | null, x0 = 0, y0 = 0) => { live.drag = d; live.x0 = x0; live.y0 = y0; };

/**
 * The routines as cards, two to a row, in the user's groups (then "My routines"). Each card has
 * Start and View; its handle drags it to another place or into another group. A group's name
 * collapses it, and its ⋯ renames or deletes it.
 */
export function RoutineGrid({ routines, groups, startDisabled, onStart, onView, onMove, onDragging, onRenameGroup, onDeleteGroup }: {
  routines: RoutineWithStructure[];
  groups: RoutineGroup[];
  startDisabled: boolean;
  onStart: (r: RoutineWithStructure) => void;
  onView: (r: RoutineWithStructure) => void;
  onMove: (moves: Move[]) => void;
  /** True while a card is being dragged, so the page can stop scrolling under the finger. */
  onDragging: (dragging: boolean) => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
}) {
  const { palette } = useTheme();
  const sections = groupRoutines(routines, groups);
  const [width, setWidth] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoutineGroup | null>(null);
  const [offset] = useState(() => new Animated.ValueXY());
  const begin = (d: Drag | null) => { setLive(d, live.x0, live.y0); setDrag(d); };
  // layouts within the grid: each section's box and where its cards start, and each card's box
  const [sectionBox] = useState(() => new Map<string, LayoutRectangle & { gridY: number }>());
  const [cardBox] = useState(() => new Map<string, LayoutRectangle>());
  // floored, with a pixel spare: a measured width can be rounded up (web), and two cards must fit a row
  const cardW = width ? Math.floor((width - GAP - 1) / 2) : 0;

  const at = (d: Drag, dx: number, dy: number) => ({ x: d.x + d.w / 2 + dx, y: d.y + d.h / 2 + dy });
  /** The section under a point, and where in it a drop lands. */
  const target = (p: { x: number; y: number }, id: string) => {
    let best: Section<RoutineWithStructure> | null = null;
    let bestDist = Infinity;
    for (const s of sections) {
      const b = sectionBox.get(keyOf(s));
      if (!b) continue;
      const dist = p.y < b.y ? b.y - p.y : p.y > b.y + b.height ? p.y - b.y - b.height : 0;
      if (dist < bestDist) { best = s; bestDist = dist; }
    }
    if (!best) return null;
    const b = sectionBox.get(keyOf(best))!;
    const rest = best.routines.filter((r) => r.id !== id);
    const rowH = (cardBox.get(id)?.height ?? 120) + GAP;
    const row = Math.max(0, Math.floor((p.y - b.y - b.gridY) / rowH));
    const index = collapsed.has(keyOf(best)) ? rest.length : Math.min(rest.length, row * 2 + (p.x < width / 2 ? 0 : 1));
    return { section: best, index };
  };

  const handle = (r: RoutineWithStructure, sectionKey: string) => Gesture.Pan()
    .runOnJS(true)
    .minDistance(4)
    // the touch-down point, before onDragging re-renders the grid and rebuilds this gesture
    .onBegin((e) => { setLive(null, e.absoluteX, e.absoluteY); onDragging(true); })
    .onStart(() => {
      const s = sectionBox.get(sectionKey);
      const c = cardBox.get(r.id);
      if (!s || !c) return;
      offset.setValue({ x: 0, y: 0 });
      // distances come from absolute positions: a re-render rebuilds the gesture mid-drag, and a
      // rebuilt gesture's own translation starts again from 0
      begin({ id: r.id, x: c.x, y: s.y + s.gridY + c.y, w: c.width, h: c.height });
    })
    .onUpdate((e) => {
      const dx = e.absoluteX - live.x0;
      const dy = e.absoluteY - live.y0;
      offset.setValue({ x: dx, y: dy });
      const d = live.drag;
      if (!d) return;
      const t = target(at(d, dx, dy), d.id);
      const k = t ? keyOf(t.section) : null;
      setHover((h) => (h === k ? h : k));
    })
    .onEnd((e) => {
      const d = live.drag;
      if (!d) return;
      const t = target(at(d, e.absoluteX - live.x0, e.absoluteY - live.y0), d.id);
      if (t) {
        const moves = moveRoutine(sections, d.id, t.section.group?.id ?? null, t.index);
        if (moves.length) onMove(moves);
      }
    })
    .onFinalize(() => {
      begin(null);
      setHover(null);
      onDragging(false);
    });

  const dragged = drag ? routines.find((r) => r.id === drag.id) : undefined;
  const toggle = (k: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const card = (r: RoutineWithStructure, sectionKey: string, ghost = false) => (
    <View
      key={ghost ? 'ghost' : r.id}
      onLayout={ghost ? undefined : (e) => cardBox.set(r.id, e.nativeEvent.layout)}
      style={{
        width: cardW, minHeight: 112, padding: space.md, gap: space.sm, justifyContent: 'space-between',
        backgroundColor: palette.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: ghost ? palette.accent : palette.hair,
        opacity: !ghost && drag?.id === r.id ? 0.35 : 1,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.xs }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="h3" numberOfLines={2}>{r.name}</T>
          <T variant="tiny" tone="mut">{r.routine_exercises.length} exercise{r.routine_exercises.length === 1 ? '' : 's'}</T>
        </View>
        {ghost ? <T tone="mut">⠿</T> : (
          <GestureDetector gesture={handle(r, sectionKey)}>
            <View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={`Move ${r.name}`}
              accessibilityHint="Drag to reorder, or into another group"
              hitSlop={10}
              style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, cursor: 'grab' } as never}>
              <T tone="mut" weight="700">⠿</T>
            </View>
          </GestureDetector>
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: space.xs }}>
        <Button title="Start" small disabled={startDisabled} onPress={() => onStart(r)} style={{ flex: 1, paddingHorizontal: space.sm }} />
        <Button title="View" small variant="secondary" onPress={() => onView(r)} style={{ flex: 1, paddingHorizontal: space.sm }} />
      </View>
    </View>
  );

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.md }}>
      {sections.map((s) => {
        const k = keyOf(s);
        // "My routines" only shows once there is something to tell apart from the groups
        if (!s.group && !s.routines.length && !(drag && groups.length)) return null;
        const shut = collapsed.has(k);
        return (
          <View
            key={k}
            onLayout={(e) => sectionBox.set(k, { ...e.nativeEvent.layout, gridY: sectionBox.get(k)?.gridY ?? 0 })}
            style={{ gap: space.sm, borderRadius: radius.md, padding: hover === k ? 4 : 0, margin: hover === k ? -4 : 0,
              backgroundColor: hover === k ? palette.accentSoft : 'transparent' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Pressable onPress={() => toggle(k)} accessibilityRole="button" accessibilityState={{ expanded: !shut }} hitSlop={6}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 32 }}>
                <T tone="mut" style={{ width: 14 }}>{shut ? '▸' : '▾'}</T>
                <T variant="label" tone="mut">{s.group?.name ?? 'My routines'}</T>
                <T variant="tiny" tone="mut">{s.routines.length}</T>
              </Pressable>
              {s.group ? (
                <Pressable onPress={() => setEditing(s.group as RoutineGroup)} accessibilityRole="button" accessibilityLabel={`${s.group.name} options`} hitSlop={10}>
                  <T tone="mut" weight="700">⋯</T>
                </Pressable>
              ) : null}
            </View>
            {shut ? null : (
              <View
                onLayout={(e) => { const b = sectionBox.get(k); sectionBox.set(k, { ...(b ?? e.nativeEvent.layout), gridY: e.nativeEvent.layout.y }); }}
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP, minHeight: s.routines.length ? undefined : 56 }}>
                {s.routines.length ? s.routines.map((r) => card(r, k)) : (
                  <View style={{ flex: 1, height: 56, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: palette.hair, alignItems: 'center', justifyContent: 'center' }}>
                    <T variant="small" tone="mut">Drag a routine here</T>
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}

      {drag && dragged ? (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', left: drag.x, top: drag.y, zIndex: 10, transform: offset.getTranslateTransform(),
          shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, elevation: 10 }}>
          {card(dragged, '', true)}
        </Animated.View>
      ) : null}

      <GroupEditor group={editing} onClose={() => setEditing(null)} onRename={onRenameGroup} onDelete={onDeleteGroup} />
    </View>
  );
}

/** Name a new group (group null and `creating`), or rename or delete one. */
export function GroupEditor({ group, creating = false, onClose, onRename, onDelete, onCreate }: {
  group: RoutineGroup | null;
  creating?: boolean;
  onClose: () => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
  onCreate?: (name: string) => void;
}) {
  const { palette } = useTheme();
  const visible = creating || !!group;
  const [name, setName] = useState('');
  const [shownFor, setShownFor] = useState<string | null>(null);
  // start from the group's name each time it opens (adjusting state during render)
  const key = visible ? (group?.id ?? 'new') : null;
  if (key !== shownFor) {
    setShownFor(key);
    setName(group?.name ?? '');
  }
  const ok = name.trim().length > 0 && name.trim().length <= 60;
  const save = () => {
    if (!ok) return;
    if (group) onRename?.(group.id, name.trim());
    else onCreate?.(name.trim());
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg }}>
        <Pressable onPress={() => undefined} accessible={false} aria-modal aria-label={group ? 'Edit group' : 'New group'}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, maxWidth: 420, width: '100%', alignSelf: 'center' }}>
          <T variant="h2">{group ? 'Edit group' : 'New group'}</T>
          <TextField label="Name" value={name} onChangeText={setName} placeholder="Push / Pull / Legs" autoFocus onSubmitEditing={save} maxLength={60} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title={group ? 'Save' : 'Create'} disabled={!ok} onPress={save} style={{ flex: 1 }} />
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
          </View>
          {group ? (
            <Button title="Delete group" variant="danger" small onPress={() => { onDelete?.(group.id); onClose(); }} />
          ) : null}
          {group ? <T variant="tiny" tone="mut" align="center">Deleting a group keeps its routines; they move to My routines.</T> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
