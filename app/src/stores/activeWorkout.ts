/**
 * The live gym sheet.
 *
 * One workout at a time lives here while it is in progress. Every change is written to the
 * store (persisted to AsyncStorage synchronously, so a killed app resumes exactly where it
 * was) and queued for the database. The queue flushes in order after every change and again
 * on demand; a failed flush keeps its operations for the next attempt. Rows carry updated_at
 * so the server's last-write-wins guard settles any overlap between devices. Once Finish has
 * queued the workout's finish, the sheet takes no more edits, and it closes when that finish
 * syncs, whichever flush runs it.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { Exercise, RoutineWithStructure } from '@/api/lifting';
import { finishWorkoutRemote } from '@/api/workoutLoads';
import { setRowPayload, usesBodyweight, type ExerciseFacts, type SetRow, type SetType, type Side } from '@/lib/lifting/setRow';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import type { Thresholds } from '@/lib/recovery/thresholds';
import { storage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

export type { SetRow, SetType, Side } from '@/lib/lifting/setRow';

/** One exercise in the workout. The library facts (slug, load mode, bodyweight factor, sides)
 *  let each saved set carry its e1RM; blocks saved before Phase 3 lack them. */
export type ExerciseBlock = ExerciseFacts & {
  id: string;
  name: string;
  position: number;
  restSeconds: number | null;
  supersetGroup: number | null;
  notes: string | null;
  sets: SetRow[];
  updatedAt: string;
  /** Logger switches: show the RPE cell; log one side per set (unilateral exercises). */
  showRpe?: boolean;
  perSide?: boolean;
};

/** The exercise columns the logger copies onto a block. */
export type ExerciseForWorkout = Pick<Exercise, 'id' | 'name' | 'measure'> &
  Partial<Pick<Exercise, 'slug' | 'load_mode' | 'bw_factor' | 'is_unilateral' | 'is_bodyweight'>>;

const factsOf = (e: ExerciseForWorkout): Omit<ExerciseFacts, 'exerciseId' | 'measure'> => ({
  slug: e.slug ?? null, loadMode: e.load_mode ?? null, bwFactor: e.bw_factor ?? null,
  unilateral: e.is_unilateral ?? false, isBodyweight: e.is_bodyweight ?? false,
});

const otherSide = (side: Side | null | undefined): Side => (side === 'left' ? 'right' : 'left');

export type ActiveWorkout = {
  id: string;
  userId: string;
  routineId: string | null;
  name: string;
  startedAt: string;
  notes: string | null;
  bodyweightKg: number | null;
  exercises: ExerciseBlock[];
  updatedAt: string;
};

type Op =
  /** One row, or several of one table in a single request (the sets saved again at Finish). */
  | { kind: 'upsert'; table: 'workouts' | 'workout_exercises' | 'workout_sets'; row: Record<string, unknown> | Record<string, unknown>[] }
  | { kind: 'delete'; table: 'workouts' | 'workout_exercises' | 'workout_sets'; id: string }
  /** Score the workout and set finished_at with its cache, in one transaction (build phase 4).
   *  Queued after every save of the workout, so it scores exactly what was logged. */
  | { kind: 'finish'; userId: string; workoutId: string; finishedAt: string };

export type RestTimer = { endsAt: number; seconds: number; label: string; notificationId?: string | null };

