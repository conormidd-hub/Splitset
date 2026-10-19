import { memo, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Animated, Easing, Image, PanResponder, Platform, Pressable, View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle,
} from 'react-native';
import Svg from 'react-native-svg';

import { T } from '@/components/ui/T';
import {
  MAX_ZOOM, MIN_ZOOM, TILE_ATTRIBUTION, TILE_SIZE, clamp, fitBbox, mercX, mercY, tileLayers, unMercX, unMercY,
  type Bbox, type MapView, type Pt, type TileStyle,
} from '@/lib/geo';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export type Projector = (lat: number, lng: number) => Pt;
export type Size = { width: number; height: number };

type Props = {
  /** What to frame when `view` is null or absent. */
  bounds: Bbox;
  /** An explicit camera, set by panning or the zoom buttons; null means "fit bounds". */
  view?: MapView | null;
  /** Called with the new camera after a pan or zoom, or null when the fit button is pressed. */
  onViewChange?: (view: MapView | null) => void;
  /** Fixed height; leave unset to fill the parent. */
  height?: number;
  /** Drag to pan and show the zoom buttons. Keep off inside a ScrollView. */
  interactive?: boolean;
  padding?: number;
  /** A thumbnail (the Run tab's mini map): the attribution shrinks to its © mark. */
  compact?: boolean;
  style?: ViewStyle;
  /** A tap in map-local pixels, with the projector and camera it was measured against. A drag never fires it. */
  onPress?: (pt: Pt, project: Projector, view: MapView) => void;
  /** SVG children drawn over the tiles. */
  children?: (project: Projector, size: Size, view: MapView) => ReactNode;
};

type Tile = { key: string; uris: string[]; left: number; top: number; width: number; height: number };

const TileLayer = memo(function TileLayer({ tiles }: { tiles: Tile[] }) {
  return (
    <>
      {tiles.map((t) =>
        t.uris.map((uri, i) => (
          <Image key={`${t.key}:${i}`} source={{ uri }} style={{ position: 'absolute', left: t.left, top: t.top, width: t.width, height: t.height }} />
        )),
      )}
    </>
  );
});

/**
 * The press position relative to the view that was hit. Native touches carry `locationX`; on the
 * web a press is a DOM click whose MouseEvent only has `offsetX`, measured from the same element
 * because every child of the hit target has pointer events off.
 */
function localPoint(e: GestureResponderEvent): Pt | null {
  const ne = e.nativeEvent as unknown as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
  if (typeof ne.locationX === 'number' && typeof ne.locationY === 'number') return { x: ne.locationX, y: ne.locationY };
  if (typeof ne.offsetX === 'number' && typeof ne.offsetY === 'number') return { x: ne.offsetX, y: ne.offsetY };
  return null;
}

/** A finger may wander this far between press-in and release and still count as a tap. */
const TAP_SLOP = 10;

/**
 * Tells a tap from a pan. On native the Pressable is terminated when the pan responder takes
 * over and never fires; on the web the browser still sends a click after the drag, which the
 * gate swallows. A map that is not interactive has no pan responder, so there a mouse drag on
 * the web also ends in a click: the distance between press-in and release catches that one.
 * Held in state like the Animated value (not a ref) because the compiler lint forbids handing
 * ref-reading closures to PanResponder.create.
 */
class PressGate {
  private dragged = false;
  private pressedAt: Pt | null = null;
  begin(p: Pt | null) {
    this.dragged = false;
    this.pressedAt = p;
  }
  drag() {
    this.dragged = true;
  }
  /** The tap position, or null when the gesture turned into a pan or a drag. */
  resolve(p: Pt | null): Pt | null {
    if (this.dragged) return null;
    const at = this.pressedAt;
    if (p && at && Math.hypot(p.x - at.x, p.y - at.y) > TAP_SLOP) return null;
    return p ?? at;
  }

