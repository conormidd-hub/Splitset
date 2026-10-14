import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Animated, Pressable, useWindowDimensions, View, type AccessibilityActionEvent, type LayoutChangeEvent, type ScrollView } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { radius, space } from '@/theme/tokens';

export type TileContext = { width: number; height: number; editing: boolean; lifted: boolean };

/** The page's scroll view and its current offset, so a drag near the edge can scroll it. */
export type ScrollLink = { ref: RefObject<ScrollView | null>; y: RefObject<number> };

type Props<K extends string> = {
  keys: readonly K[];
  editing: boolean;
  tileHeight: number;
  gap?: number;
  /** How many across for a given width; two by default, three from 640 px. */
  columns?: (width: number) => number;
  /** A guess at the width for the first frame, before onLayout has spoken. */
  initialWidth?: number;
  renderTile: (key: K, ctx: TileContext) => ReactNode;
  /** What assistive tech reads for a tile. */
  tileLabel: (key: K) => string;
  /** A plain tap outside edit mode. */
  onPress?: (key: K) => void;
  /** The order after a drop or a keyboard nudge, only when it changed. */
  onReorder: (keys: K[]) => void;
  /** While a tile is lifted the page should stop scrolling on its own. */
  onDragChange?: (dragging: boolean) => void;
  /** One last cell outside the order (an Add tile), sized like the others. */
  trailing?: ReactNode;
  scroll?: ScrollLink;
};

/** The gesture fields the grid reads; the real event has many more. */
type PanEvent = { x: number; y: number; absoluteX: number; absoluteY: number };

/** The drag handle is the tile's top-right corner, where the grip glyph sits. */
const HANDLE = 44;
const SLIDE_MS = 180;
/** Within this many pixels of the top or bottom of the window a drag scrolls the page. */
const EDGE = 72;
const SCROLL_STEP = 12;
const defaultColumns = (w: number) => (w >= 640 ? 3 : 2);

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

type Drag<K> = { key: K; before: K[]; grabX: number; grabY: number; scrollAt: number; pointer: { x: number; y: number } };

/**
 * A uniform grid of equal cells that can be reordered by dragging a tile by its handle, Garmin's
 * "Edit Home" way. Every cell is the same size, so the drop slot is arithmetic on the pointer and
 * nothing is measured but the grid's own origin. Each tile is laid out absolutely at its slot and
 * slides there when the order changes; the children themselves are never re-ordered while a
 * finger is down, because a browser drops its pointer capture when the captured element moves in
 * the DOM, which would cancel the drag. Works with a mouse under react-native-web and with touch.
 */
