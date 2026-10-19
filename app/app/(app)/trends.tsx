import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, View, type ScrollView } from 'react-native';

import { useRecentActivities } from '@/api/activities';
import { useHomeLayout } from '@/api/home';
import { useWorkouts } from '@/api/lifting';
import { useLiftPbs, useRunPbs } from '@/api/pbs';
import { useProfile, useUnits } from '@/api/profile';
import { useWellness } from '@/api/wellness';
import { LineChart, type Point } from '@/components/charts/LineChart';
import { AddMetricSheet } from '@/components/home/AddMetricSheet';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { SortableList } from '@/components/ui/SortableList';
import { T } from '@/components/ui/T';
import { useNowHour } from '@/lib/clock';
import { confirm } from '@/lib/confirm';
import { todayIso, weekStartIso } from '@/lib/dates';
import { BUILT_IN_TRENDS, DEFAULT_TRENDS, trendMetric, type BuiltInTrend } from '@/lib/homeLayout';
import { dailyWindow, formatMetric, isMetricId, METRICS, type MetricId, type MetricInputs } from '@/lib/metrics';
import { acwr, dayMs, rolling, runPoints, weeklyRunKm, weeklySum, wellnessSeries } from '@/lib/trends';
import { KM_PER_MILE, LB_PER_KG } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const RANGES = [
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 182, label: '6m' },
  { days: 365, label: '1y' },
  { days: 3650, label: 'All' },
];

/** The built-in charts' names and one-line descriptions, for the cards and the Add sheet. */
const BUILT_IN_TEXT: Record<BuiltInTrend, { label: string; subtitle: string }> = {
  weekly_running: { label: 'Weekly running', subtitle: 'Distance per week, Monday to Sunday' },
  training_load: { label: 'Training load', subtitle: '7-day mean against 28-day mean' },
  acwr: { label: 'Acute:chronic ratio', subtitle: '0.8 to 1.3 is the usual comfort band. A ramp gauge, not an injury score.' },
  fitness_fatigue: { label: 'Fitness and fatigue', subtitle: 'CTL, ATL and form from intervals.icu' },
  resting_hr: { label: 'Resting heart rate', subtitle: 'Nightly with 7-day and 30-day means' },
  hrv: { label: 'HRV', subtitle: 'Act on the rolling mean leaving its usual range, not on one low morning' },
  sleep: { label: 'Sleep', subtitle: 'Hours with a 7-day mean' },
  weight: { label: 'Weight', subtitle: 'Weigh-ins only' },
  cadence: { label: 'Cadence', subtitle: 'Runs of 4 km or more, steps per minute' },
  hr_per_run: { label: 'Average heart rate per run', subtitle: 'Runs of 4 km or more; the same pace costing fewer beats is fitness' },
  lift_volume: { label: 'Weekly lifting volume', subtitle: 'Weight moved per week across finished workouts' },
};
const BUILT_IN_LIST = BUILT_IN_TRENDS.map((id) => ({ id, ...BUILT_IN_TEXT[id] }));

/** Metrics that make a chart: every available one with a value per day (not the links). */
const chartable = (id: MetricId) => METRICS[id].available && id !== 'last_activity' && id !== 'pbs';
const WEEKLY: ReadonlySet<MetricId> = new Set(['weekly_distance', 'weekly_time', 'sessions', 'lift_volume']);

/**
 * Trends: charts over a chosen range, laid out the way the owner likes, Home screen style. The
 * built-in charts come first by default; Edit removes or drags them into a new order, and Add
 * puts back a built-in chart or charts any Home metric over time. The list is saved with the
 * home layout, so every device shows the same.
 */