  private lastTapAt = 0;
  private lastTapPt: Pt | null = null;
  /** True when this tap lands within 300 ms and 24 px of the previous one: a double tap. */
  doubleTap(p: Pt, now: number): boolean {
    const last = this.lastTapPt;
    const dbl = now - this.lastTapAt < 300 && !!last && Math.hypot(p.x - last.x, p.y - last.y) < 24;
    this.lastTapAt = dbl ? 0 : now;
    this.lastTapPt = dbl ? null : p;
    return dbl;
  }
}

/** Camera jumps beyond this are snapped, not animated: the scaled tiles would be a blur. */
const MAX_ANIMATED_ZOOM_STEP = 4;
const CAMERA_ANIM_MS = 450;

/**
 * Eases the map from the camera it last showed to a new one. The new scene is rendered at once
 * but starts under a transform that makes it line up with the old view, then that transform
 * eases to identity, so the map pans and zooms to the new place instead of jumping. Web Mercator
 * at zoom z1 is the zoom-z0 picture scaled by 2^(z1-z0), so one scale-and-translate is exact.
 * Held in state like the Animated value (not a ref) because the compiler lint forbids handing
 * ref-reading closures to PanResponder.create.
 */
class CameraAnim {
  readonly scale = new Animated.Value(1);
  readonly tx = new Animated.Value(0);
  readonly ty = new Animated.Value(0);
  private prev: { cam: MapView; size: Size } | null = null;
  private manual = false;
  private running: Animated.CompositeAnimation | null = null;

  /** The next camera came from a drag, which already moved the picture: do not animate it. */
  markManual() {
    this.manual = true;
  }

  /** Called whenever the rendered camera or the size changes. */
  onCamera(cam: MapView, size: Size) {
    const prev = this.prev;
    // the same camera again (a parent re-render): leave any ease in flight alone
    if (prev && prev.size.width === size.width && prev.size.height === size.height
      && Math.abs(cam.zoom - prev.cam.zoom) < 1e-9
      && Math.abs(cam.center.lat - prev.cam.center.lat) < 1e-9 && Math.abs(cam.center.lng - prev.cam.center.lng) < 1e-9) return;
    this.prev = { cam, size };
    const manual = this.manual;
    this.manual = false;
    this.running?.stop();
    this.running = null;
    const snap = () => {
      this.scale.setValue(1);
      this.tx.setValue(0);
      this.ty.setValue(0);
    };
    if (!prev || manual || prev.size.width !== size.width || prev.size.height !== size.height) return snap();
    const dz = cam.zoom - prev.cam.zoom;
    if (Math.abs(dz) > MAX_ANIMATED_ZOOM_STEP) return snap();

    // screen1 = k * screen0 + t, so the old view is the new scene scaled by 1/k and moved by -t/k
    const k = 2 ** dz;
    const w0 = 2 ** prev.cam.zoom, w1 = 2 ** cam.zoom;
    const tl0 = { x: mercX(prev.cam.center.lng) * w0 - size.width / 2, y: mercY(prev.cam.center.lat) * w0 - size.height / 2 };
    const tl1 = { x: mercX(cam.center.lng) * w1 - size.width / 2, y: mercY(cam.center.lat) * w1 - size.height / 2 };
    const t = { x: k * tl0.x - tl1.x, y: k * tl0.y - tl1.y };
    const span = 4 * Math.max(size.width, size.height) * Math.max(1, k);
    if (Math.hypot(t.x, t.y) > span) return snap();
    const s0 = 1 / k;
    // the view scales about its centre, so fold the centre back into the translation
    const c = { x: size.width / 2, y: size.height / 2 };
    this.scale.setValue(s0);
    this.tx.setValue(-t.x / k - (1 - s0) * c.x);
    this.ty.setValue(-t.y / k - (1 - s0) * c.y);
    const cfg = { duration: CAMERA_ANIM_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: false };
    this.running = Animated.parallel([
      Animated.timing(this.scale, { toValue: 1, ...cfg }),
      Animated.timing(this.tx, { toValue: 0, ...cfg }),
      Animated.timing(this.ty, { toValue: 0, ...cfg }),
    ]);
    this.running.start(() => {
      this.running = null;
    });
  }
}

