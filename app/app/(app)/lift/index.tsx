import { useQueryClient } from '@tanstack/react-query';
import { router, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';

import {
  invalidateWorkoutData, useDeleteRoutineGroup, useExercises, useMoveRoutines, useRoutineGroups, useRoutines, useSaveRoutineGroup, useWorkouts,
  type RoutineWithStructure,
} from '@/api/lifting';
import { useLiftPbs } from '@/api/pbs';
import { linkWorkoutToPlan } from '@/api/plan';
import { useRestSettings, useUnits } from '@/api/profile';
import { useActivityCatchUp, useCurrentBodyweight, useMuscleNames, useRecoveryMap } from '@/api/recovery';
import { GroupEditor, RoutineGrid } from '@/components/lift/RoutineGrid';
import { RoutineQuickView } from '@/components/lift/RoutineQuickView';
import { PbButton } from '@/components/pbs/PbButton';
import { FigureBubble, QuickView } from '@/components/recovery/FigureBubble';
import { FigurePair } from '@/components/recovery/FigurePair';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay, shortTime, todayIso } from '@/lib/dates';
import { stopRest } from '@/lib/restTimer';
import { useUserId } from '@/lib/session';
import { mostTired } from '@/lib/recovery/screens';
import { formatDurationShort, formatWeight } from '@/lib/units';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export default function LiftHome() {
  const uid = useUserId();
  const units = useUnits();
  const active = useActiveWorkout((s) => s.workout);
  const start = useActiveWorkout((s) => s.start);
  const routines = useRoutines();
  const workouts = useWorkouts(20);
  const lifts = useLiftPbs();
  // the workout's bodyweight snapshot (D5); null until known, and the workout screen fills it in
  const bodyweight = useCurrentBodyweight();
  const snapshot = bodyweight.ready ? bodyweight.kg : null;
  const qc = useQueryClient();
  const pathname = usePathname();
  const exercises = useExercises();
  const activeId = active?.id;
  const finishedId = useActiveWorkout((s) => s.finishedId);
  const rest = useRestSettings();
  const groups = useRoutineGroups();
  const moveRoutines = useMoveRoutines();
  const saveGroup = useSaveRoutineGroup();
  const deleteGroup = useDeleteRoutineGroup();
  const { palette } = useTheme();
  const { width: windowW } = useWindowDimensions();
  useActivityCatchUp();
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const [figureBottom, setFigureBottom] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [quick, setQuick] = useState(false);
  const [viewing, setViewing] = useState<RoutineWithStructure | null>(null);
  const [newGroup, setNewGroup] = useState(false);
  const [dragging, setDragging] = useState(false);

  // This screen stays mounted under the workout sheet, so it keeps the sheet in step from here.
  // A block copies its exercise's facts when added: an exercise edited since (mapped from its
  // screen mid-workout, or started from a stale routine) or a block saved by an older build takes
  // the library's current ones, and its sets their e1RM.
  useEffect(() => {
    if (activeId && exercises.data) useActiveWorkout.getState().refreshFacts(exercises.data);
  }, [activeId, exercises.data]);

  // A queue left from before a restart: nothing else sends it (edits are refused once a finish is
  // queued), so drain it once the workout is back. Here, not on rehydrate, where the session may
  // not be restored yet; flush() joins a drain already running.
  useEffect(() => {
    const s = useActiveWorkout.getState();
    if (activeId && s.outbox.length) void s.flush();
  }, [activeId]);

  // A finish that synced away from the Finish button (Retry now, or the drain above): stop the
  // rest timer, link it to the plan, refresh, and swap the sheet for its summary.
  useEffect(() => {
    if (!finishedId) return;
    useActiveWorkout.getState().clearFinished();
    void stopRest();
    void linkWorkoutToPlan(uid, finishedId, todayIso()).catch(() => false).then(() => invalidateWorkoutData(qc, uid));
    if (pathname === '/lift/workout') router.replace(`/lift/history/${finishedId}`);
  }, [finishedId, pathname, uid, qc]);

  const startEmpty = () => {
    if (!active) start(uid, null, undefined, snapshot, rest);
    router.push('/lift/workout');
  };
  const startRoutine = (r: RoutineWithStructure) => {
    setViewing(null);
    start(uid, r, undefined, snapshot, rest);
    router.push('/lift/workout');
  };

  // the figure is as tall as the Run tab's map, front and back side by side
  const figureWidth = Math.round(Math.min(140, (Math.min(windowW, 640) - 2 * space.lg - space.md) / 2 - space.lg));
  const tired = map.data ? mostTired(map.data, 2) : [];
  const tiredText = tired.length ? tired.map((id) => `${names(id)} (${map.data![id].label.toLowerCase()})`).join(', ') : 'Every muscle is ready';

  return (
    <Screen
      title="Lift"
      subtitle="Your recovery"
      fixedHeader
      scrollEnabled={!dragging}
      onScroll={(e) => {
        // the figure's bubble shows once the figure itself has scrolled away
        const past = figureBottom > 0 && e.nativeEvent.contentOffset.y > figureBottom - 24;
        if (past !== scrolled) setScrolled(past);
        if (!past && quick) setQuick(false);
      }}
      refreshing={routines.isFetching || workouts.isFetching}
      onRefresh={() => { routines.refetch(); groups.refetch(); workouts.refetch(); lifts.refetch(); }}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          <FigureBubble map={map.data ?? null} mode="recovery" shown={scrolled} onPress={() => setQuick(true)} nameOf={names} label="Recovery map, quick view" />
          <PbButton compact />
          <Button title="Exercises" variant="ghost" small onPress={() => router.push('/lift/exercises')} />
        </View>
      }>
      {/* the recovery figure, at the top like the Run tab's map */}
      <Pressable
        onLayout={(e) => setFigureBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
        onPress={() => router.push('/lift/recovery')}
        accessibilityRole="button"
        accessibilityLabel={`Recovery. ${tiredText}. Opens the Recovery screen.`}
        style={({ pressed }) => ({ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.md, gap: space.sm, opacity: pressed ? 0.9 : 1 })}>
        {map.data ? (
          <FigurePair map={map.data} mode="recovery" figureWidth={figureWidth} nameOf={names} labels />
        ) : map.error ? <ErrorBanner message={errorMessage(map.error)} /> : <View style={{ height: figureWidth * 2 }}><Loading label="Loading your recovery" /></View>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <T variant="small" tone="mut" numberOfLines={1} style={{ flex: 1 }}>{tired.length ? `Most tired: ${tiredText}` : tiredText}</T>
          <T variant="small" tone="accent" weight="600">Recovery ›</T>
        </View>
      </Pressable>

      {active ? (
        <Card
          tone="accent"
          title="Workout in progress"
          subtitle={`${active.name} · started ${relativeDay(active.startedAt).toLowerCase()} ${shortTime(active.startedAt)} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}`}
          onPress={() => router.push('/lift/workout')}>
          <Button title="Resume" small onPress={() => router.push('/lift/workout')} />
        </Card>
      ) : (
        <Button title="Start empty workout" onPress={startEmpty} />
      )}

      <Card
        title="Routines"
        right={
          <View style={{ flexDirection: 'row', gap: space.xs }}>
            <Button title="New group" variant="ghost" small onPress={() => setNewGroup(true)} />
            <Button title="New" variant="ghost" small onPress={() => router.push('/lift/routines/new')} />
          </View>
        }>
        {routines.isLoading ? <Loading /> : null}
        {routines.data?.length === 0 ? (
          <T tone="mut">No routines yet. Build one here, or finish a workout and save it as a routine.</T>
        ) : null}
        {routines.data?.length ? (
          <RoutineGrid
            routines={routines.data}
            groups={groups.data ?? []}
            startDisabled={!!active}
            onStart={startRoutine}
            onView={setViewing}
            onMove={(moves) => moveRoutines.mutate(moves)}
            onDragging={setDragging}
            onRenameGroup={(id, name) => saveGroup.mutate({ id, name })}
            onDeleteGroup={(id) => deleteGroup.mutate(id)}
          />
        ) : null}
        <ErrorBanner message={moveRoutines.error ? `Couldn't move it: ${errorMessage(moveRoutines.error)}` : saveGroup.error ? errorMessage(saveGroup.error) : null} />
      </Card>

      <Card title="History">
        {workouts.isLoading ? <Loading /> : null}
        {workouts.data?.length === 0 ? <EmptyState title="No workouts yet" body="Finished sessions show up here with their volume and duration." /> : null}
        {workouts.data?.map((w, i) => (
          <ListRow
            key={w.id ?? i}
            first={i === 0}
            title={w.name ?? 'Workout'}
            subtitle={`${relativeDay(w.started_at)} · ${formatDurationShort(w.duration_s)} · ${w.sets_completed ?? 0} sets`}
            value={w.volume_kg ? formatWeight(w.volume_kg, units, 0) : undefined}
            valueSub={w.volume_kg ? 'volume' : undefined}
            onPress={() => router.push(`/lift/history/${w.id}`)}
          />
        ))}
      </Card>

      <QuickView visible={quick} onClose={() => setQuick(false)} title="Recovery">
        <T variant="h3">Recovery</T>
        {map.data ? <FigurePair map={map.data} mode="recovery" figureWidth={110} nameOf={names} labels /> : <Loading />}
        <T variant="small" tone="mut">{tired.length ? `Most tired: ${tiredText}` : tiredText}</T>
        <Button title="Open Recovery" small variant="secondary" onPress={() => { setQuick(false); router.push('/lift/recovery'); }} />
      </QuickView>
      <RoutineQuickView
        routine={viewing}
        startDisabled={!!active}
        onStart={startRoutine}
        onEdit={(r) => { setViewing(null); router.push(`/lift/routines/${r.id}`); }}
        onClose={() => setViewing(null)}
      />
      <GroupEditor group={null} creating={newGroup} onClose={() => setNewGroup(false)}
        onCreate={(name) => saveGroup.mutate({ name, position: groups.data?.length ?? 0 })} />
    </Screen>
  );
}
