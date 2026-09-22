import { Stack, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useExerciseHistory, useExercises, useRecords } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { EmptyState, Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay } from '@/lib/dates';
import { formatWeight, kgToDisplay } from '@/lib/units';

export default function ExerciseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const units = useUnits();
  const exercises = useExercises();
  const records = useRecords();
  const history = useExerciseHistory(id, 30);
  const exercise = exercises.data?.find((e) => e.id === id);
  const record = records.data?.find((r) => r.exercise_id === id);
  const unit = units === 'imperial' ? 'lb' : 'kg';

  return (
    <>
      <Stack.Screen options={{ title: exercise?.name ?? 'Exercise' }} />
      <Screen>
        {exercise ? (
          <View>
            <T variant="h1">{exercise.name}</T>
            <T tone="mut">{[exercise.muscle_group, exercise.equipment, exercise.is_unilateral ? 'one side at a time' : null].filter(Boolean).join(' · ')}</T>
          </View>
        ) : null}

        <Card title="Records" subtitle={record?.last_completed_at ? `last done ${relativeDay(record.last_completed_at).toLowerCase()}` : 'no completed sets yet'}>
          <Grid>
            <StatTile label="Best weight" value={record?.best_weight_kg != null ? formatWeight(record.best_weight_kg, units, 1) : '–'} />
            <StatTile label="Est. 1RM" value={record?.best_e1rm_kg != null ? formatWeight(record.best_e1rm_kg, units, 0) : '–'} sub="Epley, ≤12 reps" />
            <StatTile label="Best set" value={record?.best_set_volume_kg != null ? formatWeight(record.best_set_volume_kg, units, 0) : '–'} sub="weight × reps" />
            <StatTile label="Most reps" value={record?.best_reps != null ? `${record.best_reps}` : '–'} />
            <StatTile label="Sets logged" value={`${record?.completed_sets ?? 0}`} />
          </Grid>
        </Card>

        <Card title="History" subtitle="Newest first">
          {history.isLoading ? <Loading /> : null}
          {history.data?.length === 0 ? <EmptyState title="Not logged yet" body="Sets you tick in a workout appear here." /> : null}
          {history.data?.map((h, i) => (
            <ListRow
              key={h.workoutId}
              first={i === 0}
              title={relativeDay(h.startedAt)}
              subtitle={h.sets.map((s) => [
                s.weight_kg != null ? `${kgToDisplay(s.weight_kg, units)}` : null,
                s.reps != null ? `${s.reps}` : s.seconds != null ? `${s.seconds}s` : null,
              ].filter(Boolean).join('×')).join(', ')}
              value={h.bestWeight != null ? `${kgToDisplay(h.bestWeight, units)} ${unit}` : `${h.sets.length} sets`}
              valueSub={h.volume ? `${formatWeight(h.volume, units, 0)} vol` : undefined}
              onPress={() => router.push(`/lift/history/${h.workoutId}`)}
            />
          ))}
        </Card>
      </Screen>
    </>
  );
}
