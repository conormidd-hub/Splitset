import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Circle, Path } from 'react-native-svg';

import { useUnits } from '@/api/profile';
import {
  useDeleteSegment, useSaveSegment, useScanSegment, useSegment, useSegmentEfforts, type SegmentEffortWithActivity,
} from '@/api/segments';
import { LineChart } from '@/components/charts/LineChart';
import { TileMap } from '@/components/map/TileMap';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { relativeDay, shortTime } from '@/lib/dates';
import { bboxOf, decodeRoute, pathD, type Bbox } from '@/lib/geo';
import { medalFor, rankEfforts } from '@/lib/segments';
import { formatDistance, formatDuration, formatPace, secPerKm } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Ranked = SegmentEffortWithActivity & { rank: number };
type Progress = { done: number; total: number };

const MEDAL_LABEL = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** When the effort happened: the matched wall-clock start, else the run's local start. */
function effortDate(e: SegmentEffortWithActivity): string | null {
  return e.started_at ?? e.activities?.start_time_local ?? null;
}

function effortMs(e: SegmentEffortWithActivity): number {
  const iso = effortDate(e);
  return iso ? Date.parse(iso) : NaN;
}

/** A medal for the top three, a plain rank badge below that. */
function RankBadge({ rank }: { rank: number }) {
  const medal = medalFor(rank);
  if (medal) return <Badge label={MEDAL_LABEL[medal]} tone={medal === 'gold' ? 'accent' : 'mut'} />;
  return <Badge label={`#${rank}`} tone="mut" />;
}

/** One step of the podium: medal, time and date; opens the run. */
function PodiumTile({ effort, onPress }: { effort: Ranked; onPress: () => void }) {
  const { palette } = useTheme();
  const medal = medalFor(effort.rank);
  const gold = medal === 'gold';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1, minWidth: 90, gap: 2, padding: space.md, borderRadius: radius.md, borderWidth: 1,
        backgroundColor: gold ? palette.accentSoft : palette.surface2,
        borderColor: gold ? palette.accentLine : palette.hair,
        opacity: pressed ? 0.7 : 1,
      })}>
      <T variant="label" tone={gold ? 'accent' : 'mut'}>{medal ? MEDAL_LABEL[medal] : `#${effort.rank}`}</T>
      <T variant="h2" style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(effort.elapsed_s)}</T>
      <T variant="small" tone="mut" numberOfLines={1}>{relativeDay(effortDate(effort))}</T>
    </Pressable>
  );
}

