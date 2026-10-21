import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { invalidateWorkoutData, useExerciseNotes, useExercises, usePreviousSets, useRoutines, useSaveExerciseNote, useSaveRoutine } from '@/api/lifting';
import { useLiftPbs } from '@/api/pbs';
import { linkWorkoutToPlan } from '@/api/plan';
import { useUnits } from '@/api/profile';
import { useCurrentBodyweight, useLiveSession, useManualBests, useMuscleNames, useThresholds } from '@/api/recovery';
import { FinishPrompt, type TemplateChoice } from '@/components/lift/FinishPrompt';
import { IdlePrompt } from '@/components/lift/IdlePrompt';
import { NOTE_ICON, NoteEditor, type ExerciseNotes, type NoteScope } from '@/components/lift/NoteEditor';
import { RestBubble } from '@/components/lift/RestBubble';
import { SupersetPill, SupersetRail, SupersetSheet, type SupersetOption } from '@/components/lift/Superset';
import { SwipeToDelete, type SwipeGroup } from '@/components/lift/SwipeToDelete';
import { LivePbPanel } from '@/components/pbs/LivePbPanel';
import { FigureBubble, QuickView } from '@/components/recovery/FigureBubble';
import { KeyStrip } from '@/components/recovery/FigureKey';
import { FigurePair } from '@/components/recovery/FigurePair';
import { LiveSessionFigure } from '@/components/recovery/LiveSessionFigure';
import { SessionMuscleRows } from '@/components/recovery/RecoveryExtras';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { NumberInput } from '@/components/ui/NumberInput';
import { SortableList } from '@/components/ui/SortableList';
import { ErrorBanner } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowSeconds } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { awayMinutes, elapsedSeconds, formatElapsed } from '@/lib/lifting/elapsed';
import { setRowE1rm } from '@/lib/lifting/setRow';
import { groupItems, groupLetter, turnIn } from '@/lib/lifting/superset';
import { templateChanged, templateFromWorkout } from '@/lib/lifting/template';
import { formatLiftPb, formatLoad, liftMetricShort, mergeSession, metricsFor, sessionBests } from '@/lib/pbs';
import { useUserId } from '@/lib/session';
import { confirm } from '@/lib/confirm';
import { adjustRest, formatClock, startRest, stopRest, useRestRemaining } from '@/lib/restTimer';
import { useRoutineDraft } from '@/stores/routineDraft';
import { displayToKg, kgToDisplay, type Units } from '@/lib/units';
import { useActiveWorkout, type ActiveWorkout, type ExerciseBlock, type SetRow, type SetType } from '@/stores/activeWorkout';
import { useTheme } from '@/theme/ThemeProvider';
import { fontSize, radius, space } from '@/theme/tokens';

const TYPE_LABEL: Record<SetType, string> = { warmup: 'W', working: '', drop: 'D', failure: 'F' };
const NEXT_TYPE: Record<SetType, SetType> = { working: 'warmup', warmup: 'drop', drop: 'failure', failure: 'working' };
/** The RPE picker: 6 to 10 in half points (workout_sets.rpe is checked to these). */
const RPE_STEPS = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