export function ReorderGrid<K extends string>({
  keys, editing, tileHeight, gap = space.sm, columns = defaultColumns, initialWidth = 0,
  renderTile, tileLabel, onPress, onReorder, onDragChange, trailing, scroll,
}: Props<K>) {
  const { height: windowH } = useWindowDimensions();
  const [width, setWidth] = useState(initialWidth);
  const cols = Math.max(1, columns(width));
  const cellW = width > 0 ? Math.floor((width - gap * (cols - 1)) / cols) : 0;
  const stepX = cellW + gap;
  const stepY = tileHeight + gap;

  // the order on screen: state for React, a ref for the gesture callbacks between renders
  const [order, setOrder] = useState<K[]>(() => [...keys]);
  const orderRef = useRef<K[]>(order);
  const [lifted, setLifted] = useState<K | null>(null);
  const drag = useRef<Drag<K> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<View>(null);
  const [ghost] = useState(() => new Animated.ValueXY());
  // where each tile is drawn, born at its slot so nothing flashes in the corner on the first
  // frame; a Map held in state so render may read it. Tiles that arrive later are added when
  // the parent's keys change, which re-renders anyway
  const [positions] = useState(() => new Map<K, Animated.ValueXY>(keys.map((k, i) => [k, new Animated.ValueXY({ x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY })])));
  // false until the first layout has placed every tile, so the grid does not slide into place
  const settled = useRef(false);

  const setLive = (next: K[]) => {
    orderRef.current = next;
    setOrder(next);
  };

  useEffect(() => {
    // the parent's order wins whenever no drag is in flight (a save landed, a tile came or went)
    if (!drag.current && !sameOrder(orderRef.current, keys)) {
      keys.forEach((k, i) => {
        if (!positions.has(k)) positions.set(k, new Animated.ValueXY({ x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY }));
      });
      orderRef.current = [...keys];
      setOrder(orderRef.current);
    }
  }, [keys, positions, cols, stepX, stepY]);

  // slide every tile to its slot whenever the order or the geometry changes; the first layout
  // places them without a slide
  useEffect(() => {
    if (cellW <= 0) return;
    const live = new Set(order);
    for (const k of [...positions.keys()]) if (!live.has(k)) positions.delete(k);
    order.forEach((k, i) => {
      const v = positions.get(k);
      if (!v) return;
      const to = { x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY };
      if (!settled.current) v.setValue(to);
      else Animated.timing(v, { toValue: to, duration: SLIDE_MS, useNativeDriver: false }).start();
    });
    settled.current = true;
  }, [order, cellW, cols, stepX, stepY, positions]);

  useEffect(() => () => { if (autoScroll.current) clearInterval(autoScroll.current); }, []);

  const slotPos = (i: number) => ({ x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY });

  /** The grid's window origin right now: what was measured, less however far the page has scrolled since. */
  const originNow = () => {
    const o = origin.current;
    const d = drag.current;
    if (!o || !d) return null;
    return { x: o.x, y: o.y - ((scroll?.y.current ?? 0) - d.scrollAt) };
  };

  /** Put the ghost under the pointer and move the placeholder to the slot under the ghost's middle. */
  const place = () => {
    const d = drag.current;
    const o = originNow();
    if (!d || !o || cellW <= 0) return;
    const gx = d.pointer.x - o.x - d.grabX;
    const gy = d.pointer.y - o.y - d.grabY;
    ghost.setValue({ x: gx, y: gy });
    const col = Math.min(cols - 1, Math.max(0, Math.floor((gx + cellW / 2) / stepX)));
    const row = Math.max(0, Math.floor((gy + tileHeight / 2) / stepY));
    const to = Math.min(row * cols + col, orderRef.current.length - 1);
    const from = orderRef.current.indexOf(d.key);
    if (from >= 0 && to !== from) setLive(move(orderRef.current, from, to));
  };

  const stopAutoScroll = () => {
    if (autoScroll.current) clearInterval(autoScroll.current);
    autoScroll.current = null;
  };

  /** Near the top or bottom of the window the page scrolls under a still finger, like the plan calendar. */
  const edgeScroll = (absoluteY: number) => {
    if (!scroll) return;
    const dir = absoluteY < EDGE ? -1 : absoluteY > windowH - EDGE ? 1 : 0;
    if (dir && !autoScroll.current) {
      autoScroll.current = setInterval(() => {
        // the offset comes back through onScroll, so a page that can't go further simply stays put
        const y = Math.max(0, (scroll.y.current ?? 0) + dir * SCROLL_STEP);
        scroll.ref.current?.scrollTo({ y, animated: false });
        place();
      }, 16);
    } else if (!dir) {
      stopAutoScroll();
    }
  };

  const start = (key: K, e: PanEvent) => {
    const i = orderRef.current.indexOf(key);
    if (i < 0 || cellW <= 0) return;
    const p = slotPos(i);
    // the finger is on the handle in the tile's top-right corner, so its place in the tile follows
    const grabX = cellW - HANDLE + e.x;
    const grabY = e.y;
    const scrollAt = scroll?.y.current ?? 0;
    // the grid's window origin follows from where the finger landed; measureInWindow confirms it a
    // tick later (it is async on the web), corrected for any scrolling in between
    origin.current = { x: e.absoluteX - grabX - p.x, y: e.absoluteY - grabY - p.y };
    containerRef.current?.measureInWindow((x, y) => {
      const d = drag.current;
      if (d?.key === key) origin.current = { x, y: y + ((scroll?.y.current ?? 0) - d.scrollAt) };
    });
    drag.current = { key, before: orderRef.current, grabX, grabY, scrollAt, pointer: { x: e.absoluteX, y: e.absoluteY } };
    ghost.setValue(p);
    setLifted(key);
    onDragChange?.(true);
  };

  const update = (e: PanEvent) => {
    const d = drag.current;
    if (!d) return;
    d.pointer = { x: e.absoluteX, y: e.absoluteY };
    place();
    edgeScroll(e.absoluteY);
  };

  const end = (ok: boolean) => {
    stopAutoScroll();
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    origin.current = null;
    setLifted(null);
    onDragChange?.(false);
    if (!ok) {
      setLive(d.before);
      return;
    }
    if (!sameOrder(orderRef.current, d.before)) onReorder(orderRef.current);
  };

  const nudge = (key: K, dir: -1 | 1) => {
    const from = orderRef.current.indexOf(key);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= orderRef.current.length) return;
    const next = move(orderRef.current, from, to);
    setLive(next);
    onReorder(next);
  };

  const rows = Math.ceil((order.length + (trailing ? 1 : 0)) / cols);
  const height = cellW > 0 ? Math.max(0, rows * stepY - gap) : 0;
  const tail = slotPos(order.length);

  return (
    <View ref={containerRef} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={{ height }}>
      {cellW > 0 ? keys.map((k) => {
        // children keep the parent's order; only where each one is drawn changes during a drag
        const v = positions.get(k);
        if (!v || !order.includes(k)) return null;
        return (
          <Animated.View
            key={k}
            style={{
              position: 'absolute', left: 0, top: 0, width: cellW, height: tileHeight,
              transform: [{ translateX: v.x }, { translateY: v.y }],
            }}>
            <Tile
              k={k}
              label={tileLabel(k)}
              editing={editing}
              first={order[0] === k}
              last={order[order.length - 1] === k}
              onStart={start}
              onUpdate={update}
              onEnd={end}
              onPress={onPress}
              onNudge={nudge}>
              {renderTile(k, { width: cellW, height: tileHeight, editing, lifted: lifted === k })}
            </Tile>
          </Animated.View>
        );
      }) : null}
      {cellW > 0 && trailing ? (
        <View style={{ position: 'absolute', left: tail.x, top: tail.y, width: cellW, height: tileHeight }}>{trailing}</View>
      ) : null}
      {lifted ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', left: 0, top: 0, width: cellW, height: tileHeight, zIndex: 10,
            transform: [{ translateX: ghost.x }, { translateY: ghost.y }, { scale: 1.04 }],
            borderRadius: radius.md, boxShadow: '0 6px 16px rgba(0, 0, 0, 0.25)',
          }}>
          {renderTile(lifted, { width: cellW, height: tileHeight, editing: true, lifted: false })}
        </Animated.View>
      ) : null}
    </View>
  );
}

