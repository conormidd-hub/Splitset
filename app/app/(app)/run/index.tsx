import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Animated, View, useWindowDimensions, type ScrollView } from 'react-native';

import { useActivities, useRunRoutes, type ActivityListRow } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { useMuscleNames, useRecoveryMap } from '@/api/recovery';
import { runTrendKeys, useRunDates } from '@/api/runTrends';
import { HeatLayer, HeatLegend } from '@/components/map/HeatLayer';
import { TileMap, type Projector } from '@/components/map/TileMap';
import { QuickView } from '@/components/recovery/FigureBubble';
import { FigurePair } from '@/components/recovery/FigurePair';
import { RouteShape } from '@/components/run/RouteShape';
import { RunMaps } from '@/components/run/RunMaps';
import { RunRow, type RunSummary } from '@/components/run/RunRow';
import { RunTrends } from '@/components/run/RunTrends';
import { Bubble, ScreenTopBar } from '@/components/ui/BarButtons';
import { Button } from '@/components/ui/Button';
import { DateFinder, type DatedItem } from '@/components/ui/DateFinder';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TabbedScreen, type TabDef } from '@/components/ui/TabbedScreen';
import { shortTime } from '@/lib/dates';
import { clusterByLocation, unionBbox, type MapView, type Pt } from '@/lib/geo';
import { decodeRuns, focusBounds, nearestRoute, newestFirst, weightRoutesWithGroups, type DecodedRun } from '@/lib/heat';
import { ICONS } from '@/lib/icons';
import { mostTired } from '@/lib/recovery/screens';
import { useUserId } from '@/lib/session';
import { formatDistance, formatDuration, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Tab = 'history' | 'trends' | 'maps';

const TABS: readonly TabDef<Tab>[] = [
  { key: 'history', label: 'History', icon: 'history' },
  { key: 'trends', label: 'Trends', icon: 'chart' },
  { key: 'maps', label: 'Maps', icon: 'map' },
];

type Section = { title: string; data: RunSummary[] };

function monthTitle(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Newest first, split into one section per month. */
function byMonth(runs: RunSummary[]): Section[] {
  const out: Section[] = [];
  for (const r of newestFirst(runs)) {
    const title = monthTitle(r.start_time_local);
    const last = out[out.length - 1];
    if (last && last.title === title) last.data.push(r);
    else out.push({ title, data: [r] });
  }
  return out;
}

const fromActivity = (a: ActivityListRow): RunSummary => ({
  id: a.id, name: a.name, start_time_local: a.start_time_local, distance_m: a.distance_m,
  moving_time_s: a.moving_time_s, avg_hr: a.avg_hr, elev_gain_m: a.elev_gain_m,
});
const fromRoute = (r: DecodedRun): RunSummary => ({
  id: r.activity_id, name: r.name, start_time_local: r.start_time_local, distance_m: r.distance_m,
  moving_time_s: r.moving_time_s, avg_hr: r.avg_hr, elev_gain_m: r.elev_gain_m,
});

const runsWord = (n: number) => (n === 1 ? 'run' : 'runs');

/**
 * The Run tab, laid out like Strava's You screen: a bar of round buttons (plan a route, all
 * activity, find a run by date, recovery), the map of where this user runs most as the hero, every
 * route coloured by how often it is run, then History, Trends and Maps tabs that stick under the
 * bar as the map scrolls away under the faded top. Tapping a route on the map narrows the history
 * to that route; tapping a run expands its headline stats, eases the map to it, and offers the full
 * stats screen. (The old mini map that followed the page is gone, by Conor's choice: the bar's
 * buttons took its place.)
 */
export default function RunHome() {
  const { palette } = useTheme();
  const units = useUnits();
  const uid = useUserId();
  const qc = useQueryClient();
  const { height: windowH } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('history');
  /** The run tapped on the map; its route group is derived, so a refetch that re-keys groups cannot strand the selection. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  const [finding, setFinding] = useState(false);
  const [peeking, setPeeking] = useState(false);
  // a chart lifted in Trends' edit mode holds the page still
  const [dragging, setDragging] = useState(false);
  // the bar's title fades as the page scrolls; the offset also lets a dragged chart scroll the page
  const [scrollFade] = useState(() => new Animated.Value(0));
  const titleOpacity = useMemo(() => scrollFade.interpolate({ inputRange: [0, 48], outputRange: [1, 0], extrapolate: 'clamp' }), [scrollFade]);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(0);
  const history = useActivities('runs');
  const routesQ = useRunRoutes();
  const dates = useRunDates();

  const decoded = useMemo(() => decodeRuns(routesQ.data), [routesQ.data]);
  const { routes: heat, groups } = useMemo(() => weightRoutesWithGroups(decoded), [decoded]);
  // each run's trace by id, for the shapes in the history and its "On the map" badge
  const tracks = useMemo(() => new Map(decoded.map((r) => [r.activity_id, r])), [decoded]);
  // the biggest cluster of runs is "home"; clusterByLocation sorts by size
  const home = useMemo(() => clusterByLocation(decoded, (r) => r.box)[0] ?? null, [decoded]);

  const picked = useMemo(() => (pickedId ? heat.find((r) => r.activity_id === pickedId) ?? null : null), [heat, pickedId]);
  const routeKey = picked?.group ?? null;
  const route = useMemo(() => (routeKey ? groups.get(routeKey) ?? null : null), [groups, routeKey]);
  const routeRuns = useMemo(() => (routeKey ? newestFirst(heat.filter((r) => r.group === routeKey)) : []), [heat, routeKey]);
  const routeBox = useMemo(() => (routeRuns.length ? unionBbox(routeRuns.map((r) => r.box)) : null), [routeRuns]);
  const expanded = useMemo(() => (expandedId ? heat.find((r) => r.activity_id === expandedId) ?? null : null), [heat, expandedId]);

  const sections = useMemo<Section[]>(() => {
    if (routeKey) return byMonth(routeRuns.map(fromRoute));
    return byMonth((history.data?.pages.flat() ?? []).map(fromActivity));
  }, [routeKey, routeRuns, history.data]);

  // stable identities: a new bounds or highlight array makes the map rebuild every route
  const bounds = useMemo(() => (expanded ? focusBounds(expanded.box) : routeBox ?? home?.fit ?? null), [expanded, routeBox, home]);
  const highlight = useMemo(
    () => (expanded ? [expanded.pts] : routeRuns.length ? routeRuns.map((r) => r.pts) : null),
    [expanded, routeRuns],
  );
  const mapHeight = Math.round(Math.min(260, Math.max(180, windowH * 0.3)));

  const calendar = useMemo<DatedItem[]>(() => (dates.data ?? []).map((r) => ({
    id: r.id,
    date: r.start_time_local.slice(0, 10),
    title: r.name ?? 'Run',
    subtitle: r.moving_time_s != null ? `${shortTime(r.start_time_local)} · ${formatDuration(r.moving_time_s)}` : shortTime(r.start_time_local),
    value: formatDistance(r.distance_m, units),
  })), [dates.data, units]);

  const onMapPress = (pt: Pt, project: Projector, cam: MapView) => {
    const hit = nearestRoute(heat, project, cam, pt);
    const nextKey = hit?.group ?? null;
    setExpandedId(null);
    setPickedId(hit?.activity_id ?? null);
    // a picked route narrows the history, so show it
    if (hit) setTab('history');
    // a missed tap keeps the view the user zoomed to; a changed selection reframes
    if (nextKey !== routeKey) setView(null);
  };
  // stable, so the memoised rows only redraw when their own run changes
  const toggleRun = useCallback((id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
    setView(null);
  }, []);
  const openRun = useCallback((id: string) => router.push(`/run/${id}`), []);
  const clearRoute = () => {
    setPickedId(null);
    setExpandedId(null);
    setView(null);
  };

  const loadingHistory = routeKey ? routesQ.isLoading : history.isLoading;
  const historyError = routeKey ? routesQ.error : history.error;

  const topBar = (
    <ScreenTopBar
      centreOpacity={titleOpacity}
      centre={<T variant="h2" weight="800">Run</T>}
      left={
        <>
          <Bubble label="Plan a route" hint="Opens the route planner" onPress={() => router.push('/run/routes/new')}>
            <SymbolView name={ICONS.plus} tintColor={palette.ink2} size={21} />
          </Bubble>
          {/* the all-activity screen */}
          <Bubble label="All activity" hint="Every activity, newest first" onPress={() => router.push('/history')}>
            <SymbolView name={ICONS.history} tintColor={palette.ink2} size={21} />
          </Bubble>
        </>
      }
      right={
        <>
          <Bubble label="Find a run by date" hint="Opens a calendar of your runs" onPress={() => setFinding(true)}>
            <SymbolView name={ICONS.calendar} tintColor={palette.ink2} size={21} />
          </Bubble>
          <Bubble label="Recovery, quick view" onPress={() => setPeeking(true)}>
            <SymbolView name={ICONS.body} tintColor={palette.accent} size={21} />
          </Bubble>
        </>
      }
    />
  );

  const hero = (
    <View style={{ gap: space.sm }}>
      {routesQ.isLoading ? (
        <View style={{ height: mapHeight, borderRadius: radius.md, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center' }}>
          <Loading label="Loading your routes" />
        </View>
      ) : routesQ.error ? (
        <ErrorBanner message={errorMessage(routesQ.error)} />
      ) : bounds ? (
        <TileMap bounds={bounds} view={view} onViewChange={setView} interactive height={mapHeight} onPress={onMapPress}>
          {(project, size, cam) => (
            <HeatLayer routes={heat} project={project} size={size} zoom={cam.zoom} highlight={highlight} palette={palette} />
          )}
        </TileMap>
      ) : (
        <View style={{ height: mapHeight, borderRadius: radius.md, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', padding: space.lg }}>
          <T tone="mut" align="center">Your map appears once a run with GPS has synced.</T>
        </View>
      )}

      {bounds ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 }}>
          {route ? (
            <>
              <T variant="small" tone="mut" numberOfLines={1} style={{ flex: 1 }}>
                {route.count} {runsWord(route.count)} · {formatDistance(route.typicalDistanceM, units)}
                {route.best?.moving_time_s != null ? ` · best ${formatDuration(route.best.moving_time_s)}` : ''}
              </T>
              <Button title="All runs" variant="ghost" small onPress={clearRoute} />
            </>
          ) : (
            <>
              <T variant="small" tone="mut" numberOfLines={1} style={{ flexShrink: 1 }}>
                {home ? `${home.items.length} ${runsWord(home.items.length)} near home` : ''}
              </T>
              <View style={{ flex: 1, minWidth: 150 }}><HeatLegend /></View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );

  return (
    <TabbedScreen
      topBar={topBar}
      hero={hero}
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      scrollEnabled={!dragging}
      scrollRef={scrollRef}
      onScroll={(e) => {
        const y = e.nativeEvent.contentOffset.y;
        scrollY.current = y;
        scrollFade.setValue(y);
      }}
      onEndReached={() => {
        if (tab === 'history' && !routeKey && history.hasNextPage && !history.isFetchingNextPage) history.fetchNextPage();
      }}
      refreshing={history.isRefetching || routesQ.isRefetching}
      onRefresh={() => {
        history.refetch();
        routesQ.refetch();
        dates.refetch();
        qc.invalidateQueries({ queryKey: runTrendKeys.allRows(uid) });
      }}
      overlay={
        <>
          <DateFinder visible={finding} onClose={() => setFinding(false)} title="Find a run" items={calendar} onOpen={openRun}
            empty={dates.isLoading ? 'Loading your runs' : 'No runs yet'} />
          {/* mounted only while open, so the Run tab never loads the recovery model unasked */}
          {peeking ? <RecoveryPeek onClose={() => setPeeking(false)} /> : null}
        </>
      }>
      {tab === 'history' ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, minHeight: 32 }}>
            <T variant="h3">{route ? 'Runs on this route' : 'Your runs'}</T>
            {route ? <Button title="All runs" variant="ghost" small onPress={clearRoute} />
              : <T variant="tiny" tone="mut">Tap a route on the map, or a run</T>}
          </View>
          {sections.length ? sections.map((s) => (
            <View key={s.title} style={{ gap: space.sm }}>
              <T variant="label" tone="mut">{s.title}</T>
              <View style={{ borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: palette.hair, backgroundColor: palette.surface }}>
                {s.data.map((r, i) => (
                  <HistoryRow key={r.id} run={r} track={tracks.get(r.id) ?? null} units={units} first={i === 0}
                    expanded={r.id === expandedId} onToggle={toggleRun} onOpen={openRun} />
                ))}
              </View>
            </View>
          )) : loadingHistory ? <Loading label="Loading runs" /> : historyError ? <ErrorBanner message={errorMessage(historyError)} /> : (
            <EmptyState title="No runs yet" body="Runs appear after the first sync from intervals.icu." />
          )}
          {!routeKey && history.isFetchingNextPage ? <Loading /> : null}
        </>
      ) : tab === 'trends' ? (
        <RunTrends scroll={{ ref: scrollRef, y: scrollY }} onDragChange={setDragging} />
      ) : (
        <RunMaps decoded={decoded} weighted={heat} groups={groups} />
      )}
    </TabbedScreen>
  );
}

/** One run in the history with its route shape; memoised, so expanding one run redraws only it. */
const HistoryRow = memo(function HistoryRow({ run, track, units, first, expanded, onToggle, onOpen }: {
  run: RunSummary; track: DecodedRun | null; units: Units; first: boolean; expanded: boolean;
  onToggle: (id: string) => void; onOpen: (id: string) => void;
}) {
  return (
    <RunRow
      run={run}
      units={units}
      first={first}
      expanded={expanded}
      onMap={!!track}
      onToggle={() => onToggle(run.id)}
      onOpen={() => onOpen(run.id)}
      leading={<RouteShape track={track} />}
    />
  );
});

/** The Recovery button's quick view: the recovery figure, the most tired muscles, and the way to the full screen. */
function RecoveryPeek({ onClose }: { onClose: () => void }) {
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const tired = map.data ? mostTired(map.data, 2) : [];
  const tiredText = tired.length ? tired.map((id) => `${names(id)} (${map.data![id].label.toLowerCase()})`).join(', ') : 'Every muscle is ready';
  return (
    <QuickView visible onClose={onClose} title="Recovery">
      <T variant="h3">Recovery</T>
      {map.data ? <FigurePair map={map.data} mode="recovery" figureWidth={110} nameOf={names} labels />
        : map.error ? <ErrorBanner message={errorMessage(map.error)} /> : <Loading label="Loading your recovery" />}
      {map.data ? <T variant="small" tone="mut">{tired.length ? `Most tired: ${tiredText}` : tiredText}</T> : null}
      <Button title="Open Recovery" small variant="secondary" onPress={() => { onClose(); router.push('/recovery'); }} />
    </QuickView>
  );
}
