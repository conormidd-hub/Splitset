import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { usePreviousSets } from '@/api/lifting';
import { linkWorkoutToPlan } from '@/api/plan';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { NumberInput } from '@/components/ui/NumberInput';
import { ErrorBanner } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowSeconds } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { useUserId } from '@/lib/session';
import { confirm } from '@/lib/confirm';
import { adjustRest, formatClock, startRest, stopRest, useRestRemaining } from '@/lib/restTimer';
import { displayToKg, kgToDisplay, type Units } from '@/lib/units';
import { useActiveWorkout, type ExerciseBlock, type SetRow, type SetType } from '@/stores/activeWorkout';
import { useRoutineDraft } from '@/stores/routineDraft';
import { useTheme } from '@/theme/ThemeProvider';
import { fontSize, radius, space } from '@/theme/tokens';

const REST_STEPS = [60, 90, 120, 150, 180, 240];
const TYPE_LABEL: Record<SetType, string> = { warmup: 'W', working: '', drop: 'D', failure: 'F' };
const NEXT_TYPE: Record<SetType, SetType> = { working: 'warmup', warmup: 'drop', drop: 'failure', failure: 'working' };

function useElapsed(startedAt: string | undefined): string {
  const nowSeconds = useNowSeconds();
  if (!startedAt) return '';
  const s = Math.max(0, Math.round(nowSeconds - new Date(startedAt).getTime() / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${m.toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}` : `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export default function ActiveWorkoutScreen() {
  const { palette } = useTheme();
  const units = useUnits();
  const uid = useUserId();
  const workout = useActiveWorkout((s) => s.workout);
  const lastError = useActiveWorkout((s) => s.lastError);
  const outboxLength = useActiveWorkout((s) => s.outbox.length);
  const { rename, finish, discard, flush } = useActiveWorkout.getState();
  const elapsed = useElapsed(workout?.startedAt);
  const rest = useRestRemaining();
  const [finishing, setFinishing] = useState(false);

  if (!workout) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg, padding: space.lg, gap: space.md }}>
        <T variant="h1">No workout in progress</T>
        <Button title="Back" variant="secondary" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const onFinish = async () => {
    const incomplete = workout.exercises.flatMap((b) => b.sets).filter((s) => !s.completed && (s.weightKg != null || s.reps != null)).length;
    const ok = await confirm('Finish workout', incomplete ? `${incomplete} filled-in set${incomplete === 1 ? ' is' : 's are'} not ticked and will be kept as unfinished. Finish anyway?` : 'Save this workout to your history?', 'Finish');
    if (!ok) return;
    setFinishing(true);
    await stopRest();
    const id = await finish();
    setFinishing(false);
    if (id) {
      linkWorkoutToPlan(uid, id, todayIso()).catch(() => {});
      router.replace(`/lift/history/${id}`);
    }
  };

  const onDiscard = async () => {
    const ok = await confirm('Discard workout', 'Everything logged in this session is deleted.', 'Discard', true);
    if (!ok) return;
    await stopRest();
    await discard();
    router.back();
  };

  const saveAsRoutine = () => {
    useRoutineDraft.getState().fromWorkout(workout);
    router.push('/lift/routines/new?from=workout');
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* header */}
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <TextInput
              value={workout.name}
              onChangeText={rename}
              style={{ flex: 1, color: palette.ink, fontSize: fontSize.h1, fontWeight: '800', padding: 0 }}
              placeholder="Workout"
              placeholderTextColor={palette.mut}
            />
            <Button title="Finish" small loading={finishing} onPress={onFinish} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <T variant="small" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{elapsed}</T>
            <T variant="small" tone={lastError ? 'neg' : 'mut'}>
              {lastError ? 'not saved' : outboxLength ? 'saving…' : 'saved'}
            </T>
            <View style={{ flex: 1 }} />
            <Pressable onPress={saveAsRoutine}><T variant="small" tone="accent" weight="600">Save as routine</T></Pressable>
            <Pressable onPress={onDiscard}><T variant="small" tone="neg" weight="600">Discard</T></Pressable>
          </View>
        </View>

        {/* rest timer */}
        {rest ? (
          <View style={{ marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: rest.remaining === 0 ? palette.accent : palette.accentSoft, borderRadius: radius.md, padding: space.md, flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <T variant="label" tone={rest.remaining === 0 ? 'onAccent' : 'accent'}>{rest.remaining === 0 ? 'Rest over' : 'Rest'}</T>
              <T variant="h1" tone={rest.remaining === 0 ? 'onAccent' : 'ink'} style={{ fontVariant: ['tabular-nums'] }}>{formatClock(rest.remaining)}</T>
            </View>
            <Button title="−30" small variant="secondary" onPress={() => adjustRest(-30)} />
            <Button title="+30" small variant="secondary" onPress={() => adjustRest(30)} />
            <Button title="Skip" small variant="ghost" onPress={() => stopRest()} />
          </View>
        ) : null}

        <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.md, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          {lastError ? (
            <View style={{ gap: space.sm }}>
              <ErrorBanner message={`Some changes have not reached the server yet: ${lastError}. They are kept on this device.`} />
              <Button title="Retry now" small variant="secondary" onPress={() => flush()} />
            </View>
          ) : null}

          {workout.exercises.map((block) => (
            <ExerciseCard key={block.id} block={block} units={units} />
          ))}

          <Button title="Add exercise" variant="secondary" onPress={() => router.push('/lift/picker?target=workout')} />
          {workout.exercises.length === 0 ? (
            <T tone="mut" align="center">Add an exercise to start logging. Sets you tick start the rest timer.</T>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ExerciseCard({ block, units }: { block: ExerciseBlock; units: Units }) {
  const { palette } = useTheme();
  const { addSet, removeExercise, setExerciseRest } = useActiveWorkout.getState();
  const previous = usePreviousSets(block.exerciseId);
  const weighted = block.measure === 'weight_reps' || block.measure === 'weight_duration';
  const timed = block.measure === 'duration' || block.measure === 'weight_duration' || block.measure === 'distance_duration';
  const repped = block.measure === 'weight_reps' || block.measure === 'reps';
  const unitLabel = units === 'imperial' ? 'lb' : 'kg';

  const cycleRest = () => {
    const current = block.restSeconds;
    const idx = current == null ? -1 : REST_STEPS.indexOf(current);
    const next = idx === -1 ? REST_STEPS[0] : idx + 1 >= REST_STEPS.length ? null : REST_STEPS[idx + 1];
    setExerciseRest(block.id, next);
  };

  const onRemove = async () => {
    const ok = await confirm('Remove exercise', `Remove ${block.name} and its sets from this workout?`, 'Remove', true);
    if (ok) removeExercise(block.id);
  };

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <Pressable style={{ flex: 1 }} onPress={() => router.push(`/lift/exercises/${block.exerciseId}`)}>
          <T variant="h3" tone="accent">{block.name}</T>
        </Pressable>
        <Pressable onPress={cycleRest} style={{ backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
          <T variant="small" tone="ink2">{block.restSeconds ? `rest ${formatClock(block.restSeconds)}` : 'no rest'}</T>
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={8}><T tone="mut">✕</T></Pressable>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingBottom: 4 }}>
        <T variant="label" tone="mut" style={{ width: 32, textAlign: 'center' }}>set</T>
        <T variant="label" tone="mut" style={{ flex: 1 }}>previous</T>
        {weighted ? <T variant="label" tone="mut" style={{ width: 72, textAlign: 'center' }}>{unitLabel}</T> : null}
        {repped ? <T variant="label" tone="mut" style={{ width: 64, textAlign: 'center' }}>reps</T> : null}
        {timed ? <T variant="label" tone="mut" style={{ width: 64, textAlign: 'center' }}>sec</T> : null}
        <T variant="label" tone="mut" style={{ width: 40, textAlign: 'center' }}>✓</T>
      </View>

      {block.sets.map((s, i) => (
        <SetLine
          key={s.id}
          set={s}
          index={i}
          block={block}
          units={units}
          weighted={weighted}
          repped={repped}
          timed={timed}
          previous={previous.data[i] ?? previous.data[previous.data.length - 1]}
        />
      ))}

      <Button title="Add set" variant="ghost" small onPress={() => addSet(block.id)} style={{ alignSelf: 'flex-start', marginTop: space.xs }} />
    </Card>
  );
}

function SetLine({
  set, index, block, units, weighted, repped, timed, previous,
}: {
  set: SetRow; index: number; block: ExerciseBlock; units: Units; weighted: boolean; repped: boolean; timed: boolean;
  previous?: { weight_kg: number | null; reps: number | null; seconds: number | null };
}) {
  const { palette } = useTheme();
  const { updateSet, toggleSet, removeSet } = useActiveWorkout.getState();
  const defaultRest = useActiveWorkout((s) => s.defaultRestSeconds);

  const prevText = previous
    ? [
        weighted && previous.weight_kg != null ? `${kgToDisplay(previous.weight_kg, units)}` : null,
        repped && previous.reps != null ? `${previous.reps}` : null,
        timed && previous.seconds != null ? `${previous.seconds}s` : null,
      ].filter(Boolean).join(' × ')
    : '';

  const fillFromPrevious = () => {
    if (!previous) return;
    updateSet(set.id, {
      weightKg: weighted && set.weightKg == null ? previous.weight_kg : set.weightKg,
      reps: repped && set.reps == null ? previous.reps : set.reps,
      seconds: timed && set.seconds == null ? previous.seconds : set.seconds,
    });
  };

  const onToggle = async () => {
    if (!set.completed) fillFromPrevious();
    const row = toggleSet(set.id);
    if (row?.completed) {
      const secs = block.restSeconds ?? defaultRest;
      if (secs) await startRest(secs, `${block.name}: set ${index + 1} done`);
    }
  };

  const onLongPressNumber = async () => {
    const ok = await confirm('Delete set', `Delete set ${index + 1}?`, 'Delete', true);
    if (ok) removeSet(set.id);
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4, opacity: set.completed ? 0.75 : 1 }}>
      <Pressable
        onPress={() => updateSet(set.id, { setType: NEXT_TYPE[set.setType] })}
        onLongPress={onLongPressNumber}
        style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: set.setType === 'working' ? palette.surface2 : palette.accentSoft }}>
        <T variant="small" weight="700" tone={set.setType === 'working' ? 'ink2' : 'accent'}>{TYPE_LABEL[set.setType] || index + 1}</T>
      </Pressable>
      <Pressable style={{ flex: 1 }} onPress={fillFromPrevious}>
        <T variant="small" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{prevText || '–'}</T>
      </Pressable>
      {weighted ? (
        <NumberInput
          value={set.weightKg == null ? null : kgToDisplay(set.weightKg, units)}
          onChange={(v) => updateSet(set.id, { weightKg: v == null ? null : displayToKg(v, units) })}
          placeholder={previous?.weight_kg != null ? `${kgToDisplay(previous.weight_kg, units)}` : '–'}
        />
      ) : null}
      {repped ? (
        <NumberInput value={set.reps} onChange={(v) => updateSet(set.id, { reps: v })} integer width={64} placeholder={previous?.reps != null ? `${previous.reps}` : '–'} />
      ) : null}
      {timed ? (
        <NumberInput value={set.seconds} onChange={(v) => updateSet(set.id, { seconds: v })} integer width={64} placeholder={previous?.seconds != null ? `${previous.seconds}` : '–'} />
      ) : null}
      <Pressable
        onPress={onToggle}
        style={{ width: 40, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: set.completed ? palette.accent : palette.surface2 }}>
        <T weight="800" tone={set.completed ? 'onAccent' : 'mut'}>✓</T>
      </Pressable>
    </View>
  );
}
