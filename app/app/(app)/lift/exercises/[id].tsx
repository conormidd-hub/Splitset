import { Stack, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useExerciseHistory, useExercises, useRecords } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { useExerciseRoles, useMuscleNames } from '@/api/recovery';
import { LineChart } from '@/components/charts/LineChart';
import { StrengthReference } from '@/components/pbs/StrengthReference';
import { Button } from '@/components/ui/Button';
import { ExerciseMuscles } from '@/components/recovery/ExerciseMuscles';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { EmptyState, Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay } from '@/lib/dates';
import { bodyweightRelative, loggedWeight } from '@/lib/pbs';
import { formatWeight, kgToDisplay } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';

export default function ExerciseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const units = useUnits();
  const { palette } = useTheme();
  const exercises = useExercises();
  const records = useRecords();
  const history = useExerciseHistory(id, 30);
  const roles = useExerciseRoles();
  const names = useMuscleNames();
  const exercise = exercises.data?.find((e) => e.id === id);
  const record = records.data?.find((r) => r.exercise_id === id);
  const unit = units === 'imperial' ? 'lb' : 'kg';
  // what the logged weight means: the load added to bodyweight, or the assistance, whose heaviest
  // is the weakest set; either way the e1RM includes bodyweight (D4)
  const loadMode = exercise?.load_mode ?? null;
  const assisted = loadMode === 'assisted';
  const added = loadMode === 'bodyweight';
  // lift_pbs has a 1RM only for weight × reps, so a legacy reps-only row (Push-up) shows none, in the tile or the chart
  const showE1rm = !exercise || exercise.measure === 'weight_reps';

  return (
    <>
      <Stack.Screen options={{ title: exercise?.name ?? 'Exercise' }} />
      <Screen>
        {exercise ? (
          <View>
            <T variant="h1">{exercise.name}</T>
            <T tone="mut">{[exercise.muscle_group, exercise.equipment, exercise.is_unilateral ? 'one side at a time' : null].filter(Boolean).join(' · ')}</T>
            {exercise.owner_id ? (
              <View style={{ flexDirection: 'row', marginTop: 8 }}>
                <Button title="Edit" small variant="secondary" onPress={() => router.push({ pathname: '/lift/exercises/new', params: { edit: exercise.id } })} />
              </View>
            ) : null}
          </View>
        ) : null}

        {exercise && roles ? (
          <Card title="Muscles" subtitle="Where one set's load lands">
            {roles.get(exercise.id)?.length
              ? <ExerciseMuscles roles={roles.get(exercise.id)!} nameOf={names} figureWidth={96} />
              : <T tone="mut">No muscles are mapped to this exercise, so it adds no load to the recovery map.</T>}
          </Card>
        ) : null}

        {exercise ? <StrengthReference exercise={exercise} /> : null}

        <Card title="Records" subtitle={record?.last_completed_at ? `last done ${relativeDay(record.last_completed_at).toLowerCase()}` : 'no completed sets yet'}>
          <Grid>
            {assisted ? null : <StatTile label={added ? 'Best added' : 'Best weight'} value={record?.best_weight_kg != null ? formatWeight(record.best_weight_kg, units, 1) : '–'} />}
            {showE1rm ? (
              <StatTile label="Est. 1RM" value={record?.best_e1rm_kg != null ? formatWeight(record.best_e1rm_kg, units, 0) : '–'} sub={bodyweightRelative(loadMode) ? 'incl. bodyweight' : 'best set, RPE counted'} />
            ) : null}
            {assisted ? null : <StatTile label="Best set" value={record?.best_set_volume_kg != null ? formatWeight(record.best_set_volume_kg, units, 0) : '–'} sub={added ? 'added weight × reps' : 'weight × reps'} />}
            <StatTile label="Most reps" value={record?.best_reps != null ? `${record.best_reps}` : '–'} />
            <StatTile label="Sets logged" value={`${record?.completed_sets ?? 0}`} />
          </Grid>
        </Card>

        {history.data && history.data.length > 1 ? (
          <Card title="Progress" subtitle={showE1rm ? `Best set and estimated 1RM per session, ${unit}` : `Best set per session, ${unit}`}>
            <LineChart
              height={180}
              series={[
                { name: added ? 'added load' : assisted ? 'most assist' : 'best set', color: palette.accent, points: [...history.data].reverse().map((h) => ({ x: Date.parse(h.startedAt), y: h.bestWeight == null ? null : kgToDisplay(h.bestWeight, units) })) },
                ...(showE1rm ? [{ name: 'est. 1RM', color: palette.ink2, dashed: true, points: [...history.data].reverse().map((h) => {
                  const best = Math.max(0, ...h.sets.filter((s) => s.set_type !== 'warmup').map((s) => s.e1rm ?? 0));
                  return { x: Date.parse(h.startedAt), y: best > 0 ? kgToDisplay(Math.round(best * 10) / 10, units) : null };
                }) }] : []),
              ]}
              yFormat={(v) => `${Math.round(v)}`}
              emptyText={showE1rm ? undefined : 'No weight logged'}
            />
          </Card>
        ) : null}

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
              value={h.bestWeight != null ? loggedWeight(h.bestWeight, units, loadMode) : `${h.sets.length} sets`}
              valueSub={h.volume ? `${formatWeight(h.volume, units, 0)} vol` : undefined}
              onPress={() => router.push(`/lift/history/${h.workoutId}`)}
            />
          ))}
        </Card>
      </Screen>
    </>
  );
}
