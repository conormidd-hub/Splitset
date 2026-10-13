import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { T } from '@/components/ui/T';
import { describeDelta, formatMetric, METRIC_ORDER, METRICS, type DetailSeries, type MetricDef, type MetricId, type Range, type Tone } from '@/lib/metrics';
import type { Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';
import { rangeNoun, toneSoft } from './helpers';

/** Latest, average, low, high and the change across the range, each with its unit. */
export function StatsRow({ id, stats, units, range }: { id: MetricId; stats: DetailSeries['stats']; units: Units; range: Range }) {
  const tile = (label: string, v: number | null) => {
    const f = formatMetric(id, v, units);
    return <StatTile label={label} value={f.text} sub={v == null ? undefined : f.unit} />;
  };
  const change = stats.change == null ? null : describeDelta(id, stats.change, units);
  return (
    <Grid>
      {tile('Latest', stats.latest)}
      {tile('Average', stats.mean)}
      {tile('Low', stats.min)}
      {tile('High', stats.max)}
      <StatTile label="Change" value={change?.text ?? '–'} sub={change ? `over ${rangeNoun(range)}` : undefined} subTone={change?.tone} />
    </Grid>
  );
}

/** What the metric is and how Garmin measures it, plus anything extra the page wants to add. */
export function AboutCard({ def, children }: { def: MetricDef; children?: ReactNode }) {
  return (
    <Card title="About">
      <View style={{ gap: space.sm }}>
        <T tone="ink2">{def.description}</T>
        {def.setupHint ? <T variant="small" tone="mut">{def.setupHint}</T> : null}
        {children}
      </View>
    </Card>
  );
}

/** The other metrics in the same group, one tap away. */
export function RelatedRow({ id }: { id: MetricId }) {
  const group = METRICS[id].group;
  const others = METRIC_ORDER.filter((m) => m !== id && METRICS[m].group === group && METRICS[m].available);
  if (!others.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      <T variant="label" tone="mut">Related</T>
      <ChipRow>
        {others.map((m) => (
          <Chip key={m} label={METRICS[m].short} onPress={() => router.push({ pathname: '/metric/[id]', params: { id: m } })} />
        ))}
      </ChipRow>
    </View>
  );
}

/** A verdict word, big, on a wash of its own colour: Productive, Balanced, Strained. */
export function StatusPill({ word, tone }: { word: string; tone: Tone }) {
  const { palette } = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: toneSoft(palette, tone), borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
      <T variant="h1" tone={tone === 'mut' ? 'ink2' : tone}>{word}</T>
    </View>
  );
}
