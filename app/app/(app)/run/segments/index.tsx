import { Stack, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useUnits } from '@/api/profile';
import { useAllEfforts, useScanAll, useSegments, type Segment, type SegmentEffort } from '@/api/segments';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay } from '@/lib/dates';
import { medalFor, rankEfforts } from '@/lib/segments';
import { formatDistance, formatDuration, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Ranked = SegmentEffort & { rank: number };
type Progress = { done: number; total: number };

const MEDAL_LABEL = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One segment in the list: name and distance, then how often it was run and the best time, then
 * the three medal times. Efforts arrive ranked fastest first, so the podium is the first three.
 */
function SegmentRow({
  segment, efforts, units, first, onPress,
}: { segment: Segment; efforts: Ranked[]; units: Units; first: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  const best = efforts[0];
  const podium = efforts.slice(0, 3);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <View style={{ paddingVertical: space.md, borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair, gap: space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <T variant="h3" numberOfLines={1} style={{ flex: 1 }}>{segment.name}</T>
          <T variant="h3" style={{ fontVariant: ['tabular-nums'] }}>{formatDistance(segment.distance_m, units, 2)}</T>
          <T tone="mut">›</T>
        </View>
        <T variant="small" tone="mut" numberOfLines={1}>
          {best
            ? `${plural(efforts.length, 'effort')} · best ${formatDuration(best.elapsed_s)} · ${relativeDay(best.started_at)}`
            : 'No efforts yet'}
        </T>
        {podium.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 2 }}>
            {podium.map((e) => {
              const medal = medalFor(e.rank);
              if (!medal) return null;
              return <Badge key={e.id} label={`${MEDAL_LABEL[medal]} ${formatDuration(e.elapsed_s)}`} tone={medal === 'gold' ? 'accent' : 'mut'} />;
            })}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function SegmentsList() {
  const units = useUnits();
  const segments = useSegments();
  const efforts = useAllEfforts();
  const scanAll = useScanAll();
  const [progress, setProgress] = useState<Progress | null>(null);

  // Every effort the user has, grouped per segment and ranked fastest first (ties: earlier date).
  const bySegment = useMemo(() => {
    const groups = new Map<string, SegmentEffort[]>();
    for (const e of efforts.data ?? []) {
      const list = groups.get(e.segment_id);
      if (list) list.push(e);
      else groups.set(e.segment_id, [e]);
    }
    const out = new Map<string, Ranked[]>();
    for (const [segmentId, list] of groups) out.set(segmentId, rankEfforts(list));
    return out;
  }, [efforts.data]);

  const list = segments.data ?? [];
  const totalEfforts = efforts.data?.length ?? 0;

  const onScan = () =>
    scanAll.mutate(
      { onProgress: (done, total) => setProgress({ done, total }) },
      { onSettled: () => setProgress(null) },
    );

  const scanLine = progress
    ? progress.total
      ? `Scanning ${progress.done} of ${plural(progress.total, 'run')}`
      : 'Looking for new runs'
    : scanAll.isSuccess
      ? scanAll.data.scanned
        ? `Scanned ${plural(scanAll.data.scanned, 'run')} · ${plural(scanAll.data.efforts, 'effort')}`
        : 'No new runs to scan'
      : null;

  return (
    <>
      <Stack.Screen options={{ title: 'Segments' }} />
      <Screen
        refreshing={segments.isRefetching || efforts.isRefetching}
        onRefresh={() => {
          segments.refetch();
          efforts.refetch();
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <T variant="label" tone="mut">Your segments</T>
            <T variant="small" tone="mut">
              {segments.data ? `${plural(list.length, 'segment')} · ${plural(totalEfforts, 'effort')}` : ' '}
            </T>
          </View>
          <Button
            title="Scan new runs"
            variant="secondary"
            small
            loading={scanAll.isPending}
            disabled={!list.length}
            onPress={onScan}
          />
        </View>

        {scanLine ? <T variant="small" tone={progress ? 'accent' : 'mut'}>{scanLine}</T> : null}
        <ErrorBanner message={scanAll.error ? errorMessage(scanAll.error) : null} />
        <ErrorBanner message={efforts.error ? errorMessage(efforts.error) : null} />

        {segments.isLoading ? (
          <Loading label="Loading segments" />
        ) : segments.error ? (
          <ErrorBanner message={errorMessage(segments.error)} />
        ) : !list.length ? (
          <EmptyState
            title="No segments yet"
            body="Open a run, tap Create segment under its map, then set the start and end on the trail. Every run that follows the same stretch is timed against it, and your three fastest earn gold, silver and bronze."
          />
        ) : (
          <Card>
            {list.map((s, i) => (
              <SegmentRow
                key={s.id}
                segment={s}
                efforts={bySegment.get(s.id) ?? []}
                units={units}
                first={i === 0}
                onPress={() => router.push(`/run/segments/${s.id}`)}
              />
            ))}
          </Card>
        )}
      </Screen>
    </>
  );
}
