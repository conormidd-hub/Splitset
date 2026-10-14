import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import { View } from 'react-native';

import { Gauge } from '@/components/charts/Gauge';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { relativeDay } from '@/lib/dates';
import { detailSeries, METRICS, type MetricInputs, type Range } from '@/lib/metrics';
import { trainingReadiness, type ReadinessLevel } from '@/lib/readiness';
import { useTheme } from '@/theme/ThemeProvider';
import type { Palette } from '@/theme/tokens';
import { space } from '@/theme/tokens';
import { FactorBar } from './FactorBar';
import { MetricChartCard, RangeSlicer } from './RangeChart';
import { AboutCard, RelatedRow } from './Sections';

/** The ring's colour per band, cold to warm. */
const GAUGE: Record<ReadinessLevel, keyof Palette> = { Poor: 'neg', Low: 'amber', Moderate: 'blue', High: 'aqua', Prime: 'accent' };

const FACTOR_ABOUT = [
  { label: 'Sleep', text: 'last night’s sleep score, or hours against 7.5 h when the watch gives no score.' },
  { label: 'Recovery', text: 'hours until you are recovered: fatigue against fitness, and whether yesterday was a hard day.' },
  { label: 'HRV status', text: 'your 7-day overnight HRV average against your personal baseline.' },
  { label: 'Acute load', text: 'recent training, whose effect fades over about ten days, against the last four weeks.' },
  { label: 'Sleep history', text: 'the last three nights together.' },
  { label: 'Stress history', text: 'the last three days. Garmin’s stress score stays on the watch, so this is intervals.icu’s own 1–4 rating.' },
];

type Props = { inputs: MetricInputs; range: Range; onRange: (r: Range) => void };

/** Training readiness as Garmin Connect lays it out: the ring, the six factors, the history. */
export function ReadinessDetail({ inputs, range, onRange }: Props) {
  const { palette } = useTheme();
  const def = METRICS.readiness;
  const r = useMemo(() => trainingReadiness(inputs), [inputs]);
  const series = useMemo(() => detailSeries('readiness', inputs, range), [inputs, range]);
  const colour = r.level ? palette[GAUGE[r.level]] : palette.mut;

  return (
    <>
      <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'flex-start' }}>
          <SymbolView name={def.icon} tintColor={palette.accent} size={22} />
          <T variant="h2">{def.label}</T>
        </View>
        <Gauge value={r.score} size={160} thickness={12} color={colour} track={palette.surface3}>
          <T variant="display" tone={r.score == null ? 'mut' : 'ink'} style={{ fontVariant: ['tabular-nums'] }}>{r.score ?? '–'}</T>
          <T variant="small" weight="700" style={{ color: colour }}>{r.level ?? 'No score'}</T>
        </Gauge>
        <Badge
          label={r.source === 'intervals' ? 'From intervals.icu' : r.source === 'estimated' ? 'Estimated by Splitset' : 'No score yet'}
          tone={r.source === 'intervals' ? 'accent' : 'mut'}
        />
        <T tone="mut" align="center">{r.explain}</T>
        {r.date ? <T variant="small" tone="mut">{relativeDay(r.date)}</T> : null}
      </View>

      <Card title="Factors" subtitle="What Garmin weighs, each scored 0–100">
        <View style={{ gap: space.md }}>
          {r.factors.map((f) => <FactorBar key={f.key} label={f.label} score={f.score} text={f.text} tone={f.tone} />)}
        </View>
      </Card>

      <RangeSlicer value={range} onChange={onRange} />
      <MetricChartCard id="readiness" inputs={inputs} range={range} series={series} yMin={0} yMax={100} hideBand />

      <AboutCard def={def}>
        <View style={{ gap: space.xs, marginTop: space.xs }}>
          {FACTOR_ABOUT.map((f) => (
            <T key={f.label} variant="small" tone="mut">
              <T variant="small" weight="700" tone="ink2">{f.label}</T> {f.text}
            </T>
          ))}
        </View>
        <T variant="small" tone="mut">
          Garmin keeps its own Training Readiness on the watch and in Garmin Connect; it never reaches intervals.icu, so this score is Splitset’s estimate from the same ingredients, weighted sleep 30%, recovery 25%, HRV 15%, acute load 15%, sleep history 10%, stress 5%.
        </T>
      </AboutCard>
      <RelatedRow id="readiness" />
    </>
  );
}
