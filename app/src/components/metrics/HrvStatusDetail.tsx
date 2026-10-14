import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import { View } from 'react-native';

import type { Series } from '@/components/charts/LineChart';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { T } from '@/components/ui/T';
import { dailyWindow, detailSeries, METRICS, RANGES, type MetricInputs, type Range } from '@/lib/metrics';
import { hrvStatus } from '@/lib/readiness';
import { dayMs, rolling } from '@/lib/trends';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';
import { MetricChartCard, RangeSlicer } from './RangeChart';
import { AboutCard, RelatedRow, StatusPill } from './Sections';

type Props = { inputs: MetricInputs; range: Range; onRange: (r: Range) => void };

/** HRV status: the week's average against the personal baseline, and the nights behind it. */
export function HrvStatusDetail({ inputs, range, onRange }: Props) {
  const { palette } = useTheme();
  const def = METRICS.hrv_status;
  const h = useMemo(() => hrvStatus(inputs), [inputs]);
  const series = useMemo(() => detailSeries('hrv_status', inputs, range), [inputs, range]);

  // nights as dots with the 7-day mean through them; a year shows weekly means with a 4-week mean
  const overlay = useMemo<Series[]>(() => {
    if (range === 'year') return [{ name: 'weekly mean', color: palette.accent, points: series.points, kind: 'line', width: 2.5 }];
    const days = RANGES.find((r) => r.value === range)?.days ?? 7;
    const daily = dailyWindow('hrv', inputs, days + 7).map((d) => ({ x: dayMs(d.date), y: d.value }));
    return [
      { name: 'nightly', color: palette.mut, points: series.points, kind: 'points', opacity: 0.6 },
      { name: '7-day', color: palette.accent, points: rolling(daily, 7).slice(7), width: 2.5 },
    ];
  }, [range, series.points, inputs, palette]);

  const ms = (v: number | null) => (v == null ? '–' : `${Math.round(v)}`);
  const source = h.baselineSource === 'garmin' ? 'ms · from Garmin' : h.baselineSource === 'computed' ? 'ms · from your last 3 weeks' : 'needs 3 weeks of nights';

  return (
    <>
      <View style={{ gap: space.sm, paddingVertical: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <SymbolView name={def.icon} tintColor={palette.accent} size={22} />
          <T variant="h2">{def.label}</T>
        </View>
        <StatusPill word={h.status} tone={h.tone} />
        <T tone="ink2">{h.why}</T>
      </View>

      <Grid>
        <StatTile label="7-day average" value={ms(h.weekly)} sub={h.weekly == null ? 'no nights yet' : `ms · ${h.nights} night${h.nights === 1 ? '' : 's'}`} />
        <StatTile label="Baseline low" value={ms(h.baselineLow)} sub={h.baselineLow == null ? undefined : 'ms'} />
        <StatTile label="Baseline high" value={ms(h.baselineHigh)} sub={source} />
      </Grid>

      <RangeSlicer value={range} onChange={onRange} />
      <MetricChartCard id="hrv_status" inputs={inputs} range={range} series={series} overlay={overlay} showBaseline={range === 'year'} subtitle={range === 'day' ? undefined : 'Overnight HRV, ms, with your baseline shaded'} />

      <AboutCard def={def}>
        <T variant="small" tone="mut">
          Balanced: inside the baseline. Unbalanced: a little outside it, above or below. Low: well below. Poor: far below. The watch’s own band arrives only with a Garmin export backfill; otherwise it is the mean ± 1 sd of the three weeks before this one.
        </T>
      </AboutCard>
      <RelatedRow id="hrv_status" />
    </>
  );
}
