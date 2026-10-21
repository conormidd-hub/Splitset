import { useMutation } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Circle, Path } from 'react-native-svg';

import { useActivities, useRunRoutes } from '@/api/activities';
import { useCafes, useDebounced } from '@/api/places';
import { useUnits } from '@/api/profile';
import { useSaveRoute } from '@/api/routes';
import { ROUTING_PROVIDER, valhalla } from '@/api/routing';
import { CafeLayer } from '@/components/map/CafeLayer';
import { StartPicker } from '@/components/map/StartPicker';
import { TileMap, type Projector } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Chip, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { MAX_ZOOM, bboxOf, decodeRoute, fitBbox, pathD, unprojectPt, viewBbox, type Bbox, type LatLng, type MapView, type Pt } from '@/lib/geo';
import { CAFE_ZOOM, cafeBox, nearestCafe } from '@/lib/places';
import { generateLoops, generatePointToPoint, type Candidate } from '@/lib/routeBuilder';
import { typicalPaceSecPerKm } from '@/lib/runAnalysis';
import { KM_PER_MILE, formatDistance, formatDuration, formatElevation } from '@/lib/units';
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

/** `distM` is the typed distance: a loop's target length, or how much further than the direct route a point-to-point should go. */
type GenInput = { mode: Mode; start: LatLng; end: LatLng | null; distM: number | null };

