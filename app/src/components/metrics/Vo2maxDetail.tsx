import { router } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import type { PbPeriods, RunPb } from '@/api/pbs';
import type { Series } from '@/components/charts/LineChart';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { T } from '@/components/ui/T';
import { dailyValues, describeDelta, detailSeries, METRICS, snapshot, type MetricInputs, type Range } from '@/lib/metrics';
import { formatDuration, formatPace, type Units } from '@/lib/units';
import { ageFromBirthYear, FITNESS_LEVELS, fitnessTable, raceTimes, vdotFromRace, vo2Classification, vo2Trend, type Fitness, type Sex } from '@/lib/vo2';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';
import { carryForward } from './helpers';
import { MetricHero } from './MetricHero';
import { MetricChartCard, RangeSlicer } from './RangeChart';
import { AboutCard, RelatedRow, StatsRow } from './Sections';

type Props = {
  inputs: MetricInputs;
  range: Range;
  onRange: (r: Range) => void;
  /** Opened as the race predictor: lead with the race card. */
  focusRaces?: boolean;
};

/**
 * VO2 max the way Garmin Connect shows it: the number, where it sits in the fitness table
 * for the athlete's age and sex, how it has moved, and the race times it implies.
 */
export function Vo2maxDetail({ inputs, range, onRange, focusRaces }: Props) {
  const { palette } = useTheme();
  const def = METRICS.vo2max;
  const { units, today } = inputs;
  const snap = useMemo(() => snapshot('vo2max', inputs), [inputs]);
  const trend = useMemo(() => vo2Trend(inputs.wellness, today), [inputs.wellness, today]);
  const sex: Sex | null = inputs.profile?.sex === 'male' || inputs.profile?.sex === 'female' ? inputs.profile.sex : null;
  const age = ageFromBirthYear(inputs.profile?.birth_year);
  const cls = useMemo(() => vo2Classification(trend.latest, age, sex), [trend.latest, age, sex]);

  const series = useMemo(() => detailSeries('vo2max', inputs, range), [inputs, range]);
  // Garmin re-estimates VO2 max every few runs, so the chart holds each reading until the next
  const overlay = useMemo<Series[]>(() => {
    const first = series.points[0]?.x ?? Infinity;
    const history = dailyValues('vo2max', inputs);
    let seed: number | null = null;
    for (const h of history) {
      if (Date.parse(`${h.date}T12:00:00`) >= first) break;
      if (h.value != null) seed = h.value;
    }
    return [
      { name: def.short, color: palette.accent, points: carryForward(series.points, seed), kind: 'line', width: 2.5 },
      { name: 'reading', color: palette.accent, points: series.points, kind: 'points', opacity: 0.9, legend: false },
    ];
  }, [series.points, inputs, palette, def.short]);

  const level = cls.level ? { label: cls.level, tone: cls.tone, index: cls.index ?? 0, of: 5 } : null;
  const profileMissing = trend.latest != null && (age == null || !sex);

  const fitness = (
    <Card title="Fitness level" subtitle={cls.level ? cls.note : 'Garmin’s table, by age and sex'}>
      <View style={{ gap: space.md }}>
        {sex ? <FitnessTable sex={sex} bandIndex={cls.bandIndex} level={cls.level} /> : null}
        {profileMissing ? (
          <View style={{ gap: space.sm, alignItems: 'flex-start' }}>
            <T tone="mut">{cls.note}</T>
            <Button title="Add in Settings" variant="ghost" small onPress={() => router.push('/settings')} />
          </View>
        ) : null}
        {trend.latest == null ? <T tone="mut">{cls.note}</T> : null}
        <T variant="tiny" tone="mut">Lower bound of each level in ml/kg/min, from Garmin’s ratings table (The Cooper Institute). Under-20s are rated on the 20–29 row.</T>
      </View>
    </Card>
  );

  const trendCard = (
    <Card title="Trend" subtitle="The latest reading against the average around then">
      <Grid>
        <ChangeTile label="30 days" change={trend.change30} units={units} />
        <ChangeTile label="90 days" change={trend.change90} units={units} />
        <ChangeTile label="1 year" change={trend.change365} units={units} />
      </Grid>
    </Card>
  );

  const races = <RaceCard vdot={trend.latest} runPbs={inputs.runPbs} units={units} />;

  return (
    <>
      <MetricHero def={def} snap={snap} level={level} levelLabels={FITNESS_LEVELS} />
      {focusRaces ? races : null}
      {fitness}
      {trendCard}
      <RangeSlicer value={range} onChange={onRange} />
      <MetricChartCard id="vo2max" inputs={inputs} range={range} series={series} overlay={overlay} />
      <StatsRow id="vo2max" stats={series.stats} units={units} range={range} />
      {focusRaces ? null : races}
      <AboutCard def={def}>
        <T variant="small" tone="mut">Only the running estimate reaches intervals.icu; cycling VO2 max and Garmin’s fitness age stay in Garmin Connect.</T>
      </AboutCard>
      <RelatedRow id={focusRaces ? 'race_predictor' : 'vo2max'} />
    </>
  );
}

