import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { useExercises, useRecords } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { GroupFilter } from '@/components/lift/GroupFilter';
import { Button } from '@/components/ui/Button';
import { ListRow } from '@/components/ui/ListRow';
import { Loading } from '@/components/ui/States';
import { TextField } from '@/components/ui/TextField';
import { filterExercises } from '@/lib/exerciseSearch';
import { formatWeight } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export default function ExerciseLibrary() {
  const { palette } = useTheme();
  const units = useUnits();
  const exercises = useExercises();
  const records = useRecords();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);

  const best = useMemo(() => new Map((records.data ?? []).map((r) => [r.exercise_id, r])), [records.data]);
  const rows = useMemo(
    () => filterExercises(exercises.data ?? [], query, group)
      .sort((a, b) => (best.has(b.id) ? 1 : 0) - (best.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name)),
    [exercises.data, query, group, best],
  );

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(e) => e.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.md }}>
            <TextField value={query} onChangeText={setQuery} placeholder="Search exercises" autoCapitalize="none" />
            <GroupFilter value={group} onChange={setGroup} />
            <Button title="New exercise" variant="secondary" small onPress={() => router.push({ pathname: '/lift/exercises/new', params: { name: query.trim() } })} />
          </View>
        }
        renderItem={({ item, index }) => {
          const r = best.get(item.id);
          // an assisted lift's heaviest weight is its most assistance, the weakest set: not a best
          const bestWeight = item.load_mode === 'assisted' ? null : r?.best_weight_kg;
          return (
            <ListRow
              first={index === 0}
              title={item.name}
              subtitle={[item.muscle_group ?? item.group, item.equipment, item.owner_id ? 'yours' : null].filter(Boolean).join(' · ')}
              value={bestWeight != null ? formatWeight(bestWeight, units, 0) : undefined}
              valueSub={r ? `${r.completed_sets ?? 0} sets` : undefined}
              onPress={() => router.push(`/exercise/${item.id}`)}
            />
          );
        }}
        ListEmptyComponent={exercises.isLoading ? <Loading /> : null}
      />
    </View>
  );
}
