import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { Circle, G, Line, Path } from 'react-native-svg';

import { useActivities, useRunRoutes } from '@/api/activities';
import { keys } from '@/api/keys';
import { useCafes, useDebounced } from '@/api/places';
import { useUnits } from '@/api/profile';
import { routeWaypoints, useRoute, useSaveRoute, useUpdateRoute, type SavedRoute } from '@/api/routes';
import { ROUTING_PROVIDER, valhalla } from '@/api/routing';
import { CafeLayer } from '@/components/map/CafeLayer';
import { HeatLayer } from '@/components/map/HeatLayer';
import { StartPicker } from '@/components/map/StartPicker';
import { TileMap, type Projector, type Size } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import {
  LegCache, addWaypoint, closeLoop, insertWaypoint, isClosed, moveWaypoint, nearestLeg, nearestWaypoint, outAndBack,
  removeWaypoint, reverseCourse, routeCourse, type Course, type Waypoint,
} from '@/lib/courseBuilder';
import { MAX_ZOOM, clusterByLocation, pathD, sameView, unprojectPt, viewBbox, type Bbox, type LatLng, type MapView, type Pt } from '@/lib/geo';
import { decodeRuns, weightRoutesWithGroups } from '@/lib/heat';
import { CAFE_ZOOM, cafeBox, nearestCafe } from '@/lib/places';
import { typicalPaceSecPerKm } from '@/lib/runAnalysis';
import { formatDistance, formatDuration, formatElevation } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import type { Palette } from '@/theme/tokens';
import { radius, space } from '@/theme/tokens';

/** Below this zoom a fingertip covers a whole block, so a tap zooms in on the spot instead of placing a point. */
const PLACE_ZOOM = 13;
/** Framed when the user has no run with a GPS trace yet: tap your part of the world and keep tapping to zoom in. */
const WORLD: Bbox = [-50, -160, 65, 160];
const MAX_UNDO = 50;
/** A finger has to land this close to a point to pick it up. */
const GRAB_PX = 18;

/** Routed legs, kept for as long as the app runs: the same two points are never routed twice. */
const legs = new LegCache(valhalla);

/**
 * Draw a course point by point. Every tap adds a point and the course follows roads and paths
 * between the points; drag a point to move it, tap the line to add one in the middle, undo, close
 * the loop or retrace back to the start, then save it as a route. `?route=<id>` opens a saved
 * drawn course with its points to change it. The map stays pinned at the top while the rest
 * scrolls underneath.
 */
export default function DrawCourse() {
  const { route: routeId } = useLocalSearchParams<{ route?: string }>();
  const existing = useRoute(routeId || undefined);
  const title = routeId ? 'Edit course' : 'Draw a course';

  if (routeId) {
    if (existing.isLoading) {
      return (
        <>
          <Stack.Screen options={{ title }} />
          <Screen><Loading label="Loading course" /></Screen>
        </>
      );
    }
    const waypoints = routeWaypoints(existing.data);
    if (existing.error || !existing.data || !waypoints) {
      return (
        <>
          <Stack.Screen options={{ title }} />
          <Screen>
            <ErrorBanner message={existing.error ? errorMessage(existing.error) : !existing.data ? 'Route not found' : 'This route was generated, not drawn, so it has no points to move.'} />
          </Screen>
        </>
      );
    }
    return <Editor key={routeId} title={title} editing={existing.data} initial={waypoints} />;
  }
  return <Editor key="new" title={title} editing={null} initial={[]} />;
}

