import { useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, type ScrollView } from 'react-native';

import { useRecentActivities } from '@/api/activities';
import { useConnection, useSyncRuns } from '@/api/connections';
import { DEFAULT_LAYOUT, useHomeLayout } from '@/api/home';
import { useWorkouts } from '@/api/lifting';
import { useRunPbs } from '@/api/pbs';
import { planTypeLabel, usePlanRange } from '@/api/plan';
import { useProfile, useUnits } from '@/api/profile';
import { useTrainingSessions } from '@/api/streaks';
import { useWellness } from '@/api/wellness';
import { AddMetricSheet } from '@/components/home/AddMetricSheet';
import { GlanceGrid } from '@/components/home/GlanceGrid';
import { InFocusCard } from '@/components/home/InFocusCard';
import { StreakButton } from '@/components/home/StreakButton';
import { StreakHeat } from '@/components/home/StreakHeat';
import { PbButton } from '@/components/pbs/PbButton';
import { RecoveryHomeCard } from '@/components/recovery/RecoveryHomeCard';
import { TrophyCabinet } from '@/components/pbs/TrophyCabinet';
import { SyncNowBar } from '@/components/sync/SyncNowBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { longDate, relativeDay, shortTime, todayIso } from '@/lib/dates';
import { snapshot, type MetricId, type MetricInputs, type Snapshot } from '@/lib/metrics';
import { sessionsFrom, sessionsLast7, weekStreak } from '@/lib/streaks';
import { formatDistance, formatDuration, formatDurationShort, formatPace, formatWeight, secPerKm } from '@/lib/units';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { space } from '@/theme/tokens';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** "32.4 km" for a This week tile, from a snapshot's number and unit. */
const withUnit = (s: Snapshot) => (s.unit ? `${s.text} ${s.unit}` : s.text);

/**
 * Today, laid out the way Garmin Connect lays out its home: one In focus metric, then the At a
 * glance tiles the owner chose, then the plan, the week and the rest. Edit mode is Garmin's too:
 * hold and drag to reorder, minus to remove, plus to add, and every change saves on the spot.
 */
