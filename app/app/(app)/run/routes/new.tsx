import { useMutation } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Circle, Path } from 'react-native-svg';

import { useActivities, useRunRoutes } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { useSaveRoute } from '@/api/routes';
import { ROUTING_PROVIDER, valhalla } from '@/api/routing';
import { TileMap, type Projector, type Size } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import {
  MAX_ZOOM, bboxOf, decodeRoute, fitBbox, mercX, mercY, pathD, unMercX, unMercY, type Bbox, type LatLng, type MapView, type Pt,
} from '@/lib/geo';
import { generateLoops, generatePointToPoint, type Candidate } from '@/lib/routeBuilder';
import { KM_PER_MILE, formatDistance, formatDuration, formatElevation, secPerKm } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Mode = Candidate['kind'];

const MODES: { value: Mode; label: string }[] = [
  { value: 'loop', label: 'Loop' },
  { value: 'point_to_point', label: 'Point to point' },
];

const MAP_HEIGHT = 300;
/** Must match the padding handed to TileMap so the camera derived here is the one it draws with. */
const MAP_PADDING = 24;
/** Below this zoom a fingertip covers hundreds of metres, so a tap zooms in on the spot instead of placing a point. */
const PLACE_ZOOM = 12;
/** Zoom to jump to when a point is chosen for the user (last run start). */
const PLACE_VIEW_ZOOM = 14;
/** Framed when the user has no run with a GPS trace yet: tap your part of the world and keep tapping to zoom in. */
const WORLD: Bbox = [-50, -160, 65, 160];

type GenInput = { mode: Mode; start: LatLng; end: LatLng | null; targetM: number | null };

/** Map-local pixels back to a coordinate, the inverse of TileMap's projector for camera `cam`. */
function unproject(pt: Pt, cam: MapView, size: Size): LatLng {
  const world = 2 ** cam.zoom;
  const tlx = mercX(cam.center.lng) * world - size.width / 2;
  const tly = mercY(cam.center.lat) * world - size.height / 2;
  return { lat: unMercY((tly + pt.y) / world), lng: unMercX((tlx + pt.x) / world) };
}

const toLatLng = (p: [number, number]): LatLng => ({ lat: p[0], lng: p[1] });

/**
 * Median pace (s/km) over the newest ten runs that have a distance and a moving time, so the
 * estimated time for a route is the user's own, not the router's walking speed.
 */
function typicalPaceSecPerKm(rows: { distance_m: number | null; moving_time_s: number | null }[] | undefined): number | null {
  if (!rows) return null;
  const paces = rows
    .map((r) => (r.distance_m != null && r.distance_m >= 1000 ? secPerKm(r.distance_m, r.moving_time_s) : null))
    .filter((p): p is number => p != null)
    .slice(0, 10)
    .sort((a, b) => a - b);
  if (!paces.length) return null;
  const mid = paces.length >> 1;
  return paces.length % 2 ? paces[mid] : (paces[mid - 1] + paces[mid]) / 2;
}

/** Every candidate as a faint line, the selected one bold over a halo. Re-projected only when the camera moves. */
const CandidatePaths = memo(function CandidatePaths({
  candidates, selected, project, accent, halo,
}: { candidates: Candidate[]; selected: number; project: Projector; accent: string; halo: string }) {
  const ds = useMemo(
    () => candidates.map((c) => pathD(c.pts.map(([lat, lng]) => project(lat, lng)), 1)),
    [candidates, project],
  );
  const chosen = ds[selected];
  return (
    <>
      {ds.map((d, i) =>
        i === selected || !d ? null : (
          <Path key={i} d={d} fill="none" stroke={accent} strokeOpacity={0.3} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        ),
      )}
      {chosen ? (
        <>
          <Path d={chosen} fill="none" stroke={halo} strokeOpacity={0.9} strokeWidth={6.5} strokeLinejoin="round" strokeLinecap="round" />
          <Path d={chosen} fill="none" stroke={accent} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
        </>
      ) : null}
    </>
  );
});

function marker(project: Projector, p: LatLng, fill: string, ring: string) {
  const s = project(p.lat, p.lng);
  return <Circle cx={s.x} cy={s.y} r={6} fill={fill} stroke={ring} strokeWidth={2} />;
}

/**
 * Build a route along real roads and paths: choose loop or point to point, tap the map to place
 * the start (and end), give a target distance, generate, pick a candidate and save it.
 */
