import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { useExercises, useRecords } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { ExerciseForm } from '@/components/lift/ExerciseForm';
import { Button } from '@/components/ui/Button';
import { ListRow } from '@/components/ui/ListRow';
import { Loading } from '@/components/ui/States';
import { TextField } from '@/components/ui/TextField';
import { formatWeight } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export default function ExerciseLibrary() {
  const { palette } = useTheme();
  const units = useUnits();
  const exercises = useExercises();
  const records = useRecords();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const best = useMemo(() => new Map((records.data ?? []).map((r) => [r.exercise_id, r])), [records.data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = exercises.data ?? [];
    return (q ? all.filter((e) => e.name.toLowerCase().includes(q) || (e.muscle_group ?? '').includes(q)) : all)
      .slice()
      .sort((a, b) => (best.has(b.id) ? 1 : 0) - (best.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
  }, [exercises.data, query, best]);

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
              <ExerciseForm initialName={query} onDone={() => setCreating(false)} />
            ) : (
              <>
                <TextField value={query} onChangeText={setQuery} placeholder="Search exercises" autoCapitalize="none" />
                <Button title="New exercise" variant="secondary" small onPress={() => setCreating(true)} />
              </>
            )}
          </View>
        }
        renderItem={({ item, index }) => {
          const r = best.get(item.id);
          return (
            <ListRow
              first={index === 0}
              title={item.name}
              subtitle={[item.muscle_group, item.equipment, item.owner_id ? 'yours' : null].filter(Boolean).join(' · ')}
              value={r?.best_weight_kg != null ? formatWeight(r.best_weight_kg, units, 0) : undefined}
              valueSub={r ? `${r.completed_sets ?? 0} sets` : undefined}
              onPress={() => router.push(`/lift/exercises/${item.id}`)}
            />
          );
        }}
        ListEmptyComponent={creating ? null : exercises.isLoading ? <Loading /> : null}
      />
    </View>
  );
}
