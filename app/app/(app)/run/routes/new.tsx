import { useMutation } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Circle, Path } from 'react-native-svg';

import { useActivities, useRunRoutes } from '@/api/activities';
import { useCafes, useDebounced } from '@/api/places';
import { useUnits } from '@/api/profile';
import { useSaveRoute } from '@/api/routes';
import { ROUTING_PROVIDER, valhalla } from '@/api/routing';
import { CafeLayer } from '@/components/map/CafeLayer';
import { StartPicker } from '@/components/map/StartPicker';
import { TileMap, type Projector, type Size } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Chip, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { MAX_ZOOM, bboxOf, decodeRoute, pathD, sameView, unprojectPt, viewBbox, type Bbox, type LatLng, type MapView, type Pt } from '@/lib/geo';
import { CAFE_ZOOM, cafeBox, nearestCafe } from '@/lib/places';
import { generateLoops, generatePointToPoint, type Candidate } from '@/lib/routeBuilder';
import { typicalPaceSecPerKm } from '@/lib/runAnalysis';
import { KM_PER_MILE, formatDistance, formatDuration, formatElevation } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Mode = Candidate['kind'];

const MODES: { value: Mode; label: string }[] = [
  { value: 'loop', label: 'Loop' },
  { value: 'point_to_point', label: 'Point to point' },
];

/** Below this zoom a fingertip covers hundreds of metres, so a tap zooms in on the spot instead of placing a point. */
const PLACE_ZOOM = 12;
/** Zoom to jump to when a point is chosen for the user (an address, home, the last run's start). */
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

/** A text link in the navigation header. */
function HeaderLink({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="link" style={({ pressed }) => ({ paddingHorizontal: space.sm, opacity: pressed ? 0.6 : 1 })}>
      <T variant="small" tone="accent" weight="700">{title}</T>
    </Pressable>
  );
}

/**
 * Build a route along real roads and paths: choose loop or point to point, put the start (and
 * end) on the map, give a distance, generate, pick a candidate and save it. The map stays pinned
 * at the top while the controls and the candidates scroll underneath, and frames each route as
 * it is chosen.
 */