export default function SegmentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const units = useUnits();
  const q = useSegment(id);
  const efforts = useSegmentEfforts(id);
  const scan = useScanSegment();
  const save = useSaveSegment();
  const del = useDeleteSegment();
  const [progress, setProgress] = useState<Progress | null>(null);
  /** The name being edited; null while not renaming. */
  const [draftName, setDraftName] = useState<string | null>(null);

  const seg = q.data;
  const pts = useMemo(() => (seg ? decodeRoute(seg.polyline) : []), [seg]);
  const bounds = useMemo<Bbox | null>(() => {
    if (seg?.bbox && seg.bbox.length === 4) return [seg.bbox[0], seg.bbox[1], seg.bbox[2], seg.bbox[3]];
    return bboxOf(pts);
  }, [seg, pts]);

  const ranked = useMemo<Ranked[]>(() => rankEfforts(efforts.data ?? []), [efforts.data]);
  const podium = useMemo(() => ranked.slice(0, 3), [ranked]);
  const newestFirst = useMemo(
    () => [...ranked].sort((a, b) => (effortMs(b) || 0) - (effortMs(a) || 0)),
    [ranked],
  );
  const historyPoints = useMemo(
    () =>
      ranked
        .map((e) => ({ x: effortMs(e), y: e.elapsed_s as number | null }))
        .filter((p) => Number.isFinite(p.x))
        .sort((a, b) => a.x - b.x),
    [ranked],
  );

  const onRescan = () =>
    scan.mutate(
      { segmentId: id, onProgress: (done, total) => setProgress({ done, total }) },
      { onSettled: () => setProgress(null) },
    );

  const onRename = () => {
    if (!seg || draftName == null) return;
    save.mutate(
      { id: seg.id, name: draftName, pts, distance_m: seg.distance_m },
      { onSuccess: () => setDraftName(null) },
    );
  };

  const onDelete = async () => {
    if (!seg) return;
    const ok = await confirm(
      'Delete segment',
      `Remove "${seg.name}" and its ${plural(ranked.length, 'effort')}? Your runs are not affected.`,
      'Delete',
      true,
    );
    if (ok) del.mutate(seg.id, { onSuccess: () => router.back() });
  };

  if (q.isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Segment' }} />
        <Screen><Loading label="Loading segment" /></Screen>
      </>
    );
  }
  if (q.error || !seg) {
    return (
      <>
        <Stack.Screen options={{ title: 'Segment' }} />
        <Screen>
          <ErrorBanner message={del.isSuccess ? null : errorMessage(q.error) || 'Segment not found'} />
        </Screen>
      </>
    );
  }

  const best = ranked[0];
  const bestPace = best ? secPerKm(seg.distance_m, best.elapsed_s) : null;
  const neverScanned = Date.parse(seg.scanned_through) <= 0;
  const scanLine = progress
    ? progress.total
      ? `Scanning ${progress.done} of ${plural(progress.total, 'run')}`
      : 'Looking for new runs'
    : scan.isSuccess
      ? scan.data.scanned
        ? `Scanned ${plural(scan.data.scanned, 'run')} · ${plural(scan.data.efforts, 'effort')}`
        : 'No new runs to scan'
      : neverScanned
        ? 'Not scanned yet. Rescan to look for efforts in your runs.'
        : `Covers runs synced up to ${relativeDay(seg.scanned_through)}.`;
  const busy = scan.isPending || save.isPending || del.isPending;

  return (
    <>
      <Stack.Screen options={{ title: seg.name }} />
      <Screen>
        <View style={{ gap: space.xs }}>
          {draftName == null ? (
            <T variant="h1">{seg.name}</T>
          ) : (
            <View style={{ gap: space.sm }}>
              <TextField
                label="Name"
                value={draftName}
                onChangeText={setDraftName}
                placeholder="Segment name"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={onRename}
                error={save.error ? errorMessage(save.error) : null}
              />
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button title="Save name" small loading={save.isPending} disabled={!draftName.trim()} onPress={onRename} />
                <Button title="Cancel" variant="ghost" small disabled={save.isPending} onPress={() => setDraftName(null)} />
              </View>
            </View>
          )}
          <T tone="mut">
            {formatDistance(seg.distance_m, units, 2)} · {plural(ranked.length, 'effort')} · created {relativeDay(seg.created_at).toLowerCase()}
          </T>
        </View>

        {pts.length >= 2 && bounds ? (
          <Card title="Segment" subtitle="Start in green, finish in red">
            <TileMap bounds={bounds} height={220}>
              {(project) => {
                const d = pathD(pts.map(([lat, lng]) => project(lat, lng)), 1);
                const start = project(pts[0][0], pts[0][1]);
                const end = project(pts[pts.length - 1][0], pts[pts.length - 1][1]);
                return (
                  <>
                    <Path d={d} fill="none" stroke={palette.surface} strokeOpacity={0.9} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
                    <Path d={d} fill="none" stroke={palette.accent} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
                    <Circle cx={start.x} cy={start.y} r={6} fill={palette.pos} stroke={palette.surface} strokeWidth={2} />
                    <Circle cx={end.x} cy={end.y} r={6} fill={palette.neg} stroke={palette.surface} strokeWidth={2} />
                  </>
                );
              }}
            </TileMap>
          </Card>
        ) : null}

        <Card>
          <Grid>
            <StatTile label="Distance" value={formatDistance(seg.distance_m, units, 2)} />
            <StatTile label="Efforts" value={`${ranked.length}`} sub={newestFirst[0] ? `last ${relativeDay(effortDate(newestFirst[0])).toLowerCase()}` : undefined} />
            <StatTile label="Best" value={best ? formatDuration(best.elapsed_s) : '–'} sub={bestPace ? formatPace(bestPace, units) : undefined} />
          </Grid>
        </Card>

        <ErrorBanner message={efforts.error ? errorMessage(efforts.error) : null} />

        <Card title="Podium" subtitle="Your three fastest">
          {efforts.isLoading ? (
            <Loading />
          ) : podium.length ? (
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {podium.map((e) => (
                <PodiumTile key={e.id} effort={e} onPress={() => router.push(`/run/${e.activity_id}`)} />
              ))}
            </View>
          ) : (
            <T tone="mut">
              {neverScanned ? 'Rescan to find the runs that cover this segment.' : 'None of your scanned runs followed this segment end to end.'}
            </T>
          )}
        </Card>

        {historyPoints.length >= 2 ? (
          <Card title="History" subtitle="Elapsed time per effort">
            <LineChart
              height={170}
              series={[{ name: 'time', color: palette.accent, points: historyPoints, kind: 'points' }]}
              yFormat={(v) => formatDuration(v)}
              showLegend={false}
            />
          </Card>
        ) : null}

        {ranked.length ? (
          <Card title="Efforts" subtitle="Newest first">
            {newestFirst.map((e, i) => (
              <ListRow
                key={e.id}
                first={i === 0}
                title={e.activities?.name ?? 'Run'}
                subtitle={`${relativeDay(effortDate(e))} · ${shortTime(effortDate(e))}`}
                badge={<RankBadge rank={e.rank} />}
                value={formatDuration(e.elapsed_s)}
                valueSub={formatPace(secPerKm(seg.distance_m, e.elapsed_s), units)}
                onPress={() => router.push(`/run/${e.activity_id}`)}
              />
            ))}
          </Card>
        ) : null}

        <Card title="Manage" subtitle={scanLine}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Button title="Rescan" variant="secondary" small loading={scan.isPending} disabled={busy && !scan.isPending} onPress={onRescan} />
            <Button title="Rename" variant="secondary" small disabled={busy || draftName != null} onPress={() => setDraftName(seg.name)} />
            <Button title="Delete" variant="danger" small loading={del.isPending} disabled={busy && !del.isPending} onPress={onDelete} />
          </View>
          <ErrorBanner message={scan.error ? errorMessage(scan.error) : del.error ? errorMessage(del.error) : null} />
        </Card>

        {!ranked.length && !efforts.isLoading && !efforts.error ? (
          <EmptyState
            title="How efforts are found"
            body="Each run with a GPS trace is checked against the segment: it has to enter at the start, follow the whole path and leave at the end. New runs are checked when you open them or tap Scan new runs on the Segments screen."
          />
        ) : null}
      </Screen>
    </>
  );
}
