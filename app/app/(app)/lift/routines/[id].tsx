import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, View, type ScrollView } from 'react-native';

import { useArchiveRoutine, useRoutine, useSaveRoutine } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { SupersetPill, SupersetRail, SupersetSheet } from '@/components/lift/Superset';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { SortableList } from '@/components/ui/SortableList';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { groupItems, groupLetter } from '@/lib/lifting/superset';
import { displayToKg, kgToDisplay, type Units } from '@/lib/units';
import { useRoutineDraft, type DraftExercise } from '@/stores/routineDraft';
import { space } from '@/theme/tokens';

export default function RoutineEditor() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const isNew = id === 'new';
  const units = useUnits();
  const existing = useRoutine(isNew ? undefined : id);
  const save = useSaveRoutine();
  const archive = useArchiveRoutine();
  const draft = useRoutineDraft();
  const [dragging, setDragging] = useState(false);
  // a drag near the top or bottom of the screen scrolls the page under the finger
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(0);

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

  // the list as drawn: a superset's exercises are one item, dragged together
  const items = groupItems(draft.exercises, (e) => e.key);
  const moveItem = (key: string, to: number) => {
    const order = items.map((i) => i.key);
    const fromIdx = order.indexOf(key);
    if (fromIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(to, 0, key);
    draft.reorder(order.flatMap((k) => items.find((i) => i.key === k)?.blocks.map((e) => e.key) ?? []));
  };

  return (
    <>
      <Stack.Screen options={{ title: isNew ? 'New routine' : 'Edit routine' }} />
      <Screen scrollEnabled={!dragging} scrollRef={scrollRef} onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}>
        <Card>
          <View style={{ gap: space.md }}>
            <TextField label="Name" value={draft.name} onChangeText={draft.setName} placeholder="Lower A" />
            <TextField label="Notes" value={draft.notes} onChangeText={draft.setNotes} placeholder="Optional" multiline />
          </View>
        </Card>

        {/* hold an exercise's ≡ and drag it to move it; a superset moves as one */}
        <SortableList
          keys={items.map((i) => i.key)}
          itemLabel={(k) => {
            const item = items.find((i) => i.key === k);
            if (!item) return 'exercise';
            return item.blocks.length > 1 ? `superset ${groupLetter(draft.exercises, item.group!)}: ${item.blocks.map((e) => e.name).join(' and ')}` : item.blocks[0].name;
          }}
          onMove={moveItem}
          onDragChange={setDragging}
          scroll={{ ref: scrollRef, y: scrollY }}
          renderItem={(k, { handle }) => {
            const item = items.find((i) => i.key === k);
            if (!item) return null;
            const letter = item.group != null ? groupLetter(draft.exercises, item.group) : null;
            if (item.blocks.length === 1) return <DraftCard e={item.blocks[0]} units={units} handle={handle} letter={letter} />;
            return (
              <SupersetRail letter={letter ?? ''}>
                {item.blocks.map((e, i) => <DraftCard key={e.key} e={e} units={units} handle={i === 0 ? handle : null} letter={letter} />)}
              </SupersetRail>
            );
          }}
        />

        <Button title="Add exercise" variant="secondary" onPress={() => router.push('/lift/picker?target=routine')} />
        <Button title={isNew ? 'Create routine' : 'Save changes'} loading={save.isPending} disabled={draft.name.trim().length < 1 || draft.exercises.length === 0} onPress={onSave} />
        <ErrorBanner message={save.error ? errorMessage(save.error) : null} />
        {!isNew ? <Button title="Delete routine" variant="danger" small loading={archive.isPending} onPress={onDelete} /> : null}
      </Screen>
    </>
  );
}

/** One exercise of the draft: its target sets, the superset pill, the grip and remove. */
function DraftCard({ e, units, handle, letter }: { e: DraftExercise; units: Units; handle: ReactNode; letter: string | null }) {
  const draft = useRoutineDraft();
  const [linking, setLinking] = useState(false);
  const all = draft.exercises;
  const at = all.findIndex((x) => x.key === e.key);
  const options = all
    .filter((x) => x.key !== e.key && (e.supersetGroup == null || x.supersetGroup !== e.supersetGroup))
    .map((x) => ({ id: x.key, name: x.name, suggested: all[at + 1]?.key === x.key, letter: x.supersetGroup != null ? groupLetter(all, x.supersetGroup) : null }));
  const weighted = e.measure !== 'reps' && e.measure !== 'duration';
  const timed = e.measure === 'duration' || e.measure === 'weight_duration';
  return (
    <Card
      title={e.name}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <SupersetPill letter={letter} name={e.name} onPress={() => setLinking(true)} />
          {handle}
          <Pressable onPress={() => draft.removeExercise(e.key)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${e.name}`}><T tone="neg">✕</T></Pressable>
        </View>
      }>
      <SupersetSheet
        open={linking}
        name={e.name}
        letter={letter}
        options={options}
        onPick={(k) => { setLinking(false); draft.setSuperset(e.key, k); }}
        onUnlink={() => { setLinking(false); draft.setSuperset(e.key, null); }}
        onAdd={() => { setLinking(false); router.push({ pathname: '/lift/picker', params: { target: 'routine', superset: e.key } }); }}
        onClose={() => setLinking(false)}
      />
      <View style={{ flexDirection: 'row', gap: space.sm, paddingBottom: 4 }}>
        <T variant="label" tone="mut" style={{ width: 32 }}>set</T>
        {weighted ? <T variant="label" tone="mut" style={{ width: 72, textAlign: 'center' }}>{units === 'imperial' ? 'lb' : 'kg'}</T> : null}
        <T variant="label" tone="mut" style={{ width: 64, textAlign: 'center' }}>{timed ? 'sec' : 'reps'}</T>
      </View>
      {e.sets.map((s, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 3 }}>
          <Pressable onLongPress={() => draft.removeSet(e.key, i)} style={{ width: 32 }}>
            <T variant="small" tone="mut">{i + 1}</T>
          </Pressable>
          {weighted ? (
            <NumberInput
              value={s.targetWeightKg == null ? null : kgToDisplay(s.targetWeightKg, units)}
              onChange={(v) => draft.updateSet(e.key, i, { targetWeightKg: v == null ? null : displayToKg(v, units) })}
              placeholder="–"
              muted
            />
          ) : null}
          {timed ? (
            <NumberInput value={s.targetSeconds ?? null} onChange={(v) => draft.updateSet(e.key, i, { targetSeconds: v })} integer width={64} placeholder="–" muted />
          ) : (
            <NumberInput value={s.targetReps} onChange={(v) => draft.updateSet(e.key, i, { targetReps: v })} integer width={64} placeholder="–" muted />
          )}
          <Pressable onPress={() => draft.removeSet(e.key, i)} hitSlop={6}><T tone="mut">✕</T></Pressable>
        </View>
      ))}
      <Button title="Add set" variant="ghost" small onPress={() => draft.addSet(e.key)} style={{ alignSelf: 'flex-start' }} />
    </Card>
  );
}