/**
 * A slippy map made of plain Image tiles with an SVG layer on top. No native map module, so it
 * runs the same on iOS, Android, web and in Expo Go; the trade-off is that it is a still picture
 * you pan and zoom, not a full map view.
 */
export function TileMap({ bounds, view, onViewChange, height, interactive = false, padding = 24, compact = false, style, onPress, children }: Props) {
  const { name, palette } = useTheme();
  const tileStyle: TileStyle = name === 'night' ? 'dark' : 'light';
  const [size, setSize] = useState<Size>({ width: 0, height: height ?? 0 });
  const [pan] = useState(() => new Animated.ValueXY());
  const [camAnim] = useState(() => new CameraAnim());
  const [gate] = useState(() => new PressGate());

  const cam: MapView | null = useMemo(() => {
    if (view) return view;
    if (!size.width || !size.height) return null;
    return fitBbox(bounds, size.width, size.height, padding);
  }, [view, bounds, size.width, size.height, padding]);

  const scene = useMemo(() => {
    if (!cam || !size.width || !size.height) return null;
    const world = 2 ** cam.zoom;
    const tlx = mercX(cam.center.lng) * world - size.width / 2;
    const tly = mercY(cam.center.lat) * world - size.height / 2;
    const project: Projector = (lat, lng) => ({ x: mercX(lng) * world - tlx, y: mercY(lat) * world - tly });

    const z = clamp(Math.round(cam.zoom), 0, MAX_ZOOM);
    const tileSize = TILE_SIZE * 2 ** (cam.zoom - z);
    const n = 2 ** z;
    const x0 = Math.floor(tlx / tileSize) - 1, x1 = Math.floor((tlx + size.width) / tileSize) + 1;
    const y0 = Math.max(0, Math.floor(tly / tileSize) - 1), y1 = Math.min(n - 1, Math.floor((tly + size.height) / tileSize) + 1);
    const tiles: Tile[] = [];
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const left = Math.round(tx * tileSize - tlx), right = Math.round((tx + 1) * tileSize - tlx);
      for (let ty = y0; ty <= y1; ty++) {
        const top = Math.round(ty * tileSize - tly), bottom = Math.round((ty + 1) * tileSize - tly);
        tiles.push({ key: `${z}/${tx}/${ty}`, uris: tileLayers(tileStyle, z, wx, ty), left, top, width: right - left, height: bottom - top });
      }
    }
    return { project, tiles, world, tlx, tly };
  }, [cam, size.width, size.height, tileStyle]);

  // The drag offset is applied as a transform while the finger is down. On release the parent
  // gets the new centre; once that camera has rendered, the transform snaps back to zero and any
  // other camera change starts its ease from the previous view. A layout effect so both land in
  // the same frame as the new scene, never one frame late.
  useLayoutEffect(() => {
    pan.setValue({ x: 0, y: 0 });
    if (cam && size.width && size.height) camAnim.onCamera(cam, size);
  }, [cam, size, pan, camAnim]);

  const transform = useMemo(
    () => [{ translateX: Animated.add(pan.x, camAnim.tx) }, { translateY: Animated.add(pan.y, camAnim.ty) }, { scale: camAnim.scale }],
    [pan, camAnim],
  );

  const responder = useMemo(() => {
    if (!interactive) return null;
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
      onPanResponderGrant: () => gate.drag(),
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        if (!cam || !onViewChange || (g.dx === 0 && g.dy === 0)) {
          pan.setValue({ x: 0, y: 0 });
          return;
        }
        const world = 2 ** cam.zoom;
        const cx = mercX(cam.center.lng) * world - g.dx;
        const cy = mercY(cam.center.lat) * world - g.dy;
        camAnim.markManual();
        onViewChange({ center: { lat: unMercY(cy / world), lng: unMercX(cx / world) }, zoom: cam.zoom });
      },
      onPanResponderTerminate: () => pan.setValue({ x: 0, y: 0 }),
    });
  }, [interactive, cam, onViewChange, pan, gate, camAnim]);

  const zoomBy = (d: number) => {
    if (!cam || !onViewChange) return;
    onViewChange({ center: cam.center, zoom: clamp(Math.round(cam.zoom + d), MIN_ZOOM, MAX_ZOOM) });
  };

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height: h } = e.nativeEvent.layout;
    setSize((prev) => (prev.width === width && prev.height === h ? prev : { width, height: h }));
  };

  const onPressIn = (e: GestureResponderEvent) => gate.begin(localPoint(e));

  const onPressed = (e: GestureResponderEvent) => {
    const p = gate.resolve(localPoint(e));
    if (!p || !scene || !cam) return;
    if (interactive && onViewChange && gate.doubleTap(p, Date.now())) {
      // a double tap zooms in a level on the spot under the finger
      const lat = unMercY((p.y + scene.tly) / scene.world), lng = unMercX((p.x + scene.tlx) / scene.world);
      onViewChange({ center: { lat, lng }, zoom: clamp(Math.round(cam.zoom + 1), MIN_ZOOM, MAX_ZOOM) });
      return;
    }
    onPress?.(p, scene.project, cam);
  };

  return (
    <View
      onLayout={onLayout}
      {...(responder?.panHandlers ?? {})}
      style={[
        { backgroundColor: palette.surface2, borderRadius: radius.md, overflow: 'hidden' },
        height ? { height } : { flex: 1 },
        // on the web the browser must hand touch moves to the responder from the first touch
        interactive && Platform.OS === 'web' ? ({ touchAction: 'none' } as ViewStyle) : null,
        style,
      ]}>
      {scene && cam ? (
        // The Pressable is the only thing under the finger: tiles and SVG ignore pointer events,
        // so a press reports map-local coordinates on every platform.
        <Pressable
          disabled={!onPress && !(interactive && onViewChange)}
          onPressIn={onPressIn}
          onPress={onPressed}
          style={{ position: 'absolute', left: 0, top: 0, width: size.width, height: size.height }}>
          <Animated.View style={{ position: 'absolute', left: 0, top: 0, width: size.width, height: size.height, pointerEvents: 'none', transform }}>
            <TileLayer tiles={scene.tiles} />
            <Svg width={size.width} height={size.height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
              {children?.(scene.project, size, cam)}
            </Svg>
          </Animated.View>
        </Pressable>
      ) : null}

      <View style={{ position: 'absolute', left: compact ? 2 : 6, bottom: compact ? 1 : 4, pointerEvents: 'none', backgroundColor: palette.surface, opacity: 0.8, borderRadius: radius.sm, paddingHorizontal: compact ? 2 : 6, paddingVertical: compact ? 0 : 1 }}>
        <T variant="tiny" tone="mut" accessibilityLabel={compact ? TILE_ATTRIBUTION : undefined}>{compact ? '©' : TILE_ATTRIBUTION}</T>
      </View>

      {interactive && onViewChange ? (
        <View style={{ position: 'absolute', right: space.sm, top: space.sm, gap: 6 }}>
          <MapButton label="+" onPress={() => zoomBy(1)} />
          <MapButton label="−" onPress={() => zoomBy(-1)} />
          <MapButton label="⌖" onPress={() => onViewChange(null)} />
        </View>
      ) : null}
    </View>
  );
}

function MapButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center',
        backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hair, opacity: pressed ? 0.7 : 0.95,
      })}>
      <T variant="h2" tone="ink" style={{ lineHeight: 22 }}>{label}</T>
    </Pressable>
  );
}
