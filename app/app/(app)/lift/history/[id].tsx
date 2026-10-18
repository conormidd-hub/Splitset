import { Stack, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useDeleteWorkout, useWorkout } from '@/api/lifting';
import { useProfile, useUnits } from '@/api/profile';
import { useMuscleNames, useSessionMap } from '@/api/recovery';
import { FigurePair } from '@/components/recovery/FigurePair';
import { SessionMuscleRows } from '@/components/recovery/RecoveryExtras';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { longDate, shortTime } from '@/lib/dates';
import { setCount, volumeKg } from '@/lib/lifting/sideCounts';
import { formatLoad, loggedWeight } from '@/lib/pbs';
import { formatDurationShort, formatWeight } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export default function WorkoutHistory() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const units = useUnits();
  const { palette } = useTheme();
  const q = useWorkout(id);
  const del = useDeleteWorkout();
  const session = useSessionMap(q.data?.finished_at ? id : undefined);
  const names = useMuscleNames();
  const profile = useProfile();
  const w = q.data;

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !w) return <Screen><ErrorBanner message={errorMessage(q.error) || 'Workout not found'} /></Screen>;

  const sets = w.workout_exercises.flatMap((e) => e.workout_sets);
  const done = sets.filter((s) => s.completed);
  const volume = volumeKg(done.filter((s) => s.set_type !== 'warmup'));
  const duration = w.finished_at ? (new Date(w.finished_at).getTime() - new Date(w.started_at).getTime()) / 1000 : null;

  const onDelete = async () => {
    const ok = await confirm('Delete workout', 'This removes the session and its sets from your history.', 'Delete', true);
    if (ok) del.mutate(w.id, { onSuccess: () => router.back() });
  };

  return (
    <>
      <Stack.Screen options={{ title: w.name }} />
      <Screen>
        <View>
          <T variant="h1">{w.name}</T>
          <T tone="mut">{longDate(w.started_at)} · {shortTime(w.started_at)}{w.finished_at ? ` to ${shortTime(w.finished_at)}` : ' · unfinished'}</T>
        </View>
        {w.finished_at && session.data ? (
          <Card title="Muscles worked" subtitle="This workout's load on each muscle, and when each is trainable and ready again after it">
            <View style={{ gap: space.md }}>
              <FigurePair map={session.data} mode="session" figureWidth={110} nameOf={names} detail labels timeZone={profile.data?.timezone} />
              <SessionMuscleRows session={session.data} nameOf={names} />
            </View>
          </Card>
        ) : null}

        <Card>
          <Grid>
            <StatTile label="Duration" value={formatDurationShort(duration)} />
            <StatTile label="Sets" value={`${setCount(done)}`} sub={`${w.workout_exercises.length} exercises`} />
            <StatTile label="Volume" value={formatWeight(volume, units, 0)} />
          </Grid>
        </Card>

        {w.workout_exercises.map((e) => (
          <Card key={e.id} title={e.exercise?.name ?? 'Exercise'} subtitle={e.notes ?? undefined}>
            {e.workout_sets.map((s, i) => {
              return (
                <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair, opacity: s.completed ? 1 : 0.5 }}>
                  <T variant="small" tone="mut" style={{ width: 32 }}>{s.set_type === 'warmup' ? 'W' : s.set_type === 'drop' ? 'D' : s.set_type === 'failure' ? 'F' : i + 1}</T>
                  <T variant="mono" style={{ flex: 1 }}>
                    {[
                      // the added load or the assistance for a bodyweight or assisted lift (notes §4.6)
                      s.weight_kg != null ? loggedWeight(s.weight_kg, units, e.exercise?.load_mode) : null,
                      s.reps != null ? `${s.reps} reps` : null,
                      s.seconds != null ? `${s.seconds} s` : null,
                    ].filter(Boolean).join(' × ') || '–'}
                    {s.side ? <T variant="small" tone="mut">{`  ${s.side === 'left' ? 'L' : 'R'}`}</T> : null}
                  </T>
                  {s.rpe != null ? <T variant="small" tone="mut" style={{ width: 56, textAlign: 'right' }}>RPE {s.rpe}</T> : null}
                  {s.e1rm != null ? <T variant="small" tone="mut" style={{ width: 96, textAlign: 'right' }}>e1RM {formatLoad(s.e1rm, units)}</T> : null}
                  {!s.completed ? <T variant="tiny" tone="mut" style={{ marginLeft: space.sm }}>skipped</T> : null}
                </View>
              );
            })}
          </Card>
        ))}

        {w.notes ? <Card title="Notes"><T>{w.notes}</T></Card> : null}

        <Button title="Delete workout" variant="danger" small loading={del.isPending} onPress={onDelete} />
      </Screen>
    </>
  );
}
