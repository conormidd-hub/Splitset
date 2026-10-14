import { router } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';

import { useAllEfforts, useRunEfforts, useScanRun, type RunEffort, type SegmentEffort } from '@/api/segments';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { medalFor, rankEfforts } from '@/lib/segments';
import { formatDistance, formatDuration, formatPace, type Units } from '@/lib/units';
import { space } from '@/theme/tokens';

/**
 * The run detail's Segments card: every saved segment this run passed through, with the time,
 * where it ranks among the user's efforts on that segment and the medal it earned. Opening a run
 * checks it against segments that have not seen it yet (a partial scan that writes efforts but
 * leaves the watermarks alone); "Check segments" runs the same check by hand.
 */

/** Activities already auto-checked since the app started: one automatic check per activity per session. */
const autoChecked = new Set<string>();

type Standing = { rank: number; count: number };

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Each effort's rank among the user's efforts on the same segment (fastest first, ties by date). */
function standings(all: SegmentEffort[] | undefined): Map<string, Standing> {
  const bySegment = new Map<string, SegmentEffort[]>();
  for (const e of all ?? []) {
    const list = bySegment.get(e.segment_id);
    if (list) list.push(e);
    else bySegment.set(e.segment_id, [e]);
  }
  const out = new Map<string, Standing>();
  for (const list of bySegment.values()) {
    const ranked = rankEfforts(list);
    for (const r of ranked) out.set(r.id, { rank: r.rank, count: ranked.length });
  }
  return out;
}

function EffortRow({ effort, standing, units, first }: { effort: RunEffort; standing: Standing | undefined; units: Units; first: boolean }) {
  const seg = effort.segments;
  const medal = standing ? medalFor(standing.rank) : null;
  const pace = seg.distance_m > 0 ? effort.elapsed_s / (seg.distance_m / 1000) : null;
  return (
    <ListRow
      first={first}
      title={seg.name}
      subtitle={`${formatDistance(seg.distance_m, units, 2)}${standing ? ` · ${ordinal(standing.rank)} of ${standing.count}` : ''}`}
      badge={
        standing ? (
          <>
            {standing.rank === 1 ? <Badge label="PR" tone="accent" /> : null}
            <Badge label={medal ? capitalise(medal) : ordinal(standing.rank)} tone={medal === 'gold' ? 'accent' : 'mut'} />
          </>
        ) : undefined
      }
      value={formatDuration(effort.elapsed_s)}
      valueSub={formatPace(pace, units)}
      onPress={() => router.push(`/run/segments/${effort.segment_id}`)}
    />
  );
}

type Props = {
  activityId: string;
  units: Units;
  /** The Route card has the run's track cached (or gave up), so a check reuses it instead of fetching twice. */
  trackReady: boolean;
  /** Starts create-segment mode on the Route card; absent when the run has no trace to cut. */
  onCut?: () => void;
};

export function SegmentsCard({ activityId, units, trackReady, onCut }: Props) {
  const efforts = useRunEfforts(activityId);
  const all = useAllEfforts();
  const scan = useScanRun();
  const check = scan.mutate;

  useEffect(() => {
    if (!trackReady || autoChecked.has(activityId)) return;
    autoChecked.add(activityId);
    check({ activityId });
  }, [activityId, trackReady, check]);

  const byId = useMemo(() => standings(all.data), [all.data]);
  const rows = efforts.data ?? [];
  const error = errorMessage(efforts.error) || errorMessage(scan.error);

  return (
    <Card
      title="Segments"
      subtitle="Saved stretches this run passed through"
>
      {/* actions under the title rather than beside it, so a phone-width title keeps its line */}
      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
        {onCut ? <Button title="Cut a segment" variant="secondary" small style={{ flexGrow: 1 }} onPress={onCut} /> : null}
        <Button title="Check segments" variant="secondary" small style={{ flexGrow: 1 }} loading={scan.isPending} onPress={() => check({ activityId })} />
      </View>
      <ErrorBanner message={error} />
      {efforts.isLoading ? (
        <Loading />
      ) : rows.length ? (
        rows.map((e, i) => <EffortRow key={e.id} effort={e} standing={byId.get(e.id)} units={units} first={i === 0} />)
      ) : !error ? (
        <T variant="small" tone="mut">No segment efforts on this run. Use “Create segment” on the Route card to save a stretch and track your times on it.</T>
      ) : null}
    </Card>
  );
}