export default function NewRoute() {
  const { palette } = useTheme();
  const units = useUnits();
  const { height: windowH } = useWindowDimensions();
  const runs = useRunRoutes();
  const recent = useActivities('runs');
  const save = useSaveRoute();

  const [mode, setMode] = useState<Mode>('loop');
  const [start, setStart] = useState<LatLng | null>(null);
  const [end, setEnd] = useState<LatLng | null>(null);
  /** Target distance in the display unit (km or mi). */
  const [target, setTarget] = useState<number | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  /** The camera the map is drawing with and its size, reported by the map itself. */
  const [mapCam, setMapCam] = useState<{ cam: MapView; size: Size } | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [name, setName] = useState('');
  /** Where the start (and the end) came from when picked by name: an address, home, a café. */
  const [startLabel, setStartLabel] = useState<string | null>(null);
  const [endLabel, setEndLabel] = useState<string | null>(null);
  const [showCafes, setShowCafes] = useState(true);

  /** Pinned at the top: about two fifths of the window, so the controls still show under it. */
  const mapHeight = Math.round(Math.min(360, Math.max(220, windowH * 0.38)));
  const cam = mapCam?.cam ?? null;
  const size = mapCam?.size ?? null;
  const onCamera = useCallback((c: MapView, s: Size) => {
    setMapCam((prev) => (prev && sameView(prev.cam, c) && prev.size.width === s.width && prev.size.height === s.height ? prev : { cam: c, size: s }));
  }, []);

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

  // useRunRoutes is oldest first, so the last entry is the most recent run with a trace.
  const lastRun = runs.data?.length ? runs.data[runs.data.length - 1] : null;
  const lastPts = useMemo(() => (lastRun ? decodeRoute(lastRun.polyline) : []), [lastRun]);
  /** What the map frames when no camera is set: the chosen route whole, else the last run's area. */
  const bounds = useMemo<Bbox>(
    () => (chosen ? bboxOf(chosen.pts) : null) ?? lastRun?.bbox ?? bboxOf(lastPts) ?? WORLD,
    [chosen, lastRun, lastPts],
  );

  // the cafés in view once zoomed in enough, asked for when the map has settled
  const cafeKey = showCafes && cam && size && cam.zoom >= CAFE_ZOOM ? cafeBox(viewBbox(cam, size)).join(',') : null;
  const settledCafeKey = useDebounced(cafeKey, 600);
  const cafesQ = useCafes(settledCafeKey ? (settledCafeKey.split(',').map(Number) as Bbox) : null);
  const cafes = showCafes && cafesQ.data ? cafesQ.data : [];

  const pace = useMemo(() => typicalPaceSecPerKm(recent.data?.pages[0]), [recent.data]);
  const unitLabel = units === 'imperial' ? 'mi' : 'km';
  const distM = target != null && target > 0 ? target * (units === 'imperial' ? KM_PER_MILE : 1) * 1000 : null;

  // Routes begin at the point the router snapped onto a path, so once there are candidates the
  // markers follow the chosen one rather than the tapped spot.
  const startPt = chosen ? toLatLng(chosen.pts[0]) : start;
  const endPt = mode === 'point_to_point' ? (chosen ? toLatLng(chosen.pts[chosen.pts.length - 1]) : end) : null;

  /** Forget the candidates but keep the map where it is: with no route to frame, a null camera would jump back to the last run. */
  const resetCandidates = () => {
    if (cam) setView(cam);
    gen.reset();
    setSelectedIdx(0);
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
    if (!cam || !size) return;
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
    resetCandidates();
    setView({ center: p, zoom: Math.max(cam?.zoom ?? 0, PLACE_VIEW_ZOOM) });
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
    // a null camera frames the chosen route whole once it arrives
    gen.mutate({ mode, start, end, distM }, { onSuccess: () => { setSelectedIdx(0); setView(null); } });
  };
  const choose = (i: number) => {
    setSelectedIdx(i);
    setView(null);
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
        ? 'Tap the map to place the start, or search for it below.'
        : mode === 'point_to_point' && !end
          ? 'Tap the map to place the end, or search for it below.'
          : chosen
            ? 'Pick a route from the list. Tap the map to move the start.'
            : mode === 'loop'
              ? 'Tap elsewhere to move the start. Drag to pan.'
              : 'Tap elsewhere to move the end, or clear the points to start over.';

  return (
    <>
      <Stack.Screen options={{ title: 'New route', headerRight: () => <HeaderLink title="Draw a course" onPress={() => router.push('/run/routes/draw')} /> }} />
      <Screen scroll={false} padded={false} style={{ flex: 1 }}>
        {/* pinned: the map and the line under it; everything else scrolls beneath */}
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
          {runs.isLoading ? (
            <View style={{ height: mapHeight, borderRadius: radius.md, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center' }}>
              <Loading label="Finding your last run" />
            </View>
          ) : (
            <View>
              <TileMap bounds={bounds} view={view} onViewChange={setView} onCamera={onCamera} height={mapHeight} interactive onPress={onMapPress}>
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
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T variant="small" tone="mut">{hint}</T>
              {where ? <T variant="small">{where}</T> : null}
            </View>
            {start ? <Button title="Clear" variant="ghost" small onPress={clearPoints} /> : null}
            <Chip label="Cafés" selected={showCafes} onPress={() => setShowCafes((v) => !v)} />
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: space.xxl }}
          keyboardShouldPersistTaps="handled">
          {runs.error ? <ErrorBanner message={errorMessage(runs.error)} /> : null}

          <Card>
            <View style={{ gap: space.md }}>
              <Segmented<Mode> options={MODES} value={mode} onChange={onModeChange} label="Route type" />
              <StartPicker
                near={cam?.center ?? null}
                prompt={mode === 'point_to_point' && start ? 'Search the end: an address or a place' : 'Search the start: an address or a place'}
                onPick={onPick}
                current={start ? { p: start, label: startLabel } : null}
                extra={lastPts.length ? <Button title="Last run start" variant="secondary" small onPress={useLastRunStart} /> : null}
              />
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
                  onPress={() => choose(i)}
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
        </ScrollView>
      </Screen>
    </>
  );
}
