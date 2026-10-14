import { memo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import type { Projector, Size } from './TileMap';
import { T } from '@/components/ui/T';
import { pathD } from '@/lib/geo';
import { HEAT_RAMP, heatColour, heatOpacity, type HeatRoute } from '@/lib/heat';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';
import type { Palette } from '@/theme/tokens';

/** Off-screen routes are skipped; this margin keeps strokes that only clip the edge. */
const CULL_MARGIN = 40;

/**
 * Every route as one stroke coloured and weighted by how often it is run (see lib/heat), drawn
 * least-run first so the hot routes sit on top, plus an optional bold run over everything.
 * Rebuilt only when the camera, the routes or the highlight change.
 */
export const HeatLayer = memo(function HeatLayer({ routes, project, size, highlight, palette }: {
  routes: HeatRoute[];
  project: Projector;
  size: Size;
  /** Runs drawn bold over the heat; start and finish dots go on the first. */
  highlight: [number, number][][] | null;
  palette: Palette;
}) {
  return (
    <>
      {routes.map((r) => {
        const a = project(r.box[0], r.box[1]);
        const b = project(r.box[2], r.box[3]);
        if (Math.max(a.x, b.x) < -CULL_MARGIN || Math.min(a.x, b.x) > size.width + CULL_MARGIN) return null;
        if (Math.max(a.y, b.y) < -CULL_MARGIN || Math.min(a.y, b.y) > size.height + CULL_MARGIN) return null;
        const d = pathD(r.pts.map(([lat, lng]) => project(lat, lng)), 1.5);
        if (!d) return null;
        return (
          <Path
            key={r.activity_id}
            d={d}
            fill="none"
            stroke={heatColour(r.weight)}
            strokeOpacity={heatOpacity(r.weight)}
            strokeWidth={2.5 + 1.5 * r.weight}
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
  const d = pathD(pts.map(([lat, lng]) => project(lat, lng)), 1);
  if (!d) return null;
  const start = project(pts[0][0], pts[0][1]);
  const end = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return (
    <>
      <Path d={d} fill="none" stroke={palette.surface} strokeOpacity={0.9} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
      <Path d={d} fill="none" stroke={palette.ink} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
      {dots ? (
        <>
          <Circle cx={start.x} cy={start.y} r={5.5} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
          <Circle cx={end.x} cy={end.y} r={5.5} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />
        </>
      ) : null}
    </>
  );
}

/** A small gradient bar reading "once" to "often", for under a heat map. */
export function HeatLegend() {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <T variant="tiny" tone="mut">Run once</T>
      <View style={{ flex: 1, height: 6, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: palette.surface2 }}>
        <Svg width="100%" height={6}>
          <Defs>
            <LinearGradient id="heat-legend" x1="0" y1="0" x2="1" y2="0">
              {HEAT_RAMP.map((c, i) => <Stop key={c} offset={i / (HEAT_RAMP.length - 1)} stopColor={c} />)}
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={6} fill="url(#heat-legend)" />
        </Svg>
      </View>
      <T variant="tiny" tone="mut">Run often</T>
    </View>
  );
}