function ChangeTile({ label, change, units }: { label: string; change: number | null; units: Units }) {
  const d = change == null ? null : describeDelta('vo2max', change, units);
  return <StatTile label={label} value={d?.text ?? '–'} sub={d ? 'ml/kg/min' : 'no reading then'} subTone={d?.tone} />;
}

const COLS = ['fair', 'good', 'excellent', 'superior'] as const;

/** Garmin's ratings table for one sex, the athlete's row lit and their level's cell in accent. */
function FitnessTable({ sex, bandIndex, level }: { sex: Sex; bandIndex: number | null; level: Fitness | null }) {
  const { palette } = useTheme();
  const rows = fitnessTable(sex);
  const hot = level && level !== 'Poor' ? (level.toLowerCase() as (typeof COLS)[number]) : null;
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: palette.hair }}>
        <T variant="label" tone="mut" style={{ width: 56, paddingLeft: 6 }}>age</T>
        {COLS.map((c) => (
          <T key={c} variant="label" tone="mut" style={{ flex: 1, textAlign: 'center' }}>{c}</T>
        ))}
      </View>
      {rows.map((r, i) => {
        const mine = i === bandIndex;
        return (
          <View key={r.age} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderRadius: radius.sm, backgroundColor: mine ? palette.accentSoft : 'transparent' }}>
            <T variant="small" tone={mine ? 'accent' : 'ink2'} weight={mine ? '700' : '500'} style={{ width: 56, paddingLeft: 6 }}>{r.age}</T>
            {COLS.map((c) => {
              const on = mine && c === hot;
              return (
                <View key={c} style={{ flex: 1, alignItems: 'center' }}>
                  <T
                    variant="small"
                    tone={on ? 'onAccent' : mine ? 'ink' : 'ink2'}
                    weight={on ? '700' : undefined}
                    style={{ fontVariant: ['tabular-nums'], paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: on ? palette.accent : 'transparent' }}>
                    {r[c].toFixed(1)}
                  </T>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

function gapText(gap: number): { text: string; tone: 'pos' | 'mut' } {
  const s = Math.abs(gap);
  if (s < 1) return { text: 'spot on', tone: 'pos' };
  const t = s < 60 ? `${Math.round(s)} s` : formatDuration(s);
  return gap < 0 ? { text: `${t} faster`, tone: 'pos' } : { text: `${t} slower`, tone: 'mut' };
}

/** Daniels' race times from the VO2 max, each beside the athlete's own best for the distance. */
function RaceCard({ vdot, runPbs, units }: { vdot: number | null; runPbs: Map<string, PbPeriods<RunPb>> | undefined; units: Units }) {
  const { palette } = useTheme();
  const rows = vdot == null ? [] : raceTimes(vdot);
  return (
    <Card title="Race predictor" subtitle={vdot == null ? undefined : `From VO2 max ${vdot.toFixed(1)}, treated as VDOT`}>
      {vdot == null ? (
        <T tone="mut">Needs a VO2 max. Garmin estimates one on outdoor runs with heart rate.</T>
      ) : (
        <View>
          <View style={{ flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: palette.hair }}>
            <T variant="label" tone="mut" style={{ width: 72 }}>race</T>
            <T variant="label" tone="mut" style={{ flex: 1 }}>predicted</T>
            <T variant="label" tone="mut" style={{ width: 118, textAlign: 'right' }}>your best</T>
          </View>
          {rows.map((r) => {
            const pb = runPbs?.get(r.pb)?.all;
            const pbSecs = pb?.seconds ?? null;
            const gap = pbSecs != null && r.seconds != null ? gapText(pbSecs - r.seconds) : null;
            const pbVdot = pbSecs != null ? vdotFromRace(r.distanceM, pbSecs) : null;
            return (
              <View key={r.pb} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: palette.hair }}>
                <T variant="h3" style={{ width: 72 }}>{r.label}</T>
                <View style={{ flex: 1 }}>
                  <T variant="mono" weight="700">{r.seconds == null ? '–' : formatDuration(r.seconds)}</T>
                  <T variant="small" tone="mut">{r.seconds == null ? 'out of range' : formatPace(r.seconds / (r.distanceM / 1000), units)}</T>
                </View>
                <View style={{ width: 118, alignItems: 'flex-end' }}>
                  <T variant="mono" tone={pbSecs == null ? 'mut' : 'ink'}>{pbSecs == null ? '–' : formatDuration(pbSecs)}</T>
                  {gap ? <T variant="small" tone={gap.tone}>{gap.text}</T> : <T variant="small" tone="mut">no PB yet</T>}
                  {pbVdot != null ? <T variant="tiny" tone="mut">VDOT {pbVdot.toFixed(1)}</T> : null}
                </View>
              </View>
            );
          })}
          <T variant="tiny" tone="mut" style={{ marginTop: space.sm }}>
            From your VO2 max with Daniels’ formula. Garmin’s predictor also weighs training history; treat as a fitness guide.
          </T>
        </View>
      )}
    </Card>
  );
}
