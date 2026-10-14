import { memo, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Animated, Image, PanResponder, Platform, Pressable, View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle,
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
  style?: ViewStyle;
  /** A tap on the map, in map-local pixels (the same frame `project` returns). A drag never fires it. */
  onPress?: (pt: Pt) => void;
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
}

/**
 * A slippy map made of plain Image tiles with an SVG layer on top. No native map module, so it
 * runs the same on iOS, Android, web and in Expo Go; the trade-off is that it is a still picture
 * you pan and zoom, not a full map view.
 */
export function TileMap({ bounds, view, onViewChange, height, interactive = false, padding = 24, style, onPress, children }: Props) {
  const { name, palette } = useTheme();
  const tileStyle: TileStyle = name === 'night' ? 'dark' : 'light';
  const [size, setSize] = useState<Size>({ width: 0, height: height ?? 0 });
  const [pan] = useState(() => new Animated.ValueXY());
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
    return { project, tiles, world };
  }, [cam, size.width, size.height, tileStyle]);

  // The drag offset is applied as a transform while the finger is down. On release the parent
  // gets the new centre; once that camera has rendered, the transform snaps back to zero.
  // A layout effect so the reset lands in the same frame as the new camera, never one frame late.
  useLayoutEffect(() => {
    pan.setValue({ x: 0, y: 0 });
  }, [cam, pan]);

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
        onViewChange({ center: { lat: unMercY(cy / world), lng: unMercX(cx / world) }, zoom: cam.zoom });
      },
      onPanResponderTerminate: () => pan.setValue({ x: 0, y: 0 }),
    });
  }, [interactive, cam, onViewChange, pan, gate]);

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
    if (!onPress) return;
    const p = gate.resolve(localPoint(e));
    if (p) onPress(p);
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
          disabled={!onPress}
          onPressIn={onPressIn}
          onPress={onPressed}
          style={{ position: 'absolute', left: 0, top: 0, width: size.width, height: size.height }}>
          <Animated.View style={{ position: 'absolute', left: 0, top: 0, width: size.width, height: size.height, pointerEvents: 'none', transform: pan.getTranslateTransform() }}>
            <TileLayer tiles={scene.tiles} />
            <Svg width={size.width} height={size.height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
              {children?.(scene.project, size, cam)}
            </Svg>
          </Animated.View>
        </Pressable>
      ) : null}

      <View style={{ position: 'absolute', left: 6, bottom: 4, pointerEvents: 'none', backgroundColor: palette.surface, opacity: 0.8, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 }}>
        <T variant="tiny" tone="mut">{TILE_ATTRIBUTION}</T>
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