export default function ActiveWorkoutScreen() {
  const { palette } = useTheme();
  const units = useUnits();
  const uid = useUserId();
  const qc = useQueryClient();
  const workout = useActiveWorkout((s) => s.workout);
  const lastError = useActiveWorkout((s) => s.lastError);
  const outboxLength = useActiveWorkout((s) => s.outbox.length);
  const idlePrompt = useActiveWorkout((s) => s.idlePrompt);
  const { rename, finish, discard, flush, setThresholds, setBodyweight, resume, dismissIdlePrompt } = useActiveWorkout.getState();
  const nowSeconds = useNowSeconds();
  // the clock holds while the workout is paused for inactivity (ActiveWorkoutBar watches for that)
  const elapsed = workout ? formatElapsed(elapsedSeconds(workout, nowSeconds * 1000)) : '';
  const paused = !!workout?.pausedAt;
  const rest = useRestRemaining();
  const [finishing, setFinishing] = useState(false);
  const thresholds = useThresholds();
  const bodyweight = useCurrentBodyweight();
  const routines = useRoutines();
  const saveRoutine = useSaveRoutine();
  const live = useLiveSession();
  const names = useMuscleNames();
  const [figureBottom, setFigureBottom] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [quick, setQuick] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const [dragging, setDragging] = useState(false);
  // a drag near the top or bottom of the screen scrolls the workout under the finger
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(0);

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

  const template = workout.routineId ? routines.data?.find((r) => r.id === workout.routineId) ?? null : null;
  const unticked = workout.exercises.flatMap((b) => b.sets).filter((s) => !s.completed && (s.weightKg != null || s.reps != null)).length;

  /** Finish, then do what was chosen for the template. Every choice saves the workout. */
  const finishWith = async (choice: TemplateChoice) => {
    setPrompt(false);
    setFinishing(true);
    await stopRest();
    // what the template takes: the sets Finish keeps (the untouched empty ones are dropped)
    const kept: ActiveWorkout = { ...workout, exercises: workout.exercises.map((b) => ({
      ...b, sets: b.sets.filter((s) => s.completed || s.weightKg != null || s.reps != null || s.seconds != null),
    })) };
    const id = await finish();
    setFinishing(false);
    if (!id) return;
    if (choice === 'update' && template) {
      try {
        await saveRoutine.mutateAsync({
          id: template.id, name: template.name, notes: template.notes,
          exercises: templateFromWorkout(kept, new Map(template.routine_exercises.map((re) => [re.exercise_id, re.notes]))),
        });
      } catch (e) {
        await confirm('Template not updated', `Your workout is saved, but ${template.name} couldn't be updated: ${e instanceof Error ? e.message : 'unknown error'}.`, 'OK');
      }
    }
    await linkWorkoutToPlan(uid, id, todayIso()).catch(() => false);
    invalidateWorkoutData(qc, uid);
    router.replace(`/lift/history/${id}`);
    if (choice === 'new') {
      useRoutineDraft.getState().fromWorkout(kept);
      router.push('/lift/routines/new?from=workout');
    }
  };

  const onFinish = async () => {
    const changed = templateChanged(workout.templateExerciseIds, workout.exercises.map((b) => b.exerciseId));
    // a changed template asks what to do with it; an unchanged one just finishes
    if (changed && template) return setPrompt(true);
    // no template: finish, or finish and keep today as a routine
    if (!template && workout.exercises.length) return setPrompt(true);
    if (changed === false && !unticked) return finishWith('keep');
    const ok = await confirm('Finish workout', unticked ? `${unticked} filled-in set${unticked === 1 ? ' is' : 's are'} not ticked and will be kept as unfinished. Finish anyway?` : 'Save this workout to your history?', 'Finish');
    if (ok) await finishWith('keep');
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

  // the list as drawn: a superset's exercises are one item, dragged together
  const items = groupItems(workout.exercises, (b) => b.id);
  const moveItem = (key: string, to: number) => {
    const order = items.map((i) => i.key);
    const from = order.indexOf(key);
    if (from < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, key);
    useActiveWorkout.getState().reorderExercises(order.flatMap((k) => items.find((i) => i.key === k)?.blocks.map((b) => b.id) ?? []));
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
            <FigureBubble map={live?.session ?? null} mode="session" shown={scrolled && !!live} onPress={() => setQuick(true)} nameOf={names}
              label="This session's muscles, quick view" />
            <RestBubble />
            <Button title="Finish" small loading={finishing} onPress={onFinish} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            {paused ? (
              <Pressable onPress={resume} accessibilityRole="button" accessibilityLabel={`Clock paused at ${elapsed}. Tap to continue.`} hitSlop={6}>
                <T variant="small" tone="accent" weight="600" style={{ fontVariant: ['tabular-nums'] }}>{elapsed} · paused</T>
              </Pressable>
            ) : (
              <T variant="small" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{elapsed}</T>
            )}
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

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.md, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!dragging}
          scrollEventThrottle={16}
          onScroll={(e) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
            // the session figure's bubble shows once the figure has scrolled away
            const past = figureBottom > 0 && e.nativeEvent.contentOffset.y > figureBottom - 16;
            if (past !== scrolled) setScrolled(past);
            if (!past && quick) setQuick(false);
          }}>
          {lastError ? (
            <View style={{ gap: space.sm }}>
              <ErrorBanner message={`Some changes have not reached the server yet: ${lastError}. They are kept on this device.`} />
              <Button title="Retry now" small variant="secondary" onPress={() => flush()} />
            </View>
          ) : null}

          {workout.exercises.length ? (
            <View onLayout={(e) => setFigureBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
              <LiveSessionFigure />
            </View>
          ) : null}

          {/* hold an exercise's ≡ and drag it to move it; a superset moves as one */}
          <SortableList
            keys={items.map((i) => i.key)}
            itemLabel={(key) => {
              const item = items.find((i) => i.key === key);
              if (!item) return 'exercise';
              return item.blocks.length > 1 ? `superset ${groupLetter(workout.exercises, item.group!)}: ${item.blocks.map((b) => b.name).join(' and ')}` : item.blocks[0].name;
            }}
            onMove={moveItem}
            onDragChange={setDragging}
            scroll={{ ref: scrollRef, y: scrollY }}
            renderItem={(key, { handle }) => {
              const item = items.find((i) => i.key === key);
              if (!item) return null;
              const letter = item.group != null ? groupLetter(workout.exercises, item.group) : null;
              if (item.blocks.length === 1) {
                return <ExerciseCard block={item.blocks[0]} units={units} routineId={workout.routineId} handle={handle} letter={letter} isTurn={false} restAfter />;
              }
              // whose set is next in the pair, and the rest timer waits for the pair's last exercise
              const turn = turnIn(item.blocks);
              return (
                <SupersetRail letter={letter ?? ''}>
                  {item.blocks.map((block, i) => (
                    <ExerciseCard
                      key={block.id} block={block} units={units} routineId={workout.routineId} handle={i === 0 ? handle : null}
                      letter={letter} isTurn={turn === i} restAfter={i === item.blocks.length - 1}
                    />
                  ))}
                </SupersetRail>
              );
            }}
          />

          <Button title="Add exercise" variant="secondary" onPress={() => router.push('/lift/picker?target=workout')} />
          {workout.exercises.length === 0 ? (
            <T tone="mut" align="center">Add an exercise to start logging. For a countdown between sets, turn on the rest timer (⏱) at the top.</T>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <QuickView visible={quick} onClose={() => setQuick(false)} title="This session">
        <T variant="h3">This session</T>
        {live ? (
          <>
            <FigurePair map={live.session} mode="session" figureWidth={110} nameOf={names} labels />
            <KeyStrip mode="session" inline />
            <SessionMuscleRows session={live.session} nameOf={names} />
          </>
        ) : null}
      </QuickView>
      <FinishPrompt open={prompt} templateName={template?.name ?? null} unticked={unticked} onChoose={(c) => void finishWith(c)} onCancel={() => setPrompt(false)} />
      <IdlePrompt
        open={paused && idlePrompt && !prompt}
        awayMinutes={awayMinutes(workout, nowSeconds * 1000)}
        onContinue={resume}
        onFinish={() => { dismissIdlePrompt(); void onFinish(); }}
        onLater={dismissIdlePrompt}
        onDiscard={() => { dismissIdlePrompt(); void onDiscard(); }}
      />
    </SafeAreaView>
  );
}

const NO_BLOCKS: ExerciseBlock[] = [];

function ExerciseCard({ block, units, routineId, handle, letter, isTurn, restAfter }: {
  block: ExerciseBlock; units: Units; routineId: string | null;
  /** The drag grip; null for a superset's later exercises, which move with the first. */
  handle: ReactNode;
  /** The superset's letter, or null when the exercise stands alone. */
  letter: string | null;
  /** In a superset, this exercise's set is the next one to do. */
  isTurn: boolean;
  /** Ticking a set here starts the rest timer (the last exercise of a superset, or one on its own). */
  restAfter: boolean;
}) {
  const { palette } = useTheme();
  const { addSet, updateSet, removeExercise, setExerciseOptions, setExerciseNote, setSuperset } = useActiveWorkout.getState();
  const routines = useRoutines();
  const exerciseNotes = useExerciseNotes();
  const saveNote = useSaveExerciseNote();
  const [noting, setNoting] = useState(false);
  const [linking, setLinking] = useState(false);
  // the other exercises, for the superset chooser: the next one is the natural partner
  const all = useActiveWorkout((s) => s.workout?.exercises ?? NO_BLOCKS);
  const at = all.findIndex((b) => b.id === block.id);
  const supersetOptions: SupersetOption[] = all
    .filter((b) => b.id !== block.id && (block.supersetGroup == null || b.supersetGroup !== block.supersetGroup))
    .map((b) => ({ id: b.id, name: b.name, suggested: all[at + 1]?.id === b.id, letter: b.supersetGroup != null ? groupLetter(all, b.supersetGroup) : null }));
  const templateNote = routineId
    ? routines.data?.find((r) => r.id === routineId)?.routine_exercises.find((re) => re.exercise_id === block.exerciseId)?.notes ?? null
    : null;
  const notes: ExerciseNotes = { template: templateNote, exercise: exerciseNotes.data?.get(block.exerciseId) ?? null, workout: block.notes };
  const onSaveNote = (scope: NoteScope, text: string) => {
    if (scope === 'workout') setExerciseNote(block.id, text);
    else saveNote.mutate({ scope, exerciseId: block.exerciseId, routineId, note: text });
  };
  const thresholds = useActiveWorkout((s) => s.thresholds);
  const workoutBodyweight = useActiveWorkout((s) => s.workout?.bodyweightKg ?? null);
  const previous = usePreviousSets(block.exerciseId);
  const exercises = useExercises();
  const lifts = useLiftPbs();
  const manual = useManualBests();
  const [showPb, setShowPb] = useState(false);
  // the set row whose Delete pane is open, so swiping another closes it
  const swipeGroup: SwipeGroup = useRef(null);
  const row = exercises.data?.find((e) => e.id === block.exerciseId);
  const bodyweight = block.isBodyweight ?? row?.is_bodyweight ?? false;
  const unilateral = block.unilateral ?? row?.is_unilateral ?? false;
  const showRpe = block.showRpe ?? block.sets.some((s) => s.rpe != null);
  const perSide = !!block.perSide;
  // what the weight field means: the weight, the load added to bodyweight, or the assistance
  const loadMode = block.loadMode ?? row?.load_mode ?? null;
  const e1rmOf = (s: SetRow) => setRowE1rm(thresholds, block, s, workoutBodyweight);
  const metrics = metricsFor(block.measure, bodyweight, loadMode);
  const stored = lifts.data?.get(block.exerciseId);
  const session = sessionBests(block.sets, block.measure, bodyweight, e1rmOf, loadMode);
  const manualBest = manual.data?.get(block.exerciseId) ?? null;
  // the bodyweight the set e1RMs use (setE1rm's fallback), so the panel's quick loads invert them exactly
  const e1rmBodyweight = workoutBodyweight || thresholds.bodyweight_default_kg;
  // the rep range being lifted now (the next set to tick, else the last, falling back to what that
  // set was last time): singles and doubles are 1RM territory, three and up 3RM
  const firstOpen = block.sets.findIndex((s) => !s.completed);
  const nextIdx = firstOpen === -1 ? block.sets.length - 1 : firstOpen;
  const plannedReps = block.sets[nextIdx]?.reps ?? (previous.data[nextIdx] ?? previous.data[previous.data.length - 1])?.reps ?? 1;
  const focus = metrics.includes('1rm') ? (plannedReps <= 2 || !metrics.includes('3rm') ? '1rm' : '3rm') : (metrics[0] ?? null);
  const merged = metrics.map((m) => ({ m, ...mergeSession(stored?.get(m), session[m], m === '1rm' ? manualBest : null) }));
  // the one set per metric that beat the all-time best, for a trophy on its row
  const prSets = new Set(merged.filter((x) => x.beatsAllTime).map((x) => session[x.m]!.setId));
  const summary = merged.filter((x) => x.all != null).slice(0, 2)
    .map((x) => `${liftMetricShort(x.m, loadMode)} ${formatLiftPb(x.m, x.all, units)}`).join(' · ');

  const loadNextSet = (kg: number) => {
    const target = block.sets.find((s) => !s.completed) ?? addSet(block.id);
    if (target) updateSet(target.id, { weightKg: kg });
  };
  const weighted = block.measure === 'weight_reps' || block.measure === 'weight_duration';
  const timed = block.measure === 'duration' || block.measure === 'weight_duration' || block.measure === 'distance_duration';
  const repped = block.measure === 'weight_reps' || block.measure === 'reps';
  const unitLabel = units === 'imperial' ? 'lb' : 'kg';
  // the weight column says what it holds (notes §4.6): the assistance, or the load added to bodyweight
  const weightLabel = loadMode === 'assisted' ? 'assist' : loadMode === 'bodyweight' ? `+${unitLabel}` : unitLabel;
  const col = perSide && showRpe ? COL_TIGHT : COL;

  const onRemove = async () => {
    const ok = await confirm('Remove exercise', `Remove ${block.name} and its sets from this workout?`, 'Remove', true);
    if (ok) removeExercise(block.id);
  };

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        {handle}
        <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => router.push(`/lift/exercises/${block.exerciseId}`)}>
          <T variant="h3" tone="accent" numberOfLines={1}>{block.name}</T>
        </Pressable>
        <SupersetPill letter={letter} name={block.name} onPress={() => setLinking(true)} />
        {metrics.length ? (
          <Pressable
            onPress={() => setShowPb((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={`${block.name} personal bests`}
            style={{ backgroundColor: showPb ? palette.amber : palette.surface, borderColor: palette.amber, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
            <T variant="small" weight="700" style={{ color: showPb ? palette.surface : palette.amber }}>🏆 PB</T>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => setNoting(true)}
          accessibilityRole="button"
          accessibilityLabel={`${block.name} notes`}
          hitSlop={6}
          style={{ height: 28, minWidth: 34, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill,
            backgroundColor: notes.template || notes.exercise || notes.workout ? palette.accentSoft : palette.surface2 }}>
          <T variant="small">📝</T>
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${block.name}`}><T tone="mut">✕</T></Pressable>
      </View>

      {(['template', 'exercise', 'workout'] as const).filter((s) => notes[s]).map((s) => (
        <Pressable key={s} onPress={() => setNoting(true)} style={{ marginTop: -4, marginBottom: space.xs }}>
          <T variant="small" tone="ink2" numberOfLines={3}>{NOTE_ICON[s]} {notes[s]}</T>
        </Pressable>
      ))}
      <NoteEditor open={noting} exerciseName={block.name} hasTemplate={!!routineId} notes={notes} onSave={onSaveNote} onClose={() => setNoting(false)} />
      <SupersetSheet
        open={linking}
        name={block.name}
        letter={letter}
        options={supersetOptions}
        onPick={(id) => { setLinking(false); setSuperset(block.id, id); }}
        onUnlink={() => { setLinking(false); setSuperset(block.id, null); }}
        onAdd={() => { setLinking(false); router.push({ pathname: '/lift/picker', params: { target: 'workout', superset: block.id } }); }}
        onClose={() => setLinking(false)}
      />

      {metrics.length && !showPb ? (
        <Pressable onPress={() => setShowPb(true)} style={{ marginTop: -4, marginBottom: space.sm }}>
          <T variant="small" tone="mut">
            {summary ? `All-time ${summary}` : 'No PB yet: tick a set to set one'}
            {prSets.size ? <T variant="small" weight="700" style={{ color: palette.amber }}>{'  ·  new PB 🏆'}</T> : null}
          </T>
        </Pressable>
      ) : null}
      {showPb ? (
        <LivePbPanel
          stored={stored} session={session} metrics={metrics} focus={focus} units={units} onLoad={loadNextSet} manualBest={manualBest}
          loadMode={loadMode} bwFactor={block.bwFactor ?? row?.bw_factor ?? null} bodyweightKg={e1rmBodyweight}
        />
      ) : null}

      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
        <Chip label="RPE" selected={showRpe} onPress={() => setExerciseOptions(block.id, { showRpe: !showRpe })} />
        {unilateral ? <Chip label="Each side" selected={perSide} onPress={() => setExerciseOptions(block.id, { perSide: !perSide })} /> : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: col.gap, paddingBottom: 4 }}>
        <T variant="label" tone="mut" style={{ width: 32, textAlign: 'center' }}>set</T>
        {perSide ? <T variant="label" tone="mut" style={{ width: 28, textAlign: 'center' }}>side</T> : null}
        <T variant="label" tone="mut" style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>previous</T>
        {weighted ? (
          <T variant="label" tone="mut" style={{ width: col.weight, textAlign: 'center' }} accessibilityLabel={loadMode === 'assisted' ? `assistance in ${unitLabel}` : undefined}>
            {weightLabel}
          </T>
        ) : null}
        {repped ? <T variant="label" tone="mut" style={{ width: col.count, textAlign: 'center' }}>reps</T> : null}
        {timed ? <T variant="label" tone="mut" style={{ width: col.count, textAlign: 'center' }}>sec</T> : null}
        {showRpe ? <T variant="label" tone="mut" style={{ width: col.rpe, textAlign: 'center' }}>RPE</T> : null}
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
          col={col}
          e1rm={e1rmOf(s)}
          swipeGroup={swipeGroup}
          isNext={!!letter && isTurn && i === firstOpen}
          restAfter={restAfter}
        />
      ))}

      <Button title="Add set" variant="ghost" small onPress={() => addSet(block.id)} style={{ alignSelf: 'flex-start', marginTop: space.xs }} />
    </Card>
  );
}

/** Column widths of a set row, and the gap between columns. */
const COL = { weight: 72, count: 60, rpe: 44, gap: space.sm as number };
/** With both RPE and Each side on, the row narrows to fit a 375 pt screen (32 + 28 + 60 + 48 + 36
 *  + 40, plus 6 gaps of 4: 268 pt), so "previous", tap to fill and its trophy keep about 40 pt. */
const COL_TIGHT: typeof COL = { weight: 60, count: 48, rpe: 36, gap: space.xs };

function SetLine({
  set, index, block, units, weighted, repped, timed, previous, isPr, showRpe, perSide, col, e1rm, swipeGroup, isNext, restAfter,
}: {
  set: SetRow; index: number; block: ExerciseBlock; units: Units; weighted: boolean; repped: boolean; timed: boolean;
  previous?: { weight_kg: number | null; reps: number | null; seconds: number | null };
  isPr?: boolean;
  showRpe: boolean;
  perSide: boolean;
  col: typeof COL;
  /** The e1RM this set stores, from the engine; shown once the set is ticked. */
  e1rm: number | null;
  swipeGroup: SwipeGroup;
  /** In a superset, this is the set to do next: its number wears an accent ring. */
  isNext: boolean;
  /** Ticking this set starts the rest timer; off for a superset's earlier exercises. */
  restAfter: boolean;
}) {
  const { palette } = useTheme();
  const { updateSet, toggleSet, removeSet } = useActiveWorkout.getState();
  const rest = useActiveWorkout((s) => s.workout?.rest);
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
    // only when the rest timer is on (⏱ at the top), and after a superset's last exercise, not between its pair
    if (row?.completed && rest?.on && restAfter) await startRest(rest.seconds, `${block.name}: set ${index + 1} done`);
  };

  // the long press stays as the way in without a swipe (screen readers, a mouse)
  const onLongPressNumber = async () => {
    const ok = await confirm('Delete set', `Delete set ${index + 1}?`, 'Delete', true);
    if (ok) removeSet(set.id);
  };

  const pickRpe = (rpe: number | null) => {
    updateSet(set.id, { rpe });
    setPickingRpe(false);
  };

  return (
    <SwipeToDelete onDelete={() => removeSet(set.id)} label={`set ${index + 1}`} openRef={swipeGroup}>
    <View style={{ paddingVertical: 4, opacity: set.completed ? 0.75 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: col.gap }}>
        <Pressable
          onPress={() => updateSet(set.id, { setType: NEXT_TYPE[set.setType] })}
          onLongPress={onLongPressNumber}
          accessibilityLabel={`Set ${index + 1}, ${set.setType === 'warmup' ? 'warm-up' : set.setType}${isNext ? ', next in the superset' : ''}. Tap to change the set type; hold to delete the set.`}
          style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: set.setType === 'working' ? palette.surface2 : palette.accentSoft,
            borderWidth: isNext ? 2 : 0, borderColor: palette.accent }}>
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
            width={col.weight}
          />
        ) : null}
        {repped ? (
          <NumberInput value={set.reps} onChange={(v) => updateSet(set.id, { reps: v })} integer width={col.count} placeholder={previous?.reps != null ? `${previous.reps}` : '–'} />
        ) : null}
        {timed ? (
          <NumberInput value={set.seconds} onChange={(v) => updateSet(set.id, { seconds: v })} integer width={col.count} placeholder={previous?.seconds != null ? `${previous.seconds}` : '–'} />
        ) : null}
        {showRpe ? (
          <Pressable
            onPress={() => setPickingRpe((v) => !v)}
            accessibilityLabel={set.rpe != null ? `RPE ${set.rpe}. Tap to change.` : 'No RPE. Tap to add one.'}
            style={{ width: col.rpe, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: pickingRpe ? palette.accentSoft : palette.surface3 }}>
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
        <T variant="tiny" tone="mut" align="right" style={{ paddingTop: 2, paddingRight: 40 + col.gap }}>e1RM {formatLoad(e1rm, units)}</T>
      ) : null}
    </View>
    </SwipeToDelete>
  );
}
