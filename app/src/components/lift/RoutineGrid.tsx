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
/** How long a finger rests on a card before it lifts; a shorter touch is a tap or a scroll. */
const HOLD_MS = 300;
type Move = { id: string; group_id: string | null; position: number };
type Drag = { id: string; x: number; y: number; w: number; h: number };
type Target = { section: Section<RoutineWithStructure>; index: number };
const keyOf = (s: Section<RoutineWithStructure>) => s.group?.id ?? 'mine';
/** The card being dragged, for the gesture's callbacks (the `drag` state only draws it). One drag
 *  happens at a time, so one slot is enough. */
const live: { drag: Drag | null; x0: number; y0: number; slot: string } = { drag: null, x0: 0, y0: 0, slot: '' };
const setLive = (d: Drag | null, x0 = 0, y0 = 0) => { live.drag = d; live.x0 = x0; live.y0 = y0; };
/** The slot the other cards have made room for ("section:index"), so a drag only re-animates on a change. */
const setSlot = (slot: string) => { live.slot = slot; };

/**
 * The routines as cards, two to a row, in the user's groups (then "My routines"). Each card has
 * Start and View. Holding a card (anywhere on it) lifts it; dragging it moves it to another place
 * or into another group, the other cards sliding aside to show where it will land. A group's name
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
  // 0 at rest, 1 once lifted: the card grows a little and takes a shadow
  const [lift] = useState(() => new Animated.Value(0));
  // where each card has slid to make room, while a drag is on
  const [slide] = useState(() => new Map<string, Animated.ValueXY>());
  const slideOf = (id: string) => {
    let v = slide.get(id);
    if (!v) { v = new Animated.ValueXY(); slide.set(id, v); }
    return v;
  };
  const begin = (d: Drag | null) => { setLive(d, live.x0, live.y0); setDrag(d); };
  // layouts within the grid: each section's box and where its cards start, and each card's box
  const [sectionBox] = useState(() => new Map<string, LayoutRectangle & { gridY: number }>());
  const [cardBox] = useState(() => new Map<string, LayoutRectangle>());
  // floored, with a pixel spare: a measured width can be rounded up (web), and two cards must fit a row
  const cardW = width ? Math.floor((width - GAP - 1) / 2) : 0;

  const at = (d: Drag, dx: number, dy: number) => ({ x: d.x + d.w / 2 + dx, y: d.y + d.h / 2 + dy });

  /** Slide the other cards into the places they would take if the card dropped at `t` now. */
  const makeRoom = (t: Target | null, dragId: string) => {
    const slot = t ? `${keyOf(t.section)}:${t.index}` : '';
    if (slot === live.slot) return;
    setSlot(slot);
    const rowH = (cardBox.get(dragId)?.height ?? 120) + GAP;
    const pos = (i: number) => ({ x: (i % 2) * (cardW + GAP), y: Math.floor(i / 2) * rowH });
    for (const s of sections) {
      const rest = s.routines.filter((r) => r.id !== dragId);
      // the section's cards as they would stand: the hole where the card would land, the gap it left closed
      const order: (RoutineWithStructure | null)[] = t && keyOf(t.section) === keyOf(s)
        ? [...rest.slice(0, t.index), null, ...rest.slice(t.index)]
        : rest;
      s.routines.forEach((r, from) => {
        if (r.id === dragId) return;
        const to = order.findIndex((x) => x?.id === r.id);
        const a = pos(from);
        const b = pos(to < 0 ? from : to);
        Animated.spring(slideOf(r.id), { toValue: { x: b.x - a.x, y: b.y - a.y }, useNativeDriver: false, speed: 24, bounciness: 3 }).start();
      });
    }
  };
  const settle = () => {
    setSlot('');
    for (const v of slide.values()) v.setValue({ x: 0, y: 0 });
  };

  /** The section under a point, and where in it a drop lands. */
  const target = (p: { x: number; y: number }, id: string): Target | null => {
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

  /** A hold on the card lifts it; a shorter touch is a tap (Start, View) or scrolls the page. */
  const hold = (r: RoutineWithStructure, sectionKey: string) => Gesture.Pan()
    .runOnJS(true)
    .activateAfterLongPress(HOLD_MS)
    // the touch-down point, before onDragging re-renders the grid and rebuilds this gesture
    .onBegin((e) => { setLive(null, e.absoluteX, e.absoluteY); })
    .onStart((e) => {
      const s = sectionBox.get(sectionKey);
      const c = cardBox.get(r.id);
      if (!s || !c) return;
      // the finger may have crept a little during the hold: the card starts under it
      const dx = e.absoluteX - live.x0;
      const dy = e.absoluteY - live.y0;
      offset.setValue({ x: dx, y: dy });
      lift.setValue(0);
      Animated.spring(lift, { toValue: 1, useNativeDriver: false, speed: 30, bounciness: 6 }).start();
      // distances come from absolute positions: a re-render rebuilds the gesture mid-drag, and a
      // rebuilt gesture's own translation starts again from 0
      const d: Drag = { id: r.id, x: c.x, y: s.y + s.gridY + c.y, w: c.width, h: c.height };
      begin(d);
      onDragging(true);
      makeRoom(target(at(d, dx, dy), d.id), d.id);
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
      makeRoom(t, d.id);
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
      if (!live.drag) return;   // a tap or a scroll: nothing was lifted
      begin(null);
      setHover(null);
      settle();
      onDragging(false);
    });

  const dragged = drag ? routines.find((r) => r.id === drag.id) : undefined;
  const toggle = (k: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const cardBody = (r: RoutineWithStructure, ghost: boolean) => (
    <View
      accessibilityHint={ghost ? undefined : 'Hold and drag to move it, or into another group'}
      style={{
        width: cardW, minHeight: 112, padding: space.md, gap: space.sm, justifyContent: 'space-between',
        backgroundColor: palette.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: ghost ? palette.accent : palette.hair,
        // the lifted card is drawn by the ghost; its place in the grid stays as the hole it will drop back into
        opacity: !ghost && drag?.id === r.id ? 0 : 1,
        cursor: ghost ? undefined : 'grab',
      } as never}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.xs }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="h3" numberOfLines={2}>{r.name}</T>
          <T variant="tiny" tone="mut">{r.routine_exercises.length} exercise{r.routine_exercises.length === 1 ? '' : 's'}</T>
        </View>
        <T tone="mut" weight="700" accessible={false} importantForAccessibility="no">⠿</T>
      </View>
      <View style={{ flexDirection: 'row', gap: space.xs }}>
        <Button title="Start" small disabled={startDisabled} onPress={() => onStart(r)} style={{ flex: 1, paddingHorizontal: space.sm }} />
        <Button title="View" small variant="secondary" onPress={() => onView(r)} style={{ flex: 1, paddingHorizontal: space.sm }} />
      </View>
    </View>
  );

  /** A card in the grid: the whole card takes the hold, and slides aside while another is dragged. */
  const card = (r: RoutineWithStructure, sectionKey: string) => (
    <Animated.View
      key={r.id}
      // measured at rest: a card that has slid aside keeps the box of its own slot
      onLayout={(e) => { if (!live.drag) cardBox.set(r.id, e.nativeEvent.layout); }}
      style={{ transform: slideOf(r.id).getTranslateTransform() }}>
      <GestureDetector gesture={hold(r, sectionKey)}>
        {cardBody(r, false)}
      </GestureDetector>
    </Animated.View>
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
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', left: drag.x, top: drag.y, zIndex: 10,
            transform: [...offset.getTranslateTransform(), { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }],
            shadowColor: '#000', shadowOpacity: lift.interpolate({ inputRange: [0, 1], outputRange: [0, 0.3] }), shadowRadius: 12, elevation: 10,
          }}>
          {cardBody(dragged, true)}
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
