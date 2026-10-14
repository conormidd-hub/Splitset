import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useSaveSegment, useScanSegment, type RunEffort } from '@/api/segments';
import { ProfileChart, type ProfileSeries } from '@/components/charts/ProfileChart';
import { TileMap, type Projector } from '@/components/map/TileMap';
import { Trail } from '@/components/map/Trail';
import { MetricLegend } from '@/components/run/MetricLegend';
import { RouteMarkers, SegmentBands, type Selection } from '@/components/run/RouteOverlay';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { bboxOf, type MapView, type Pt } from '@/lib/geo';
import { METRICS, colourScale, formatMetric, hasMetric, metricValues, nearestIndex, type Metric, type Track } from '@/lib/runAnalysis';
import { MIN_SEGMENT_M, subTrack } from '@/lib/segments';
import { KM_PER_MILE, formatDistance, formatElevation, formatPace, type Units } from '@/lib/units';
import { useMapPrefs } from '@/stores/mapPrefs';
import { useTheme } from '@/theme/ThemeProvider';
import { space, type Palette } from '@/theme/tokens';

/**
 * The run detail's Route card: metric chips, the trail over a tile map, the colour legend, a
 * distance profile, the stats strip and the button row, all sharing one cursor. It also hosts
 * create-segment mode, where the cursor marks the start and the end of a stretch to save.
 *
 * The map's tap-to-point mapping needs TileMap's projector, which only exists inside its render
 * prop; RouteMarkers reports the projector it drew with and the press handler projects the
 * track with that same function, so the picked point is exactly the one under the finger.
 */

const MAP_HEIGHT = 240;
const CHART_HEIGHT = 130;
/** Row buttons size to their label and share the slack; the narrower padding keeps three on one line. */
const ROW_BUTTON: ViewStyle = { flexGrow: 1, paddingHorizontal: space.sm };

const xKm = (m: number) => `${(m / 1000).toFixed(1)} km`;
const xMi = (m: number) => `${(m / 1000 / KM_PER_MILE).toFixed(1)} mi`;

/** Theme colour for a metric's chart line; the trail uses the fixed ramps in runAnalysis instead. */
function lineColour(m: Metric, palette: Palette): string {
  switch (m) {
    case 'pace': return palette.accent;
    case 'hr': return palette.neg;
    case 'cad': return palette.amber;
    case 'alt': return palette.blue;
  }
}

function metricSeries(track: Track, m: Metric, units: Units, colour: string, axis: 'left' | 'right' | 'own'): ProfileSeries {
  const label = METRICS.find((x) => x.key === m)?.label ?? m;
  return {
    // pace ticks are short "4:41" strings on a 44 px axis, so the unit moves into the name
    name: m === 'pace' ? `Pace /${units === 'imperial' ? 'mi' : 'km'}` : label,
    color: colour,
    values: metricValues(track, m),
    kind: 'line',
    axis,
    // faster pace reads higher, as on a watch
    invert: m === 'pace',
    format: (v) => (m === 'pace' ? formatPace(v, units, false) : formatMetric(m, v, units)),
  };
}

/**
 * Elevation as an area (when known) plus the chosen metrics as lines. One metric gets a labelled
 * axis of its own; several overlay the plot each on its own scale, since pace, heart rate and
 * cadence share no unit, and the cursor header reads their exact values.
 */
function chartSeries(track: Track, metrics: Metric[], units: Units, palette: Palette): ProfileSeries[] {
  const out: ProfileSeries[] = [];
  if (track.hasAlt) {
    out.push({ name: 'Elevation', color: palette.mut, values: track.alt, kind: 'area', format: (v) => formatElevation(v, units) });
  }
  const lines = metrics.filter((m) => m !== 'alt' && hasMetric(track, m));
  for (const m of lines) {
    const axis = lines.length === 1 ? (track.hasAlt ? 'right' : 'left') : 'own';
    out.push(metricSeries(track, m, units, lineColour(m, palette), axis));
  }
  return out;
}

type Props = {
  activityId: string;
  track: Track;
  units: Units;
  /** activities.hr_zones (zone upper bounds) for the discrete heart-rate colouring; null for percentiles. */
  hrZones: number[] | null;
  /** This run's matched segment efforts, drawn as labelled bands on the map. */
  efforts: RunEffort[];
  /** The inspected point, shared with the sticky stats bar above the card. */
  cursor: number | null;
  onCursor: (index: number | null) => void;
  /** Create-segment mode, started from the Segments card; the card ends it on Cancel or Save. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  /** True while a finger is down on a chart; the screen freezes its scroll meanwhile. */
  onScrubbingChange: (scrubbing: boolean) => void;
};

