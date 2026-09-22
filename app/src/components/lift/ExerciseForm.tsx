import { useState } from 'react';
import { View } from 'react-native';

import { useCreateExercise, type Exercise } from '@/api/lifting';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { space } from '@/theme/tokens';

const GROUPS = ['quads', 'hamstrings', 'glutes', 'calves', 'back', 'chest', 'shoulders', 'biceps', 'triceps', 'core', 'full_body', 'cardio', 'mobility'];
const EQUIPMENT = ['barbell', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'bodyweight', 'other'];
type Measure = Exercise['measure'] extends string ? 'weight_reps' | 'reps' | 'duration' | 'weight_duration' | 'distance_duration' : never;

export function ExerciseForm({ initialName = '', onDone }: { initialName?: string; onDone: (created: Exercise | null) => void }) {
  const create = useCreateExercise();
  const [name, setName] = useState(initialName);
  const [group, setGroup] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>('weight_reps');
  const [unilateral, setUnilateral] = useState(false);

  const submit = () =>
    create.mutate(
      {
        name: name.trim(), muscle_group: group, equipment, measure,
        is_bodyweight: equipment === 'bodyweight', is_unilateral: unilateral,
      },
      { onSuccess: (e) => onDone(e) },
    );

  return (
    <Card title="New exercise">
      <View style={{ gap: space.md }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="Cable row" autoCapitalize="sentences" />
        <View style={{ gap: space.xs }}>
          <T variant="label" tone="mut">Muscle group</T>
          <ChipRow>
            {GROUPS.map((g) => <Chip key={g} label={g.replace('_', ' ')} selected={group === g} onPress={() => setGroup(group === g ? null : g)} />)}
          </ChipRow>
        </View>
        <View style={{ gap: space.xs }}>
          <T variant="label" tone="mut">Equipment</T>
          <ChipRow>
            {EQUIPMENT.map((g) => <Chip key={g} label={g} selected={equipment === g} onPress={() => setEquipment(equipment === g ? null : g)} />)}
          </ChipRow>
        </View>
        <View style={{ gap: space.xs }}>
          <T variant="label" tone="mut">Logged as</T>
          <Segmented<Measure>
            options={[
              { value: 'weight_reps', label: 'kg × reps' },
              { value: 'reps', label: 'reps' },
              { value: 'duration', label: 'time' },
              { value: 'weight_duration', label: 'kg × time' },
            ]}
            value={measure}
            onChange={setMeasure}
          />
        </View>
        <ChipRow>
          <Chip label="One side at a time" selected={unilateral} onPress={() => setUnilateral(!unilateral)} />
        </ChipRow>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button title="Create" small loading={create.isPending} disabled={name.trim().length < 2} onPress={submit} />
          <Button title="Cancel" small variant="ghost" onPress={() => onDone(null)} />
        </View>
        <ErrorBanner message={create.error ? errorMessage(create.error) : null} />
      </View>
    </Card>
  );
}
