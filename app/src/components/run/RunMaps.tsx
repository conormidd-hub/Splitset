import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';

import { useRunRoutes } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { HeatLayer, HeatLegend } from '@/components/map/HeatLayer';
import { TileMap } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowHour } from '@/lib/clock';
import { isoDate, relativeDay } from '@/lib/dates';
import { bboxCenter, bboxOf, clusterByLocation, type Bbox, type LatLng, type MapView } from '@/lib/geo';
import { decodeRuns, focusBounds, newestFirst, weightRoutes, type DecodedRun, type HeatRoute } from '@/lib/heat';
import { ICONS, type IconKey } from '@/lib/icons';
import { groupRoutes, type RouteGroup } from '@/lib/routeSimilarity';
import { formatDistance, formatDuration, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export const MAP_RANGES = [
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
  { days: 0, label: 'All' },
];

/** How many frequent routes the Run tab lists before "Show all". */
const FIRST_ROUTES = 6;

function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function containsPoint(b: Bbox, p: LatLng): boolean {
  return p.lat >= b[0] && p.lat <= b[2] && p.lng >= b[1] && p.lng <= b[3];
}

const runsWord = (n: number) => (n === 1 ? 'run' : 'runs');

/**
 * The Maps hub's state: the heat map of every run with a GPS trace over a range, split into areas,
 * and the "trails you run most" groups of the area on show. `focus` (an activity id) frames that
 * run and its surroundings until a range or area chip is pressed. A screen that has already
 * decoded and weighted the routes (the Run tab) hands them in, so nothing is done twice; with
 * `groupsNow` the frequent routes are grouped straight away, else on `wantGroups()`.
 */
export function useMapsHub({ focus, decoded: givenDecoded, weighted: givenWeighted, groups: givenGroups, groupsNow = false }: {
  focus?: string;
  decoded?: DecodedRun[];
  weighted?: HeatRoute[];
  /** The whole history's route groups, as weightRoutesWithGroups keys them. */
  groups?: Map<string, RouteGroup>;
  groupsNow?: boolean;
} = {}) {
  const q = useRunRoutes();
  const [days, setDays] = useState(0);
  /** An area chip the user pressed; null means "the default area" (the focus run's, else the biggest). */
  const [clusterPick, setClusterPick] = useState<number | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  /** The focus param the user has dismissed by pressing a chip, so the param alone no longer frames the map. */
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);
  /** Set the first time the frequent routes are wanted; grouping is skipped until then. */
  const [groupsWanted, setGroupsWanted] = useState(false);
  /** A frequent route the user tapped: drawn bold over the heat and framed. */
  const [highlight, setHighlight] = useState<RouteGroup | null>(null);
  // hour-granular "now" so the memo below is pure and the screen re-renders at most hourly
  const nowHour = useNowHour();

  const decoded = useMemo(() => givenDecoded ?? decodeRuns(q.data), [givenDecoded, q.data]);
  // frequency weights over the whole history, so a range chip never recolours the routes
  const weighted = useMemo(() => givenWeighted ?? weightRoutes(decoded), [givenWeighted, decoded]);

  const routes = useMemo(() => {
    if (!days) return weighted;
    const cutoff = `${isoDate(new Date(nowHour - days * 86_400_000))}T00:00:00`;
    return weighted.filter((r) => r.start_time_local >= cutoff);
  }, [weighted, days, nowHour]);

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

  const wanted = groupsNow || groupsWanted;
  // Newest first so the latest run anchors each group. Only computed once the routes are wanted.
  const groups = useMemo(() => {
    if (!wanted) return [];
    // over the whole history these are the groups the heat map was coloured by, already made
    if (!days && givenGroups) return [...givenGroups.values()];
    // the same newest-first order weightRoutes groups with, so both agree on the groups
    return groupRoutes(newestFirst(routes).map((r) => ({
      id: r.activity_id, pts: r.pts, distance_m: r.distance_m, moving_time_s: r.moving_time_s, start_time_local: r.start_time_local,
    })));
  }, [wanted, days, givenGroups, routes]);

  // The list follows the area chips: a group belongs to the area its representative run is in.
  const areaGroups = useMemo(() => {
    if (!cluster) return [];
    const ids = new Set(cluster.items.map((r) => r.activity_id));
    return groups.filter((g) => ids.has(g.representative.id));
  }, [groups, cluster]);

  const highlightBox = useMemo(() => (highlight ? bboxOf(highlight.representative.pts) : null), [highlight]);
  // a stable array, or the map would rebuild every route on each render
  const highlightPts = useMemo(() => (highlight ? [highlight.representative.pts] : null), [highlight]);

  const totalM = useMemo(() => routes.reduce((s, r) => s + (r.distance_m ?? 0), 0), [routes]);

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

  return {
    q, days, routes, clusters, idx, cluster, view, setView, highlight, highlightBox, highlightPts, focusBox, areaGroups, totalM, span,
    pickRange: (d: number) => {
      setDays(d);
      setClusterPick(null);
      setView(null);
      setHighlight(null);
      dismissFocus();
    },
    pickArea: (i: number) => {
      setClusterPick(i);
      setView(null);
      setHighlight(null);
      dismissFocus();
    },
    wantGroups: () => setGroupsWanted(true),
    showGroup: (g: RouteGroup) => {
      setHighlight(g);
      setView(null);
      dismissFocus();
    },
    clearHighlight: () => {
      setHighlight(null);
      setView(null);
    },
  };
}