type State = {
  workout: ActiveWorkout | null;
  outbox: Op[];
  flushing: boolean;
  lastError: string | null;
  timer: RestTimer | null;
  defaultRestSeconds: number;
  /** The signed-in user's thresholds, for the e1RM each saved set stores. Not persisted: the
   *  workout screen sets it from useThresholds(). */
  thresholds: Thresholds;
  /** A workout whose finish synced with no finish() call waiting on it (Retry now, or a queue
   *  left from before a restart): the Lift tab links it to the plan, refreshes and opens it. */
  finishedId: string | null;

  start: (userId: string, routine?: RoutineWithStructure | null, name?: string, bodyweightKg?: number | null) => ActiveWorkout;
  rename: (name: string) => void;
  setNotes: (notes: string) => void;
  addExercise: (exercise: ExerciseForWorkout, restSeconds?: number | null) => ExerciseBlock;
  setExerciseOptions: (blockId: string, options: { showRpe?: boolean; perSide?: boolean }) => void;
  /** Snapshot bodyweight on the workout (D5); sets whose e1RM depends on it are saved again. */
  setBodyweight: (kg: number) => void;
  setThresholds: (thresholds: Thresholds) => void;
  /** Copy the library's current facts onto blocks whose copies differ (an exercise edited
   *  mid-workout, a block saved before Phase 3), and save their sets again with the e1RM they give. */
  refreshFacts: (rows: ExerciseForWorkout[]) => void;
  removeExercise: (blockId: string) => void;
  setExerciseRest: (blockId: string, seconds: number | null) => void;
  addSet: (blockId: string) => SetRow | null;
  updateSet: (setId: string, patch: Partial<Pick<SetRow, 'weightKg' | 'reps' | 'rpe' | 'seconds' | 'side' | 'setType' | 'notes'>>) => void;
  toggleSet: (setId: string, completed?: boolean) => SetRow | null;
  removeSet: (setId: string) => void;
  /** Queue the finish and wait for it: the workout's id once it has synced, else null (the sheet
   *  stays open, with the finish still queued). */
  finish: () => Promise<string | null>;
  discard: () => Promise<void>;
  /** Drain the queue. A call while a drain is running waits for that one, which runs whatever
   *  was queued in the meantime too. */
  flush: () => Promise<void>;
  clearFinished: () => void;
  setTimer: (timer: RestTimer | null) => void;
};

export const uuid = (): string =>
  // crypto.randomUUID exists on web, iOS 15.4+, Android via Hermes; the fallback is fine for
  // client-generated ids that only need to be unique per user
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

const now = () => new Date().toISOString();

const rowOf = {
  workout: (w: ActiveWorkout, finishedAt: string | null = null) => ({
    id: w.id, user_id: w.userId, routine_id: w.routineId, name: w.name, started_at: w.startedAt,
    finished_at: finishedAt, notes: w.notes, bodyweight_kg: w.bodyweightKg, updated_at: now(),
  }),
  exercise: (w: ActiveWorkout, b: ExerciseBlock) => ({
    id: b.id, workout_id: w.id, user_id: w.userId, exercise_id: b.exerciseId, position: b.position,
    superset_group: b.supersetGroup, rest_seconds: b.restSeconds, notes: b.notes, updated_at: now(),
  }),
  /** The set's row, with the e1RM its exercise and the workout's bodyweight give it (Phase 3). */
  set: (c: Thresholds, w: ActiveWorkout, s: SetRow) =>
    setRowPayload(c, w, w.exercises.find((b) => b.id === s.workoutExerciseId), s, now()),
};

/** True once Finish has queued the workout's finish: what it scores is settled from then on. */
const finishQueued = (outbox: Op[], workoutId: string) => outbox.some((o) => o.kind === 'finish' && o.workoutId === workoutId);

/** The drain in progress, shared by every flush() call made while it runs. */
let draining: Promise<void> | null = null;
/** The workout a finish() call is waiting on, and whether its finish has synced: that call opens
 *  the summary itself, so the store doesn't hand the id to the Lift tab as well. */
let awaited: { workoutId: string; synced: boolean } | null = null;