type TileProps<K extends string> = {
  k: K;
  label: string;
  editing: boolean;
  first: boolean;
  last: boolean;
  onStart: (key: K, e: PanEvent) => void;
  onUpdate: (e: PanEvent) => void;
  onEnd: (ok: boolean) => void;
  onPress?: (key: K) => void;
  onNudge: (key: K, dir: -1 | 1) => void;
  children: ReactNode;
};

/**
 * One cell. Outside edit mode it is a button that opens the metric. In edit mode its top-right
 * corner is the drag handle: only that corner takes the pan, so a swipe on the body still scrolls
 * the page on a phone, and keyboard or screen-reader users move it with the two actions.
 */
function Tile<K extends string>({ k, label, editing, first, last, onStart, onUpdate, onEnd, onPress, onNudge, children }: TileProps<K>) {
  const pan = Gesture.Pan()
    .enabled(editing)
    .minDistance(2)
    .runOnJS(true)
    .onStart((e) => onStart(k, e))
    .onUpdate((e) => onUpdate(e))
    .onEnd((_e, ok) => onEnd(ok));

  const actions = editing
    ? [
      ...(first ? [] : [{ name: 'moveLeft', label: 'Move earlier' }]),
      ...(last ? [] : [{ name: 'moveRight', label: 'Move later' }]),
    ]
    : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'moveLeft') onNudge(k, -1);
    else if (e.nativeEvent.actionName === 'moveRight') onNudge(k, 1);
  };

  return (
    <View style={{ flex: 1 }}>
      <Pressable
        onPress={() => { if (!editing) onPress?.(k); }}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={editing ? 'Drag it by the handle in its corner to move it' : undefined}
        accessibilityActions={actions}
        onAccessibilityAction={editing ? onAction : undefined}
        style={{ flex: 1 }}>
        {children}
      </Pressable>
      {editing ? (
        <GestureDetector gesture={pan}>
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Drag handle for ${label}`}
            style={{ position: 'absolute', top: 0, right: 0, width: HANDLE, height: HANDLE }}
          />
        </GestureDetector>
      ) : null}
    </View>
  );
}
