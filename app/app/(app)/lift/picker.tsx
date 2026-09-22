import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { useExercises, type Exercise } from '@/api/lifting';
import { ExerciseForm } from '@/components/lift/ExerciseForm';
import { Button } from '@/components/ui/Button';
import { ListRow } from '@/components/ui/ListRow';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { useRoutineDraft } from '@/stores/routineDraft';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export default function ExercisePicker() {
  const { target } = useLocalSearchParams<{ target?: 'workout' | 'routine' }>();
  const { palette } = useTheme();
  const exercises = useExercises();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = exercises.data ?? [];
    const filtered = q ? all.filter((e) => e.name.toLowerCase().includes(q) || (e.muscle_group ?? '').includes(q)) : all;
    return [...filtered].sort((a, b) => (a.owner_id ? 0 : 1) - (b.owner_id ? 0 : 1) || a.name.localeCompare(b.name));
  }, [exercises.data, query]);

  const choose = (e: Exercise) => {
    if (target === 'routine') useRoutineDraft.getState().addExercise({ id: e.id, name: e.name, measure: e.measure });
    else useActiveWorkout.getState().addExercise({ id: e.id, name: e.name, measure: e.measure });
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <FlatList
        data={creating ? [] : rows}
        keyExtractor={(e) => e.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.md }}>
            {creating ? (
              <ExerciseForm initialName={query} onDone={(e) => (e ? choose(e) : setCreating(false))} />
            ) : (
              <>
                <TextField value={query} onChangeText={setQuery} placeholder="Search exercises" autoCapitalize="none" autoFocus />
                <Button title={query.trim() ? `Create "${query.trim()}"` : 'Create a new exercise'} variant="secondary" small onPress={() => setCreating(true)} />
              </>
            )}
          </View>
        }
        renderItem={({ item, index }) => (
          <ListRow
            first={index === 0}
            title={item.name}
            subtitle={[item.muscle_group, item.equipment, item.owner_id ? 'yours' : null].filter(Boolean).join(' · ')}
            onPress={() => choose(item)}
          />
        )}
        ListEmptyComponent={creating ? null : exercises.isLoading ? <Loading /> : <T tone="mut" align="center">No matches. Create it above.</T>}
      />
    </View>
  );
}
