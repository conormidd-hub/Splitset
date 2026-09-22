import { useMemo, useState } from 'react';

import { useRecentActivities } from '@/api/activities';
import { useWorkouts } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { useWellness } from '@/api/wellness';
import { LineChart } from '@/components/charts/LineChart';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { T } from '@/components/ui/T';
import { useNowSeconds } from '@/lib/clock';
import { weekStartIso } from '@/lib/dates';
import { acwr, dayMs, rolling, runPoints, weeklyRunKm, weeklySum, wellnessSeries } from '@/lib/trends';
import { KM_PER_MILE, LB_PER_KG } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';

const RANGES = [
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 182, label: '6m' },
  { days: 365, label: '1y' },
  { days: 3650, label: 'All' },
];

export default function Trends() {
  const { palette } = useTheme();
  const units = useUnits();
  const [days, setDays] = useState(90);
  const wellness = useWellness(days);
  const activities = useRecentActivities(days);
  const workouts = useWorkouts(400);
  // hour-granular "now" so the memo below is pure and recomputes at most hourly
  const nowHour = Math.floor(useNowSeconds() / 3600) * 3600 * 1000;

  const distUnit = units === 'imperial' ? 'mi' : 'km';
  const massUnit = units === 'imperial' ? 'lb' : 'kg';

  const charts = useMemo(() => {
    const w = wellness.data ?? [];
    const a = activities.data ?? [];
    const km = units === 'imperial' ? (v: number) => v / KM_PER_MILE : (v: number) => v;
    const kg = units === 'imperial' ? (v: number) => v * LB_PER_KG : (v: number) => v;
    const rhr = wellnessSeries(w, 'resting_hr');
    const hrv = wellnessSeries(w, 'hrv');
    const sleep = wellnessSeries(w, 'sleep_s', (v) => v / 3600);
    const weight = wellnessSeries(w, 'weight_kg', kg).filter((p) => p.y != null);
    const ctl = wellnessSeries(w, 'ctl');
    const atl = wellnessSeries(w, 'atl');
    const load = acwr(a);
    const cutoff = nowHour - days * 86_400_000;
    const liftVolume = new Map<string, number>();
    for (const wk of workouts.data ?? []) {
      if (!wk.started_at || Date.parse(wk.started_at) < cutoff) continue;
      const key = weekStartIso(new Date(wk.started_at));
      liftVolume.set(key, (liftVolume.get(key) ?? 0) + kg(wk.volume_kg ?? 0));
    }
    return {
      weeklyKm: weeklyRunKm(a).map((p) => ({ x: p.x, y: p.y == null ? null : km(p.y) })),
      weeklyLoad: weeklySum(a, (x) => x.load),
      rhr, rhr7: rolling(rhr, 7), rhr30: rolling(rhr, 30),
      hrv, hrv7: rolling(hrv, 7), hrv60: rolling(hrv, 60),
      sleep, sleep7: rolling(sleep, 7),
      weight,
      ctl, atl, tsb: ctl.map((p, i) => ({ x: p.x, y: p.y != null && atl[i].y != null ? p.y - (atl[i].y as number) : null })),
      acute: load.acute.filter((p) => p.x >= cutoff), chronic: load.chronic.filter((p) => p.x >= cutoff), ratio: load.ratio.filter((p) => p.x >= cutoff),
      cadence: runPoints(a, (x) => x.cadence),
      hrAtPace: runPoints(a, (x) => x.avg_hr),
      liftVolume: [...liftVolume.entries()].sort().map(([wk, v]) => ({ x: dayMs(wk), y: Math.round(v) })),
    };
  }, [wellness.data, activities.data, workouts.data, days, units, nowHour]);

  const loading = wellness.isLoading || activities.isLoading;

  return (
    <Screen title="Trends" subtitle="Over time" refreshing={wellness.isFetching || activities.isFetching} onRefresh={() => { wellness.refetch(); activities.refetch(); workouts.refetch(); }}>
      <ChipRow>
        {RANGES.map((r) => <Chip key={r.days} label={r.label} selected={days === r.days} onPress={() => setDays(r.days)} />)}
      </ChipRow>
      {loading ? <T tone="mut">Loading…</T> : null}

      <Card title="Weekly running" subtitle={`${distUnit} per week, Monday to Sunday`}>
        <LineChart height={190} series={[{ name: distUnit, color: palette.accent, points: charts.weeklyKm, kind: 'bars' }]} yFormat={(v) => `${Math.round(v)}`} showLegend={false} />
      </Card>

      <Card title="Training load" subtitle="7-day mean against 28-day mean">
        <LineChart height={190} series={[
          { name: 'weekly load', color: palette.blue, points: charts.weeklyLoad, kind: 'bars', opacity: 0.35 },
        ]} showLegend={false} />
        <LineChart height={170} series={[
          { name: '7-day', color: palette.orange, points: charts.acute },
          { name: '28-day', color: palette.aqua, points: charts.chronic, dashed: true },
        ]} yMin={0} />
      </Card>

      <Card title="Acute:chronic ratio" subtitle="0.8 to 1.3 is the usual comfort band. A ramp gauge, not an injury score.">
        <LineChart height={170} series={[{ name: 'ACWR', color: palette.ink2, points: charts.ratio }]} yMin={0} yMax={2} band={{ from: 0.8, to: 1.3, color: palette.aqua }} yFormat={(v) => v.toFixed(1)} showLegend={false} />
      </Card>

      <Card title="Fitness and fatigue" subtitle="CTL, ATL and form from intervals.icu">
        <LineChart height={190} series={[
          { name: 'Fitness', color: palette.blue, points: charts.ctl, kind: 'area' },
          { name: 'Fatigue', color: palette.orange, points: charts.atl },
          { name: 'Form', color: palette.aqua, points: charts.tsb, dashed: true },
        ]} yFormat={(v) => `${Math.round(v)}`} />
      </Card>

      <Card title="Resting heart rate" subtitle="Nightly with 7-day and 30-day means">
        <LineChart height={190} series={[
          { name: 'nightly', color: palette.mut, points: charts.rhr, kind: 'points', opacity: 0.6 },
          { name: '7-day', color: palette.accent, points: charts.rhr7 },
          { name: '30-day', color: palette.ink2, points: charts.rhr30, dashed: true },
        ]} yFormat={(v) => `${Math.round(v)}`} />
      </Card>

      <Card title="HRV" subtitle="Act on the rolling mean leaving its usual range, not on one low morning">
        <LineChart height={190} series={[
          { name: 'nightly', color: palette.mut, points: charts.hrv, kind: 'points', opacity: 0.6 },
          { name: '7-day', color: palette.accent, points: charts.hrv7 },
          { name: '60-day', color: palette.ink2, points: charts.hrv60, dashed: true },
        ]} yFormat={(v) => `${Math.round(v)}`} />
      </Card>

      <Card title="Sleep" subtitle="Hours with a 7-day mean">
        <LineChart height={170} series={[
          { name: 'hours', color: palette.blue, points: charts.sleep, kind: 'bars', opacity: 0.45 },
          { name: '7-day', color: palette.accent, points: charts.sleep7 },
        ]} yMin={0} yFormat={(v) => v.toFixed(1)} />
      </Card>

      <Card title="Weight" subtitle={`Weigh-ins only, ${massUnit}`}>
        <LineChart height={170} series={[{ name: massUnit, color: palette.accent, points: charts.weight, kind: 'line' }]} yFormat={(v) => v.toFixed(1)} showLegend={false} emptyText="No weigh-ins in this range" />
      </Card>

      <Card title="Cadence" subtitle="Runs of 4 km or more, steps per minute">
        <LineChart height={170} series={[{ name: 'spm', color: palette.orange, points: charts.cadence, kind: 'points' }]} yFormat={(v) => `${Math.round(v)}`} showLegend={false} />
      </Card>

      <Card title="Average heart rate per run" subtitle="Runs of 4 km or more; the same pace costing fewer beats is fitness">
        <LineChart height={170} series={[{ name: 'bpm', color: palette.neg, points: charts.hrAtPace, kind: 'points' }]} yFormat={(v) => `${Math.round(v)}`} showLegend={false} />
      </Card>

      <Card title="Weekly lifting volume" subtitle={`${massUnit} moved per week across finished workouts`}>
        <LineChart height={170} series={[{ name: massUnit, color: palette.aqua2, points: charts.liftVolume, kind: 'bars' }]} yFormat={(v) => `${Math.round(v / 1000)}k`} showLegend={false} emptyText="Finish a workout to see volume here" />
      </Card>
    </Screen>
  );
}
