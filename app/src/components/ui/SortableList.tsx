import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, useWindowDimensions, View, type AccessibilityActionEvent, type LayoutRectangle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { ScrollLink } from '@/components/home/ReorderGrid';
import { T } from '@/components/ui/T';
import { dropSlot, makeRoom } from '@/lib/sortable';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** Within this many pixels of the top or bottom of the window a drag scrolls the page. */
const EDGE = 96;
const SCROLL_STEP = 14;
const SLIDE_MS = 150;

type Drag<K> = { key: K; from: number; to: number; y0: number; scrollAt: number; pointerY: number };

type Props<K extends string> = {
  keys: readonly K[];
  gap?: number;
  /** One item. `handle` is the ≡ grip to place in it (its header); `lifted` while it's dragged. */
  renderItem: (key: K, ctx: { handle: ReactNode; lifted: boolean }) => ReactNode;
  /** What the handle says to assistive tech ("Back squat"). */
  itemLabel: (key: K) => string;
  /** The item's new place, after a drop or a screen-reader nudge, only when it moved. */
  onMove: (key: K, toIndex: number) => void;
  /** While an item is lifted the page should stop scrolling on its own. */
  onDragChange?: (dragging: boolean) => void;
  scroll?: ScrollLink;
};

/**
 * A vertical list whose items (cards of any height) are reordered by holding the ≡ handle and
 * dragging. The others slide aside to show where it will land, and near the top or bottom of the
 * window the page scrolls under the finger. Items are only moved with transforms while a finger is
 * down, never reordered (a browser drops its pointer capture when the captured element moves in the
 * DOM); the new order is handed back on the drop. Screen readers move an item with the handle's
 * two actions.
 */
