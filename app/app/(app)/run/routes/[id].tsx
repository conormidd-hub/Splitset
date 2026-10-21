import { Stack, router, useLocalSearchParams } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Circle, Path } from 'react-native-svg';

import { useActivities } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { kindLabel, useDeleteRoute, useRoute, useRouteHeights } from '@/api/routes';
import { ROUTING_PROVIDER } from '@/api/routing';
import { ProfileChart, type ProfileSeries } from '@/components/charts/ProfileChart';
import { TileMap, type Projector } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { relativeDay } from '@/lib/dates';
import { saveTextFile } from '@/lib/download';
import { bboxOf, decodeRoute, haversineKm, pathD, type Bbox } from '@/lib/geo';
import { gpxFilename, toGpx } from '@/lib/gpx';
import { typicalPaceSecPerKm } from '@/lib/runAnalysis';
import { formatDistance, formatDuration, formatElevation } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const MAP_HEIGHT = 240;
const CHART_HEIGHT = 130;

/** Cumulative great-circle distance along the route in metres: the profile's x axis. */
function cumulativeM(pts: [number, number][]): number[] {
  const out = new Array<number>(pts.length);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) acc += haversineKm({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] }) * 1000;
    out[i] = acc;
  }
  return out;
}

/** The route over a halo. Re-projected only when the camera changes, not on every cursor move. */
const RoutePath = memo(function RoutePath({ pts, project, accent, halo }: { pts: [number, number][]; project: Projector; accent: string; halo: string }) {
  const d = useMemo(() => pathD(pts.map(([lat, lng]) => project(lat, lng)), 1), [pts, project]);
  if (!d) return null;
  return (
    <>
      <Path d={d} fill="none" stroke={halo} strokeOpacity={0.9} strokeWidth={6.5} strokeLinejoin="round" strokeLinecap="round" />
      <Path d={d} fill="none" stroke={accent} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
    </>
  );
});

