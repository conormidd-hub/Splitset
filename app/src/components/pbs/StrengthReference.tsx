import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import type { Exercise } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import {
  useAddManualPb, useCurrentBodyweight, useDeleteManualPb, useStrengthReference, useThresholds,
} from '@/api/recovery';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { NumberInput } from '@/components/ui/NumberInput';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { relativeDay, todayIso } from '@/lib/dates';
import { formatLoad } from '@/lib/pbs';
import type { ReferenceTone } from '@/lib/recovery/pbHistory';
import { displayToKg } from '@/lib/units';
import { space } from '@/theme/tokens';

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
    if (item.source === 'logged' && item.workoutId) router.push(`/lift/history/${item.workoutId}`);
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

      {d.reference ? <KnownBestForm exercise={exercise} /> : null}

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "Add a known best": weight × reps, dated today unless another date is typed. */
function KnownBestForm({ exercise }: { exercise: Exercise }) {
  const units = useUnits();
  const c = useThresholds();
  const bodyweight = useCurrentBodyweight();
  const add = useAddManualPb();
  const [weight, setWeight] = useState<number | null>(null);
  const [reps, setReps] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const today = todayIso();
  const datedAt = date.trim() || today;
  const dateBad = !DATE.test(datedAt) || Number.isNaN(Date.parse(datedAt)) || datedAt > today;
  const bodyweightMode = exercise.load_mode === 'bodyweight' || exercise.load_mode === 'assisted';
  const ready = weight != null && weight >= 0 && reps != null && reps >= 1 && !dateBad;

  const submit = () => {
    if (!ready) return;
    add.mutate(
      { exercise, weightKg: displayToKg(weight, units), reps, datedAt, bodyweightKg: bodyweight.kg },
      { onSuccess: () => { setWeight(null); setReps(null); setDate(''); } },
    );
  };

  return (
    <Card title="Add a known best" subtitle={`Counts like a logged set for ${c.pb.window_days} days; a heavier logged set replaces it`}>
      <View style={{ gap: space.sm }}>
        {bodyweightMode ? (
          <T variant="small" tone="mut">
            {exercise.load_mode === 'assisted' ? 'Weight is the assistance' : 'Weight is the added load'}; your bodyweight ({formatLoad(bodyweight.kg, units)}) is counted in.
          </T>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <NumberInput value={weight} onChange={setWeight} placeholder={units === 'imperial' ? 'lb' : 'kg'} width={84} />
          <T tone="mut">×</T>
          <NumberInput value={reps} onChange={setReps} integer placeholder="reps" width={72} />
          <View style={{ flex: 1 }}>
            <TextField value={date} onChangeText={setDate} placeholder={`today (${today})`} autoCapitalize="none" error={date && dateBad ? 'A past date as YYYY-MM-DD' : undefined} />
          </View>
        </View>
        {add.error ? <ErrorBanner message={errorMessage(add.error)} /> : null}
        <Button title="Add known best" small disabled={!ready} loading={add.isPending} onPress={submit} style={{ alignSelf: 'flex-start' }} />
      </View>
    </Card>
  );
}
