import { useMemo, useState } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';

import { T } from '@/components/ui/T';
import { elevationStats, type Track } from '@/lib/runAnalysis';
import { KM_PER_MILE, formatDuration, formatPace, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  track: Track;
  /** The cursor's point index; null shows the run's totals and averages instead. */
  index: number | null;
  units: Units;
  /** Shown as a small × while a cursor is pinned. */
  onClear?: () => void;
};

type Cell = { label: string; value: string };

const DASH = '–';
/** Below this width seven columns would clip "1:02:33"; the strip wraps to two rows instead. */
const WRAP_BELOW = 340;

const num = (v: number | null | undefined, decimals: number): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(decimals) : DASH;

const mean = (xs: (number | null)[]): number | null => {
  let s = 0, n = 0;
  for (const v of xs) if (v != null && Number.isFinite(v)) { s += v; n++; }
  return n ? s / n : null;
};

const distValue = (m: number | null | undefined, units: Units): string =>
  typeof m === 'number' && Number.isFinite(m) ? num(units === 'imperial' ? m / 1000 / KM_PER_MILE : m / 1000, 2) : DASH;

const elevValue = (m: number | null | undefined, units: Units): string =>
  typeof m === 'number' && Number.isFinite(m) ? `${Math.round(units === 'imperial' ? m * 3.28084 : m)}` : DASH;

const gradeValue = (g: number | null | undefined): string =>
  typeof g === 'number' && Number.isFinite(g) ? `${g > 0 ? '+' : ''}${g.toFixed(1)}` : DASH;

/**
 * Seven numbers in two lines: distance, time, pace, heart rate, cadence, elevation and grade,
 * read at the cursor when there is one and summarising the whole run otherwise. Units sit in
 * the labels; on narrow phones the seven cells wrap into two rows rather than clipping.
 */
export function StatsStrip({ track, index, units, onClear }: Props) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);
  const distUnit = units === 'imperial' ? 'mi' : 'km';
  const elevUnit = units === 'imperial' ? 'ft' : 'm';

  const summary = useMemo<Cell[]>(() => {
    const { gain, loss } = track.hasAlt ? elevationStats(track.alt) : { gain: 0, loss: 0 };
    const avgPace = track.totalTime != null && track.totalDist > 0 ? track.totalTime / (track.totalDist / 1000) : null;
    const netGrade = track.hasAlt && track.totalDist > 0 ? ((gain - loss) / track.totalDist) * 100 : null;
    return [
      { label: `Dist ${distUnit}`, value: distValue(track.totalDist, units) },
      { label: 'Time', value: track.totalTime != null ? formatDuration(track.totalTime) : DASH },
      { label: `Pace /${distUnit}`, value: formatPace(avgPace, units, false) },
      { label: 'HR', value: track.hasHr ? num(mean(track.hr), 0) : DASH },
      { label: 'Cad', value: track.hasCad ? num(mean(track.cad), 0) : DASH },
      { label: `Climb ${elevUnit}`, value: track.hasAlt ? `+${elevValue(gain, units)}` : DASH },
      { label: 'Grade %', value: gradeValue(netGrade) },
    ];
  }, [track, units, distUnit, elevUnit]);

  // dist has one entry per point, with or without a GPS trace (treadmill tracks are samples-only)
  const pinned = index != null && index >= 0 && index < track.dist.length;
  const cells: Cell[] = pinned
    ? [
        { label: `Dist ${distUnit}`, value: distValue(track.dist[index], units) },
        { label: 'Time', value: track.t ? formatDuration(track.t[index]) : DASH },
        { label: `Pace /${distUnit}`, value: formatPace(track.pace[index], units, false) },
        { label: 'HR', value: num(track.hr[index], 0) },
        { label: 'Cad', value: num(track.cad[index], 0) },
        { label: `Elev ${elevUnit}`, value: elevValue(track.alt[index], units) },
        { label: 'Grade %', value: gradeValue(track.grade[index]) },
      ]
    : summary;

  const wrap = width > 0 && width < WRAP_BELOW;
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth((prev) => (prev === w ? prev : w));
  };

  return (
    <View onLayout={onLayout} style={{ backgroundColor: palette.surface2, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.xs }}>
      <View style={{ flexDirection: 'row', flexWrap: wrap ? 'wrap' : 'nowrap', alignItems: 'center', rowGap: space.sm }}>
        {cells.map((c) => (
          <View key={c.label} style={wrap ? { flexBasis: '25%', alignItems: 'center', gap: 1 } : { flex: 1, alignItems: 'center', gap: 1 }}>
            <T variant="tiny" tone="mut" numberOfLines={1}>{c.label}</T>
            <T variant="small" weight="600" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>{c.value}</T>
          </View>
        ))}
      </View>
      {onClear && pinned ? (
        <Pressable
          onPress={onClear}
          hitSlop={8}
          accessibilityLabel="Clear cursor"
          style={({ pressed }) => ({ position: 'absolute', top: 2, right: 6, opacity: pressed ? 0.6 : 1 })}>
          <T variant="small" tone="mut" weight="700">×</T>
        </Pressable>
      ) : null}
    </View>
  );
}