export default function NewRoute() {
  const { palette } = useTheme();
  const units = useUnits();
  const runs = useRunRoutes();
  const recent = useActivities('runs');
  const save = useSaveRoute();

  const [mode, setMode] = useState<Mode>('loop');
  const [start, setStart] = useState<LatLng | null>(null);
  const [end, setEnd] = useState<LatLng | null>(null);
  /** Target distance in the display unit (km or mi). */
  const [target, setTarget] = useState<number | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  const [mapWidth, setMapWidth] = useState(0);
  const [mapTouch, setMapTouch] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [name, setName] = useState('');

  // useRunRoutes is oldest first, so the last entry is the most recent run with a trace.
  const lastRun = runs.data?.length ? runs.data[runs.data.length - 1] : null;
  const lastPts = useMemo(() => (lastRun ? decodeRoute(lastRun.polyline) : []), [lastRun]);
  const bounds = useMemo<Bbox>(() => lastRun?.bbox ?? bboxOf(lastPts) ?? WORLD, [lastRun, lastPts]);
  // The camera TileMap is drawing with: the explicit view, else the same fit it computes itself.
  const cam = useMemo<MapView | null>(
    () => view ?? (mapWidth ? fitBbox(bounds, mapWidth, MAP_HEIGHT, MAP_PADDING) : null),
    [view, bounds, mapWidth],
  );

  const pace = useMemo(() => typicalPaceSecPerKm(recent.data?.pages[0]), [recent.data]);
  const unitLabel = units === 'imperial' ? 'mi' : 'km';
  const targetM = target != null && target > 0 ? target * (units === 'imperial' ? KM_PER_MILE : 1) * 1000 : null;

  const gen = useMutation({
    retry: false,
    mutationFn: (input: GenInput): Promise<Candidate[]> => {
      if (input.mode === 'loop') {
        if (input.targetM == null) throw new Error('Enter a target distance');
        return generateLoops(input.start, input.targetM, valhalla);
      }
      if (!input.end) throw new Error('Place the end point');
      return generatePointToPoint(input.start, input.end, input.targetM, valhalla);
    },
  });
  const candidates = gen.data ?? [];
  const selected = candidates.length ? Math.min(selectedIdx, candidates.length - 1) : -1;
  const chosen = selected >= 0 ? candidates[selected] : null;

  // Routes begin at the point the router snapped onto a path, so once there are candidates the
  // markers follow the chosen one rather than the tapped spot.
  const startPt = chosen ? toLatLng(chosen.pts[0]) : start;
  const endPt = mode === 'point_to_point' ? (chosen ? toLatLng(chosen.pts[chosen.pts.length - 1]) : end) : null;

  const resetCandidates = () => {
    gen.reset();
    setSelectedIdx(0);
  };

  const onMapLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setMapWidth((prev) => (prev === w ? prev : w));
  };

  const onMapPress = (pt: Pt) => {
    if (!cam || !mapWidth) return;
    const p = unproject(pt, cam, { width: mapWidth, height: MAP_HEIGHT });
    if (cam.zoom < PLACE_ZOOM) {
      setView({ center: p, zoom: Math.min(MAX_ZOOM, cam.zoom + 3) });
      return;
    }
    if (!start || mode === 'loop') setStart(p);
    else setEnd(p);
    resetCandidates();
  };

  const onModeChange = (m: Mode) => {
    setMode(m);
    if (m === 'loop') setEnd(null);
    resetCandidates();
  };

  const useLastRunStart = () => {
    if (!lastPts.length) return;
    const p = toLatLng(lastPts[0]);
    setStart(p);
    setView({ center: p, zoom: Math.max(cam?.zoom ?? 0, PLACE_VIEW_ZOOM) });
    resetCandidates();
  };

  const clearPoints = () => {
    setStart(null);
    setEnd(null);
    resetCandidates();
  };

  const canGenerate = !!start && (mode === 'loop' ? targetM != null : !!end) && !gen.isPending;
  const generate = () => {
    if (!start) return;
    gen.mutate({ mode, start, end, targetM }, { onSuccess: () => setSelectedIdx(0) });
  };

  const defaultName = chosen ? `${chosen.label} · ${formatDistance(chosen.distance_m, units)}` : '';
  const onSave = () => {
    if (!chosen) return;
    save.mutate(
      { name: name.trim() || defaultName, candidate: chosen, start: toLatLng(chosen.pts[0]) },
      { onSuccess: (id) => router.replace(`/run/routes/${id}`) },
    );
  };

  /** "~48:30" at the user's usual pace, or the router's walking time when there are no runs to learn from. */
  const estLabel = (c: Candidate) => (pace != null ? `~${formatDuration((pace * c.distance_m) / 1000)}` : `walk ${formatDuration(c.duration_s)}`);

  const hint = !cam
    ? ''
    : cam.zoom < PLACE_ZOOM
      ? 'Zoom in to place points: tap the map to zoom in on that spot.'
      : !start
        ? 'Tap the map to place the start.'
        : mode === 'point_to_point' && !end
          ? 'Tap the map to place the end.'
          : mode === 'loop'
            ? 'Tap elsewhere to move the start. Drag to pan.'
            : 'Tap elsewhere to move the end, or clear the points to start over.';

  return (
    <>
      <Stack.Screen options={{ title: 'New route' }} />
      <Screen scrollEnabled={!mapTouch}>
        <Segmented<Mode> options={MODES} value={mode} onChange={onModeChange} />

        {runs.isLoading ? (
          <Loading label="Finding your last run" />
        ) : (
          <View style={{ gap: space.sm }}>
            {/* While a finger is on the map the page must not scroll, or every vertical pan would scroll instead. */}
            <View
              onLayout={onMapLayout}
              onTouchStart={() => setMapTouch(true)}
              onTouchEnd={() => setMapTouch(false)}
              onTouchCancel={() => setMapTouch(false)}>
              <TileMap bounds={bounds} view={view} onViewChange={setView} height={MAP_HEIGHT} padding={MAP_PADDING} interactive onPress={onMapPress}>
                {(project) => (
                  <>
                    {candidates.length ? (
                      <CandidatePaths candidates={candidates} selected={selected} project={project} accent={palette.accent} halo={palette.surface} />
                    ) : null}
                    {endPt ? marker(project, endPt, palette.neg, palette.surface) : null}
                    {startPt ? marker(project, startPt, palette.pos, palette.surface) : null}
                  </>
                )}
              </TileMap>
            </View>
            <T variant="small" tone="mut">{hint}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {lastPts.length ? <Button title="Use last run start" variant="secondary" small onPress={useLastRunStart} /> : null}
              {start ? <Button title="Clear points" variant="ghost" small onPress={clearPoints} /> : null}
            </View>
          </View>
        )}
        {runs.error ? <ErrorBanner message={errorMessage(runs.error)} /> : null}

        <Card>
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.md }}>
              <View style={{ gap: space.xs }}>
                <T variant="label" tone="mut">{mode === 'loop' ? `Target ${unitLabel}` : `Target ${unitLabel} (optional)`}</T>
                <NumberInput value={target} onChange={setTarget} width={96} placeholder="–" muted />
              </View>
              <Button title="Generate" onPress={generate} loading={gen.isPending} disabled={!canGenerate} style={{ flex: 1 }} />
            </View>
            {gen.error ? <ErrorBanner message={errorMessage(gen.error)} /> : null}
          </View>
        </Card>

        {candidates.length ? (
          <Card title="Routes found" subtitle={targetM != null ? `Closest to ${formatDistance(targetM, units)} first` : 'Direct route first'}>
            {candidates.map((c, i) => (
              <ListRow
                key={`${c.label}-${i}`}
                first={i === 0}
                title={c.label}
                subtitle={`${formatElevation(c.elev_gain_m, units)} climb · ${formatElevation(c.elev_loss_m, units)} descent`}
                badge={i === selected ? <Badge label="Selected" tone="accent" /> : undefined}
                value={formatDistance(c.distance_m, units)}
                valueSub={estLabel(c)}
                onPress={() => setSelectedIdx(i)}
              />
            ))}
          </Card>
        ) : null}

        {chosen ? (
          <Card title="Save route">
            <View style={{ gap: space.md }}>
              <TextField label="Name" value={name} onChangeText={setName} placeholder={defaultName} returnKeyType="done" />
              {save.error ? <ErrorBanner message={errorMessage(save.error)} /> : null}
              <Button title="Save route" onPress={onSave} loading={save.isPending} />
            </View>
          </Card>
        ) : null}

        <T variant="tiny" tone="mut" align="center">Routing by {ROUTING_PROVIDER}</T>
      </Screen>
    </>
  );
}
