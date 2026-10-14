import { Stack, router, useLocalSearchParams } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Circle, Path } from 'react-native-svg';

import { useRunRoutes, type RunRoute } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { TileMap, type Projector, type Size } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowHour } from '@/lib/clock';
import { isoDate, relativeDay } from '@/lib/dates';
import { bboxCenter, bboxOf, clusterByLocation, decodeRoute, pathD, type Bbox, type LatLng, type MapView } from '@/lib/geo';
import { groupRoutes, type RouteGroup } from '@/lib/routeSimilarity';
import { formatDistance, formatDuration } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space, type Palette } from '@/theme/tokens';

const RANGES = [
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
  { days: 0, label: 'All' },
];

type Tab = 'heat' | 'routes';

const TABS: { value: Tab; label: string }[] = [
  { value: 'heat', label: 'Heat map' },
  { value: 'routes', label: 'Frequent routes' },
];

type Decoded = RunRoute & { pts: [number, number][]; box: Bbox };

function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** The run's box grown by its own width and height on every side, so the run sits in the middle third. */
function focusBounds(b: Bbox): Bbox {
  const dLat = b[2] - b[0];
  const dLng = b[3] - b[1];
  return [b[0] - dLat, b[1] - dLng, b[2] + dLat, b[3] + dLng];
}

function containsPoint(b: Bbox, p: LatLng): boolean {
  return p.lat >= b[0] && p.lat <= b[2] && p.lng >= b[1] && p.lng <= b[3];
}

/** One translucent stroke per run; where routes repeat, the strokes stack up and the road glows. */
function heatPaths(routes: Decoded[], project: Projector, size: Size, color: string, alpha: number) {
  const m = 40;
  return routes.map((r) => {
    const a = project(r.box[0], r.box[1]);
    const b = project(r.box[2], r.box[3]);
    if (Math.max(a.x, b.x) < -m || Math.min(a.x, b.x) > size.width + m) return null;
    if (Math.max(a.y, b.y) < -m || Math.min(a.y, b.y) > size.height + m) return null;
    const d = pathD(r.pts.map(([lat, lng]) => project(lat, lng)), 1.5);
    if (!d) return null;
    return <Path key={r.activity_id} d={d} fill="none" stroke={color} strokeOpacity={alpha} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />;
  });
}

/**
 * Every route's stroke plus the optional bold representative, rebuilt only when the camera, the
 * routes or the highlight change, so re-renders of the screen (chips, summary) cost nothing here.
 */
const HeatLayer = memo(function HeatLayer({ routes, project, size, alpha, highlight, palette }: {
  routes: Decoded[]; project: Projector; size: Size; alpha: number; highlight: [number, number][] | null; palette: Palette;
}) {
  return (
    <>
      {heatPaths(routes, project, size, palette.accent, alpha)}
      {highlight ? boldPath(highlight, project, palette) : null}
    </>
  );
});

/** A frequent route's representative run drawn bold over the heat: a halo, the stroke, then start and finish dots. */
function boldPath(pts: [number, number][], project: Projector, palette: Palette) {
  const d = pathD(pts.map(([lat, lng]) => project(lat, lng)), 1);
  if (!d) return null;
  const start = project(pts[0][0], pts[0][1]);
  const end = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return (
    <>
      <Path d={d} fill="none" stroke={palette.surface} strokeOpacity={0.9} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
      <Path d={d} fill="none" stroke={palette.ink} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={start.x} cy={start.y} r={5.5} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
      <Circle cx={end.x} cy={end.y} r={5.5} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />
    </>
  );
}

/**
 * The Maps hub: the heat map of every run with a GPS trace, the "trails you run most" list, and
 * the doors to Segments and Routes. `?focus=<activity_id>` (from a run's detail) frames that run
 * and its surroundings until a range or area chip is pressed.
 */