export default function Trends() {
  const { palette } = useTheme();
  const units = useUnits();
  const [days, setDays] = useState(90);
  const wellness = useWellness(days);
  const activities = useRecentActivities(days);
  const workouts = useWorkouts(400);
  const runPbs = useRunPbs();
  const liftPbs = useLiftPbs();
  const profile = useProfile();
  const { layout, save } = useHomeLayout();
  const trends = layout.trends ?? DEFAULT_TRENDS;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(0);
  // hour-granular "now" so the memo below is pure and the screen re-renders at most hourly
  const nowHour = useNowHour();

  const distUnit = units === 'imperial' ? 'mi' : 'km';
  const massUnit = units === 'imperial' ? 'lb' : 'kg';
  const today = todayIso();
  const inputs = useMemo<MetricInputs>(() => ({
    wellness: wellness.data ?? [], activities: activities.data ?? [], workouts: workouts.data ?? [],
    runPbs: runPbs.data, liftPbs: liftPbs.data, profile: profile.data ?? null, units, today,
  }), [wellness.data, activities.data, workouts.data, runPbs.data, liftPbs.data, profile.data, units, today]);

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

  /** A built-in chart's body. */
  const builtIn = (id: BuiltInTrend): ReactNode => {
    switch (id) {
      case 'weekly_running':
        return <LineChart height={190} series={[{ name: distUnit, color: palette.accent, points: charts.weeklyKm, kind: 'bars' }]} yFormat={(v) => `${Math.round(v)}`} showLegend={false} />;
      case 'training_load':
        return (
          <>
            <LineChart height={190} series={[{ name: 'weekly load', color: palette.blue, points: charts.weeklyLoad, kind: 'bars', opacity: 0.35 }]} showLegend={false} />
            <LineChart height={170} series={[
              { name: '7-day', color: palette.orange, points: charts.acute },
              { name: '28-day', color: palette.aqua, points: charts.chronic, dashed: true },
            ]} yMin={0} />
          </>
        );
      case 'acwr':
        return <LineChart height={170} series={[{ name: 'ACWR', color: palette.ink2, points: charts.ratio }]} yMin={0} yMax={2} band={{ from: 0.8, to: 1.3, color: palette.aqua }} yFormat={(v) => v.toFixed(1)} showLegend={false} />;
      case 'fitness_fatigue':
        return <LineChart height={190} series={[
          { name: 'Fitness', color: palette.blue, points: charts.ctl, kind: 'area' },
          { name: 'Fatigue', color: palette.orange, points: charts.atl },
          { name: 'Form', color: palette.aqua, points: charts.tsb, dashed: true },
        ]} yFormat={(v) => `${Math.round(v)}`} />;
      case 'resting_hr':
        return <LineChart height={190} series={[
          { name: 'nightly', color: palette.mut, points: charts.rhr, kind: 'points', opacity: 0.6 },
          { name: '7-day', color: palette.accent, points: charts.rhr7 },
          { name: '30-day', color: palette.ink2, points: charts.rhr30, dashed: true },
        ]} yFormat={(v) => `${Math.round(v)}`} />;
      case 'hrv':
        return <LineChart height={190} series={[
          { name: 'nightly', color: palette.mut, points: charts.hrv, kind: 'points', opacity: 0.6 },
          { name: '7-day', color: palette.accent, points: charts.hrv7 },
          { name: '60-day', color: palette.ink2, points: charts.hrv60, dashed: true },
        ]} yFormat={(v) => `${Math.round(v)}`} />;
      case 'sleep':
        return <LineChart height={170} series={[
          { name: 'hours', color: palette.blue, points: charts.sleep, kind: 'bars', opacity: 0.45 },
          { name: '7-day', color: palette.accent, points: charts.sleep7 },
        ]} yMin={0} yFormat={(v) => v.toFixed(1)} />;
      case 'weight':
        return <LineChart height={170} series={[{ name: massUnit, color: palette.accent, points: charts.weight, kind: 'line' }]} yFormat={(v) => v.toFixed(1)} showLegend={false} emptyText="No weigh-ins in this range" />;
      case 'cadence':
        return <LineChart height={170} series={[{ name: 'spm', color: palette.orange, points: charts.cadence, kind: 'points' }]} yFormat={(v) => `${Math.round(v)}`} showLegend={false} />;
      case 'hr_per_run':
        return <LineChart height={170} series={[{ name: 'bpm', color: palette.neg, points: charts.hrAtPace, kind: 'points' }]} yFormat={(v) => `${Math.round(v)}`} showLegend={false} />;
      case 'lift_volume':
        return <LineChart height={170} series={[{ name: massUnit, color: palette.aqua2, points: charts.liftVolume, kind: 'bars' }]} yFormat={(v) => `${Math.round(v / 1000)}k`} showLegend={false} emptyText="Finish a workout to see volume here" />;
    }
  };

  /** A metric over the range: points and a 7-day mean, or weekly bars for the weekly totals. */
  const metricChart = (id: MetricId): ReactNode => {
    const daily = dailyWindow(id, inputs, Math.min(days, 730));
    const fmt = (v: number) => formatMetric(id, v, units).text;
    if (WEEKLY.has(id)) {
      const weeks = new Map<string, number>();
      for (const d of daily) if (d.value != null) weeks.set(weekStartIso(new Date(dayMs(d.date))), (weeks.get(weekStartIso(new Date(dayMs(d.date)))) ?? 0) + d.value);
      const points: Point[] = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wk, v]) => ({ x: dayMs(wk), y: v }));
      return <LineChart height={170} series={[{ name: METRICS[id].short, color: palette.accent, points, kind: 'bars' }]} yFormat={fmt} showLegend={false} />;
    }
    const points: Point[] = daily.map((d) => ({ x: dayMs(d.date), y: d.value }));
    return <LineChart height={170} series={[
      { name: 'daily', color: palette.mut, points, kind: 'points', opacity: 0.6 },
      { name: '7-day', color: palette.accent, points: rolling(points, 7) },
    ]} yFormat={fmt} emptyText="No readings in this range" />;
  };

  const textOf = (id: string): { label: string; subtitle: string } => {
    const metric = trendMetric(id);
    if (metric && isMetricId(metric)) {
      const def = METRICS[metric];
      return { label: def.label, subtitle: WEEKLY.has(metric) ? 'Per week' : 'Daily, with a 7-day mean' };
    }
    const t = BUILT_IN_TEXT[id as BuiltInTrend];
    if (!t) return { label: id, subtitle: '' };
    if (id === 'weekly_running') return { ...t, subtitle: `${distUnit} per week, Monday to Sunday` };
    if (id === 'weight') return { ...t, subtitle: `Weigh-ins only, ${massUnit}` };
    if (id === 'lift_volume') return { ...t, subtitle: `${massUnit} moved per week across finished workouts` };
    return t;
  };

  const setTrends = (next: string[]) => save({ ...layout, trends: next });
  const remove = (id: string) => setTrends(trends.filter((t) => t !== id));
  const move = (id: string, to: number) => {
    const next = trends.filter((t) => t !== id);
    next.splice(to, 0, id);
    setTrends(next);
  };
  const reset = async () => {
    if (await confirm('Reset Trends?', 'The charts go back to the built-in set, in order.', 'Reset', true)) save({ ...layout, trends: null });
  };

  const card = (id: string, handle: ReactNode) => {
    const { label, subtitle } = textOf(id);
    const metric = trendMetric(id);
    return (
      <Card
        title={label}
        subtitle={subtitle}
        right={editing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            {handle}
            <Pressable onPress={() => remove(id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${label}`}>
              <T tone="neg" weight="700">✕</T>
            </Pressable>
          </View>
        ) : undefined}>
        {editing ? null : metric && isMetricId(metric) ? metricChart(metric) : builtIn(id as BuiltInTrend)}
      </Card>
    );
  };

  return (
    <Screen
      title="Trends"
      subtitle="Over time"
      right={<Button title={editing ? 'Done' : 'Edit'} variant="ghost" small onPress={() => setEditing((e) => !e)} />}
      scrollEnabled={!dragging}
      scrollRef={scrollRef}
      onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
      refreshing={wellness.isFetching || activities.isFetching}
      onRefresh={() => { wellness.refetch(); activities.refetch(); workouts.refetch(); }}>
      {editing ? (
        <T variant="small" tone="mut">Drag a chart by its handle to move it, ✕ removes it, and Add a trend puts back a chart or charts any metric over time.</T>
      ) : (
        <ChipRow>
          {RANGES.map((r) => <Chip key={r.days} label={r.label} selected={days === r.days} onPress={() => setDays(r.days)} />)}
        </ChipRow>
      )}
      {loading && !editing ? <T tone="mut">Loading…</T> : null}

      {editing ? (
        // collapsed to their titles while editing, so a long list is easy to rearrange
        <SortableList
          keys={trends}
          itemLabel={(id) => textOf(id).label}
          onMove={move}
          onDragChange={setDragging}
          scroll={{ ref: scrollRef, y: scrollY }}
          renderItem={(id, { handle }) => card(id, handle)}
        />
      ) : (
        trends.map((id) => <View key={id}>{card(id, null)}</View>)
      )}
      {!trends.length && !editing ? <T tone="mut" align="center">No charts. Tap Edit, then Add a trend.</T> : null}

      {editing ? (
        <View style={{ gap: space.sm }}>
          <Button title="Add a trend" variant="secondary" onPress={() => setAdding(true)} />
          <Button title="Reset to default" variant="ghost" small onPress={() => { void reset(); }} />
        </View>
      ) : (
        <Button title="Add a trend" variant="ghost" small onPress={() => { setEditing(true); setAdding(true); }} />
      )}

      <AddMetricSheet
        visible={adding}
        mode="trend"
        layout={layout}
        trends={trends}
        builtInTrends={BUILT_IN_LIST}
        chartable={chartable}
        onAddTrend={(id) => { if (!trends.includes(id)) setTrends([...trends, id]); }}
        onClose={() => setAdding(false)}
        onAdd={() => undefined}
        onPick={() => undefined}
      />
    </Screen>
  );
}