export function RouteCard({ activityId, track, units, hrZones, efforts, cursor, onCursor, creating, onCreatingChange, onScrubbingChange }: Props) {
  const { palette } = useTheme();
  const { metrics: preferred, toggleMetric } = useMapPrefs();
  const save = useSaveSegment();
  const scan = useScanSegment();

  const [view, setView] = useState<MapView | null>(null);
  const [projector, setProjector] = useState<Projector | null>(null);
  const [startIdx, setStartIdx] = useState<number | null>(null);
  const [endIdx, setEndIdx] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Stable per track: TileMap's camera memo keys on it, and the camera decides the projector.
  const bounds = useMemo(() => bboxOf(track.pts), [track]);
  const mapBounds = track.pts.length >= 2 ? bounds : null;
  const available = useMemo(() => METRICS.map((m) => m.key).filter((k) => hasMetric(track, k)), [track]);
  // the toggled metrics this run can show, in the order they were chosen; one colours the trail
  // itself, several run as thin lines beside it
  const layers = useMemo(
    () => preferred.filter((m) => available.includes(m)).map((m) => ({ metric: m, scale: colourScale(metricValues(track, m), m, { hrZones, units }) })),
    [preferred, available, track, hrZones, units],
  );
  const selected = useMemo(() => layers.map((l) => l.metric), [layers]);
  const mainSeries = useMemo(() => chartSeries(track, selected, units, palette), [track, selected, units, palette]);
  const xFormat = units === 'imperial' ? xMi : xKm;

  const selection = useMemo<Selection | null>(
    () => (creating && startIdx != null ? { start: startIdx, end: endIdx } : null),
    [creating, startIdx, endIdx],
  );
  const stretch = useMemo(
    () => (startIdx != null && endIdx != null ? subTrack(track, startIdx, endIdx) : null),
    [track, startIdx, endIdx],
  );
  const tooShort = stretch != null && stretch.distance_m < MIN_SEGMENT_M;
  const busy = save.isPending || scan.isPending;
  const canSave = stretch != null && !tooShort && name.trim().length > 0 && !busy;

  // A function kept in state must go through an updater, or React would call it as one.
  const onProject = useCallback((p: Projector) => setProjector(() => p), []);
  const onMapPress = (pt: Pt) => {
    if (!projector) return;
    onCursor(nearestIndex(track.pts.map(([lat, lng]) => projector(lat, lng)), pt.x, pt.y));
  };
  const scrubStart = () => onScrubbingChange(true);
  const scrubEnd = () => onScrubbingChange(false);

  // Segments run in track order: marking the end before the start (or the other way round) swaps them.
  const markStart = () => {
    if (cursor == null) return;
    if (endIdx != null && cursor > endIdx) { setStartIdx(endIdx); setEndIdx(cursor); } else setStartIdx(cursor);
  };
  const markEnd = () => {
    if (cursor == null) return;
    if (startIdx != null && cursor < startIdx) { setEndIdx(startIdx); setStartIdx(cursor); } else setEndIdx(cursor);
  };

  const exitCreate = () => {
    onCreatingChange(false);
    setStartIdx(null);
    setEndIdx(null);
    setName('');
    setSavedId(null);
    setProgress(null);
    save.reset();
    scan.reset();
  };

  const openSegment = (segmentId: string) => {
    exitCreate();
    router.push(`/run/segments/${segmentId}`);
  };

  const onSave = async () => {
    if (!stretch) return;
    try {
      const segmentId = await save.mutateAsync({
        name,
        pts: stretch.pts,
        distance_m: stretch.distance_m,
        source_activity_id: activityId,
      });
      setSavedId(segmentId);
      setProgress({ done: 0, total: 0 });
      await scan.mutateAsync({ segmentId, onProgress: (done, total) => setProgress({ done, total }) });
      openSegment(segmentId);
    } catch {
      // shown through save.error / scan.error below; a saved segment stays openable
    } finally {
      setProgress(null);
    }
  };

  const distAt = (i: number | null) => (i != null && i < track.dist.length ? formatDistance(track.dist[i], units, 2) : '–');

  const subtitle = creating
    ? 'Cut a segment from this run'
    : mapBounds
      ? 'Tap the map or the chart to inspect a point; double-tap the map to zoom'
      : 'Drag the chart to inspect a point';

  return (
    <Card title="Route" subtitle={subtitle}>
      <View style={{ gap: space.sm }}>
        {!creating && available.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {available.map((k) => (
              <Chip key={k} label={METRICS.find((m) => m.key === k)?.label ?? k} selected={layers.some((l) => l.metric === k)} onPress={() => toggleMetric(k)} />
            ))}
          </ScrollView>
        ) : null}

        {mapBounds ? (
          <View onTouchStart={scrubStart} onTouchEnd={scrubEnd} onTouchCancel={scrubEnd}>
          <TileMap bounds={mapBounds} height={MAP_HEIGHT} padding={34} onPress={onMapPress} view={view} onViewChange={setView} interactive>
            {(project) => (
              <>
                <SegmentBands track={track} project={project} efforts={efforts} />
                {creating || layers.length === 0 ? (
                  <Trail track={track} project={project} metric={null} scale={null} accent={palette.accent} />
                ) : layers.length === 1 ? (
                  <Trail track={track} project={project} metric={layers[0].metric} scale={layers[0].scale} accent={palette.accent} />
                ) : (
                  <>
                    <Trail track={track} project={project} metric={null} scale={null} accent={palette.mut} width={2} />
                    {layers.map((l, i) => (
                      <Trail
                        key={l.metric}
                        track={track}
                        project={project}
                        metric={l.metric}
                        scale={l.scale}
                        accent={palette.accent}
                        width={2.5}
                        offsetPx={Math.ceil((i + 1) / 2) * 5.5 * (i % 2 === 0 ? 1 : -1)}
                      />
                    ))}
                  </>
                )}
                <RouteMarkers track={track} project={project} efforts={efforts} cursor={cursor} selection={selection} onProject={onProject} units={units} />
              </>
            )}
          </TileMap>
          </View>
        ) : null}

        {mapBounds && !creating
          ? layers.map((l) => (l.scale ? <MetricLegend key={l.metric} scale={l.scale} metric={l.metric} /> : null))
          : null}

        {mainSeries.length ? (
          <ProfileChart
            x={track.dist}
            series={mainSeries}
            cursorIndex={cursor}
            onCursor={onCursor}
            height={CHART_HEIGHT}
            xFormat={xFormat}
            onScrubStart={scrubStart}
            onScrubEnd={scrubEnd}
          />
        ) : null}

        {creating ? (
          <View style={{ gap: space.sm }}>
            <T variant="small" tone="mut">Move the cursor on the map or the chart, then mark where the segment starts and ends.</T>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button title="Set start here" variant="secondary" small style={ROW_BUTTON} disabled={cursor == null || busy} onPress={markStart} />
              <Button title="Set end here" variant="secondary" small style={ROW_BUTTON} disabled={cursor == null || busy} onPress={markEnd} />
            </View>
            <T variant="small" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>
              Start {distAt(startIdx)} · End {distAt(endIdx)} · Length {stretch ? formatDistance(stretch.distance_m, units, 2) : '–'}
            </T>
            <TextField
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Riverside climb"
              autoCapitalize="sentences"
              returnKeyType="done"
              editable={!busy}
              error={tooShort ? `Too short: a segment needs at least ${MIN_SEGMENT_M} m` : null}
              hint={stretch ? undefined : 'Set the start and the end first'}
            />
            {progress ? (
              <T variant="small" tone="mut">
                {progress.total > 0 ? `Scanning ${progress.done} of ${progress.total} runs` : 'Finding runs on this segment…'}
              </T>
            ) : null}
            <ErrorBanner message={errorMessage(save.error) || errorMessage(scan.error)} />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button title="Cancel" variant="ghost" small style={ROW_BUTTON} disabled={busy} onPress={exitCreate} />
              {savedId ? (
                <Button title="Open segment" small style={ROW_BUTTON} loading={busy} onPress={() => openSegment(savedId)} />
              ) : (
                <Button title="Save" small style={ROW_BUTTON} disabled={!canSave} loading={busy} onPress={onSave} />
              )}
            </View>
          </View>
        ) : null}
      </View>
    </Card>
  );
}
