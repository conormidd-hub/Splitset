import { useMemo } from 'react';
import { Circle, Path } from 'react-native-svg';

import { TileMap } from './TileMap';
import { bboxOf, decodeRoute, pathD } from '@/lib/geo';
import { useTheme } from '@/theme/ThemeProvider';

/** One activity's route over a basemap, framed to fit, with start and finish markers. */
export function RouteMap({ encoded, height = 240 }: { encoded: string; height?: number }) {
  const { palette } = useTheme();
  const pts = useMemo(() => decodeRoute(encoded), [encoded]);
  const bounds = useMemo(() => bboxOf(pts), [pts]);
  if (pts.length < 2 || !bounds) return null;

  return (
    <TileMap bounds={bounds} height={height}>
      {(project) => {
        const d = pathD(pts.map(([lat, lng]) => project(lat, lng)), 1);
        const start = project(pts[0][0], pts[0][1]);
        const end = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        return (
          <>
            <Path d={d} fill="none" stroke={palette.surface} strokeOpacity={0.9} strokeWidth={6.5} strokeLinejoin="round" strokeLinecap="round" />
            <Path d={d} fill="none" stroke={palette.accent} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
            <Circle cx={start.x} cy={start.y} r={5.5} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
            <Circle cx={end.x} cy={end.y} r={5.5} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />
          </>
        );
      }}
    </TileMap>
  );
}
