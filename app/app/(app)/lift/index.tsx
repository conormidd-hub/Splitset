import { useQueryClient } from '@tanstack/react-query';
import { router, usePathname } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, View, useWindowDimensions, type ScrollView } from 'react-native';

import {
  invalidateWorkoutData, liftKeys, useDeleteRoutineGroup, useExercises, useMoveRoutines, useRoutineGroups, useRoutines, useSaveRoutineGroup,
  type RoutineWithStructure,
} from '@/api/lifting';
import { useWorkoutDays, useWorkoutPages } from '@/api/liftTrends';
import { linkWorkoutToPlan } from '@/api/plan';
import { useRestSettings, useUnits } from '@/api/profile';
import { useActivityCatchUp, useCurrentBodyweight, useMuscleNames, useRecoveryMap, useThresholds } from '@/api/recovery';
import { LiftHistoryList } from '@/components/lift/LiftHistoryList';
import { LiftPbsList } from '@/components/lift/LiftPbsList';
import { LiftTrends } from '@/components/lift/LiftTrends';
import { GroupEditor, RoutineGrid } from '@/components/lift/RoutineGrid';
import { RoutineQuickView } from '@/components/lift/RoutineQuickView';
import { BodyMap } from '@/components/recovery/BodyMap';
import { QuickView } from '@/components/recovery/FigureBubble';
import { KeyButton, KeyStrip } from '@/components/recovery/FigureKey';
import { FigurePair } from '@/components/recovery/FigurePair';
import { Bubble, ScreenTopBar } from '@/components/ui/BarButtons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateFinder, type DatedItem } from '@/components/ui/DateFinder';
import { PickSheet } from '@/components/ui/PickSheet';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TabbedScreen, type TabDef } from '@/components/ui/TabbedScreen';
import { isoDate, parseDate, relativeDay, shortTime, todayIso } from '@/lib/dates';
import { ICONS } from '@/lib/icons';
import { stopRest } from '@/lib/restTimer';
import { useUserId } from '@/lib/session';
import { mostTired } from '@/lib/recovery/screens';
import { formatDurationShort, formatWeight } from '@/lib/units';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Tab = 'routines' | 'history' | 'trends' | 'pbs';
const TABS: readonly TabDef<Tab>[] = [
  { key: 'routines', label: 'Routines', icon: 'routines' },
  { key: 'history', label: 'History', icon: 'history' },
  { key: 'trends', label: 'Trends', icon: 'chart' },
  { key: 'pbs', label: 'PBs', icon: 'trophy' },
];

/** What the + button offers. */
const ADD_OPTIONS = [
  { id: 'routine', label: 'New routine', subtitle: 'A workout template to start from', icon: 'edit' },
  { id: 'group', label: 'New routine group', subtitle: 'Push / Pull / Legs, Upper / Lower…', icon: 'routines' },
  { id: 'exercise', label: 'New exercise', subtitle: 'One of your own, for the library', icon: 'lift' },
] as const;

/**
 * The Lift tab, laid out like Strava's You screen: round buttons along the top (+ and all activity
 * on the left, the recovery map and a calendar of workouts on the right), the recovery figure under
 * them, and a row of tabs that sticks under the bar once the figure has scrolled away: Routines
 * (where a workout starts), History, Trends (each lift's progression) and PBs.
 */
