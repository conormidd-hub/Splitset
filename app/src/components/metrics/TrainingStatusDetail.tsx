import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import { View } from 'react-native';

import { LineChart, type Point } from '@/components/charts/LineChart';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { T } from '@/components/ui/T';
import { isoDate, weekStartIso } from '@/lib/dates';
import { formLevel, formatMetric, loadRatioLevel, METRICS, type MetricInputs } from '@/lib/metrics';
import { STATUS_MEANING, STATUS_TONE, trainingStatus, type TrainingStatusWord } from '@/lib/readiness';
import { acwr, dayMs, weeklySum } from '@/lib/trends';
import { vo2Trend } from '@/lib/vo2';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';
import { carryForward } from './helpers';
import { AboutCard, RelatedRow, StatusPill } from './Sections';

const DAY = 86_400_000;
const WEEKS = 8;
const STATUSES = Object.keys(STATUS_MEANING) as TrainingStatusWord[];

/**
 * Training status as Garmin Connect lays it out: the word and why, the load numbers behind it,
 * eight weeks of load, the VO2 max trend, and what every status would mean.
 */
export function TrainingStatusDetail({ inputs }: { inputs: MetricInputs }) {
  const { palette } = useTheme();
  const def = METRICS.training_status;
  const { units, today } = inputs;
  const s = useMemo(() => trainingStatus(inputs), [inputs]);

  // everything per week, so the bars and the rolling lines share one axis
  const load = useMemo(() => {
    // compared as dates, so the hour a clock change takes never drops the eighth week's bar
    const cutoff = isoDate(new Date(dayMs(weekStartIso(new Date(dayMs(today)))) - (WEEKS - 1) * 7 * DAY));
    const inRange = (p: Point) => isoDate(new Date(p.x)) >= cutoff;
    const all = acwr(inputs.activities);
    const perWeek = (ps: Point[]) => ps.filter(inRange).map((p) => ({ x: p.x, y: p.y == null ? null : p.y * 7 }));
    return {
      weekly: weeklySum(inputs.activities, (a) => a.load).filter(inRange),
      acute: perWeek(all.acute),
      chronic: perWeek(all.chronic),
    };
  }, [inputs.activities, today]);

  const vo2 = useMemo(() => {
    const t = vo2Trend(inputs.wellness, today);
    const cutoff = dayMs(today) - 90 * DAY;
    const seed = t.series.filter((p) => p.x < cutoff && p.y != null).pop()?.y ?? null;
    const recent = t.series.filter((p) => p.x >= cutoff);
    return { change30: t.change30, line: carryForward(recent, seed), dots: recent };
  }, [inputs.wellness, today]);

  const ratio = formatMetric('load_ratio', s.loadRatio, units);
  const ratioLevel = s.loadRatio == null ? null : loadRatioLevel(s.loadRatio);
  const form = formatMetric('form', s.form, units);
  const level = s.form == null ? null : formLevel(s.form);
  const vo2Sub = vo2.change30 == null ? 'No reading from 30 days ago to compare' : `${vo2.change30 > 0 ? '+' : vo2.change30 < 0 ? '−' : ''}${Math.abs(vo2.change30).toFixed(1)} in 30 days`;

  return (
    <>
      <View style={{ gap: space.sm, paddingVertical: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <SymbolView name={def.icon} tintColor={palette.accent} size={22} />
          <T variant="h2">{def.label}</T>
        </View>
        <StatusPill word={s.status} tone={s.tone} />
        <T tone="ink2">{s.why}</T>
      </View>

      <Grid>
        <StatTile label="Acute load" value={`${s.acuteLoad}`} sub="last 7 days" />
        <StatTile label="Load ratio" value={ratio.text} sub={ratioLevel ? ratioLevel.label : 'needs 4 weeks'} subTone={ratioLevel?.tone} />
        <StatTile label="Form" value={form.text} sub={level ? level.label : 'no load yet'} subTone={level?.tone} />
      </Grid>

      <Card title="Load" subtitle={`Per week over ${WEEKS} weeks: each week’s total, the rolling 7-day total, the 4-week average`}>
        <LineChart
          height={200}
          series={[
            { name: 'week', color: palette.blue, points: load.weekly, kind: 'bars', opacity: 0.35 },
            { name: '7-day', color: palette.orange, points: load.acute, width: 2 },
            { name: '28-day', color: palette.aqua, points: load.chronic, dashed: true },
          ]}
          yMin={0}
          yFormat={(v) => `${Math.round(v)}`}
          emptyText="No activities in the last eight weeks"
        />
      </Card>

      <Card title="VO2 max trend" subtitle={vo2Sub}>
        <LineChart
          height={160}
          series={[
            { name: 'VO2 max', color: palette.accent, points: vo2.line, width: 2.5 },
            { name: 'reading', color: palette.accent, points: vo2.dots, kind: 'points', opacity: 0.9, legend: false },
          ]}
          yFormat={(v) => v.toFixed(1)}
          showLegend={false}
          emptyText="No VO2 max in the last 90 days"
        />
      </Card>

      <Card title="What each status means" subtitle="Garmin’s own words">
        {STATUSES.map((w, i) => {
          const on = w === s.status;
          const tone = STATUS_TONE[w];
          return (
            <View key={w} style={{ flexDirection: 'row', gap: space.md, paddingVertical: space.sm, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
              <View style={{ width: 3, borderRadius: 2, backgroundColor: on ? palette.accent : 'transparent' }} />
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <T variant="h3" tone={on && tone !== 'mut' ? tone : 'ink'}>{w}</T>
                  {on ? <Badge label="NOW" tone="accent" /> : null}
                </View>
                <T variant="small" tone="mut">{STATUS_MEANING[w]}</T>
              </View>
            </View>
          );
        })}
      </Card>

      <AboutCard def={def}>
        <T variant="small" tone="mut">
          Garmin never sends its status to intervals.icu, so Splitset reads the same signals: fitness now against four weeks ago, the latest VO2 max against the month before, the 7-day load over the 28-day load, and HRV status.
        </T>
      </AboutCard>
      <RelatedRow id="training_status" />
    </>
  );
}
