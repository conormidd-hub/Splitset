import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useActivities, useRunRoutes, type ActivityListRow } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { HeatLayer, HeatLegend } from '@/components/map/HeatLayer';
import { TileMap, type Projector } from '@/components/map/TileMap';
import { QuickView } from '@/components/recovery/FigureBubble';
import { RunRow, type RunSummary } from '@/components/run/RunRow';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { clusterByLocation, unionBbox, type MapView, type Pt } from '@/lib/geo';
import { decodeRuns, focusBounds, nearestRoute, newestFirst, weightRoutesWithGroups, type DecodedRun } from '@/lib/heat';
import { formatDistance, formatDuration } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

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

/**
 * The Run tab. The map of where this user runs most sits on top, every route coloured by how
 * often it is run; the run history scrolls beneath it, newest first, in month sections. Tapping a
 * route on the map narrows the history to that route and shows its numbers; tapping a run expands
 * its headline stats, eases the map to it, and offers the full stats screen. Runs only.
 */
export default function RunHome() {
  const { palette } = useTheme();
  const units = useUnits();
  const { height: windowH } = useWindowDimensions();
  /** The run tapped on the map; its route group is derived, so a refetch that re-keys groups cannot strand the selection. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  // scrolled past the map: it waits top-right as a mini map, and opens larger when tapped
  const [mapBottom, setMapBottom] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [large, setLarge] = useState(false);
  const history = useActivities('runs');
  const routesQ = useRunRoutes();

  const decoded = useMemo(() => decodeRuns(routesQ.data), [routesQ.data]);
  const { routes: heat, groups } = useMemo(() => weightRoutesWithGroups(decoded), [decoded]);
  const traced = useMemo(() => new Set(heat.map((r) => r.activity_id)), [heat]);
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
  const mapHeight = Math.round(Math.min(240, Math.max(170, windowH * 0.26)));

  const onMapPress = (pt: Pt, project: Projector, cam: MapView) => {
    const hit = nearestRoute(heat, project, cam, pt);
    const nextKey = hit?.group ?? null;
    setExpandedId(null);
    setPickedId(hit?.activity_id ?? null);
    // a missed tap keeps the view the user zoomed to; a changed selection reframes
    if (nextKey !== routeKey) setView(null);
  };
  const toggleRun = (id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
    setView(null);
  };
  const clearRoute = () => {
    setPickedId(null);
    setExpandedId(null);
    setView(null);
  };

  const runsWord = (n: number) => (n === 1 ? 'run' : 'runs');
  const loadingHistory = routeKey ? routesQ.isLoading : history.isLoading;
  const historyError = routeKey ? routesQ.error : history.error;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm }}>
        {/* as tall as the mini map, so the row holds still when it appears */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md, minHeight: 64 }}>
          <View>
            <T variant="label" tone="mut">{route ? 'This route' : 'Where you run'}</T>
            <T variant="display">Run</T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
            {scrolled && bounds ? (
              <Pressable
                onPress={() => setLarge(true)}
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Map of this run, larger' : route ? 'Map of this route, larger' : 'Map of your runs, larger'}
                style={({ pressed }) => ({ width: 96, height: 64, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1.5,
                  borderColor: palette.accent, opacity: pressed ? 0.85 : 1 })}>
                <View pointerEvents="none">
                  <TileMap bounds={bounds} height={64} padding={6} compact>
                    {(project, size, cam) => (
                      <HeatLayer routes={heat} project={project} size={size} zoom={cam.zoom} highlight={highlight} palette={palette} />
                    )}
                  </TileMap>
                </View>
              </Pressable>
            ) : null}
            <Button title="Maps" variant="secondary" small onPress={() => router.push('/run/heatmap')} />
          </View>
        </View>

      </View>

      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, paddingBottom: space.xxl }}
        stickySectionHeadersEnabled={false}
        extraData={expandedId}
        renderSectionHeader={({ section }) => (
          <View style={{ marginTop: space.sm }}>
            <T variant="label" tone="mut" style={{ marginBottom: space.sm }}>{section.title}</T>
            <View style={{ height: radius.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, backgroundColor: palette.surface, marginBottom: -radius.lg }} />
          </View>
        )}
        renderSectionFooter={() => (
          <View style={{ height: radius.lg, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, backgroundColor: palette.surface }} />
        )}
        renderItem={({ item, index }) => (
          <RunRow
            run={item}
            units={units}
            first={index === 0}
            expanded={item.id === expandedId}
            onMap={traced.has(item.id)}
            onToggle={() => toggleRun(item.id)}
            onOpen={() => router.push(`/run/${item.id}`)}
          />
        )}
        onScroll={(e) => {
          const past = mapBottom > 0 && e.nativeEvent.contentOffset.y > mapBottom - 24;
          if (past !== scrolled) setScrolled(past);
          if (!past && large) setLarge(false);
        }}
        scrollEventThrottle={16}
        ListHeaderComponent={
          <View style={{ gap: space.sm }}>
            <View style={{ gap: space.sm }} onLayout={(e) => setMapBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
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
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
              <T variant="h3">{route ? 'Runs on this route' : 'Your runs'}</T>
              <T variant="tiny" tone="mut">{route ? 'Tap a run for its stats' : 'Tap a route on the map, or a run'}</T>
            </View>
          </View>
        }
        ListFooterComponent={!routeKey && history.isFetchingNextPage ? <Loading /> : null}
        ListEmptyComponent={
          loadingHistory ? <Loading label="Loading runs" /> : historyError ? <ErrorBanner message={errorMessage(historyError)} /> : (
            <EmptyState title="No runs yet" body="Runs appear after the first sync from intervals.icu." />
          )
        }
        onEndReached={() => {
          if (!routeKey && history.hasNextPage && !history.isFetchingNextPage) history.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        refreshing={history.isRefetching || routesQ.isRefetching}
        onRefresh={() => {
          history.refetch();
          routesQ.refetch();
        }}
      />

      {/* the mini map, opened larger: the same map, interactive; a tap outside shrinks it back */}
      <QuickView visible={large && !!bounds} onClose={() => setLarge(false)} title="Map">
        {bounds ? (
          <TileMap bounds={bounds} view={view} onViewChange={setView} interactive height={Math.round(Math.min(320, windowH * 0.4))} onPress={onMapPress}>
            {(project, size, cam) => (
              <HeatLayer routes={heat} project={project} size={size} zoom={cam.zoom} highlight={highlight} palette={palette} />
            )}
          </TileMap>
        ) : null}
        <T variant="small" tone="mut" numberOfLines={1}>
          {expanded ? expanded.name ?? 'This run' : route ? `${route.count} ${runsWord(route.count)} on this route` : 'Every route, coloured by how often you run it'}
        </T>
      </QuickView>
    </SafeAreaView>
  );
}