export type MapsHub = ReturnType<typeof useMapsHub>;

/** The range chips, and the area chips when the runs fall in more than one place. */
export function MapsChips({ hub }: { hub: MapsHub }) {
  return (
    <>
      <ChipRow>
        {MAP_RANGES.map((r) => (
          <Chip key={r.days} label={r.label} selected={hub.days === r.days} onPress={() => hub.pickRange(r.days)} />
        ))}
      </ChipRow>
      {hub.clusters.length > 1 ? (
        <ChipRow>
          {hub.clusters.map((c, i) => (
            <Chip key={i} label={`${c.items.length} ${runsWord(c.items.length)}`} selected={i === hub.idx} onPress={() => hub.pickArea(i)} />
          ))}
        </ChipRow>
      ) : null}
    </>
  );
}

/** Loading, a failed load, or no routes in the range; null when there is a map to show. */
export function MapsState({ hub }: { hub: MapsHub }) {
  if (hub.q.isLoading) return <Loading label="Loading routes" />;
  if (hub.q.error) return <ErrorBanner message={errorMessage(hub.q.error)} />;
  if (!hub.cluster) {
    return <EmptyState title="No routes yet" body={hub.days ? 'No runs with a GPS trace in this range.' : 'Routes appear once the sync has fetched the GPS streams for your runs.'} />;
  }
  return null;
}