export function SortableList<K extends string>({ keys, gap = space.md, renderItem, itemLabel, onMove, onDragChange, scroll }: Props<K>) {
  const { height: windowH } = useWindowDimensions();
  const [lifted, setLifted] = useState<K | null>(null);
  const boxes = useRef(new Map<K, LayoutRectangle>());
  const drag = useRef<Drag<K> | null>(null);
  const begun = useRef<{ key: K; y: number } | null>(null);
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  // each item's offset while a drag is on; a Map in state so render may read it
  const [offsets] = useState(() => new Map<K, Animated.Value>());
  for (const k of keys) if (!offsets.has(k)) offsets.set(k, new Animated.Value(0));

  useEffect(() => () => { if (autoScroll.current) clearInterval(autoScroll.current); }, []);

  const boxList = () => keys.map((k) => boxes.current.get(k) ?? { x: 0, y: 0, width: 0, height: 0 });

  /** Follow the finger, and slide the others aside when the landing place changes. */
  const place = () => {
    const d = drag.current;
    if (!d) return;
    const delta = d.pointerY - d.y0 + ((scroll?.y.current ?? 0) - d.scrollAt);
    offsets.get(d.key)?.setValue(delta);
    const list = boxList();
    const to = dropSlot(list, d.from, delta);
    if (to === d.to) return;
    d.to = to;
    const size = (list[d.from]?.height ?? 0) + gap;
    keys.forEach((k, i) => {
      if (k === d.key) return;
      const v = offsets.get(k);
      if (v) Animated.timing(v, { toValue: makeRoom(i, d.from, to, size), duration: SLIDE_MS, useNativeDriver: false }).start();
    });
  };

  const stopAutoScroll = () => {
    if (autoScroll.current) clearInterval(autoScroll.current);
    autoScroll.current = null;
  };

  const edgeScroll = (absoluteY: number) => {
    if (!scroll) return;
    const dir = absoluteY < EDGE ? -1 : absoluteY > windowH - EDGE ? 1 : 0;
    if (dir && !autoScroll.current) {
      autoScroll.current = setInterval(() => {
        // the offset comes back through onScroll, so a page that can't go further stays put
        const y = Math.max(0, (scroll.y.current ?? 0) + dir * SCROLL_STEP);
        scroll.ref.current?.scrollTo({ y, animated: false });
        place();
      }, 16);
    } else if (!dir) stopAutoScroll();
  };

  // the touch-down point: by the time the pan starts the item may have re-rendered
  const begin = (key: K, absoluteY: number) => { begun.current = { key, y: absoluteY }; };

  const start = (key: K, absoluteY: number) => {
    const from = keys.indexOf(key);
    if (from < 0) return;
    const y0 = begun.current?.key === key ? begun.current.y : absoluteY;
    drag.current = { key, from, to: from, y0, scrollAt: scroll?.y.current ?? 0, pointerY: absoluteY };
    setLifted(key);
    onDragChange?.(true);
    place();
  };

  const update = (absoluteY: number) => {
    const d = drag.current;
    if (!d) return;
    d.pointerY = absoluteY;
    place();
    edgeScroll(absoluteY);
  };

  const end = (ok: boolean) => {
    stopAutoScroll();
    begun.current = null;
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    for (const v of offsets.values()) v.setValue(0);
    setLifted(null);
    onDragChange?.(false);
    if (ok && d.to !== d.from) onMove(d.key, d.to);
  };

  const nudge = (key: K, dir: -1 | 1) => {
    const from = keys.indexOf(key);
    const to = from + dir;
    if (from >= 0 && to >= 0 && to < keys.length) onMove(key, to);
  };

  return (
    <View style={{ gap }}>
      {keys.map((k, i) => (
        <Animated.View
          key={k}
          onLayout={(e) => { if (!drag.current) boxes.current.set(k, e.nativeEvent.layout); }}
          style={{
            zIndex: lifted === k ? 10 : 0,
            transform: [{ translateY: offsets.get(k) ?? 0 }, { scale: lifted === k ? 1.02 : 1 }],
            ...(lifted === k ? { boxShadow: '0 8px 20px rgba(0, 0, 0, 0.3)', borderRadius: radius.lg } : null),
          }}>
          {renderItem(k, {
            lifted: lifted === k,
            handle: (
              <Handle k={k} label={itemLabel(k)} first={i === 0} last={i === keys.length - 1}
                onBegin={begin} onStart={start} onUpdate={update} onEnd={end} onNudge={nudge} />
            ),
          })}
        </Animated.View>
      ))}
    </View>
  );
}

/** The ≡ grip. Only it takes the pan, so a swipe anywhere else on a card still scrolls the page. */
function Handle<K extends string>({ k, label, first, last, onBegin, onStart, onUpdate, onEnd, onNudge }: {
  k: K; label: string; first: boolean; last: boolean;
  onBegin: (key: K, y: number) => void; onStart: (key: K, y: number) => void; onUpdate: (y: number) => void;
  onEnd: (ok: boolean) => void; onNudge: (key: K, dir: -1 | 1) => void;
}) {
  const { palette } = useTheme();
  const pan = Gesture.Pan()
    .minDistance(2)
    .runOnJS(true)
    .onBegin((e) => onBegin(k, e.absoluteY))
    .onStart((e) => onStart(k, e.absoluteY))
    .onUpdate((e) => onUpdate(e.absoluteY))
    .onEnd((_e, ok) => onEnd(ok))
    .onFinalize(() => onEnd(false));
  const actions = [
    ...(first ? [] : [{ name: 'moveUp', label: 'Move up' }]),
    ...(last ? [] : [{ name: 'moveDown', label: 'Move down' }]),
  ];
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'moveUp') onNudge(k, -1);
    else if (e.nativeEvent.actionName === 'moveDown') onNudge(k, 1);
  };
  return (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Move ${label}`}
        accessibilityHint="Hold and drag to move it"
        accessibilityActions={actions}
        onAccessibilityAction={onAction}
        hitSlop={8}
        style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
          backgroundColor: palette.surface2, cursor: 'grab' } as never}>
        <T tone="mut" weight="700">≡</T>
      </View>
    </GestureDetector>
  );
}