export default function Today() {
  const units = useUnits();
  const qc = useQueryClient();
  const profile = useProfile();
  const connection = useConnection();
  const syncRuns = useSyncRuns(1);
  const recent = useRecentActivities(90);
  const wellness = useWellness(90);
  const workouts = useWorkouts(60);
  const runPbs = useRunPbs();
  const training = useTrainingSessions();
  const today = todayIso();
  const plan = usePlanRange(today, today);
  const active = useActiveWorkout((s) => s.workout);
  const lastLift = workouts.data?.[0];
  const { layout, loaded, save, saving, error: saveError } = useHomeLayout();
  const params = useLocalSearchParams<{ edit?: string }>();

  const inputs = useMemo<MetricInputs>(() => ({
    wellness: wellness.data ?? [],
    activities: recent.data ?? [],
    workouts: workouts.data ?? [],
    runPbs: runPbs.data,
    profile: profile.data ?? null,
    units,
    today,
  }), [wellness.data, recent.data, workouts.data, runPbs.data, profile.data, units, today]);

  // the streak and the heat line read two years of workouts, lightly
  const sessions = useMemo(
    () => sessionsFrom(training.data?.activities ?? [], training.data?.workouts ?? [], units),
    [training.data, units],
  );
  const heatCount = sessionsLast7(sessions, today);
  const streak = weekStreak(sessions, today, training.data?.oldest);

  const refreshing = recent.isFetching || wellness.isFetching;
  const refresh = () => {
    recent.refetch();
    wellness.refetch();
    workouts.refetch();
    training.refetch();
    qc.invalidateQueries({ queryKey: ['pbs'] });
    syncRuns.refetch();
    connection.refetch();
    profile.refetch();
  };

  // ---------------------------------------------------------------- first run
  // a brand-new account with nothing connected goes to the welcome wizard, once per visit. Only
  // while this tab is the one on screen: Today stays mounted behind the other tabs, and a
  // disconnect over in Settings must not yank the whole app into the wizard
  const focused = useIsFocused();
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current || !focused) return;
    if (profile.data && profile.data.onboarded_at == null && connection.isSuccess && !connection.data) {
      redirected.current = true;
      router.replace('/welcome');
    }
  }, [focused, profile.data, connection.isSuccess, connection.data]);

  // ---------------------------------------------------------------- the layout and its edit mode
  const [editing, setEditing] = useState(params.edit === '1');
  const [dragging, setDragging] = useState(false);
  // the sheet's mode outlives its visibility, so the title holds still while it slides away
  const [sheet, setSheet] = useState<{ open: boolean; mode: 'add' | 'pick' }>({ open: false, mode: 'add' });
  const openSheet = (mode: 'add' | 'pick') => setSheet({ open: true, mode });
  const closeSheet = () => setSheet((s) => ({ ...s, open: false }));
  // a drag near the top or bottom of the screen scrolls the page under the finger
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(0);
  // Settings sends people here with ?edit=1; a fresh arrival opens edit mode, Done closes it
  const [seenEdit, setSeenEdit] = useState(params.edit);
  if (params.edit !== seenEdit) {
    setSeenEdit(params.edit);
    if (params.edit === '1') setEditing(true);
  }
  const finishEditing = () => {
    setEditing(false);
    setDragging(false);
    if (params.edit) router.setParams({ edit: undefined });
  };

  // "Saving…" while the profile row is written, "Saved" for a moment after
  const [wasSaving, setWasSaving] = useState(saving);
  // bumped as each save lands, so the two-second timer restarts rather than overlapping
  const [saved, setSaved] = useState(0);
  if (saving !== wasSaving) {
    setWasSaving(saving);
    if (!saving && !saveError) setSaved((n) => n + 1);
  }
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(0), 2000);
    return () => clearTimeout(t);
  }, [saved]);
  const note = saving ? 'Saving…' : saveError ? 'Not saved' : saved ? 'Saved' : null;

  const setFocus = (id: MetricId) => { if (layout.focus !== id) save({ ...layout, focus: id }); };
  const addGlance = (id: MetricId) => { if (!layout.glance.includes(id)) save({ ...layout, glance: [...layout.glance, id] }); };
  const removeGlance = (id: MetricId) => save({ ...layout, glance: layout.glance.filter((g) => g !== id) });
  const reorderGlance = (glance: MetricId[]) => save({ ...layout, glance });
  const resetLayout = async () => {
    if (await confirm('Reset the home screen?', 'In focus and At a glance go back to the defaults.', 'Reset', true)) save(DEFAULT_LAYOUT);
  };

  const focusSnap = useMemo(() => (layout.focus ? snapshot(layout.focus, inputs) : null), [layout.focus, inputs]);
  const week = useMemo(() => ({
    distance: snapshot('weekly_distance', inputs),
    sessions: snapshot('sessions', inputs),
    time: snapshot('weekly_time', inputs),
  }), [inputs]);
  const last = recent.data?.length ? recent.data[recent.data.length - 1] : null;

  const conn = connection.data;
  const name = profile.data?.display_name ?? '';

  return (
    <Screen
      title={name ? `${greeting()}, ${name}` : greeting()}
      subtitle={longDate(new Date().toISOString())}
      right={
        <View style={{ alignItems: 'flex-end', gap: space.xs }}>
          <PbButton />
          {training.isSuccess ? <StreakButton streak={streak} /> : null}
        </View>
      }
      refreshing={refreshing}
      onRefresh={refresh}
      scrollEnabled={!dragging}
      scrollRef={scrollRef}
      onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}>
      {training.isSuccess ? <StreakHeat count={heatCount} style={{ marginTop: -space.sm }} /> : null}
      {connection.isSuccess && !conn ? (
        <Card tone="accent" title="Connect your watch" subtitle="Two minutes: an intervals.icu account, your Garmin, and one key." onPress={() => router.push('/settings/connect')}>
          <Button title="Connect" small onPress={() => router.push('/settings/connect')} />
        </Card>
      ) : null}
      {conn?.status === 'auth_failed' ? (
        <Card tone="neg" title="intervals.icu sync is failing" subtitle={conn.last_error ?? 'The API key was rejected.'} onPress={() => router.push('/settings/connect')} />
      ) : null}

      {loaded ? (
        <>
          <View style={{ gap: space.sm }}>
            <T variant="label" tone="mut">In focus</T>
            <InFocusCard snapshot={focusSnap} onChange={() => openSheet('pick')} />
          </View>

          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 }}>
              <T variant="label" tone="mut" style={{ flex: 1 }}>At a glance</T>
              {note ? <T variant="tiny" tone={note === 'Not saved' ? 'neg' : 'mut'}>{note}</T> : null}
              <Button title={editing ? 'Done' : 'Edit'} variant="ghost" small onPress={editing ? finishEditing : () => setEditing(true)} />
            </View>
            <GlanceGrid
              ids={layout.glance}
              inputs={inputs}
              editing={editing}
              onReorder={reorderGlance}
              onRemove={removeGlance}
              onAdd={() => openSheet('add')}
              onDragChange={setDragging}
              scroll={{ ref: scrollRef, y: scrollY }}
            />
            {editing ? (
              <View style={{ gap: space.xs, alignItems: 'center' }}>
                <T variant="small" tone="mut" align="center">Drag a tile by the handle in its corner to move it. Minus removes, plus adds.</T>
                <Button title="Reset to default" variant="ghost" small onPress={() => { void resetLayout(); }} />
              </View>
            ) : null}
          </View>
        </>
      ) : null}

      <Card title="Today's plan" right={<Button title="Plan" variant="ghost" small onPress={() => router.push('/plan')} />}>
        {plan.data?.length ? (
          plan.data.map((s, i) => (
            <ListRow
              key={s.id}
              first={i === 0}
              title={s.title}
              subtitle={[planTypeLabel(s.type), s.subtype, s.target_distance_m ? formatDistance(s.target_distance_m, units, 1) : null].filter(Boolean).join(' · ')}
              badge={<Badge label={s.status} tone={s.status === 'done' ? 'pos' : s.status === 'skipped' ? 'neg' : 'mut'} />}
              onPress={() => router.push(`/plan/${s.id}`)}
            />
          ))
        ) : (
          <T tone="mut">Nothing planned today.{plan.isSuccess ? ' Rest day, or add a session from the Plan tab.' : ''}</T>
        )}
      </Card>

      <Card title="This week" subtitle="Monday to today">
        <Grid>
          <StatTile label="Running" value={withUnit(week.distance)} sub={week.distance.sub} subTone={week.distance.subTone} />
          <StatTile label="Sessions" value={week.sessions.text} sub={week.sessions.sub} subTone={week.sessions.subTone} />
          <StatTile label="Time" value={week.time.text} sub={week.time.sub} subTone={week.time.subTone} />
        </Grid>
      </Card>

      {last ? (
        <Card title="Latest activity">
          <ListRow
            first
            title={last.name ?? last.type}
            subtitle={`${relativeDay(last.start_time_local)} · ${shortTime(last.start_time_local)}`}
            badge={<Badge label={last.type} />}
            value={last.distance_m ? formatDistance(last.distance_m, units) : formatDuration(last.moving_time_s)}
            valueSub={last.distance_m ? formatPace(secPerKm(last.distance_m, last.moving_time_s), units) : undefined}
            onPress={() => router.push(`/run/${last.id}`)}
          />
        </Card>
      ) : null}

      <Card title="Lifting" right={<Button title="Lift" variant="ghost" small onPress={() => router.push('/lift')} />}>
        {active ? (
          <ListRow
            first
            title="Workout in progress"
            subtitle={`${active.name} · started ${shortTime(active.startedAt)} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}`}
            badge={<Badge label="live" tone="accent" />}
            onPress={() => router.push('/lift/workout')}
          />
        ) : lastLift ? (
          <ListRow
            first
            title={lastLift.name ?? 'Workout'}
            subtitle={`${relativeDay(lastLift.started_at)} · ${formatDurationShort(lastLift.duration_s)} · ${lastLift.sets_completed ?? 0} sets`}
            value={lastLift.volume_kg ? formatWeight(lastLift.volume_kg, units, 0) : undefined}
            valueSub={lastLift.volume_kg ? 'volume' : undefined}
            onPress={() => router.push(`/lift/history/${lastLift.id}`)}
          />
        ) : (
          <View style={{ gap: 12 }}>
            <T tone="mut">No workouts logged yet. Routines, sets, the rest timer and records live in the Lift tab.</T>
            <Button title="Start a workout" variant="secondary" small onPress={() => router.push('/lift')} />
          </View>
        )}
      </Card>

      <RecoveryHomeCard />

      <TrophyCabinet units={units} />

      <SyncNowBar />

      <AddMetricSheet
        visible={sheet.open}
        mode={sheet.mode}
        layout={layout}
        onClose={closeSheet}
        onAdd={addGlance}
        onPick={setFocus}
      />
    </Screen>
  );
}
