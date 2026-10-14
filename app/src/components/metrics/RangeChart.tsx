import { LineChart, type Series } from '@/components/charts/LineChart';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { METRICS, RANGES, type DetailSeries, type MetricId, type MetricInputs, type Range } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { DailyTimeline } from './DailyTimeline';
import { cursorFormatFor, xFormatFor } from './helpers';

const OPTIONS = RANGES.map((r) => ({ value: r.value, label: r.label }));

/** Day / Week / Month / Year. */
export function RangeSlicer({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return <Segmented<Range> options={OPTIONS} value={value} onChange={onChange} />;
}

type Props = {
  id: MetricId;
  inputs: MetricInputs;
  range: Range;
  series: DetailSeries;
  /** Replaces the metric's own series on the chart; the baseline and band still come from `series`. */
  overlay?: Series[];
  /** Defaults to on, unless an overlay is drawing its own lines. */
  showBaseline?: boolean;
  hideBand?: boolean;
  yMin?: number;
  yMax?: number;
  title?: string;
  subtitle?: string;
};

/**
 * The card under the slicer: the daily timeline for Day, a chart for the rest, with the rolling
 * mean dashed and the usual range shaded so one odd reading can be seen for what it is.
 */
export function MetricChartCard({ id, inputs, range, series, overlay, showBaseline, hideBand, yMin, yMax, title, subtitle }: Props) {
  const { palette } = useTheme();
  const def = METRICS[id];

  if (range === 'day') {
    return (
      <Card title={title} subtitle={subtitle ?? 'The last 14 days, newest first'}>
        <DailyTimeline id={id} rows={series.timeline} units={inputs.units} today={inputs.today} />
      </Card>
    );
  }

  const main: Series = series.kind === 'bars'
    ? { name: def.short, color: palette.accent, points: series.points, kind: 'bars', opacity: 0.6 }
    : { name: def.short, color: palette.accent, points: series.points, kind: 'line', width: 2.5 };
  const list: Series[] = [...(overlay ?? [main])];
  // a week of nightly readings is seven points: dots make a single night visible where the line breaks
  if (!overlay && series.kind === 'line' && range === 'week') {
    list.push({ name: `${def.short} nightly`, color: palette.accent, points: series.points, kind: 'points', opacity: 0.5, legend: false });
  }
  if ((showBaseline ?? !overlay) && series.baseline && series.baselineLabel) {
    list.push({ name: series.baselineLabel, color: palette.ink2, points: series.baseline, dashed: true, width: 1.5 });
  }
  const band = !hideBand && series.band ? { from: series.band.from, to: series.band.to, color: palette.aqua } : undefined;

  return (
    <Card title={title} subtitle={subtitle}>
      <LineChart
        height={220}
        series={list}
        band={band}
        bandLabel={band ? series.band?.label : undefined}
        yMin={yMin}
        yMax={yMax}
        yFormat={series.yFormat}
        xFormat={xFormatFor(range)}
        cursorFormat={cursorFormatFor(range)}
        emptyText="Nothing in this range yet"
      />
    </Card>
  );
}
