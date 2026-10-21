import { memo } from 'react';
import { Circle, G, Path, Text as SvgText } from 'react-native-svg';

import type { Projector, Size } from './TileMap';
import { MAX_ZOOM } from '@/lib/geo';
import type { Cafe } from '@/lib/places';
import type { Palette } from '@/theme/tokens';

/** Off-screen cafés are skipped; this margin keeps a symbol that only clips the edge. */
const CULL_MARGIN = 12;
/** Names appear at the map's closest zoom, where there is room for them. */
const LABEL_ZOOM = MAX_ZOOM;
const LABEL_MAX_CHARS = 22;

/** A small cup: body, handle and two wisps of steam, drawn in a 14 px box. */
const CUP_BODY = 'M3 5h7v3.5a3.5 3.5 0 0 1-7 0z';
const CUP_HANDLE = 'M10 6h1a1.5 1.5 0 0 1 0 3h-1';
const CUP_STEAM = 'M5.5 2v1.5M8 2v1.5';

/**
 * Cafés as small cup symbols, each on a pale disc so it reads on busy tiles, with their names at
 * the closest zoom. Drawn under the course and its markers; a tap is matched in the screen with
 * `nearestCafe`, the symbols themselves take no pointer events.
 */
export const CafeLayer = memo(function CafeLayer({ cafes, project, size, zoom, palette }: {
  cafes: Cafe[];
  project: Projector;
  size: Size;
  zoom: number;
  palette: Palette;
}) {
  const labels = zoom >= LABEL_ZOOM;
  return (
    <>
      {cafes.map((c) => {
        const s = project(c.lat, c.lng);
        if (s.x < -CULL_MARGIN || s.x > size.width + CULL_MARGIN || s.y < -CULL_MARGIN || s.y > size.height + CULL_MARGIN) return null;
        const name = labels && c.name ? (c.name.length > LABEL_MAX_CHARS ? `${c.name.slice(0, LABEL_MAX_CHARS - 1)}…` : c.name) : null;
        return (
          <G key={c.id}>
            <Circle cx={s.x} cy={s.y} r={7.5} fill={palette.surface} fillOpacity={0.92} stroke={palette.hair} strokeWidth={1} />
            <G transform={`translate(${s.x - 7}, ${s.y - 7})`} fill="none" stroke={palette.ink2} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d={CUP_BODY} fill={palette.surface2} />
              <Path d={CUP_HANDLE} />
              <Path d={CUP_STEAM} />
            </G>
            {name ? (
              <>
                <SvgText x={s.x + 10} y={s.y + 3.5} fontSize={10} fontWeight="600" stroke={palette.surface} strokeWidth={3} strokeOpacity={0.9} fill={palette.surface}>{name}</SvgText>
                <SvgText x={s.x + 10} y={s.y + 3.5} fontSize={10} fontWeight="600" fill={palette.ink2}>{name}</SvgText>
              </>
            ) : null}
          </G>
        );
      })}
    </>
  );
});
