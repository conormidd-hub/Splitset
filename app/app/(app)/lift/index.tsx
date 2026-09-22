import { router } from 'expo-router';
import { View } from 'react-native';

import { useRoutines, useWorkouts } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay, shortTime } from '@/lib/dates';
import { useUserId } from '@/lib/session';
import { formatDurationShort, formatWeight } from '@/lib/units';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { space } from '@/theme/tokens';

export default function LiftHome() {
  const uid = useUserId();
  const units = useUnits();
  const active = useActiveWorkout((s) => s.workout);
  const start = useActiveWorkout((s) => s.start);
  const routines = useRoutines();
  const workouts = useWorkouts(20);

  const startEmpty = () => {
    if (!active) start(uid);
    router.push('/lift/workout');
  };

  return (
    <Screen
      title="Lift"
      subtitle="Strength"
      refreshing={routines.isFetching || workouts.isFetching}
      onRefresh={() => { routines.refetch(); workouts.refetch(); }}
      right={<Button title="Exercises" variant="ghost" small onPress={() => router.push('/lift/exercises')} />}>
      {active ? (
        <Card
          tone="accent"
          title="Workout in progress"
          subtitle={`${active.name} · started ${relativeDay(active.startedAt).toLowerCase()} ${shortTime(active.startedAt)} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}`}
          onPress={() => router.push('/lift/workout')}>
          <Button title="Resume" small onPress={() => router.push('/lift/workout')} />
        </Card>
      ) : (
        <Button title="Start empty workout" onPress={startEmpty} />
      )}

      <Card title="Routines" right={<Button title="New" variant="ghost" small onPress={() => router.push('/lift/routines/new')} />}>
        {routines.isLoading ? <Loading /> : null}
        {routines.data?.length === 0 ? (
          <T tone="mut">No routines yet. Build one here, or finish a workout and save it as a routine.</T>
        ) : null}
        {routines.data?.map((r, i) => (
          <View key={r.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: 'rgba(127,127,127,0.15)', paddingVertical: space.md, gap: space.sm }}>
            <View>
              <T variant="h3">{r.name}</T>
              <T variant="small" tone="mut" numberOfLines={2}>
                {r.routine_exercises.map((e) => `${e.routine_sets.length || 1}× ${e.exercise?.name ?? 'exercise'}`).join(' · ') || 'Empty routine'}
              </T>
            </View>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button
                title="Start"
                small
                disabled={!!active}
                onPress={() => { start(uid, r); router.push('/lift/workout'); }}
              />
              <Button title="Edit" small variant="secondary" onPress={() => router.push(`/lift/routines/${r.id}`)} />
            </View>
          </View>
        ))}
      </Card>

      <Card title="History">
        {workouts.isLoading ? <Loading /> : null}
        {workouts.data?.length === 0 ? <EmptyState title="No workouts yet" body="Finished sessions show up here with their volume and duration." /> : null}
        {workouts.data?.map((w, i) => (
          <ListRow
            key={w.id ?? i}
            first={i === 0}
            title={w.name ?? 'Workout'}
            subtitle={`${relativeDay(w.started_at)} · ${formatDurationShort(w.duration_s)} · ${w.sets_completed ?? 0} sets`}
            value={w.volume_kg ? formatWeight(w.volume_kg, units, 0) : undefined}
            valueSub={w.volume_kg ? 'volume' : undefined}
            onPress={() => router.push(`/lift/history/${w.id}`)}
          />
        ))}
      </Card>
    </Screen>
  );
}