/** The heat map with the line above it (what is on show, or the tapped route) and the note under it. `height` unset fills the parent. */
export function HubMap({ hub, units, height }: { hub: MapsHub; units: Units; height?: number }) {
  const { palette } = useTheme();
  const { highlight, routes, clusters, totalM, span, cluster } = hub;
  if (!cluster) return null;
  return (
    <View style={{ flex: height ? undefined : 1, gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <T variant="small" tone="mut" style={{ flex: 1 }}>
          {highlight
            ? `${highlight.count} ${runsWord(highlight.count)} on this route · ${formatDistance(highlight.typicalDistanceM, units)} · best ${formatDuration(highlight.best?.moving_time_s)}`
            : `${routes.length} ${runsWord(routes.length)} · ${formatDistance(totalM, units, 0)} · ${span}${clusters.length > 1 ? ` · ${clusters.length} areas` : ''}`}
        </T>
        {highlight ? <Button title="Clear" variant="ghost" small onPress={hub.clearHighlight} /> : null}
      </View>
      <TileMap bounds={hub.highlightBox ?? hub.focusBox ?? cluster.fit} view={hub.view} onViewChange={hub.setView} interactive height={height}>
        {(project, size, cam) => (
          <HeatLayer routes={routes} project={project} size={size} zoom={cam.zoom} highlight={hub.highlightPts} palette={palette} />
        )}
      </TileMap>
      {highlight ? (
        <T variant="tiny" tone="mut" align="center">The bold line is the most typical run of this route. Drag to pan.</T>
      ) : (
        <HeatLegend />
      )}
    </View>
  );
}

/** "12 routes from 80 runs · most run first". */
export function routesSummary(hub: MapsHub): string {
  const n = hub.areaGroups.length, runs = hub.cluster?.items.length ?? 0;
  return `${n} ${n === 1 ? 'route' : 'routes'} from ${runs} ${runsWord(runs)} · most run first`;
}

/** One frequent route: its usual distance, best time and last run, and how often it is run. */
export function FrequentRouteRow({ group, units, first, onPress }: { group: RouteGroup; units: Units; first?: boolean; onPress: () => void }) {
  return (
    <ListRow
      first={first}
      title={formatDistance(group.typicalDistanceM, units)}
      subtitle={`Best ${formatDuration(group.best?.moving_time_s)} · Last run ${relativeDay(group.lastDate)}`}
      value={`${group.count}`}
      valueSub={runsWord(group.count)}
      onPress={onPress}
    />
  );
}

/** A door to another map screen, with its icon. */
function LinkRow({ icon, title, subtitle, href, first }: { icon: IconKey; title: string; subtitle: string; href: Href; first?: boolean }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md,
        borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair, opacity: pressed ? 0.7 : 1,
      })}>
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <SymbolView name={ICONS[icon]} tintColor={palette.accent} size={18} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="h3" numberOfLines={1}>{title}</T>
        <T variant="small" tone="mut" numberOfLines={1}>{subtitle}</T>
      </View>
      <SymbolView name={ICONS.chevron} tintColor={palette.mut} size={16} />
    </Pressable>
  );
}

/**
 * The Run tab's Maps: the heat map over a range with its area chips, the routes run most in that
 * area (tap one to draw it bold on the map), and the doors to planned routes, segments and the
 * full-screen map. The Run tab hands in the routes it has already decoded and grouped.
 */
export function RunMaps({ decoded, weighted, groups }: { decoded?: DecodedRun[]; weighted?: HeatRoute[]; groups?: Map<string, RouteGroup> }) {
  const { palette } = useTheme();
  const units = useUnits();
  const { height: windowH } = useWindowDimensions();
  const hub = useMapsHub({ decoded, weighted, groups, groupsNow: true });
  const [allRoutes, setAllRoutes] = useState(false);
  const shown = allRoutes ? hub.areaGroups : hub.areaGroups.slice(0, FIRST_ROUTES);
  const state = <MapsState hub={hub} />;
  const blocked = hub.q.isLoading || !!hub.q.error || !hub.cluster;
  const card = { backgroundColor: palette.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.lg } as const;

  return (
    <View style={{ gap: space.md }}>
      <MapsChips hub={hub} />
      {blocked ? state : (
        <>
          <HubMap hub={hub} units={units} height={Math.round(Math.min(380, Math.max(240, windowH * 0.42)))} />
          <View style={{ gap: space.sm }}>
            <View>
              <T variant="h3">Frequent routes</T>
              <T variant="small" tone="mut">{hub.areaGroups.length ? routesSummary(hub) : 'Runs that follow the same path are grouped here.'}</T>
            </View>
            {shown.length ? (
              <View style={card}>
                {shown.map((g, i) => (
                  <FrequentRouteRow key={g.key} group={g} units={units} first={i === 0} onPress={() => hub.showGroup(g)} />
                ))}
              </View>
            ) : null}
            {hub.areaGroups.length > FIRST_ROUTES ? (
              <Button
                title={allRoutes ? 'Show fewer' : `Show all ${hub.areaGroups.length} routes`}
                variant="ghost"
                small
                onPress={() => setAllRoutes((a) => !a)}
              />
            ) : null}
          </View>
        </>
      )}
      <View style={card}>
        <LinkRow first icon="route" title="Planned routes" subtitle="Routes you have planned and kept" href="/run/routes" />
        <LinkRow icon="time" title="Segments" subtitle="Your best times on stretches you run often" href="/run/segments" />
        <LinkRow icon="map" title="Full-screen map" subtitle="The heat map and frequent routes, larger" href="/run/heatmap" />
      </View>
    </View>
  );
}
