import { format } from 'date-fns';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useHomeLayout } from '@/api/home';
import { useExercises, useRecords, type Exercise } from '@/api/lifting';
import { useLiftProgress } from '@/api/liftTrends';
import { useUnits } from '@/api/profile';
import { useThresholds } from '@/api/recovery';
import { EditableCharts } from '@/components/charts/EditableCharts';
import { LineChart } from '@/components/charts/LineChart';
import type { ScrollLink } from '@/components/home/ReorderGrid';
import { Button } from '@/components/ui/Button';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { PickSheet, type PickOption, type PickSection } from '@/components/ui/PickSheet';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowHour } from '@/lib/clock';
import { relativeDay } from '@/lib/dates';
import { liftTrend, parseLiftTrend, type LiftMeasure } from '@/lib/homeLayout';
import {
  defaultLiftMeasure, defaultLiftTrends, e1rmOfSet, isWeightMeasure, liftMeasuresFor, progressPoints, progressSummary, rangeStart, workoutBests,
} from '@/lib/lifting/progression';
import { bodyweightRelative } from '@/lib/pbs';
import type { Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const RANGES = [
  { key: '3m', label: '3m', days: 91 },
  { key: '6m', label: '6m', days: 182 },
  { key: '1y', label: '1y', days: 365 },
  { key: 'all', label: 'All', days: null },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

const MEASURE_LABEL: Record<LiftMeasure, string> = { e1rm: 'Best e1RM', heaviest: 'Heaviest', volume: 'Volume', reps: 'Reps' };

/** A card's subtitle: what its line follows, and in what. */
function measureText(m: LiftMeasure, ex: Exercise | undefined, unit: string): string {
  const added = ex?.load_mode === 'bodyweight';
  switch (m) {
    case 'e1rm': return `Best estimated 1RM per workout, ${unit}${bodyweightRelative(ex?.load_mode) ? ', bodyweight included' : ''}`;
    case 'heaviest': return added ? `Most weight added per workout, ${unit}` : `Heaviest set per workout, ${unit}`;
    case 'volume': return `Volume per workout (${added ? 'added weight' : 'weight'} × reps), ${unit}`;
    case 'reps': return 'Most reps in one set per workout';
  }
}

/** A number as the chart shows it: whole above 100, else to one decimal without a trailing .0. */
const num = (v: number) => (Math.abs(v) >= 100 ? `${Math.round(v)}` : `${Math.round(v * 10) / 10}`);
/** Axis labels: volumes in thousands once they get long. */
const axis = (v: number) => (Math.abs(v) >= 10_000 ? `${Math.round(v / 1000)}k` : num(v));

/**
 * The Lift tab's Trends, Strong style: a card per lift charting one point per workout (its best
 * e1RM, heaviest set, volume or most reps) over the chosen range. Laid out like the Home screen:
 * Edit drags or removes cards, Add charts another lift, and the small chips on a card switch what
 * it follows. Until the owner changes it, the list is the main compound lifts they have logged.
 * Saved with the home layout, so every device shows the same.
 */
export function LiftTrends({ scroll, onDragChange }: { scroll?: ScrollLink; onDragChange?: (dragging: boolean) => void }) {
  const units = useUnits();
  const exercises = useExercises();
  const records = useRecords();
  const { layout, save, error } = useHomeLayout();
  const [range, setRange] = useState<RangeKey>('6m');
  const [adding, setAdding] = useState(false);
  // hour-granular "now", so the range's start is pure and the charts redraw at most hourly
  const nowHour = useNowHour();
  const unit = units === 'imperial' ? 'lb' : 'kg';

  const byId = useMemo(() => new Map((exercises.data ?? []).map((e) => [e.id, e])), [exercises.data]);
  const defaults = useMemo(() => defaultLiftTrends(exercises.data ?? [], records.data ?? []), [exercises.data, records.data]);
  const ids = layout.liftTrends ?? defaults;
  const setIds = (next: string[]) => save({ ...layout, liftTrends: next });
  const days = RANGES.find((r) => r.key === range)?.days ?? null;
  const since = rangeStart(nowHour, days);

  /** A card switches to another measure of its lift, unless another card already shows that. */
  const swap = (id: string, measure: LiftMeasure) => {
    const p = parseLiftTrend(id);
    if (!p) return;
    const next = liftTrend(p.exerciseId, measure);
    if (!ids.includes(next)) setIds(ids.map((t) => (t === id ? next : t)));
  };
  const add = (exerciseId: string) => {
    const e = byId.get(exerciseId);
    const m = e ? defaultLiftMeasure(e) : null;
    if (m && !ids.includes(liftTrend(exerciseId, m))) setIds([...ids, liftTrend(exerciseId, m)]);
  };

  // the Add sheet: lifts with sets (most recent first), then the rest of the library
  const sections = useMemo<PickSection[]>(() => {
    const done = new Map((records.data ?? []).filter((r) => r.exercise_id && (r.completed_sets ?? 0) > 0).map((r) => [r.exercise_id!, r]));
    const charted = new Set(ids.map((t) => parseLiftTrend(t)?.exerciseId));
    const option = (e: Exercise): PickOption => {
      const chartable = defaultLiftMeasure(e) != null;
      const r = done.get(e.id);
      return {
        id: e.id,
        label: e.name,
        subtitle: !chartable ? 'Timed exercises have no chart yet'
          : r ? `${relativeDay(r.last_completed_at)} · ${r.completed_sets} set${r.completed_sets === 1 ? '' : 's'}`
          : [e.muscle_group, e.equipment].filter(Boolean).join(' · ') || undefined,
        added: charted.has(e.id),
        disabled: !chartable,
      };
    };
    const all = exercises.data ?? [];
    const lastOf = (e: Exercise) => done.get(e.id)?.last_completed_at ?? '';
    const logged = all.filter((e) => done.has(e.id)).sort((a, b) => lastOf(b).localeCompare(lastOf(a)));
    return [
      { title: 'Logged', options: logged.map(option) },
      { title: 'Library', options: all.filter((e) => !done.has(e.id)).map(option) },
    ];
  }, [exercises.data, records.data, ids]);

  if (layout.liftTrends == null && (exercises.isLoading || records.isLoading)) return <Loading label="Loading your lifts" />;

  return (
    <>
      <ErrorBanner message={error ? `Not saved: ${errorMessage(error)}` : exercises.error ? errorMessage(exercises.error) : null} />
      <EditableCharts
        ids={ids}
        textOf={(id) => {
          const p = parseLiftTrend(id);
          const ex = p ? byId.get(p.exerciseId) : undefined;
          return { label: ex?.name ?? 'Exercise', subtitle: p ? measureText(p.measure, ex, unit) : undefined };
        }}
        renderChart={(id) => {
          const p = parseLiftTrend(id);
          if (!p) return null;
          const ex = byId.get(p.exerciseId);
          // the card's other measures, less any another card already shows
          const options = (ex ? liftMeasuresFor(ex) : [p.measure]).filter((m) => m === p.measure || !ids.includes(liftTrend(p.exerciseId, m)));
          return (
            <LiftChart exerciseId={p.exerciseId} exercise={ex} measure={p.measure} options={options} since={since} units={units}
              onMeasure={(m) => swap(id, m)} />
          );
        }}
        cardRight={(id) => {
          const p = parseLiftTrend(id);
          return p ? <Button title="History" variant="ghost" small onPress={() => router.push(`/lift/exercises/${p.exerciseId}`)} /> : null;
        }}
        onChange={setIds}
        onAdd={() => setAdding(true)}
        onReset={() => save({ ...layout, liftTrends: null })}
        resetText="The charts go back to your main compound lifts."
        emptyText="No lifts charted yet. Finish a workout, or tap Add a chart."
        toolbar={
          <ChipRow>
            {RANGES.map((r) => <Chip key={r.key} label={r.label} selected={range === r.key} onPress={() => setRange(r.key)} />)}
          </ChipRow>
        }
        scroll={scroll}
        onDragChange={onDragChange}
      />
      <PickSheet visible={adding} title="Chart a lift" search="Find an exercise" sections={sections} onPick={add} onClose={() => setAdding(false)} />
    </>
  );
}

/** One lift's chart: its measure chips, a one-line summary and the line with a dot per workout. */
function LiftChart({ exerciseId, exercise, measure, options, since, units, onMeasure }: {
  exerciseId: string; exercise: Exercise | undefined; measure: LiftMeasure; options: readonly LiftMeasure[];
  since: number | null; units: Units; onMeasure: (m: LiftMeasure) => void;
}) {
  const { palette } = useTheme();
  const c = useThresholds();
  const sets = useLiftProgress(exerciseId);
  const bests = useMemo(() => (sets.data ? workoutBests(sets.data, (s) => e1rmOfSet(c, exercise, s)) : []), [sets.data, c, exercise]);
  const points = useMemo(() => progressPoints(bests, measure, units, since), [bests, measure, units, since]);
  const summary = progressSummary(points);
  const unit = isWeightMeasure(measure) ? ` ${units === 'imperial' ? 'lb' : 'kg'}` : '';
  const shown = (v: number) => `${num(v)}${unit}`;
  // a long range labels months, a short one days
  const long = points.length > 1 && points[points.length - 1].x - points[0].x > 200 * 86_400_000;

  return (
    <View style={{ gap: space.sm }}>
      {options.length > 1 ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="What the chart follows" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {options.map((m) => <MeasureChip key={m} label={MEASURE_LABEL[m]} on={m === measure} onPress={() => onMeasure(m)} />)}
        </View>
      ) : null}
      {summary ? (
        <T variant="small" tone="mut">
          {`Latest ${shown(summary.latest)} · best ${shown(summary.best)}`}
          {points.length > 1 ? (
            <T variant="small" weight="600" tone={summary.change > 0 ? 'pos' : summary.change < 0 ? 'neg' : 'mut'}>
              {` · ${summary.change > 0 ? '+' : summary.change < 0 ? '−' : '±'}${shown(Math.abs(summary.change))}`}
            </T>
          ) : null}
          {points.length > 1 ? ` since ${relativeDay(new Date(points[0].x).toISOString())}` : null}
        </T>
      ) : null}
      {sets.isLoading ? <Loading /> : sets.error ? <ErrorBanner message={errorMessage(sets.error)} /> : (
        <LineChart
          height={170}
          series={[
            { name: MEASURE_LABEL[measure], color: palette.accent, points },
            { name: 'workouts', color: palette.accent, kind: 'points', legend: false, points },
          ]}
          yFormat={axis}
          xFormat={(ms) => format(ms, long ? 'MMM yy' : 'd MMM')}
          cursorFormat={(ms) => format(ms, 'EEE d MMM yyyy')}
          emptyText={bests.length ? 'Nothing logged in this range' : 'Not logged in a finished workout yet'}
        />
      )}
    </View>
  );
}

/** A small pill choosing what a card follows. */
function MeasureChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      aria-checked={on}
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => ({
        borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4,
        backgroundColor: on ? palette.accentSoft : palette.surface2, borderWidth: 1, borderColor: on ? palette.accentLine : 'transparent',
        opacity: pressed ? 0.75 : 1,
      })}>
      <T variant="tiny" weight={on ? '700' : '600'} tone={on ? 'accent' : 'ink2'}>{label}</T>
    </Pressable>
  );
}
