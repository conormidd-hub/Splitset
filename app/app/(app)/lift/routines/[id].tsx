import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';

import { useArchiveRoutine, useRoutine, useSaveRoutine } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { formatClock } from '@/lib/restTimer';
import { displayToKg, kgToDisplay } from '@/lib/units';
import { useRoutineDraft } from '@/stores/routineDraft';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const REST_STEPS = [60, 90, 120, 150, 180, 240];

export default function RoutineEditor() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const isNew = id === 'new';
  const { palette } = useTheme();
  const units = useUnits();
  const existing = useRoutine(isNew ? undefined : id);
  const save = useSaveRoutine();
  const archive = useArchiveRoutine();
  const draft = useRoutineDraft();

  // Load the draft once per routine. "from=workout" means the active workout already filled it.
  useEffect(() => {
    if (isNew) {
      if (from !== 'workout' && draft.loadedFrom !== 'new') draft.reset(null);
    } else if (existing.data && draft.loadedFrom !== existing.data.id) {
      draft.reset(existing.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, from, existing.data?.id]);

  const onSave = () =>
    save.mutate(draft.toDraft(), {
      onSuccess: () => {
        draft.reset(null);
        router.back();
      },
    });

  const onDelete = async () => {
    if (isNew) return;
    const ok = await confirm('Delete routine', 'Past workouts started from it are kept.', 'Delete', true);
    if (ok) archive.mutate(id, { onSuccess: () => router.back() });
  };

  if (!isNew && existing.isLoading) return <Screen><Loading /></Screen>;

  return (
    <>
      <Stack.Screen options={{ title: isNew ? 'New routine' : 'Edit routine' }} />
      <Screen>
        <Card>
          <View style={{ gap: space.md }}>
            <TextField label="Name" value={draft.name} onChangeText={draft.setName} placeholder="Lower A" />
            <TextField label="Notes" value={draft.notes} onChangeText={draft.setNotes} placeholder="Optional" multiline />
          </View>
        </Card>

        {draft.exercises.map((e, idx) => (
          <Card
            key={e.key}
            title={e.name}
            right={
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Pressable onPress={() => draft.move(e.key, -1)} disabled={idx === 0} hitSlop={6}><T tone={idx === 0 ? 'mut' : 'ink'}>↑</T></Pressable>
                <Pressable onPress={() => draft.move(e.key, 1)} disabled={idx === draft.exercises.length - 1} hitSlop={6}><T tone={idx === draft.exercises.length - 1 ? 'mut' : 'ink'}>↓</T></Pressable>
                <Pressable onPress={() => draft.removeExercise(e.key)} hitSlop={6}><T tone="neg">✕</T></Pressable>
              </View>
            }>
            <Pressable
              onPress={() => {
                const i = e.restSeconds == null ? -1 : REST_STEPS.indexOf(e.restSeconds);
                draft.setRest(e.key, i === -1 ? REST_STEPS[0] : i + 1 >= REST_STEPS.length ? null : REST_STEPS[i + 1]);
              }}
              style={{ alignSelf: 'flex-start', backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, marginBottom: space.sm }}>
              <T variant="small" tone="ink2">{e.restSeconds ? `rest ${formatClock(e.restSeconds)}` : 'no rest timer'}</T>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: space.sm, paddingBottom: 4 }}>
              <T variant="label" tone="mut" style={{ width: 32 }}>set</T>
              {e.measure !== 'reps' && e.measure !== 'duration' ? <T variant="label" tone="mut" style={{ width: 72, textAlign: 'center' }}>{units === 'imperial' ? 'lb' : 'kg'}</T> : null}
              {e.measure === 'duration' || e.measure === 'weight_duration' ? (
                <T variant="label" tone="mut" style={{ width: 64, textAlign: 'center' }}>sec</T>
              ) : (
                <T variant="label" tone="mut" style={{ width: 64, textAlign: 'center' }}>reps</T>
              )}
            </View>
            {e.sets.map((s, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 3 }}>
                <Pressable onLongPress={() => draft.removeSet(e.key, i)} style={{ width: 32 }}>
                  <T variant="small" tone="mut">{i + 1}</T>
                </Pressable>
                {e.measure !== 'reps' && e.measure !== 'duration' ? (
                  <NumberInput
                    value={s.targetWeightKg == null ? null : kgToDisplay(s.targetWeightKg, units)}
                    onChange={(v) => draft.updateSet(e.key, i, { targetWeightKg: v == null ? null : displayToKg(v, units) })}
                    placeholder="–"
                    muted
                  />
                ) : null}
                {e.measure === 'duration' || e.measure === 'weight_duration' ? (
                  <NumberInput value={s.targetSeconds ?? null} onChange={(v) => draft.updateSet(e.key, i, { targetSeconds: v })} integer width={64} placeholder="–" muted />
                ) : (
                  <NumberInput value={s.targetReps} onChange={(v) => draft.updateSet(e.key, i, { targetReps: v })} integer width={64} placeholder="–" muted />
                )}
                <Pressable onPress={() => draft.removeSet(e.key, i)} hitSlop={6}><T tone="mut">✕</T></Pressable>
              </View>
            ))}
            <Button title="Add set" variant="ghost" small onPress={() => draft.addSet(e.key)} style={{ alignSelf: 'flex-start' }} />
          </Card>
        ))}

        <Button title="Add exercise" variant="secondary" onPress={() => router.push('/lift/picker?target=routine')} />
        <Button title={isNew ? 'Create routine' : 'Save changes'} loading={save.isPending} disabled={draft.name.trim().length < 1 || draft.exercises.length === 0} onPress={onSave} />
        <ErrorBanner message={save.error ? errorMessage(save.error) : null} />
        {!isNew ? <Button title="Delete routine" variant="danger" small loading={archive.isPending} onPress={onDelete} /> : null}
      </Screen>
    </>
  );
}