export default function Maps() {
  const { palette } = useTheme();
  const units = useUnits();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const q = useRunRoutes();
  const [tab, setTab] = useState<Tab>('heat');
  const [days, setDays] = useState(0);
  /** An area chip the user pressed; null means "the default area" (the focus run's, else the biggest). */
  const [clusterPick, setClusterPick] = useState<number | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  /** The focus param the user has dismissed by pressing a chip, so the param alone no longer frames the map. */
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);
  /** Set the first time the Frequent routes tab opens; grouping is skipped until then. */
  const [groupsWanted, setGroupsWanted] = useState(false);
  /** A frequent route the user tapped: drawn bold over the heat and framed. */
  const [highlight, setHighlight] = useState<RouteGroup | null>(null);
  // hour-granular "now" so the memo below is pure and the screen re-renders at most hourly
  const nowHour = useNowHour();

  const decoded = useMemo<Decoded[]>(
    () => (q.data ?? []).flatMap((r) => {
      const pts = decodeRoute(r.polyline);
      const box = r.bbox ?? bboxOf(pts);
      return pts.length >= 2 && box ? [{ ...r, pts, box }] : [];
    }),
    [q.data],
  );

  const routes = useMemo(() => {
    if (!days) return decoded;
    const cutoff = `${isoDate(new Date(nowHour - days * 86_400_000))}T00:00:00`;
    return decoded.filter((r) => r.start_time_local >= cutoff);
  }, [decoded, days, nowHour]);

  const clusters = useMemo(() => clusterByLocation(routes, (r) => r.box), [routes]);

  const focusRun = useMemo(() => (focus ? decoded.find((r) => r.activity_id === focus) : undefined), [decoded, focus]);
  const focusCentre = useMemo(() => (focusRun ? bboxCenter(focusRun.box) : null), [focusRun]);
  const focusBox = useMemo(
    () => (focusRun && focus !== dismissedFocus ? focusBounds(focusRun.box) : null),
    [focusRun, focus, dismissedFocus],
  );

  // The area chip starts on the cluster around the focused run; a chip press overrides it.
  const defaultIdx = focusCentre ? Math.max(0, clusters.findIndex((c) => containsPoint(c.bbox, focusCentre))) : 0;
  const idx = Math.min(clusterPick ?? defaultIdx, Math.max(0, clusters.length - 1));
  const cluster = clusters[idx];

  // Newest first so the latest run anchors each group. Only computed once the tab has been opened.
  const groups = useMemo(() => {
    if (!groupsWanted) return [];
    const newestFirst = [...routes].reverse();
    return groupRoutes(newestFirst.map((r) => ({
      id: r.activity_id, pts: r.pts, distance_m: r.distance_m, moving_time_s: r.moving_time_s, start_time_local: r.start_time_local,
    })));
  }, [groupsWanted, routes]);

  // The list follows the area chips: a group belongs to the area its representative run is in.
  const areaGroups = useMemo(() => {
    if (!cluster) return [];
    const ids = new Set(cluster.items.map((r) => r.activity_id));
    return groups.filter((g) => ids.has(g.representative.id));
  }, [groups, cluster]);

  const highlightBox = useMemo(() => (highlight ? bboxOf(highlight.representative.pts) : null), [highlight]);

  const totalM = useMemo(() => routes.reduce((s, r) => s + (r.distance_m ?? 0), 0), [routes]);
  // faint with hundreds of runs so hot spots still separate, bolder when there are only a few
  const alpha = Math.min(0.6, Math.max(0.12, 1.6 / Math.sqrt(Math.max(1, routes.length))));

  const span = routes.length
    ? (() => {
        const first = monthYear(routes[0].start_time_local);
        const last = monthYear(routes[routes.length - 1].start_time_local);
        return first === last ? first : `${first} to ${last}`;
      })()
    : '';

  const dismissFocus = () => {
    if (focus) setDismissedFocus(focus);
  };
  const pickRange = (d: number) => {
    setDays(d);
    setClusterPick(null);
    setView(null);
    setHighlight(null);
    dismissFocus();
  };
  const pickArea = (i: number) => {
    setClusterPick(i);
    setView(null);
    setHighlight(null);
    dismissFocus();
  };
  const openTab = (t: Tab) => {
    setTab(t);
    if (t === 'routes') setGroupsWanted(true);
  };
  const showGroup = (g: RouteGroup) => {
    setHighlight(g);
    setView(null);
    setTab('heat');
    dismissFocus();
  };
  const clearHighlight = () => {
    setHighlight(null);
    setView(null);
  };

  const runsWord = (n: number) => (n === 1 ? 'run' : 'runs');

  return (
    <>
      <Stack.Screen options={{ title: 'Maps' }} />
      <Screen scroll={false} style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button title="Segments" variant="secondary" small style={{ flex: 1 }} onPress={() => router.push('/run/segments')} />
          <Button title="Routes" variant="secondary" small style={{ flex: 1 }} onPress={() => router.push('/run/routes')} />
        </View>

        <Segmented options={TABS} value={tab} onChange={openTab} />

        <ChipRow>
          {RANGES.map((r) => (
            <Chip key={r.days} label={r.label} selected={days === r.days} onPress={() => pickRange(r.days)} />
          ))}
        </ChipRow>

        {clusters.length > 1 ? (
          <ChipRow>
            {clusters.map((c, i) => (
              <Chip key={i} label={`${c.items.length} ${runsWord(c.items.length)}`} selected={i === idx} onPress={() => pickArea(i)} />
            ))}
          </ChipRow>
        ) : null}

        {q.isLoading ? (
          <Loading label="Loading routes" />
        ) : q.error ? (
          <ErrorBanner message={errorMessage(q.error)} />
        ) : !cluster ? (
          <EmptyState title="No routes yet" body={days ? 'No runs with a GPS trace in this range.' : 'Routes appear once the sync has fetched the GPS streams for your runs.'} />
        ) : tab === 'routes' ? (
          areaGroups.length ? (
            <FlatList
              data={areaGroups}
              keyExtractor={(g) => g.key}
              style={{ flex: 1 }}
              initialNumToRender={12}
              contentContainerStyle={{
                backgroundColor: palette.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.lg,
              }}
              ListHeaderComponent={
                <T variant="small" tone="mut" style={{ paddingTop: space.md }}>
                  {areaGroups.length} {areaGroups.length === 1 ? 'route' : 'routes'} from {cluster.items.length} {runsWord(cluster.items.length)} · most run first
                </T>
              }
              renderItem={({ item, index }) => (
                <ListRow
                  first={index === 0}
                  title={formatDistance(item.typicalDistanceM, units)}
                  subtitle={`Best ${formatDuration(item.best?.moving_time_s)} · Last run ${relativeDay(item.lastDate)}`}
                  value={`${item.count}`}
                  valueSub={runsWord(item.count)}
                  onPress={() => showGroup(item)}
                />
              )}
            />
          ) : (
            <EmptyState title="No routes to group" body="Runs that follow the same path are grouped here once they have GPS traces." />
          )
        ) : (
          <View style={{ flex: 1, gap: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <T variant="small" tone="mut" style={{ flex: 1 }}>
                {highlight
                  ? `${highlight.count} ${runsWord(highlight.count)} on this route · ${formatDistance(highlight.typicalDistanceM, units)} · best ${formatDuration(highlight.best?.moving_time_s)}`
                  : `${routes.length} ${runsWord(routes.length)} · ${formatDistance(totalM, units, 0)} · ${span}${clusters.length > 1 ? ` · ${clusters.length} areas` : ''}`}
              </T>
              {highlight ? <Button title="Clear" variant="ghost" small onPress={clearHighlight} /> : null}
            </View>
            <TileMap bounds={highlightBox ?? focusBox ?? cluster.fit} view={view} onViewChange={setView} interactive>
              {(project, size) => (
                <HeatLayer routes={routes} project={project} size={size} alpha={alpha} highlight={highlight?.representative.pts ?? null} palette={palette} />
              )}
            </TileMap>
            <T variant="tiny" tone="mut" align="center">
              {highlight ? 'The bold line is the most typical run of this route.' : 'Drag to pan. Brighter lines are roads you run most.'}
            </T>
          </View>
        )}
      </Screen>
    </>
  );
}
