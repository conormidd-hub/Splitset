import { Stack, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { epley, useDeleteWorkout, useWorkout } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { longDate, shortTime } from '@/lib/dates';
import { formatDurationShort, formatWeight, kgToDisplay } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export default function WorkoutHistory() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const units = useUnits();
  const { palette } = useTheme();
  const q = useWorkout(id);
  const del = useDeleteWorkout();
  const w = q.data;

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !w) return <Screen><ErrorBanner message={errorMessage(q.error) || 'Workout not found'} /></Screen>;

  const sets = w.workout_exercises.flatMap((e) => e.workout_sets);
  const done = sets.filter((s) => s.completed);
  const volume = done.filter((s) => s.set_type !== 'warmup').reduce((t, s) => t + (s.weight_kg ?? 0) * (s.reps ?? 0), 0);
  const duration = w.finished_at ? (new Date(w.finished_at).getTime() - new Date(w.started_at).getTime()) / 1000 : null;
  const unit = units === 'imperial' ? 'lb' : 'kg';

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
        <Card>
          <Grid>
            <StatTile label="Duration" value={formatDurationShort(duration)} />
            <StatTile label="Sets" value={`${done.length}`} sub={`${w.workout_exercises.length} exercises`} />
            <StatTile label="Volume" value={formatWeight(volume, units, 0)} />
          </Grid>
        </Card>

        {w.workout_exercises.map((e) => (
          <Card key={e.id} title={e.exercise?.name ?? 'Exercise'} subtitle={e.notes ?? undefined}>
            {e.workout_sets.map((s, i) => {
              const e1 = epley(s.weight_kg, s.reps);
              return (
                <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair, opacity: s.completed ? 1 : 0.5 }}>
                  <T variant="small" tone="mut" style={{ width: 32 }}>{s.set_type === 'warmup' ? 'W' : s.set_type === 'drop' ? 'D' : s.set_type === 'failure' ? 'F' : i + 1}</T>
                  <T variant="mono" style={{ flex: 1 }}>
                    {[
                      s.weight_kg != null ? `${kgToDisplay(s.weight_kg, units)} ${unit}` : null,
                      s.reps != null ? `${s.reps} reps` : null,
                      s.seconds != null ? `${s.seconds} s` : null,
                    ].filter(Boolean).join(' × ') || '–'}
                  </T>
                  {s.rpe != null ? <T variant="small" tone="mut" style={{ width: 56, textAlign: 'right' }}>RPE {s.rpe}</T> : null}
                  {e1 ? <T variant="small" tone="mut" style={{ width: 80, textAlign: 'right' }}>e1RM {kgToDisplay(Math.round(e1 * 10) / 10, units)}</T> : null}
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