function Editor({ title, editing, initial }: { title: string; editing: SavedRoute | null; initial: Waypoint[] }) {
  const { palette } = useTheme();
  const units = useUnits();
  const { height: windowH } = useWindowDimensions();
  const runsQ = useRunRoutes();
  const recent = useActivities('runs');
  const save = useSaveRoute();
  const update = useUpdateRoute();

  const [wps, setWps] = useState<Waypoint[]>(initial);
  const [past, setPast] = useState<Waypoint[][]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  /** The point under the finger and where it is right now; the course re-routes on release. */
  const [drag, setDrag] = useState<{ index: number; at: Waypoint } | null>(null);
  const [showRuns, setShowRuns] = useState(true);
  const [showCafes, setShowCafes] = useState(true);
  /** Where the start came from when picked by name (an address, home, a café): the label "Save as home" keeps. */
  const [startLabel, setStartLabel] = useState<string | null>(null);
  /** The last point added by name, to confirm it under the map. */
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [view, setView] = useState<MapView | null>(null);
  /** The camera the map is drawing with and its size, reported by the map itself. */
  const [mapCam, setMapCam] = useState<{ cam: MapView; size: Size } | null>(null);

  /** Pinned at the top: two fifths of the window, so the toolbar and the stats still show under it. */
  const mapHeight = Math.round(Math.min(400, Math.max(240, windowH * 0.4)));
  const cam = mapCam?.cam ?? null;
  const size = mapCam?.size ?? null;
  const onCamera = useCallback((c: MapView, s: Size) => {
    setMapCam((prev) => (prev && sameView(prev.cam, c) && prev.size.width === s.width && prev.size.height === s.height ? prev : { cam: c, size: s }));
  }, []);

  // the user's runs underneath, weighted like the Run tab's map, so the course can follow the paths they know
  const decoded = useMemo(() => decodeRuns(runsQ.data), [runsQ.data]);
  const heat = useMemo(() => weightRoutesWithGroups(decoded).routes, [decoded]);
  const home = useMemo(() => clusterByLocation(decoded, (r) => r.box)[0] ?? null, [decoded]);
  const bounds = useMemo<Bbox>(
    () => (editing?.bbox && editing.bbox.length === 4 ? (editing.bbox as Bbox) : home?.fit ?? WORLD),
    [editing, home],
  );

  // the cafés in view once zoomed in enough, asked for when the map has settled
  const cafeKey = showCafes && cam && size && cam.zoom >= CAFE_ZOOM ? cafeBox(viewBbox(cam, size)).join(',') : null;
  const settledCafeKey = useDebounced(cafeKey, 600);
  const cafesQ = useCafes(settledCafeKey ? (settledCafeKey.split(',').map(Number) as Bbox) : null);
  const cafes = showCafes && cafesQ.data ? cafesQ.data : [];

  const courseQ = useQuery({
    queryKey: keys.course(wps),
    enabled: wps.length >= 2,
    staleTime: Infinity,
    retry: false,
    // the previous course stays on the map while the changed legs route
    placeholderData: keepPreviousData,
    queryFn: () => routeCourse(wps, legs),
  });
  const course: Course | null = wps.length >= 2 ? courseQ.data ?? null : null;
  /** The course on screen is the one for these points (not a previous one kept while routing). */
  const current = !!course && course.waypoints === wps;
  const routing = wps.length >= 2 && (courseQ.isFetching || !current);
  const closed = isClosed(wps);
  const shown = drag ? moveWaypoint(wps, drag.index, drag.at) : wps;

  const pace = useMemo(() => typicalPaceSecPerKm(recent.data?.pages[0]), [recent.data]);
  const est = course ? (pace != null ? (pace * course.distance_m) / 1000 : course.duration_s) : null;

  /** Every change goes through here, so Undo can take it back. */
  const commit = (next: Waypoint[]) => {
    if (next === wps) return;
    setPast((p) => [...p.slice(-(MAX_UNDO - 1)), wps]);
    setWps(next);
    setSelected(null);
    setLastAdded(null);
    if (next[0] !== wps[0]) setStartLabel(null);
  };
  const undo = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast((p) => p.slice(0, -1));
    setWps(prev);
    setSelected(null);
  };

  /** A map-local point as a waypoint, through the size the map reported. */
  const toWaypoint = (pt: Pt, c: MapView): Waypoint => {
    const p = unprojectPt(pt, c, size ?? { width: 0, height: mapHeight });
    return [p.lat, p.lng];
  };

  const onMapPress = (pt: Pt, project: Projector, c: MapView) => {
    if (!size) return;
    if (c.zoom < PLACE_ZOOM) {
      setView({ center: unprojectPt(pt, c, size), zoom: Math.min(MAX_ZOOM, c.zoom + 3) });
      return;
    }
    const hit = nearestWaypoint(wps, project, pt);
    if (hit != null) {
      setSelected((s) => (s === hit ? null : hit));
      return;
    }
    // a tap on a café puts the point exactly there, at the end of the course
    const cafe = nearestCafe(cafes, project, pt);
    const p: Waypoint = cafe ? [cafe.lat, cafe.lng] : toWaypoint(pt, c);
    const leg = current && !cafe ? nearestLeg(course, project, pt) : null;
    commit(leg != null ? insertWaypoint(wps, leg, p) : addWaypoint(wps, p));
    if (cafe) {
      const label = cafe.name ?? 'Café';
      setLastAdded(label);
      if (!wps.length) setStartLabel(label);
    }
  };

  /** From the search, the device or home: the next point of the course, and the map looks at it. */
  const onPick = (p: LatLng, label: string) => {
    commit(addWaypoint(wps, [p.lat, p.lng]));
    setLastAdded(label);
    if (!wps.length) setStartLabel(label);
    setView({ center: p, zoom: Math.max(cam?.zoom ?? 0, 15) });
  };

  const onDragStart = (pt: Pt, project: Projector, c: MapView) => {
    if (c.zoom < PLACE_ZOOM) return false;
    const hit = nearestWaypoint(wps, project, pt, GRAB_PX);
    if (hit == null) return false;
    setDrag({ index: hit, at: wps[hit] });
    setSelected(hit);
    return true;
  };
  const onDragMove = (pt: Pt) => {
    if (drag && cam) setDrag({ index: drag.index, at: toWaypoint(pt, cam) });
  };
  const onDragEnd = (pt: Pt) => {
    if (!drag) return;
    if (cam) commit(moveWaypoint(wps, drag.index, toWaypoint(pt, cam)));
    setDrag(null);
    setSelected(drag.index);
  };

  const removeSelected = () => {
    if (selected != null) commit(removeWaypoint(wps, selected));
  };
  const tryAgain = async () => {
    await legs.forgetFailures();
    courseQ.refetch();
  };

  const canSave = current && !course.unrouted.length && !routing;
  const defaultName = course ? `${formatDistance(course.distance_m, units)} course` : 'Course';
  const saving = save.isPending || update.isPending;
  const saveError = save.error ?? update.error;
  const onSave = () => {
    if (!course || !canSave) return;
    const input = {
      name: name.trim() || defaultName, pts: course.pts, distance_m: course.distance_m, elev_gain_m: course.elev_gain_m,
      elev_loss_m: course.elev_loss_m, kind: 'drawn' as const, waypoints: wps,
    };
    const open = (id: string) => router.replace(`/run/routes/${id}`);
    if (editing) update.mutate({ id: editing.id, ...input }, { onSuccess: open });
    else save.mutate(input, { onSuccess: open });
  };

  const hint = !cam
    ? ''
    : cam.zoom < PLACE_ZOOM
      ? 'Zoom in to draw: tap the map to zoom in on that spot.'
      : !wps.length
        ? 'Tap the map where your course starts, or search for it below.'
        : wps.length === 1
          ? 'Tap where to go next. Each tap adds a point, and the course follows roads and paths between the points.'
          : current && course.unrouted.length
            ? 'A point is too far from any road or path. Drag it onto one, or tap it and remove it.'
            : selected != null
              ? 'Drag the point to move it, or remove it. Tap it again to let it go.'
              : 'Tap to add a point, tap the line to add one in the middle, drag a point to move it. Drag elsewhere to pan.';

  return (
    <>
      <Stack.Screen options={{ title }} />
      <Screen scroll={false} padded={false} style={{ flex: 1 }}>
        {/* pinned: the map, its hint and the toolbar; everything else scrolls beneath */}
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
          {runsQ.isLoading ? (
            <View style={{ height: mapHeight, borderRadius: radius.md, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center' }}>
              <Loading label="Finding your runs" />
            </View>
          ) : (
            <View>
              <TileMap
                bounds={bounds}
                view={view}
                onViewChange={setView}
                onCamera={onCamera}
                height={mapHeight}
                interactive
                onPress={onMapPress}
                onDragStart={onDragStart}
                onDragMove={onDragMove}
                onDragEnd={onDragEnd}>
                {(project, mapSize, c) => (
                  <>
                    {showRuns && heat.length ? (
                      <HeatLayer routes={heat} project={project} size={mapSize} zoom={c.zoom} highlight={null} palette={palette} />
                    ) : null}
                    {cafes.length && c.zoom >= CAFE_ZOOM ? <CafeLayer cafes={cafes} project={project} size={mapSize} zoom={c.zoom} palette={palette} /> : null}
                    {course ? <CourseLines course={course} project={project} palette={palette} faded={routing} /> : null}
                    {drag ? <RubberBand wps={shown} index={drag.index} project={project} colour={palette.ink2} /> : null}
                    <Markers wps={shown} selected={selected} closed={closed} project={project} palette={palette} />
                  </>
                )}
              </TileMap>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T variant="small" tone="mut">{hint}</T>
              {lastAdded ? <T variant="small">Added {lastAdded}.</T> : null}
            </View>
            {heat.length ? <Chip label="My runs" selected={showRuns} onPress={() => setShowRuns((v) => !v)} /> : null}
            <Chip label="Cafés" selected={showCafes} onPress={() => setShowCafes((v) => !v)} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Button title="Undo" variant="secondary" small onPress={undo} disabled={!past.length} />
            {selected != null ? <Button title="Remove point" variant="danger" small onPress={removeSelected} /> : null}
            {wps.length >= 2 && !closed ? <Button title="Back to start" variant="secondary" small onPress={() => commit(closeLoop(wps))} /> : null}
            {wps.length >= 2 && !closed ? <Button title="Out and back" variant="secondary" small onPress={() => commit(outAndBack(wps))} /> : null}
            {wps.length >= 2 ? <Button title="Reverse" variant="secondary" small onPress={() => commit(reverseCourse(wps))} /> : null}
            {wps.length ? <Button title="Clear" variant="ghost" small onPress={() => commit([])} /> : null}
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: space.xxl }}
          keyboardShouldPersistTaps="handled">
          {runsQ.error ? <ErrorBanner message={errorMessage(runsQ.error)} /> : null}
          {courseQ.error ? <ErrorBanner message={errorMessage(courseQ.error)} /> : null}

          {course ? (
            <Grid>
              <StatTile label="Distance" value={formatDistance(course.distance_m, units, 2)} sub={routing ? 'routing…' : undefined} />
              <StatTile label="Climb" value={formatElevation(course.elev_gain_m, units)} sub={course.heightsKnown ? undefined : 'some legs unknown'} />
              <StatTile label="Descent" value={formatElevation(course.elev_loss_m, units)} sub={course.heightsKnown ? undefined : 'some legs unknown'} />
              <StatTile label="Est. time" value={est != null ? formatDuration(est) : '–'} sub={pace != null ? 'at your usual pace' : 'walking'} />
            </Grid>
          ) : null}

          {current && course.unrouted.length ? (
            <Card tone="neg">
              <View style={{ gap: space.sm }}>
                <T>
                  {course.unrouted.length === 1 ? 'One stretch' : `${course.unrouted.length} stretches`} of this course could not be routed and
                  {course.unrouted.length === 1 ? ' is' : ' are'} drawn as a straight dashed line. Move or remove the point, or try again if the
                  routing server was busy.
                </T>
                <View style={{ flexDirection: 'row' }}>
                  <Button title="Try again" variant="secondary" small onPress={tryAgain} />
                </View>
              </View>
            </Card>
          ) : null}

          <Card>
            <StartPicker
              near={cam?.center ?? null}
              prompt={wps.length ? 'Add an address or place as the next point' : 'Start from an address or place'}
              onPick={onPick}
              current={wps.length ? { p: { lat: wps[0][0], lng: wps[0][1] }, label: startLabel } : null}
            />
          </Card>

          {!wps.length && !runsQ.isLoading ? (
            <Card title="How it works">
              <View style={{ gap: space.xs }}>
                <T variant="small" tone="mut">1. Put the start on the map: tap it, search an address, or use your location or home.</T>
                <T variant="small" tone="mut">2. Keep tapping where you want to go. The course follows roads and paths between your points; the cups are cafés to run to.</T>
                <T variant="small" tone="mut">3. Drag a point to move it, tap the line to add one, finish with Back to start or Out and back, and save.</T>
              </View>
            </Card>
          ) : null}

          {wps.length >= 2 ? (
            <Card title={editing ? 'Save changes' : 'Save course'}>
              <View style={{ gap: space.md }}>
                <TextField label="Name" value={name} onChangeText={setName} placeholder={defaultName} returnKeyType="done" />
                {saveError ? <ErrorBanner message={errorMessage(saveError)} /> : null}
                <Button title={editing ? 'Save changes' : 'Save course'} onPress={onSave} loading={saving} disabled={!canSave} />
              </View>
            </Card>
          ) : null}

          <T variant="tiny" tone="mut" align="center">Routing by {ROUTING_PROVIDER}</T>
        </ScrollView>
      </Screen>
    </>
  );
}

/**
 * The course: each routed leg bold over a halo, each leg that could not be routed a straight
 * dashed line in the warning colour. Faded while the changed legs are still routing.
 * Re-projected only when the course or the camera changes.
 */
const CourseLines = memo(function CourseLines({ course, project, palette, faded }: { course: Course; project: Projector; palette: Palette; faded: boolean }) {
  const paths = useMemo(
    () => course.legs.map((leg) => ({ d: pathD(leg.pts.map(([lat, lng]) => project(lat, lng)), 1), broken: !!leg.error })),
    [course, project],
  );
  return (
    <G opacity={faded ? 0.55 : 1}>
      {paths.map((p, i) =>
        !p.d ? null : p.broken ? (
          <Path key={i} d={p.d} fill="none" stroke={palette.neg} strokeWidth={3} strokeDasharray="7 6" strokeLinecap="round" />
        ) : (
          <G key={i}>
            <Path d={p.d} fill="none" stroke={palette.surface} strokeOpacity={0.9} strokeWidth={6.5} strokeLinejoin="round" strokeLinecap="round" />
            <Path d={p.d} fill="none" stroke={palette.accent} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
          </G>
        ),
      )}
    </G>
  );
});

/** Dashed lines from the point being dragged to its neighbours: where the course will go once the finger lifts. */
function RubberBand({ wps, index, project, colour }: { wps: Waypoint[]; index: number; project: Projector; colour: string }) {
  const at = project(wps[index][0], wps[index][1]);
  return (
    <>
      {[index - 1, index + 1].map((k) => {
        const n = wps[k];
        if (!n) return null;
        const s = project(n[0], n[1]);
        return <Line key={k} x1={at.x} y1={at.y} x2={s.x} y2={s.y} stroke={colour} strokeOpacity={0.7} strokeWidth={2} strokeDasharray="4 5" />;
      })}
    </>
  );
}

/**
 * The points: the start in the positive colour, the finish (when the course does not come back
 * to the start) in the negative one, the rest small accent rings, and the selected one large.
 * On a closed course the last point sits on the first and is not drawn twice.
 */
function Markers({ wps, selected, closed, project, palette }: { wps: Waypoint[]; selected: number | null; closed: boolean; project: Projector; palette: Palette }) {
  const last = wps.length - 1;
  const order = selected != null ? [...wps.keys()].filter((i) => i !== selected).concat(selected) : [...wps.keys()];
  return (
    <>
      {order.map((i) => {
        if (closed && i === last) return null;
        const s = project(wps[i][0], wps[i][1]);
        const isSelected = i === selected || (closed && selected === last && i === 0);
        if (isSelected) return <Circle key={i} cx={s.x} cy={s.y} r={9} fill={palette.accent} stroke={palette.surface} strokeWidth={2.5} />;
        if (i === 0) return <Circle key={i} cx={s.x} cy={s.y} r={7} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />;
        if (i === last && wps.length > 1) return <Circle key={i} cx={s.x} cy={s.y} r={7} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />;
        return <Circle key={i} cx={s.x} cy={s.y} r={5.5} fill={palette.surface} stroke={palette.accent} strokeWidth={2.5} />;
      })}
    </>
  );
}
