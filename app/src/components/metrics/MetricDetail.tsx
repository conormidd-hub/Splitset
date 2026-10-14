import { useMemo } from 'react';

import type { Series } from '@/components/charts/LineChart';
import { Card } from '@/components/ui/Card';
import { T } from '@/components/ui/T';
import { detailSeries, METRICS, snapshot, type MetricId, type MetricInputs, type Range } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { MetricHero } from './MetricHero';
import { MetricChartCard, RangeSlicer } from './RangeChart';
import { AboutCard, RelatedRow, StatsRow } from './Sections';

const LOAD_TRIO = ['fitness', 'fatigue', 'form'] as const;
type LoadId = (typeof LOAD_TRIO)[number];
const isLoadId = (id: MetricId): id is LoadId => (LOAD_TRIO as readonly MetricId[]).includes(id);

type Props = { id: MetricId; inputs: MetricInputs; range: Range; onRange: (r: Range) => void };

/**
 * The page every ordinary metric gets: hero, Day / Week / Month / Year, the timeline or chart,
 * the numbers, what it is, and its neighbours. The verdict pages (readiness, status, VO2 max)
 * have bodies of their own next door.
 */
export function MetricDetail({ id, inputs, range, onRange }: Props) {
  const { palette } = useTheme();
  const def = METRICS[id];
  const snap = useMemo(() => snapshot(id, inputs), [id, inputs]);
  const series = useMemo(() => detailSeries(id, inputs, range), [id, inputs, range]);

  // fitness, fatigue and form are one picture: whichever was tapped, draw all three and lead with it
  const trio = useMemo<Series[] | undefined>(() => {
    if (!isLoadId(id)) return undefined;
    const colour = { fitness: palette.blue, fatigue: palette.orange, form: palette.aqua } as const;
    return LOAD_TRIO.map((k) => {
      const on = k === id;
      return {
        name: METRICS[k].label,
        color: colour[k],
        points: on ? series.points : detailSeries(k, inputs, range).points,
        kind: k === 'fitness' ? 'area' : 'line',
        dashed: k === 'form',
        width: on ? 2.5 : 1.25,
        opacity: on ? 1 : 0.7,
      } satisfies Series;
    });
  }, [id, inputs, range, series.points, palette]);

  if (!def.available) {
    return (
      <>
        <MetricHero def={def} snap={snap} />
        <AboutCard def={def} />
        <RelatedRow id={id} />
      </>
    );
  }

  return (
    <>
      <MetricHero def={def} snap={snap} />
      {def.setupHint && snap.value == null ? (
        <Card tone="accent" title="Not set up yet">
          <T>{def.setupHint}</T>
        </Card>
      ) : null}
      <RangeSlicer value={range} onChange={onRange} />
      <MetricChartCard id={id} inputs={inputs} range={range} series={series} overlay={trio} />
      <StatsRow id={id} stats={series.stats} units={inputs.units} range={range} />
      <AboutCard def={def} />
      <RelatedRow id={id} />
    </>
  );
}
