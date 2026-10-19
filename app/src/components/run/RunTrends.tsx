import { format } from 'date-fns';
import { useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useHomeLayout } from '@/api/home';
import { useUnits } from '@/api/profile';
import { useRunTrendRows } from '@/api/runTrends';
import { EditableCharts } from '@/components/charts/EditableCharts';
import { LineChart, type Point } from '@/components/charts/LineChart';
import type { ScrollLink } from '@/components/home/ReorderGrid';
import { StackedBars } from '@/components/run/StackedBars';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { PickSheet, type PickSection } from '@/components/ui/PickSheet';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { useNowHour } from '@/lib/clock';
import { isoDate } from '@/lib/dates';
import { DEFAULT_RUN_TRENDS, isRunTrend, type RunTrend } from '@/lib/homeLayout';
import type { IconKey } from '@/lib/icons';
import { paceOf, perRun, rangeStart, rollingMean, weekly, weeklyZones, type TrendPoint } from '@/lib/runTrends';
import { KM_PER_MILE, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const RANGES = [
  { days: 91, label: '3m' },
  { days: 182, label: '6m' },
  { days: 365, label: '1y' },
  { days: 0, label: 'All' },
];

const FT_PER_M = 3.28084;
const CM_PER_IN = 2.54;
/** How many runs the trend line under each run's dot averages. */
const ROLL = 7;

/** A chart's card title, its one-line subtitle in the owner's units, and its icon in the Add sheet. */
function textOf(id: RunTrend, units: Units): { label: string; subtitle: string; icon: IconKey } {
  const imperial = units === 'imperial';
  const dist = imperial ? 'mi' : 'km';
  switch (id) {
    case 'run_weekly_distance': return { label: 'Weekly distance', subtitle: `${dist} per week, Monday to Sunday`, icon: 'run' };
    case 'run_weekly_time': return { label: 'Weekly time', subtitle: 'Hours running per week', icon: 'time' };
    case 'run_hr_zones': return { label: 'Heart-rate zones', subtitle: 'Hours in each zone per week, easy to hard', icon: 'heart' };
    case 'run_hr': return { label: 'Average heart rate', subtitle: `Each run in bpm, with a ${ROLL}-run mean`, icon: 'hrv' };
    case 'run_pace': return { label: 'Average pace', subtitle: `Each run in min/${dist}, with a ${ROLL}-run mean. Lower is faster`, icon: 'vo2' };
    case 'run_cadence': return { label: 'Cadence', subtitle: `Each run in steps per minute, with a ${ROLL}-run mean`, icon: 'steps' };
    case 'run_long': return { label: 'Long run', subtitle: `The longest run each week, ${dist}`, icon: 'route' };
    case 'run_weekly_count': return { label: 'Runs per week', subtitle: 'How many runs each week', icon: 'calendar' };
    case 'run_elevation': return { label: 'Weekly climb', subtitle: `Elevation gained per week, ${imperial ? 'ft' : 'm'}`, icon: 'status' };
    case 'run_stride': return { label: 'Stride length', subtitle: `Each run in ${imperial ? 'feet' : 'metres'}, with a ${ROLL}-run mean`, icon: 'walk' };
    case 'run_gct': return { label: 'Ground contact time', subtitle: `Each run in milliseconds, with a ${ROLL}-run mean`, icon: 'steps' };
    case 'run_vert_osc': return { label: 'Vertical oscillation', subtitle: `Each run in ${imperial ? 'inches' : 'cm'}, with a ${ROLL}-run mean`, icon: 'expand' };
    case 'run_power': return { label: 'Running power', subtitle: `Each run in watts, with a ${ROLL}-run mean`, icon: 'readiness' };
  }
}

/** The Add sheet's groups. */
const SECTIONS: { title: string; ids: RunTrend[] }[] = [
  { title: 'Volume', ids: ['run_weekly_distance', 'run_weekly_time', 'run_weekly_count', 'run_long', 'run_elevation'] },
  { title: 'Heart rate', ids: ['run_hr_zones', 'run_hr'] },
  { title: 'Form', ids: ['run_pace', 'run_cadence', 'run_stride', 'run_gct', 'run_vert_osc', 'run_power'] },
];

const scaled = (pts: TrendPoint[], f: (v: number) => number): Point[] => pts.map((p) => ({ x: p.x, y: p.y == null ? null : f(p.y) }));
const oneDp = (v: number) => (Math.abs(v) < 10 ? `${Math.round(v * 10) / 10}` : `${Math.round(v)}`);
const hours = (v: number) => `${oneDp(v)}h`;
const minSec = (v: number) => {
  const s = Math.round(v);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** Time in a zone in the tap readout: "45m" or "1h 05m". */
const zoneTime = (h: number) => {
  const m = Math.round(h * 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

/**
 * The Run tab's Trends: charts of the owner's running over a chosen range, laid out the way they
 * like, Home screen style (Edit to move or remove, Add for more, Reset for the default set). Weekly
 * volume as bars, time in each heart-rate zone stacked per week, and each run's heart rate, pace,
 * cadence and running dynamics as dots under a rolling mean. Saved with the home layout.
 */
export function RunTrends({ scroll, onDragChange }: { scroll?: ScrollLink; onDragChange?: (dragging: boolean) => void }) {
  const { palette } = useTheme();
  const units = useUnits();
  const { layout, save } = useHomeLayout();
  const ids = useMemo(() => (layout.runTrends ?? DEFAULT_RUN_TRENDS).filter(isRunTrend), [layout.runTrends]);
  const [days, setDays] = useState(182);
  const [adding, setAdding] = useState(false);
  const q = useRunTrendRows(days);
  // the range the rows on screen belong to: while a new range loads the last one's rows stay up,
  // and they are charted over their own span, not the new one's
  const [dataDays, setDataDays] = useState(days);
  if (q.isSuccess && !q.isPlaceholderData && dataDays !== days) setDataDays(days);
  // hour-granular "now" so the memo below is pure
  const nowHour = useNowHour();
  const today = isoDate(new Date(nowHour));

  const imperial = units === 'imperial';
  const charts = useMemo(() => {
    const rows = q.data ?? [];
    const span = { from: rangeStart(dataDays, today), to: today };
    const dist = (m: number) => (imperial ? m / 1000 / KM_PER_MILE : m / 1000);
    const each = (pick: Parameters<typeof perRun>[1], f: (v: number) => number = (v) => v) => {
      const pts = scaled(perRun(rows, pick), f);
      return { pts, mean: rollingMean(pts, ROLL) };
    };
    return {
      distance: scaled(weekly(rows, (r) => r.distance_m, 'sum', span), dist),
      time: scaled(weekly(rows, (r) => r.moving_time_s, 'sum', span), (s) => s / 3600),
      zones: weeklyZones(rows, span),
      long: scaled(weekly(rows, (r) => r.distance_m, 'max', span), dist),
      count: weekly(rows, () => 1, 'count', span),
      elevation: scaled(weekly(rows, (r) => r.elev_gain_m, 'sum', span), (m) => (imperial ? m * FT_PER_M : m)),
      hr: each((r) => r.avg_hr),
      pace: each(paceOf, (s) => (imperial ? s * KM_PER_MILE : s)),
      cadence: each((r) => r.cadence),
      stride: each((r) => r.stride_m, (m) => (imperial ? m * FT_PER_M : m)),
      gct: each((r) => r.gct_ms),
      vertOsc: each((r) => r.vert_osc_cm, (cm) => (imperial ? cm / CM_PER_IN : cm)),
      power: each((r) => r.avg_power_w),
    };
  }, [q.data, dataDays, today, imperial]);

  // a long range labels months; a short one, days
  const long = dataDays === 0 || dataDays > 200;
  const xFormat = (ms: number) => format(new Date(ms), long ? "MMM ''yy" : 'd MMM');
  const weekCursor = (ms: number) => `w/c ${format(new Date(ms), 'd MMM yyyy')}`;
  const runCursor = (ms: number) => format(new Date(ms), 'EEE d MMM yyyy');
  const distUnit = imperial ? 'mi' : 'km';

  const bars = (name: string, points: Point[], color: string, yFormat: (v: number) => string, emptyText?: string) => (
    <LineChart height={180} series={[{ name, color, points, kind: 'bars' }]} yFormat={yFormat} xFormat={xFormat} cursorFormat={weekCursor}
      showLegend={false} emptyText={emptyText ?? 'No runs in this range'} />
  );
  const dots = (s: { pts: Point[]; mean: Point[] }, color: string, yFormat: (v: number) => string, emptyText?: string) => (
    <LineChart height={180} series={[
      { name: 'run', color: palette.mut, points: s.pts, kind: 'points', opacity: 0.55 },
      { name: `${ROLL}-run mean`, color, points: s.mean },
    ]} yFormat={yFormat} xFormat={xFormat} cursorFormat={runCursor} emptyText={emptyText ?? 'No runs in this range'} />
  );
  const dynamics = 'No runs in this range have it. It needs a watch or pod that records running dynamics.';

  const renderChart = (id: string): ReactNode => {
    if (!isRunTrend(id)) return null;
    switch (id) {
      case 'run_weekly_distance': return bars(distUnit, charts.distance, palette.accent, oneDp);
      case 'run_weekly_time': return bars('hours', charts.time, palette.blue, hours);
      case 'run_hr_zones': {
        const { weeks, zones, folded } = charts.zones;
        // cool to hot, the run screen's zone colours with the hardest zone in red
        const colours = [palette.mut, palette.blue, palette.aqua, palette.amber, palette.neg];
        const layers = colours.slice(0, zones).map((color, i) => ({ name: `Z${i + 1}${folded && i === zones - 1 ? '+' : ''}`, color }));
        return (
          <StackedBars
            bars={weeks.map((w) => ({ x: w.x, values: w.values.map((s) => s / 3600) }))}
            layers={layers}
            height={180}
            yFormat={hours}
            valueFormat={zoneTime}
            xFormat={xFormat}
            cursorFormat={weekCursor}
            emptyText="No runs in this range have heart-rate zones"
          />
        );
      }
      case 'run_hr': return dots(charts.hr, palette.neg, (v) => `${Math.round(v)}`);
      case 'run_pace': return dots(charts.pace, palette.accent, minSec);
      case 'run_cadence': return dots(charts.cadence, palette.orange, (v) => `${Math.round(v)}`);
      case 'run_long': return bars(distUnit, charts.long, palette.aqua, oneDp);
      case 'run_weekly_count': return bars('runs', charts.count, palette.amber, (v) => `${Math.round(v)}`);
      case 'run_elevation': return bars(imperial ? 'ft' : 'm', charts.elevation, palette.aqua2, (v) => `${Math.round(v)}`);
      case 'run_stride': return dots(charts.stride, palette.blue, (v) => v.toFixed(2), dynamics);
      case 'run_gct': return dots(charts.gct, palette.amber, (v) => `${Math.round(v)}`, dynamics);
      case 'run_vert_osc': return dots(charts.vertOsc, palette.aqua, (v) => v.toFixed(1), dynamics);
      case 'run_power': return dots(charts.power, palette.orange, (v) => `${Math.round(v)}`, 'No runs in this range have power. It needs a watch or pod that records it.');
    }
  };

  const sections: PickSection[] = SECTIONS.map((s) => ({
    title: s.title,
    options: s.ids.map((id) => {
      const t = textOf(id, units);
      return { id, label: t.label, subtitle: t.subtitle, icon: t.icon, added: ids.includes(id) };
    }),
  }));

  const setIds = (next: string[]) => save({ ...layout, runTrends: next });

  return (
    <View style={{ gap: space.md }}>
      {q.error ? <ErrorBanner message={errorMessage(q.error)} /> : null}
      {q.isLoading ? (
        <Loading label="Loading your runs" />
      ) : (
        <EditableCharts
          ids={ids}
          textOf={(id) => (isRunTrend(id) ? textOf(id, units) : { label: id })}
          renderChart={renderChart}
          onChange={setIds}
          onAdd={() => setAdding(true)}
          onReset={() => save({ ...layout, runTrends: null })}
          resetText="The charts go back to weekly distance and time, heart-rate zones, heart rate, cadence and pace."
          toolbar={
            <ChipRow>
              {RANGES.map((r) => <Chip key={r.days} label={r.label} selected={days === r.days} onPress={() => setDays(r.days)} />)}
            </ChipRow>
          }
          emptyText="No charts. Tap Edit, then Add a chart."
          scroll={scroll}
          onDragChange={onDragChange}
        />
      )}
      <PickSheet
        visible={adding}
        title="Add a chart"
        sections={sections}
        onPick={(id) => { if (!ids.includes(id as RunTrend)) setIds([...ids, id]); }}
        onClose={() => setAdding(false)}
      />
    </View>
  );
}