export default function LiftHome() {
  const uid = useUserId();
  const units = useUnits();
  const active = useActiveWorkout((s) => s.workout);
  const start = useActiveWorkout((s) => s.start);
  const routines = useRoutines();
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
  const { palette, name: themeName } = useTheme();
  const c = useThresholds();
  const { width: windowW } = useWindowDimensions();
  useActivityCatchUp();
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const [tab, setTab] = useState<Tab>('routines');
  const [quick, setQuick] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<RoutineWithStructure | null>(null);
  const [newGroup, setNewGroup] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // the calendar reads every workout, so only once it has been opened
  const [finding, setFinding] = useState(false);
  const [askedDays, setAskedDays] = useState(false);
  const history = useWorkoutPages();
  const days = useWorkoutDays(askedDays);
  // the page's scroll: the title fades with it, and a dragged chart scrolls the page under the finger
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(0);
  // how far down the page the tab row sticks: the bottom of the hero above it
  const heroBottom = useRef(0);
  const [scrolled] = useState(() => new Animated.Value(0));
  const titleFade = scrolled.interpolate({ inputRange: [0, 48], outputRange: [1, 0], extrapolate: 'clamp' });

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
    if (pathname === '/lift/workout') router.replace(`/workout/${finishedId}`);
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

  const refresh = () => {
    setRefreshing(true);
    void Promise.allSettled([
      routines.refetch(), groups.refetch(),
      qc.invalidateQueries({ queryKey: liftKeys.workouts(uid) }),
      qc.invalidateQueries({ queryKey: liftKeys.records(uid) }),
      qc.invalidateQueries({ queryKey: ['exerciseHistory', uid] }),
      qc.invalidateQueries({ queryKey: ['pbs'] }),
    ]).then(() => setRefreshing(false));
  };

  const pickAdd = (id: string) => {
    if (id === 'routine') router.push('/lift/routines/new');
    else if (id === 'exercise') router.push('/lift/exercises/new');
    // one modal at a time: iOS won't show the group's while the sheet is still sliding away
    else setTimeout(() => setNewGroup(true), Platform.OS === 'ios' ? 450 : 0);
  };

  const historyRows = useMemo(() => history.data?.pages.flat() ?? [], [history.data]);
  const loadMore = () => {
    if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  };
  // this page doesn't make room for the keyboard, so the PBs' find-a-lift field, under the figure,
  // would be typed into blind: bring the tab row up under the bar, which puts the field near the top
  const showPbSearch = () => {
    if (Platform.OS !== 'web' && scrollY.current < heroBottom.current) {
      scrollRef.current?.scrollTo({ y: heroBottom.current, animated: true });
    }
  };
  const dayItems = useMemo<DatedItem[]>(() => (days.data ?? []).flatMap((w) => {
    const d = parseDate(w.started_at);
    return w.id && d ? [{
      id: w.id, date: isoDate(d), title: w.name ?? 'Workout',
      subtitle: `${shortTime(w.started_at)} · ${formatDurationShort(w.duration_s)} · ${w.sets_completed ?? 0} sets`,
      value: w.volume_kg ? formatWeight(w.volume_kg, units, 0) : undefined,
    }] : [];
  }), [days.data, units]);

  // front and back side by side, compact enough to leave the tabs in view
  const figureWidth = Math.round(Math.min(96, (Math.min(windowW, 640) - 2 * space.lg - space.md) / 2 - space.xl));
  const tired = map.data ? mostTired(map.data, 2) : [];
  const tiredText = tired.length ? tired.map((id) => `${names(id)} (${map.data![id].label.toLowerCase()})`).join(', ') : 'Every muscle is ready';

  const topBar = (
    <ScreenTopBar
      centreOpacity={titleFade}
      centre={<T variant="h2" accessibilityRole="header" numberOfLines={1}>Lift</T>}
      left={
        <>
          <Bubble label="Add" hint="A new routine, routine group or exercise" onPress={() => setAdding(true)}>
            <SymbolView name={ICONS.plus} tintColor={palette.ink2} size={21} />
          </Bubble>
          {/* /history is the all-activity screen (runs, rides and workouts) */}
          <Bubble label="All activity" hint="Every run, ride and workout, newest first" onPress={() => router.push('/history')}>
            <SymbolView name={ICONS.history} tintColor={palette.ink2} size={21} />
          </Bubble>
        </>
      }
      right={
        <>
          <Bubble label="Recovery map, quick view" onPress={() => setQuick(true)}>
            {map.data ? (
              // the figure itself, shrunk: its colours say how recovered at a glance
              <View pointerEvents="none" style={{ marginTop: 10 }}>
                <BodyMap map={map.data} view="front" mode="recovery" theme={themeName === 'night' ? 'dark' : 'light'} thresholds={c} width={24} nameOf={names} />
              </View>
            ) : <SymbolView name={ICONS.body} tintColor={palette.ink2} size={21} />}
          </Bubble>
          <Bubble label="Find a workout by date" onPress={() => { setAskedDays(true); setFinding(true); }}>
            <SymbolView name={ICONS.calendar} tintColor={palette.ink2} size={21} />
          </Bubble>
        </>
      }
    />
  );

  // the recovery figure: scrolls away under the bar's fade; tapping it opens Recovery. The colour
  // key sits over its corner as a sibling, since a button inside a button is not HTML
  const hero = (
    <View onLayout={(e) => { heroBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height; }}>
      <Pressable
        onPress={() => router.push('/recovery')}
        accessibilityRole="button"
        accessibilityLabel={`Recovery. ${tiredText}. Opens the Recovery screen.`}
        style={({ pressed }) => ({ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.sm, gap: space.xs, opacity: pressed ? 0.9 : 1 })}>
        {map.data ? (
          <FigurePair map={map.data} mode="recovery" figureWidth={figureWidth} nameOf={names} />
        ) : map.error ? <ErrorBanner message={errorMessage(map.error)} /> : <View style={{ height: figureWidth * 2 }}><Loading label="Loading your recovery" /></View>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.xs }}>
          <T variant="small" tone="mut" numberOfLines={1} style={{ flex: 1 }}>{tired.length ? `Most tired: ${tiredText}` : tiredText}</T>
          <T variant="small" tone="accent" weight="600">Recovery ›</T>
        </View>
      </Pressable>
      {/* the colour key, one tap away wherever the figure is */}
      <View style={{ position: 'absolute', top: space.sm, right: space.sm }}>
        <KeyButton mode="recovery" size={26} />
      </View>
    </View>
  );

  const overlay = (
    <>
      <PickSheet
        visible={adding}
        title="Add"
        closeOnPick
        sections={[{ options: ADD_OPTIONS }]}
        onPick={pickAdd}
        onClose={() => setAdding(false)}
      />
      <QuickView visible={quick} onClose={() => setQuick(false)} title="Recovery">
        <T variant="h3">Recovery</T>
        {map.data ? <FigurePair map={map.data} mode="recovery" figureWidth={110} nameOf={names} labels /> : <Loading />}
        <T variant="small" tone="mut">{tired.length ? `Most tired: ${tiredText}` : tiredText}</T>
        <KeyStrip mode="recovery" inline />
        <Button title="Open Recovery" small variant="secondary" onPress={() => { setQuick(false); router.push('/recovery'); }} />
      </QuickView>
      <DateFinder
        visible={finding}
        onClose={() => setFinding(false)}
        title="Workouts by date"
        items={dayItems}
        onOpen={(id) => router.push(`/workout/${id}`)}
        empty={days.isLoading ? 'Loading your workouts…' : days.error ? "Couldn't load your workouts" : 'No workouts yet'}
      />
      <RoutineQuickView
        routine={viewing}
        startDisabled={!!active}
        onStart={startRoutine}
        onEdit={(r) => { setViewing(null); router.push(`/lift/routines/${r.id}`); }}
        onClose={() => setViewing(null)}
      />
      <GroupEditor group={null} creating={newGroup} onClose={() => setNewGroup(false)}
        onCreate={(name) => saveGroup.mutate({ name, position: groups.data?.length ?? 0 })} />
    </>
  );

  return (
    <TabbedScreen
      topBar={topBar}
      hero={hero}
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      refreshing={refreshing}
      onRefresh={refresh}
      scrollEnabled={!dragging}
      scrollRef={scrollRef}
      onScroll={(e) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
        scrolled.setValue(e.nativeEvent.contentOffset.y);
      }}
      onEndReached={tab === 'history' ? loadMore : undefined}
      overlay={overlay}>
      {tab === 'routines' ? (
        <>
          {active ? (
            <Card
              tone="accent"
              title="Workout in progress"
              subtitle={`${active.name} · started ${relativeDay(active.startedAt).toLowerCase()} ${shortTime(active.startedAt)} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}`}
              onPress={() => router.push('/lift/workout')}>
              <Button title="Resume" small onPress={() => router.push('/lift/workout')} />
            </Card>
          ) : null}

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

          {active ? null : <Button title="Start empty workout" onPress={startEmpty} />}
          <Button title="Exercise library ›" variant="ghost" small onPress={() => router.push('/lift/exercises')} />
        </>
      ) : tab === 'history' ? (
        <LiftHistoryList
          workouts={historyRows}
          loading={history.isLoading}
          error={history.error}
          hasMore={!!history.hasNextPage}
          loadingMore={history.isFetchingNextPage}
          onMore={loadMore}
        />
      ) : tab === 'trends' ? (
        <LiftTrends scroll={{ ref: scrollRef, y: scrollY }} onDragChange={setDragging} />
      ) : (
        <>
          <LiftPbsList onSearchFocus={showPbSearch} />
          <Button title="Running PBs ›" variant="ghost" small onPress={() => router.push({ pathname: '/pbs', params: { tab: 'running' } })} />
        </>
      )}
    </TabbedScreen>
  );
}