/** One saved route: its map, elevation profile, headline numbers and a way to delete it. */
export default function RouteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const units = useUnits();
  const q = useRoute(id);
  const route = q.data;
  const heights = useRouteHeights(route);
  const recent = useActivities('runs');
  const del = useDeleteRoute();
  const [cursor, setCursor] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const pts = useMemo(() => (route ? decodeRoute(route.polyline) : []), [route]);
  const x = useMemo(() => cumulativeM(pts), [pts]);
  const bounds = useMemo<Bbox | null>(
    () => (route?.bbox && route.bbox.length === 4 ? (route.bbox as Bbox) : bboxOf(pts)),
    [route, pts],
  );
  // Heights line up 1:1 with the decoded polyline; anything else cannot be plotted against x.
  const hs = heights.data && heights.data.length === pts.length && pts.length >= 2 ? heights.data : null;
  const series = useMemo<ProfileSeries[]>(
    () => (hs ? [{ name: 'Elevation', color: palette.blue, values: hs, kind: 'area', format: (v) => formatElevation(v, units) }] : []),
    [hs, palette.blue, units],
  );
  // Stable so the chart's geometry memo survives cursor moves.
  const xFormat = useMemo(() => (m: number) => formatDistance(m, units, 1), [units]);

  const pace = useMemo(() => typicalPaceSecPerKm(recent.data?.pages[0]), [recent.data]);
  const est = route && pace != null ? (pace * route.distance_m) / 1000 : null;
  // a finish marker only where the route ends away from its start; loops, generated or drawn back to the start, have none
  const openEnded = pts.length >= 2
    && haversineKm({ lat: pts[0][0], lng: pts[0][1] }, { lat: pts[pts.length - 1][0], lng: pts[pts.length - 1][1] }) > 0.05;

  /** A GPX track, with the terrain heights once they have loaded, named after the route. */
  const onExport = async () => {
    if (!route || pts.length < 2) return;
    setExportError(null);
    setExporting(true);
    try {
      const desc = `${formatDistance(route.distance_m, units)} ${kindLabel(route.kind).toLowerCase()} from Splitset`;
      await saveTextFile(gpxFilename(route.name), toGpx({ name: route.name, pts, heights: hs, type: 'running', desc }), 'application/gpx+xml');
    } catch (e) {
      setExportError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const onDelete = async () => {
    if (!route) return;
    const ok = await confirm('Delete route', `Remove "${route.name}" from your saved routes? Your runs are not affected.`, 'Delete', true);
    if (!ok) return;
    del.mutate(route.id, {
      onSuccess: () => {
        if (router.canGoBack()) router.back();
        else router.replace('/run/routes');
      },
    });
  };

  const cursorPt = cursor != null && cursor >= 0 && cursor < pts.length ? pts[cursor] : null;

  return (
    <>
      <Stack.Screen options={{ title: route?.name ?? 'Route' }} />
      <Screen scrollEnabled={!scrubbing}>
        {q.isLoading ? (
          <Loading label="Loading route" />
        ) : q.error || !route ? (
          <ErrorBanner message={errorMessage(q.error) || 'Route not found'} />
        ) : (
          <>
            <View>
              <T variant="h1">{route.name}</T>
              <T variant="small" tone="mut">{kindLabel(route.kind)} · saved {relativeDay(route.created_at)}</T>
            </View>

            <Card>
              <View style={{ gap: space.sm }}>
                {bounds && pts.length >= 2 ? (
                  <TileMap bounds={bounds} height={MAP_HEIGHT}>
                    {(project) => {
                      const s = project(pts[0][0], pts[0][1]);
                      const e = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
                      const c = cursorPt ? project(cursorPt[0], cursorPt[1]) : null;
                      return (
                        <>
                          <RoutePath pts={pts} project={project} accent={palette.accent} halo={palette.surface} />
                          {openEnded ? <Circle cx={e.x} cy={e.y} r={5.5} fill={palette.neg} stroke={palette.surface} strokeWidth={2} /> : null}
                          <Circle cx={s.x} cy={s.y} r={5.5} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
                          {c ? <Circle cx={c.x} cy={c.y} r={7} fill={palette.accent} stroke={palette.surface} strokeWidth={2.5} /> : null}
                        </>
                      );
                    }}
                  </TileMap>
                ) : (
                  <ErrorBanner message="This route has no shape to draw." />
                )}

                {heights.isLoading ? (
                  <Loading label="Loading elevation" />
                ) : heights.error ? (
                  <ErrorBanner message={errorMessage(heights.error)} />
                ) : hs ? (
                  <ProfileChart
                    x={x}
                    series={series}
                    cursorIndex={cursor}
                    onCursor={setCursor}
                    height={CHART_HEIGHT}
                    xFormat={xFormat}
                    onScrubStart={() => setScrubbing(true)}
                    onScrubEnd={() => setScrubbing(false)}
                  />
                ) : null}
              </View>
            </Card>

            <Grid>
              <StatTile label="Distance" value={formatDistance(route.distance_m, units, 2)} />
              <StatTile label="Climb" value={formatElevation(route.elev_gain_m, units)} />
              <StatTile label="Descent" value={formatElevation(route.elev_loss_m, units)} />
              <StatTile label="Est. time" value={est != null ? formatDuration(est) : '–'} sub={est != null ? 'at your usual pace' : 'needs a few runs'} />
            </Grid>

            <Card
              title="Take it with you"
              subtitle="Export the route as a GPX file, then import it in Garmin Connect on the web (Training & Planning, Courses, Import) and send the course to your watch.">
              <View style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                  <Button title="Export GPX" variant="secondary" small onPress={onExport} loading={exporting} disabled={pts.length < 2} />
                  {route.kind === 'drawn' ? (
                    <Button title="Edit course" variant="secondary" small onPress={() => router.push({ pathname: '/run/routes/draw', params: { route: route.id } })} />
                  ) : null}
                </View>
                {exportError ? <ErrorBanner message={exportError} /> : null}
              </View>
            </Card>

            <Button title="Delete route" variant="danger" onPress={onDelete} loading={del.isPending} />
            {del.error ? <ErrorBanner message={errorMessage(del.error)} /> : null}

            <T variant="tiny" tone="mut" align="center">Routing by {route.provider ?? ROUTING_PROVIDER}</T>
          </>
        )}
      </Screen>
    </>
  );
}