export const useActiveWorkout = create<State>()(
  persist(
    (set, get) => {
      const queue = (...ops: Op[]) => {
        set((s) => ({ outbox: [...s.outbox, ...ops] }));
        void get().flush();
      };
      const mutate = (fn: (w: ActiveWorkout) => void): ActiveWorkout | null => {
        const w = get().workout;
        // after Finish, an edit would reach a finished workout unscored (or un-finish it)
        if (!w || finishQueued(get().outbox, w.id)) return null;
        const next: ActiveWorkout = { ...w, exercises: w.exercises.map((b) => ({ ...b, sets: b.sets.map((s) => ({ ...s })) })) };
        fn(next);
        next.updatedAt = now();
        set({ workout: next });
        return next;
      };

      return {
        workout: null,
        outbox: [],
        flushing: false,
        lastError: null,
        timer: null,
        defaultRestSeconds: 90,
        thresholds: DEFAULT_THRESHOLDS,
        finishedId: null,

        start: (userId, routine, name, bodyweightKg) => {
          const startedAt = now();
          const c = get().thresholds;
          const w: ActiveWorkout = {
            id: uuid(), userId, routineId: routine?.id ?? null,
            name: name ?? routine?.name ?? 'Workout', startedAt, notes: null, bodyweightKg: bodyweightKg ?? null, exercises: [], updatedAt: startedAt,
          };
          const ops: Op[] = [{ kind: 'upsert', table: 'workouts', row: rowOf.workout(w) }];
          for (const re of routine?.routine_exercises ?? []) {
            const block: ExerciseBlock = {
              id: uuid(), exerciseId: re.exercise_id, name: re.exercise?.name ?? 'Exercise', measure: re.exercise?.measure ?? 'weight_reps',
              ...(re.exercise ? factsOf(re.exercise) : {}),
              position: w.exercises.length, restSeconds: re.rest_seconds, supersetGroup: re.superset_group, notes: re.notes, sets: [], updatedAt: startedAt,
            };
            const targets = re.routine_sets.length ? re.routine_sets : [{ set_type: 'working', target_reps: null, target_weight_kg: null, target_seconds: null }];
            for (const t of targets) {
              block.sets.push({
                id: uuid(), workoutExerciseId: block.id, exerciseId: block.exerciseId, position: block.sets.length,
                setType: (t.set_type as SetType) ?? 'working', weightKg: t.target_weight_kg ?? null, reps: t.target_reps ?? null,
                rpe: null, seconds: t.target_seconds ?? null, completed: false, completedAt: null, notes: null, updatedAt: startedAt,
              });
            }
            w.exercises.push(block);
            ops.push({ kind: 'upsert', table: 'workout_exercises', row: rowOf.exercise(w, block) });
            for (const s of block.sets) ops.push({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(c, w, s) });
          }
          set({ workout: w, timer: null, lastError: null });
          queue(...ops);
          return w;
        },

        rename: (name) => {
          const w = mutate((x) => { x.name = name; });
          if (w) queue({ kind: 'upsert', table: 'workouts', row: rowOf.workout(w) });
        },

        setNotes: (notes) => {
          const w = mutate((x) => { x.notes = notes || null; });
          if (w) queue({ kind: 'upsert', table: 'workouts', row: rowOf.workout(w) });
        },

        addExercise: (exercise, restSeconds) => {
          const block: ExerciseBlock = {
            id: uuid(), exerciseId: exercise.id, name: exercise.name, measure: exercise.measure, ...factsOf(exercise), position: 0,
            restSeconds: restSeconds ?? get().defaultRestSeconds, supersetGroup: null, notes: null, sets: [], updatedAt: now(),
          };
          const w = mutate((x) => {
            block.position = x.exercises.length;
            block.sets.push({
              id: uuid(), workoutExerciseId: block.id, exerciseId: block.exerciseId, position: 0, setType: 'working',
              weightKg: null, reps: null, rpe: null, seconds: null, completed: false, completedAt: null, notes: null, updatedAt: now(),
            });
            x.exercises.push(block);
          });
          if (w) {
            queue(
              { kind: 'upsert', table: 'workout_exercises', row: rowOf.exercise(w, block) },
              ...block.sets.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(get().thresholds, w, s) })),
            );
          }
          return block;
        },

        setExerciseOptions: (blockId, options) => {
          const changed: SetRow[] = [];
          const w = mutate((x) => {
            const b = x.exercises.find((e) => e.id === blockId);
            if (!b) return;
            if (options.showRpe !== undefined) b.showRpe = options.showRpe;
            if (options.perSide !== undefined && options.perSide !== !!b.perSide) {
              b.perSide = options.perSide;
              // on: open sets without a side alternate left, right; off: one set covers both sides again
              let side: Side | null | undefined = null;
              for (const s of b.sets) {
                if (options.perSide && !s.side && !s.completed) side = s.side = otherSide(side);
                else if (options.perSide) { side = s.side; continue; }
                else if (s.side) s.side = null;
                else continue;
                s.updatedAt = now();
                changed.push(s);
              }
            }
          });
          if (w && changed.length) queue(...changed.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(get().thresholds, w, s) })));
        },

        setBodyweight: (kg) => {
          const w = mutate((x) => { x.bodyweightKg = kg; });
          if (!w) return;
          const c = get().thresholds;
          queue(
            { kind: 'upsert', table: 'workouts', row: rowOf.workout(w) },
            ...w.exercises.filter(usesBodyweight).flatMap((b) => b.sets.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(c, w, s) }))),
          );
        },

        setThresholds: (thresholds) => set({ thresholds }),

        refreshFacts: (rows) => {
          const byId = new Map(rows.map((r) => [r.id, r]));
          const stale = new Set(
            (get().workout?.exercises ?? []).filter((b) => {
              const row = byId.get(b.exerciseId);
              if (!row) return false;
              const f = factsOf(row);
              return b.slug !== f.slug || b.loadMode !== f.loadMode || b.bwFactor !== f.bwFactor
                || b.unilateral !== f.unilateral || b.isBodyweight !== f.isBodyweight;
            }).map((b) => b.id),
          );
          if (!stale.size) return;
          const w = mutate((x) => {
            for (const b of x.exercises) if (stale.has(b.id)) Object.assign(b, factsOf(byId.get(b.exerciseId)!));
          });
          if (!w) return;
          const c = get().thresholds;
          queue(...w.exercises.filter((b) => stale.has(b.id)).flatMap((b) => b.sets.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(c, w, s) }))));
        },

        removeExercise: (blockId) => {
          const w = mutate((x) => {
            x.exercises = x.exercises.filter((b) => b.id !== blockId).map((b, i) => ({ ...b, position: i }));
          });
          if (w) {
            queue(
              { kind: 'delete', table: 'workout_exercises', id: blockId },
              ...w.exercises.map((b): Op => ({ kind: 'upsert', table: 'workout_exercises', row: rowOf.exercise(w, b) })),
            );
          }
        },

        setExerciseRest: (blockId, seconds) => {
          let block: ExerciseBlock | undefined;
          const w = mutate((x) => {
            block = x.exercises.find((b) => b.id === blockId);
            if (block) block.restSeconds = seconds;
          });
          if (w && block) queue({ kind: 'upsert', table: 'workout_exercises', row: rowOf.exercise(w, block) });
        },

        addSet: (blockId) => {
          let created: SetRow | null = null;
          const w = mutate((x) => {
            const b = x.exercises.find((e) => e.id === blockId);
            if (!b) return;
            const last = b.sets[b.sets.length - 1];
            created = {
              id: uuid(), workoutExerciseId: b.id, exerciseId: b.exerciseId, position: b.sets.length,
              setType: last?.setType === 'warmup' ? 'working' : (last?.setType ?? 'working'),
              weightKg: last?.weightKg ?? null, reps: last?.reps ?? null, rpe: null, seconds: last?.seconds ?? null,
              side: b.perSide ? otherSide(last?.side) : null,
              completed: false, completedAt: null, notes: null, updatedAt: now(),
            };
            b.sets.push(created);
          });
          if (w && created) queue({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(get().thresholds, w, created) });
          return created;
        },

        updateSet: (setId, patch) => {
          let row: SetRow | undefined;
          const w = mutate((x) => {
            for (const b of x.exercises) {
              const s = b.sets.find((y) => y.id === setId);
              if (s) {
                Object.assign(s, patch, { updatedAt: now() });
                row = s;
              }
            }
          });
          if (w && row) queue({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(get().thresholds, w, row) });
        },

        toggleSet: (setId, completed) => {
          let row: SetRow | null = null;
          const w = mutate((x) => {
            for (const b of x.exercises) {
              const s = b.sets.find((y) => y.id === setId);
              if (s) {
                s.completed = completed ?? !s.completed;
                s.completedAt = s.completed ? now() : null;
                s.updatedAt = now();
                row = s;
              }
            }
          });
          if (w && row) queue({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(get().thresholds, w, row) });
          return row;
        },

        removeSet: (setId) => {
          let touched: SetRow[] = [];
          const w = mutate((x) => {
            for (const b of x.exercises) {
              if (b.sets.some((s) => s.id === setId)) {
                b.sets = b.sets.filter((s) => s.id !== setId).map((s, i) => ({ ...s, position: i }));
                touched = b.sets;
              }
            }
          });
          if (w) {
            queue(
              { kind: 'delete', table: 'workout_sets', id: setId },
              ...touched.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(get().thresholds, w, s) })),
            );
          }
        },

        finish: async () => {
          const w = get().workout;
          if (!w) return null;
          // a second Finish while the first is still queued only waits for it, keeping its finishedAt
          if (!finishQueued(get().outbox, w.id)) {
            // drop untouched empty sets so history stays honest
            const cleaned = mutate((x) => {
              for (const b of x.exercises) b.sets = b.sets.filter((s) => s.completed || s.weightKg != null || s.reps != null || s.seconds != null);
            }) ?? w;
            const removed = w.exercises.flatMap((b) => b.sets).filter((s) => !cleaned.exercises.some((b) => b.sets.some((y) => y.id === s.id)));
            // every set again, with the e1RM this build gives it: sets saved by an older build have none
            const c = get().thresholds;
            const kept = cleaned.exercises.flatMap((b) => b.sets.map((s) => rowOf.set(c, cleaned, s)));
            const resave: Op[] = kept.length ? [{ kind: 'upsert', table: 'workout_sets', row: kept }] : [];
            const finishedAt = now();
            set((s) => ({
              outbox: [
                ...s.outbox,
                ...removed.map((r): Op => ({ kind: 'delete', table: 'workout_sets', id: r.id })),
                ...resave,
                { kind: 'upsert', table: 'workouts', row: rowOf.workout(cleaned) },
                { kind: 'finish', userId: w.userId, workoutId: w.id, finishedAt },
              ],
            }));
          }
          const claim = { workoutId: w.id, synced: false };
          awaited = claim;
          try {
            await get().flush();
          } finally {
            if (awaited === claim) awaited = null;
          }
          // still unsynced: the sheet stays open, and Retry (or the next Finish) sends it
          return claim.synced ? w.id : null;
        },

        discard: async () => {
          const w = get().workout;
          set({ workout: null, timer: null, outbox: [] });
          if (w) {
            try {
              await supabase.from('workouts').delete().eq('id', w.id);
            } catch {
              // the row may never have reached the server; nothing to clean up
            }
          }
        },

        flush: () => {
          if (draining) return draining;
          let settled = false;
          const drain = (async () => {
            set({ flushing: true });
            try {
              while (get().outbox.length) {
                const op = get().outbox[0];
                if (op.kind === 'finish') {
                  await finishWorkoutRemote(op.userId, op.workoutId, op.finishedAt);
                } else {
                  const res = op.kind === 'upsert'
                    ? await supabase.from(op.table).upsert(op.row as never, { onConflict: 'id' })
                    : await supabase.from(op.table).delete().eq('id', op.id);
                  if (res.error) throw res.error;
                }
                // a synced finish closes the sheet whichever flush ran it; with no finish() waiting
                // on it, the Lift tab takes it from finishedId (and stops the rest timer)
                let mine = false;
                if (op.kind === 'finish' && awaited?.workoutId === op.workoutId) {
                  awaited.synced = true;
                  mine = true;
                }
                set((s) => ({
                  // a discard while the op was in flight has already emptied the queue
                  outbox: s.outbox[0] === op ? s.outbox.slice(1) : s.outbox,
                  lastError: null,
                  ...(op.kind === 'finish' && s.workout?.id === op.workoutId
                    ? { workout: null, ...(mine ? { timer: null } : { finishedId: op.workoutId }) }
                    : {}),
                }));
              }
            } catch (e) {
              set({ lastError: e instanceof Error ? e.message : 'Could not save' });
            } finally {
              settled = true;
              draining = null;
              set({ flushing: false });
            }
          })();
          // an empty queue settles before the drain is even returned: nothing to share then
          if (!settled) draining = drain;
          return drain;
        },

        clearFinished: () => set({ finishedId: null }),

        setTimer: (timer) => set({ timer }),
      };
    },
    {
      name: 'splitset-active-workout',
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ workout: s.workout, outbox: s.outbox, timer: s.timer, defaultRestSeconds: s.defaultRestSeconds, finishedId: s.finishedId }),
    },
  ),
);
