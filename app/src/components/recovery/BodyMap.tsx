import { createElement } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Circle, Ellipse, Path, Polygon, Rect } from 'react-native-svg';

import { BODY_SVG } from '@/lib/recovery/bodySvg';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import {
  figureOf, musclesIn, paintFigure, type FigureMap, type FigureTheme, type FigureView, type MapMode, type ShapeKind,
} from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import type { Thresholds } from '@/lib/recovery/thresholds';

/** The two views, parsed once from the SVG files (src/lib/recovery/bodySvg.ts). */
export const FIGURES = { front: figureOf(BODY_SVG.front), back: figureOf(BODY_SVG.back) } as const;
const [, , VB_W, VB_H] = FIGURES.front.viewBox;
export const FIGURE_ASPECT = VB_H / VB_W;

const COMPONENTS: Record<ShapeKind, unknown> = { path: Path, ellipse: Ellipse, circle: Circle, rect: Rect, polygon: Polygon };
/** The geometry attributes of a shape, under react-native-svg's prop names. */
const GEOMETRY: Record<string, string> = {
  d: 'd', cx: 'cx', cy: 'cy', rx: 'rx', ry: 'ry', r: 'r', x: 'x', y: 'y', width: 'width', height: 'height', points: 'points',
};
/** SVG attributes react-native-svg takes, under its prop names. data-*, ids and ARIA are left out. */
const PROPS: Record<string, string> = {
  ...GEOMETRY,
  fill: 'fill', stroke: 'stroke', 'stroke-width': 'strokeWidth', 'stroke-linejoin': 'strokeLinejoin', 'stroke-linecap': 'strokeLinecap',
  opacity: 'opacity', 'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity',
};
/** The glow: a soft wide halo and a crisp line, both drawn over the region's outline. */
const GLOW = [{ width: VB_W * 0.04, opacity: 0.28 }, { width: VB_W * 0.012, opacity: 0.9 }];

type Props = {
  /** recovery_map or session_map (build phase 5); null draws every region Ready. */
  map: FigureMap | null;
  view: FigureView;
  mode: MapMode;
  theme: FigureTheme;
  /** The user's thresholds, for the silhouette and outline colours. */
  thresholds?: Thresholds;
  width: number;
  /** Tapping a region. */
  onSelect?: (muscle: MuscleId) => void;
  /** Display names, for the screen-reader summary. */
  nameOf?: (id: MuscleId) => string;
  /** What the summary says the figure shows, e.g. "muscles used" or "fatigue on Tue 13 Oct";
   *  "fatigue now" (recovery) or "this workout" (session) by default. */
  context?: string;
  /** The summary when no region is coloured; "every muscle Ready" by default. */
  emptyText?: string;
  /** Muscles to draw a glowing outline around (the live workout's Body view: what this session has loaded). */
  glow?: ReadonlySet<MuscleId>;
  glowColor?: string;
};

/**
 * The body figure, front or back, coloured from a recovery or session map (spec §10). Regions are
 * coloured by their data-muscle attribute; silhouette shapes only ever take silhouette_fill(_dark).
 * Every region can be tapped. Screen readers get a one-line summary; the list view (MuscleList)
 * is the full text equivalent.
 */
export function BodyMap({ map, view, mode, theme, thresholds = DEFAULT_THRESHOLDS, width, onSelect, nameOf, context, emptyText, glow, glowColor }: Props) {
  const figure = FIGURES[view];
  const painted = paintFigure(figure, map, theme, thresholds);
  const name = nameOf ?? ((id: MuscleId) => id.replace(/_/g, ' '));
  const coloured = musclesIn(figure).filter((id) => (map?.[id].level ?? 0) > 0);
  const glowing = glow ? musclesIn(figure).filter((id) => glow.has(id)) : [];
  const summary = `Body map, ${view} view, ${context ?? (mode === 'session' ? 'this workout' : 'fatigue now')}: ` +
    (coloured.length ? coloured.map((id) => `${name(id)} ${map![id].label}`).join(', ') : (emptyText ?? 'every muscle Ready')) +
    (glowing.length ? `. Loaded this session: ${glowing.map(name).join(', ')}` : '');
  /** A region's tap, as react-native-svg takes it on each platform. */
  const pressProps = (muscle: MuscleId): Record<string, unknown> => {
    if (!onSelect) return {};
    const select = () => onSelect(muscle);
    // on web, react-native-svg turns onPress into responder props React warns about, and
    // replaces onClick unless onPress is exactly null; a plain click is all a region needs
    return Platform.OS === 'web' ? { onPress: null, onClick: select, style: { cursor: 'pointer' } } : { onPress: select };
  };
  // the glow goes over every region, so a neighbour never hides it; a tap on the glow is a tap on
  // its muscle, since the strokes cover much of a small region
  const halos = glow && glowColor
    ? painted.filter((p) => p.muscle && glow.has(p.muscle)).flatMap((p) => GLOW.map((g, i) => {
        const props: Record<string, unknown> = {
          key: `${p.key}-glow${i}`, fill: 'none', stroke: glowColor, strokeWidth: g.width, strokeOpacity: g.opacity,
          strokeLinejoin: 'round', strokeLinecap: 'round', ...pressProps(p.muscle!),
        };
        for (const [k, v] of Object.entries(p.attrs)) if (GEOMETRY[k]) props[GEOMETRY[k]] = v;
        return createElement(COMPONENTS[p.kind] as never, props);
      }))
    : null;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary}>
      <Svg width={width} height={width * FIGURE_ASPECT} viewBox={figure.viewBox.join(' ')}>
        {painted.map((p) => {
          const props: Record<string, unknown> = { key: p.key };
          for (const [k, v] of Object.entries(p.attrs)) if (PROPS[k]) props[PROPS[k]] = v;
          if (p.muscle) Object.assign(props, pressProps(p.muscle));
          return createElement(COMPONENTS[p.kind] as never, props);
        })}
        {halos}
      </Svg>
    </View>
  );
}
