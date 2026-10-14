import { memo, useId, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import type { Projector, Size } from './TileMap';
import { T } from '@/components/ui/T';
import { smoothPathD } from '@/lib/geo';
import { HEAT_RAMPS, heatColour, heatOpacity, heatWidth, oneTracePerRoute, type HeatRoute } from '@/lib/heat';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';
import type { Palette } from '@/theme/tokens';

/** Off-screen routes are skipped; this margin keeps strokes that only clip the edge. */
const CULL_MARGIN = 40;

/**
 * Every route as one thin, smoothed stroke (its most typical run) in the theme's accent, deepening
 * and thickening a little with how often it is run and thinning as the map zooms out (see
 * lib/heat), drawn least-run first so the staples sit on top, plus an optional bold run over
 * everything. Taps are still tested against every run, so any lap of a route selects it.
 * Rebuilt only when the camera, the routes or the highlight change.
 */
export const HeatLayer = memo(function HeatLayer({ routes, project, size, zoom, highlight, palette }: {
  routes: HeatRoute[];
  project: Projector;
  size: Size;
  /** The camera's zoom: lines thin as the map zooms out. */
  zoom: number;
  /** Runs drawn bold over the heat; start and finish dots go on the first. */
  highlight: [number, number][][] | null;
  palette: Palette;
}) {
  const { name } = useTheme();
  const ramp = HEAT_RAMPS[name];
  const traces = useMemo(() => oneTracePerRoute(routes), [routes]);
  return (
    <>
      {traces.map((r) => {
        const a = project(r.box[0], r.box[1]);
        const b = project(r.box[2], r.box[3]);
        if (Math.max(a.x, b.x) < -CULL_MARGIN || Math.min(a.x, b.x) > size.width + CULL_MARGIN) return null;
        if (Math.max(a.y, b.y) < -CULL_MARGIN || Math.min(a.y, b.y) > size.height + CULL_MARGIN) return null;
        const d = smoothPathD(r.pts.map(([lat, lng]) => project(lat, lng)));
        if (!d) return null;
        return (
          <Path
            key={r.activity_id}
            d={d}
            fill="none"
            stroke={heatColour(r.weight, ramp)}
            strokeOpacity={heatOpacity(r.weight)}
            strokeWidth={heatWidth(r.weight, zoom)}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
      {highlight?.map((pts, i) => <BoldRoute key={i} pts={pts} project={project} palette={palette} dots={i === 0} />)}
    </>
  );
});

/** One run drawn bold over the heat: a halo, the stroke, then start and finish dots. */
export function BoldRoute({ pts, project, palette, dots = true }: { pts: [number, number][]; project: Projector; palette: Palette; dots?: boolean }) {
  const d = smoothPathD(pts.map(([lat, lng]) => project(lat, lng)), 1.5);
  if (!d) return null;
  const start = project(pts[0][0], pts[0][1]);
  const end = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return (
    <>
      <Path d={d} fill="none" stroke={palette.surface} strokeOpacity={0.9} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
      <Path d={d} fill="none" stroke={palette.ink} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {dots ? (
        <>
          <Circle cx={start.x} cy={start.y} r={4.5} fill={palette.pos} stroke={palette.surface} strokeWidth={1.5} />
          <Circle cx={end.x} cy={end.y} r={4.5} fill={palette.neg} stroke={palette.surface} strokeWidth={1.5} />
        </>
      ) : null}
    </>
  );
}

/** A small gradient bar reading "once" to "often", for under a heat map. */
export function HeatLegend() {
  const { name, palette } = useTheme();
  const ramp = HEAT_RAMPS[name];
  // SVG ids are global to the document, and the Run tab's legend stays mounted under the Maps hub's.
  const gradientId = `heat-legend-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <T variant="tiny" tone="mut">Run once</T>
      <View style={{ flex: 1, height: 6, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: palette.surface2 }}>
        <Svg width="100%" height={6}>
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
              {[0, 0.5, 1].map((w) => <Stop key={w} offset={w} stopColor={heatColour(w, ramp)} stopOpacity={heatOpacity(w)} />)}
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={6} fill={`url(#${gradientId})`} />
        </Svg>
      </View>
      <T variant="tiny" tone="mut">Run often</T>
    </View>
  );
}
