import polyline from '@mapbox/polyline';
import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/theme/ThemeProvider';
import { radius } from '@/theme/tokens';

/** The run's route drawn as a plain SVG trace, no tiles and no native map module. */
export function RouteSvg({ encoded, height = 220 }: { encoded: string; height?: number }) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);

  const shape = useMemo(() => {
    const pts = polyline.decode(encoded) as [number, number][];
    if (pts.length < 2) return null;
    const lats = pts.map((p) => p[0]);
    const lngs = pts.map((p) => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const cos = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
    const w = (maxLng - minLng) * cos || 1e-6;
    const h = (maxLat - minLat) || 1e-6;
    return { pts, minLat, maxLat, minLng, w, h, cos };
  }, [encoded]);

  if (!shape) return null;
  const pad = 14;
  const scale = width ? Math.min((width - pad * 2) / shape.w, (height - pad * 2) / shape.h) : 1;
  const drawW = shape.w * scale, drawH = shape.h * scale;
  const ox = (width - drawW) / 2, oy = (height - drawH) / 2;
  const px = (lng: number) => ox + (lng - shape.minLng) * shape.cos * scale;
  const py = (lat: number) => oy + (shape.maxLat - lat) * scale;
  const d = shape.pts.map(([lat, lng], i) => `${i ? 'L' : 'M'}${px(lng).toFixed(1)} ${py(lat).toFixed(1)}`).join(' ');
  const start = shape.pts[0], end = shape.pts[shape.pts.length - 1];

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={{ height, backgroundColor: palette.surface2, borderRadius: radius.md, overflow: 'hidden' }}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Path d={d} fill="none" stroke={palette.accent} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx={px(start[1])} cy={py(start[0])} r={5} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
          <Circle cx={px(end[1])} cy={py(end[0])} r={5} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />
        </Svg>
      ) : null}
    </View>
  );
}