const toLatLng = (p: [number, number]): LatLng => ({ lat: p[0], lng: p[1] });

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
  /** Where the start (and the end) came from when picked by name: an address, home, a café. */
  const [startLabel, setStartLabel] = useState<string | null>(null);
  const [endLabel, setEndLabel] = useState<string | null>(null);
  const [showCafes, setShowCafes] = useState(true);

  // useRunRoutes is oldest first, so the last entry is the most recent run with a trace.
  const lastRun = runs.data?.length ? runs.data[runs.data.length - 1] : null;
  const lastPts = useMemo(() => (lastRun ? decodeRoute(lastRun.polyline) : []), [lastRun]);
  const bounds = useMemo<Bbox>(() => lastRun?.bbox ?? bboxOf(lastPts) ?? WORLD, [lastRun, lastPts]);
  // The camera TileMap is drawing with: the explicit view, else the same fit it computes itself.
  const cam = useMemo<MapView | null>(
    () => view ?? (mapWidth ? fitBbox(bounds, mapWidth, MAP_HEIGHT, MAP_PADDING) : null),
    [view, bounds, mapWidth],
  );
  const size = useMemo(() => ({ width: mapWidth, height: MAP_HEIGHT }), [mapWidth]);

  // the cafés in view once zoomed in enough, asked for when the map has settled
  const cafeKey = showCafes && cam && mapWidth && cam.zoom >= CAFE_ZOOM ? cafeBox(viewBbox(cam, size)).join(',') : null;
  const settledCafeKey = useDebounced(cafeKey, 600);
  const cafesQ = useCafes(settledCafeKey ? (settledCafeKey.split(',').map(Number) as Bbox) : null);
  const cafes = showCafes && cafesQ.data ? cafesQ.data : [];

  const pace = useMemo(() => typicalPaceSecPerKm(recent.data?.pages[0]), [recent.data]);
  const unitLabel = units === 'imperial' ? 'mi' : 'km';
  const distM = target != null && target > 0 ? target * (units === 'imperial' ? KM_PER_MILE : 1) * 1000 : null;

  const gen = useMutation({
    retry: false,
    mutationFn: (input: GenInput): Promise<Candidate[]> => {
      if (input.mode === 'loop') {
        if (input.distM == null) throw new Error('Enter a target distance');
        return generateLoops(input.start, input.distM, valhalla);
      }
      if (!input.end) throw new Error('Place the end point');
      return generatePointToPoint(input.start, input.end, input.distM != null ? { extraM: input.distM } : null, valhalla);
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

  /** Put the start (or, point to point, the end) at `p`; `label` says where it came from when picked by name. */
  const place = (p: LatLng, label: string | null) => {
    if (!start || mode === 'loop') {
      setStart(p);
      setStartLabel(label);
    } else {
      setEnd(p);
      setEndLabel(label);
    }
    resetCandidates();
  };

  const onMapPress = (pt: Pt, project: Projector) => {
    if (!cam || !mapWidth) return;
    const tapped = unprojectPt(pt, cam, size);
    if (cam.zoom < PLACE_ZOOM) {
      setView({ center: tapped, zoom: Math.min(MAX_ZOOM, cam.zoom + 3) });
      return;
    }
    // a tap on a café puts the point exactly there
    const cafe = nearestCafe(cafes, project, pt);
    place(cafe ? { lat: cafe.lat, lng: cafe.lng } : tapped, cafe ? cafe.name ?? 'Café' : null);
  };

  /** From the search, the device or home: put the point there and look at it. */
  const onPick = (p: LatLng, label: string) => {
    place(p, label);
    setView({ center: p, zoom: Math.max(cam?.zoom ?? 0, PLACE_VIEW_ZOOM) });
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
    setStartLabel('Last run start');
    setView({ center: p, zoom: Math.max(cam?.zoom ?? 0, PLACE_VIEW_ZOOM) });
    resetCandidates();
  };

  const clearPoints = () => {
    setStart(null);
    setEnd(null);
    setStartLabel(null);
    setEndLabel(null);
    resetCandidates();
  };

  const canGenerate = !!start && (mode === 'loop' ? distM != null : !!end) && !gen.isPending;
  const generate = () => {
    if (!start) return;
    gen.mutate({ mode, start, end, distM }, { onSuccess: () => setSelectedIdx(0) });
  };
  const where = [startLabel ? `Start: ${startLabel}` : null, endLabel ? `End: ${endLabel}` : null].filter(Boolean).join(' · ');

  const defaultName = chosen ? `${chosen.label} · ${formatDistance(chosen.distance_m, units)}` : '';
  const onSave = () => {
    if (!chosen) return;
    save.mutate(
      {
        name: name.trim() || defaultName, pts: chosen.pts, distance_m: chosen.distance_m, elev_gain_m: chosen.elev_gain_m,
        elev_loss_m: chosen.elev_loss_m, kind: chosen.kind, waypoints: null,
      },
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
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button title="Draw your own course instead" variant="ghost" small onPress={() => router.push('/run/routes/draw')} />
        </View>

        {runs.isLoading ? (
          <Loading label="Finding your last run" />
        ) : (
          <View style={{ gap: space.sm }}>
            <StartPicker
              near={cam?.center ?? null}
              prompt={mode === 'point_to_point' && start ? 'Search the end: an address or a place' : 'Search the start: an address or a place'}
              onPick={onPick}
              current={start ? { p: start, label: startLabel } : null}
              extra={
                <>
                  {lastPts.length ? <Button title="Last run start" variant="secondary" small onPress={useLastRunStart} /> : null}
                  {start ? <Button title="Clear points" variant="ghost" small onPress={clearPoints} /> : null}
                </>
              }
            />
            {/* While a finger is on the map the page must not scroll, or every vertical pan would scroll instead. */}
            <View
              onLayout={onMapLayout}
              onTouchStart={() => setMapTouch(true)}
              onTouchEnd={() => setMapTouch(false)}
              onTouchCancel={() => setMapTouch(false)}>
              <TileMap bounds={bounds} view={view} onViewChange={setView} height={MAP_HEIGHT} padding={MAP_PADDING} interactive onPress={onMapPress}>
                {(project, mapSize, c) => (
                  <>
                    {cafes.length && c.zoom >= CAFE_ZOOM ? <CafeLayer cafes={cafes} project={project} size={mapSize} zoom={c.zoom} palette={palette} /> : null}
                    {candidates.length ? (
                      <CandidatePaths candidates={candidates} selected={selected} project={project} accent={palette.accent} halo={palette.surface} />
                    ) : null}
                    {endPt ? marker(project, endPt, palette.neg, palette.surface) : null}
                    {startPt ? marker(project, startPt, palette.pos, palette.surface) : null}
                  </>
                )}
              </TileMap>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="small" tone="mut">{hint}</T>
                {where ? <T variant="small">{where}</T> : null}
              </View>
              <Chip label="Cafés" selected={showCafes} onPress={() => setShowCafes((v) => !v)} />
            </View>
          </View>
        )}
        {runs.error ? <ErrorBanner message={errorMessage(runs.error)} /> : null}

        <Card>
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.md }}>
              <View style={{ gap: space.xs }}>
                <T variant="label" tone="mut">{mode === 'loop' ? `Target ${unitLabel}` : `Extra ${unitLabel} (optional)`}</T>
                <NumberInput value={target} onChange={setTarget} width={96} placeholder={mode === 'loop' ? '–' : '+0'} muted />
              </View>
              <Button title="Generate" onPress={generate} loading={gen.isPending} disabled={!canGenerate} style={{ flex: 1 }} />
            </View>
            {mode === 'point_to_point' ? (
              <T variant="tiny" tone="mut">Extra: how much further than the direct route, taken as a detour on the way. Leave it empty for the direct route.</T>
            ) : null}
            {gen.error ? <ErrorBanner message={errorMessage(gen.error)} /> : null}
          </View>
        </Card>

        {candidates.length ? (
          <Card
            title="Routes found"
            subtitle={
              distM == null ? 'Direct route first'
              : mode === 'loop' ? `Closest to ${formatDistance(distM, units)} first`
              : `About ${formatDistance(distM, units)} more than the direct route first`
            }>
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
