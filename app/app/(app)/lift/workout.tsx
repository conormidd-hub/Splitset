import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { invalidateWorkoutData, useExercises, usePreviousSets } from '@/api/lifting';
import { useLiftPbs } from '@/api/pbs';
import { linkWorkoutToPlan } from '@/api/plan';
import { useUnits } from '@/api/profile';
import { useCurrentBodyweight, useManualBests, useThresholds } from '@/api/recovery';
import { LivePbPanel, metricsFor } from '@/components/pbs/LivePbPanel';
import { LiveSessionFigure } from '@/components/recovery/LiveSessionFigure';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { NumberInput } from '@/components/ui/NumberInput';
import { ErrorBanner } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowSeconds } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { setRowE1rm } from '@/lib/lifting/setRow';
import { formatLiftPb, formatLoad, LIFT_METRICS, mergeSession, sessionBests } from '@/lib/pbs';
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
/** The RPE picker: 6 to 10 in half points (workout_sets.rpe is checked to these). */
const RPE_STEPS = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

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
  const qc = useQueryClient();
  const workout = useActiveWorkout((s) => s.workout);
  const lastError = useActiveWorkout((s) => s.lastError);
  const outboxLength = useActiveWorkout((s) => s.outbox.length);
  const { rename, finish, discard, flush, setThresholds, setBodyweight } = useActiveWorkout.getState();
  const elapsed = useElapsed(workout?.startedAt);
  const rest = useRestRemaining();
  const [finishing, setFinishing] = useState(false);
  const thresholds = useThresholds();
  const bodyweight = useCurrentBodyweight();

  // every saved set's e1RM uses the user's thresholds and the workout's bodyweight snapshot (D5);
  // a workout started before bodyweight had loaded takes it as soon as it has
  useEffect(() => { setThresholds(thresholds); }, [thresholds, setThresholds]);
  const needsBodyweight = !!workout && workout.bodyweightKg == null;
  useEffect(() => {
    if (needsBodyweight && bodyweight.ready) setBodyweight(bodyweight.kg);
  }, [needsBodyweight, bodyweight.ready, bodyweight.kg, setBodyweight]);

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
      await linkWorkoutToPlan(uid, id, todayIso()).catch(() => false);
      invalidateWorkoutData(qc, uid);
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
              style={{ flex: 1, minWidth: 0, color: palette.ink, fontSize: fontSize.h1, fontWeight: '800', padding: 0 }}
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

          {workout.exercises.length ? <LiveSessionFigure /> : null}

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
  const { addSet, updateSet, removeExercise, setExerciseRest, setExerciseOptions } = useActiveWorkout.getState();
  const thresholds = useActiveWorkout((s) => s.thresholds);
  const workoutBodyweight = useActiveWorkout((s) => s.workout?.bodyweightKg ?? null);
  const previous = usePreviousSets(block.exerciseId);
  const exercises = useExercises();
  const lifts = useLiftPbs();
  const manual = useManualBests();
  const [showPb, setShowPb] = useState(false);
  const row = exercises.data?.find((e) => e.id === block.exerciseId);
  const bodyweight = block.isBodyweight ?? row?.is_bodyweight ?? false;
  const unilateral = block.unilateral ?? row?.is_unilateral ?? false;
  const showRpe = block.showRpe ?? block.sets.some((s) => s.rpe != null);
  const perSide = !!block.perSide;
  const e1rmOf = (s: SetRow) => setRowE1rm(thresholds, block, s, workoutBodyweight);
  const metrics = metricsFor(block.measure, bodyweight);
  const stored = lifts.data?.get(block.exerciseId);
  const session = sessionBests(block.sets, block.measure, bodyweight, e1rmOf);
  // the rep range being lifted now (the next set to tick, else the last, falling back to what that
  // set was last time): singles and doubles are 1RM territory, three and up 3RM
  const firstOpen = block.sets.findIndex((s) => !s.completed);
  const nextIdx = firstOpen === -1 ? block.sets.length - 1 : firstOpen;
  const plannedReps = block.sets[nextIdx]?.reps ?? (previous.data[nextIdx] ?? previous.data[previous.data.length - 1])?.reps ?? 1;
  const focus = metrics.includes('1rm') ? (plannedReps <= 2 ? '1rm' : '3rm') : (metrics[0] ?? null);
  const merged = metrics.map((m) => ({ m, ...mergeSession(stored?.get(m), session[m], m === '1rm' ? manual.data?.get(block.exerciseId) : null) }));
  // the one set per metric that beat the all-time best, for a trophy on its row
  const prSets = new Set(merged.filter((x) => x.beatsAllTime).map((x) => session[x.m]!.setId));
  const summary = merged.filter((x) => x.all != null).slice(0, 2)
    .map((x) => `${LIFT_METRICS.find((l) => l.key === x.m)?.short} ${formatLiftPb(x.m, x.all, units)}`).join(' · ');

  const loadNextSet = (kg: number) => {
    const target = block.sets.find((s) => !s.completed) ?? addSet(block.id);
    if (target) updateSet(target.id, { weightKg: kg });
  };
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
        {metrics.length ? (
          <Pressable
            onPress={() => setShowPb((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={`${block.name} personal bests`}
            style={{ backgroundColor: showPb ? palette.amber : palette.surface, borderColor: palette.amber, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
            <T variant="small" weight="700" style={{ color: showPb ? palette.surface : palette.amber }}>🏆 PB</T>
          </Pressable>
        ) : null}
        <Pressable onPress={cycleRest} style={{ backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
          <T variant="small" tone="ink2">{block.restSeconds ? `rest ${formatClock(block.restSeconds)}` : 'no rest'}</T>
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={8}><T tone="mut">✕</T></Pressable>
      </View>

      {metrics.length && !showPb ? (
        <Pressable onPress={() => setShowPb(true)} style={{ marginTop: -4, marginBottom: space.sm }}>
          <T variant="small" tone="mut">
            {summary ? `All-time ${summary}` : 'No PB yet: tick a set to set one'}
            {prSets.size ? <T variant="small" weight="700" style={{ color: palette.amber }}>{'  ·  new PB 🏆'}</T> : null}
          </T>
        </Pressable>
      ) : null}
      {showPb ? (
        <LivePbPanel stored={stored} session={session} metrics={metrics} focus={focus} units={units} onLoad={loadNextSet} />
      ) : null}

      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
        <Chip label="RPE" selected={showRpe} onPress={() => setExerciseOptions(block.id, { showRpe: !showRpe })} />
        {unilateral ? <Chip label="Each side" selected={perSide} onPress={() => setExerciseOptions(block.id, { perSide: !perSide })} /> : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingBottom: 4 }}>
        <T variant="label" tone="mut" style={{ width: 32, textAlign: 'center' }}>set</T>
        {perSide ? <T variant="label" tone="mut" style={{ width: 28, textAlign: 'center' }}>side</T> : null}
        <T variant="label" tone="mut" style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>previous</T>
        {weighted ? <T variant="label" tone="mut" style={{ width: COL.weight, textAlign: 'center' }}>{unitLabel}</T> : null}
        {repped ? <T variant="label" tone="mut" style={{ width: COL.count, textAlign: 'center' }}>reps</T> : null}
        {timed ? <T variant="label" tone="mut" style={{ width: COL.count, textAlign: 'center' }}>sec</T> : null}
        {showRpe ? <T variant="label" tone="mut" style={{ width: COL.rpe, textAlign: 'center' }}>RPE</T> : null}
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
          isPr={prSets.has(s.id)}
          showRpe={showRpe}
          perSide={perSide}
          e1rm={e1rmOf(s)}
        />
      ))}

      <Button title="Add set" variant="ghost" small onPress={() => addSet(block.id)} style={{ alignSelf: 'flex-start', marginTop: space.xs }} />
    </Card>
  );
}

/** Column widths of a set row. */
const COL = { weight: 72, count: 60, rpe: 44 };

function SetLine({
  set, index, block, units, weighted, repped, timed, previous, isPr, showRpe, perSide, e1rm,
}: {
  set: SetRow; index: number; block: ExerciseBlock; units: Units; weighted: boolean; repped: boolean; timed: boolean;
  previous?: { weight_kg: number | null; reps: number | null; seconds: number | null };
  isPr?: boolean;
  showRpe: boolean;
  perSide: boolean;
  /** The e1RM this set stores, from the engine; shown once the set is ticked. */
  e1rm: number | null;
}) {
  const { palette } = useTheme();
  const { updateSet, toggleSet, removeSet } = useActiveWorkout.getState();
  const defaultRest = useActiveWorkout((s) => s.defaultRestSeconds);
  const [pickingRpe, setPickingRpe] = useState(false);

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

  const pickRpe = (rpe: number | null) => {
    updateSet(set.id, { rpe });
    setPickingRpe(false);
  };

  return (
    <View style={{ paddingVertical: 4, opacity: set.completed ? 0.75 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          onPress={() => updateSet(set.id, { setType: NEXT_TYPE[set.setType] })}
          onLongPress={onLongPressNumber}
          accessibilityLabel={`Set ${index + 1}, ${set.setType === 'warmup' ? 'warm-up' : set.setType}. Tap to change the set type.`}
          style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: set.setType === 'working' ? palette.surface2 : palette.accentSoft }}>
          <T variant="small" weight="700" tone={set.setType === 'working' ? 'ink2' : 'accent'}>{TYPE_LABEL[set.setType] || index + 1}</T>
        </Pressable>
        {perSide ? (
          <Pressable
            onPress={() => updateSet(set.id, { side: set.side === 'left' ? 'right' : 'left' })}
            accessibilityLabel={`Side: ${set.side ?? 'not set'}. Tap to switch.`}
            style={{ width: 28, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface2 }}>
            <T variant="small" weight="700" tone="ink2">{set.side === 'left' ? 'L' : set.side === 'right' ? 'R' : '–'}</T>
          </Pressable>
        ) : null}
        <Pressable style={{ flex: 1, minWidth: 0 }} onPress={fillFromPrevious}>
          <T variant="small" tone="mut" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>{isPr ? '🏆 ' : ''}{prevText || '–'}</T>
        </Pressable>
        {weighted ? (
          <NumberInput
            value={set.weightKg == null ? null : kgToDisplay(set.weightKg, units)}
            onChange={(v) => updateSet(set.id, { weightKg: v == null ? null : displayToKg(v, units) })}
            placeholder={previous?.weight_kg != null ? `${kgToDisplay(previous.weight_kg, units)}` : '–'}
            width={COL.weight}
          />
        ) : null}
        {repped ? (
          <NumberInput value={set.reps} onChange={(v) => updateSet(set.id, { reps: v })} integer width={COL.count} placeholder={previous?.reps != null ? `${previous.reps}` : '–'} />
        ) : null}
        {timed ? (
          <NumberInput value={set.seconds} onChange={(v) => updateSet(set.id, { seconds: v })} integer width={COL.count} placeholder={previous?.seconds != null ? `${previous.seconds}` : '–'} />
        ) : null}
        {showRpe ? (
          <Pressable
            onPress={() => setPickingRpe((v) => !v)}
            accessibilityLabel={set.rpe != null ? `RPE ${set.rpe}. Tap to change.` : 'No RPE. Tap to add one.'}
            style={{ width: COL.rpe, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: pickingRpe ? palette.accentSoft : palette.surface3 }}>
            <T variant="small" weight="600" tone={set.rpe != null ? 'ink' : 'mut'}>{set.rpe ?? '–'}</T>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onToggle}
          style={{ width: 40, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: set.completed ? palette.accent : palette.surface2 }}>
          <T weight="800" tone={set.completed ? 'onAccent' : 'mut'}>✓</T>
        </Pressable>
      </View>
      {pickingRpe ? (
        <View style={{ paddingTop: space.sm, paddingLeft: 40 }}>
          <ChipRow>
            {RPE_STEPS.map((v) => <Chip key={v} label={`${v}`} selected={set.rpe === v} onPress={() => pickRpe(v)} />)}
            <Chip label="none" selected={set.rpe == null} onPress={() => pickRpe(null)} />
          </ChipRow>
        </View>
      ) : null}
      {set.completed && e1rm != null ? (
        <T variant="tiny" tone="mut" align="right" style={{ paddingTop: 2, paddingRight: 48 }}>e1RM {formatLoad(e1rm, units)}</T>
      ) : null}
    </View>
  );
}
