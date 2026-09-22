/**
 * The live gym sheet.
 *
 * One workout at a time lives here while it is in progress. Every change is written to the
 * store (persisted to AsyncStorage synchronously, so a killed app resumes exactly where it
 * was) and queued for the database. The queue flushes in order after every change and again
 * on demand; a failed flush keeps its operations for the next attempt. Rows carry updated_at
 * so the server's last-write-wins guard settles any overlap between devices.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { Exercise, RoutineWithStructure } from '@/api/lifting';
import { storage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

export type SetType = 'warmup' | 'working' | 'drop' | 'failure';

export type SetRow = {
  id: string;
  workoutExerciseId: string;
  exerciseId: string;
  position: number;
  setType: SetType;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  seconds: number | null;
  completed: boolean;
  completedAt: string | null;
  notes: string | null;
  updatedAt: string;
};

export type ExerciseBlock = {
  id: string;
  exerciseId: string;
  name: string;
  measure: string;
  position: number;
  restSeconds: number | null;
  supersetGroup: number | null;
  notes: string | null;
  sets: SetRow[];
  updatedAt: string;
};

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
  | { kind: 'upsert'; table: 'workouts' | 'workout_exercises' | 'workout_sets'; row: Record<string, unknown> }
  | { kind: 'delete'; table: 'workouts' | 'workout_exercises' | 'workout_sets'; id: string };

export type RestTimer = { endsAt: number; seconds: number; label: string; notificationId?: string | null };

type State = {
  workout: ActiveWorkout | null;
  outbox: Op[];
  flushing: boolean;
  lastError: string | null;
  timer: RestTimer | null;
  defaultRestSeconds: number;

  start: (userId: string, routine?: RoutineWithStructure | null, name?: string) => ActiveWorkout;
  rename: (name: string) => void;
  setNotes: (notes: string) => void;
  addExercise: (exercise: Pick<Exercise, 'id' | 'name' | 'measure'>, restSeconds?: number | null) => ExerciseBlock;
  removeExercise: (blockId: string) => void;
  setExerciseRest: (blockId: string, seconds: number | null) => void;
  addSet: (blockId: string) => SetRow | null;
  updateSet: (setId: string, patch: Partial<Pick<SetRow, 'weightKg' | 'reps' | 'rpe' | 'seconds' | 'setType' | 'notes'>>) => void;
  toggleSet: (setId: string, completed?: boolean) => SetRow | null;
  removeSet: (setId: string) => void;
  finish: () => Promise<string | null>;
  discard: () => Promise<void>;
  flush: () => Promise<void>;
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
  set: (w: ActiveWorkout, s: SetRow) => ({
    id: s.id, workout_exercise_id: s.workoutExerciseId, workout_id: w.id, exercise_id: s.exerciseId, user_id: w.userId,
    position: s.position, set_type: s.setType, weight_kg: s.weightKg, reps: s.reps, rpe: s.rpe, seconds: s.seconds,
    completed: s.completed, completed_at: s.completedAt, notes: s.notes, updated_at: now(),
  }),
};

export const useActiveWorkout = create<State>()(
  persist(
    (set, get) => {
      const queue = (...ops: Op[]) => {
        set((s) => ({ outbox: [...s.outbox, ...ops] }));
        void get().flush();
      };
      const mutate = (fn: (w: ActiveWorkout) => void): ActiveWorkout | null => {
        const w = get().workout;
        if (!w) return null;
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

        start: (userId, routine, name) => {
          const startedAt = now();
          const w: ActiveWorkout = {
            id: uuid(), userId, routineId: routine?.id ?? null,
            name: name ?? routine?.name ?? 'Workout', startedAt, notes: null, bodyweightKg: null, exercises: [], updatedAt: startedAt,
          };
          const ops: Op[] = [{ kind: 'upsert', table: 'workouts', row: rowOf.workout(w) }];
          for (const re of routine?.routine_exercises ?? []) {
            const block: ExerciseBlock = {
              id: uuid(), exerciseId: re.exercise_id, name: re.exercise?.name ?? 'Exercise', measure: re.exercise?.measure ?? 'weight_reps',
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
            for (const s of block.sets) ops.push({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(w, s) });
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
            id: uuid(), exerciseId: exercise.id, name: exercise.name, measure: exercise.measure, position: 0,
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
              ...block.sets.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(w, s) })),
            );
          }
          return block;
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
              completed: false, completedAt: null, notes: null, updatedAt: now(),
            };
            b.sets.push(created);
          });
          if (w && created) queue({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(w, created) });
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
          if (w && row) queue({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(w, row) });
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
          if (w && row) queue({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(w, row) });
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
              ...touched.map((s): Op => ({ kind: 'upsert', table: 'workout_sets', row: rowOf.set(w, s) })),
            );
          }
        },

        finish: async () => {
          const w = get().workout;
          if (!w) return null;
          // drop untouched empty sets so history stays honest
          const cleaned = mutate((x) => {
            for (const b of x.exercises) b.sets = b.sets.filter((s) => s.completed || s.weightKg != null || s.reps != null || s.seconds != null);
          });
          const removed = w.exercises.flatMap((b) => b.sets).filter((s) => !cleaned?.exercises.some((b) => b.sets.some((y) => y.id === s.id)));
          const finishedAt = now();
          set((s) => ({
            outbox: [
              ...s.outbox,
              ...removed.map((r): Op => ({ kind: 'delete', table: 'workout_sets', id: r.id })),
              { kind: 'upsert', table: 'workouts', row: rowOf.workout(cleaned ?? w, finishedAt) },
            ],
          }));
          await get().flush();
          if (get().outbox.length) return null;   // still unsynced: keep the sheet open
          set({ workout: null, timer: null });
          return w.id;
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

        flush: async () => {
          if (get().flushing) return;
          set({ flushing: true });
          try {
            while (get().outbox.length) {
              const op = get().outbox[0];
              const res = op.kind === 'upsert'
                ? await supabase.from(op.table).upsert(op.row as never, { onConflict: 'id' })
                : await supabase.from(op.table).delete().eq('id', op.id);
              if (res.error) throw res.error;
              set((s) => ({ outbox: s.outbox.slice(1), lastError: null }));
            }
          } catch (e) {
            set({ lastError: e instanceof Error ? e.message : 'Could not save' });
          } finally {
            set({ flushing: false });
          }
        },

        setTimer: (timer) => set({ timer }),
      };
    },
    {
      name: 'splitset-active-workout',
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ workout: s.workout, outbox: s.outbox, timer: s.timer, defaultRestSeconds: s.defaultRestSeconds }),
    },
  ),
);
