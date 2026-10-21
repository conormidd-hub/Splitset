import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import type { Exercise } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { useDeleteManualPb, useStrengthReference, useThresholds } from '@/api/recovery';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { relativeDay } from '@/lib/dates';
import { formatLoad } from '@/lib/pbs';
import type { ReferenceTone } from '@/lib/recovery/pbHistory';
import { space } from '@/theme/tokens';

import { KnownBestFields } from './KnownBestFields';

const BADGE: Record<ReferenceTone, 'mut' | 'accent' | 'pos' | 'neg'> = {
  logged: 'pos', manual: 'accent', lapsed: 'mut', estimated: 'neg', calibrating: 'neg',
};
const HISTORY_SHOWN = 12;

/**
 * The PB section of an exercise screen (build phase 3): the reference the next session is
 * scored against and where it comes from, the best of the PB window and of all time, a form for
 * a known best, and the history behind them with logged / manual badges.
 */
export function StrengthReference({ exercise }: { exercise: Exercise }) {
  const units = useUnits();
  const c = useThresholds();
  const q = useStrengthReference(exercise.id);
  const [showAll, setShowAll] = useState(false);
  const del = useDeleteManualPb();
  const d = q.data;

  if (q.isLoading) return <Card title="Strength reference"><Loading /></Card>;
  if (!d) return null;

  const items = showAll ? d.items : d.items.slice(0, HISTORY_SHOWN);
  const onItem = async (item: (typeof d.items)[number]) => {
    if (item.source === 'logged' && item.workoutId) router.push(`/workout/${item.workoutId}`);
    else if (item.manualPbId && (await confirm('Delete known best', 'Remove this known best? Your logged sets are not affected.', 'Delete', true))) {
      del.mutate(item.manualPbId);
    }
  };

  return (
    <>
      <Card title="Strength reference" subtitle="What your next session is scored against">
        {d.fixed ? (
          <T tone="mut">Sets of this exercise each cost the same, so it needs no reference.</T>
        ) : d.reference ? (
          <View style={{ gap: space.sm }}>
            <Grid>
              <StatTile label="Reference" value={d.reference.pb != null ? formatLoad(d.reference.pb, units) : '–'} sub="estimated 1RM" />
              <StatTile label={`Best, ${c.pb.window_days} days`} value={formatLoad(d.window, units)} />
              <StatTile label="All-time best" value={formatLoad(d.allTime, units)} />
            </Grid>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Badge label={d.reference.tone} tone={BADGE[d.reference.tone]} />
              <T variant="small" tone="mut" style={{ flex: 1 }}>{d.reference.label}</T>
            </View>
          </View>
        ) : (
          <T tone="mut">Not scored yet: this exercise is not in the library.</T>
        )}
      </Card>

      {d.reference ? (
        <Card title="Add a known best" subtitle="A best from before Splitset, or a day you didn’t log">
          <KnownBestFields exercise={exercise} />
        </Card>
      ) : null}

      {d.items.length ? (
        <Card title="PB history" subtitle="Each workout's best set and your known bests, newest first">
          {items.map((item, i) => (
            <ListRow
              key={item.key}
              first={i === 0}
              title={relativeDay(item.at)}
              subtitle={item.weightKg != null && item.reps != null ? `${formatLoad(item.weightKg, units)} × ${item.reps}` : undefined}
              value={formatLoad(item.e1rm, units)}
              valueSub="e1RM"
              badge={<Badge label={item.source} tone={item.source === 'manual' ? 'accent' : 'mut'} />}
              onPress={() => onItem(item)}
            />
          ))}
          {d.items.length > HISTORY_SHOWN ? (
            <Button title={showAll ? 'Show fewer' : `Show all ${d.items.length}`} variant="ghost" small onPress={() => setShowAll((v) => !v)} />
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
