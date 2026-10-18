import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { useExercises, type Exercise } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { useExerciseRoles, useMuscleNames, useReferenceLines } from '@/api/recovery';
import { GroupFilter } from '@/components/lift/GroupFilter';
import { PickerRow } from '@/components/lift/PickerRow';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { filterExercises } from '@/lib/exerciseSearch';
import { formatLoad } from '@/lib/pbs';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { useRoutineDraft } from '@/stores/routineDraft';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export default function ExercisePicker() {
  const { target } = useLocalSearchParams<{ target?: 'workout' | 'routine' }>();
  const { palette } = useTheme();
  const exercises = useExercises();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const units = useUnits();
  const roles = useExerciseRoles();
  const names = useMuscleNames();
  const reference = useReferenceLines((kg) => formatLoad(kg, units));

  const rows = useMemo(
    () => filterExercises(exercises.data ?? [], query, group)
      .sort((a, b) => (a.owner_id ? 0 : 1) - (b.owner_id ? 0 : 1) || a.name.localeCompare(b.name)),
    [exercises.data, query, group],
  );

  const choose = (e: Exercise) => {
    if (target === 'routine') useRoutineDraft.getState().addExercise({ id: e.id, name: e.name, measure: e.measure });
    else useActiveWorkout.getState().addExercise(e);
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(e) => e.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.md }}>
            <TextField value={query} onChangeText={setQuery} placeholder="Search exercises" autoCapitalize="none" autoFocus />
            <GroupFilter value={group} onChange={setGroup} />
            <Button
              title={query.trim() ? `Create "${query.trim()}"` : 'Create a new exercise'}
              variant="secondary"
              small
              onPress={() => router.push({ pathname: '/lift/exercises/new', params: { name: query.trim(), target: target === 'routine' ? 'routine' : 'workout' } })}
            />
          </View>
        }
        renderItem={({ item, index }) => (
          <PickerRow
            exercise={item}
            first={index === 0}
            roles={roles?.get(item.id) ?? []}
            reference={reference ? reference(item) : null}
            expanded={expanded === item.id}
            onToggle={() => setExpanded((cur) => (cur === item.id ? null : item.id))}
            onChoose={() => choose(item)}
            nameOf={names}
          />
        )}
        ListEmptyComponent={exercises.isLoading ? <Loading /> : <T tone="mut" align="center">No matches. Create it above.</T>}
      />
    </View>
  );
}
