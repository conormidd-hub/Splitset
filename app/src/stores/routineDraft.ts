/** Scratch state for the routine editor, so the exercise picker screen can add to it. */

import { create } from 'zustand';

import type { RoutineDraft, RoutineWithStructure } from '@/api/lifting';
import type { ActiveWorkout } from './activeWorkout';

export type DraftExercise = RoutineDraft['exercises'][number] & { key: string; name: string; measure: string };

type State = {
  id: string | null;
  name: string;
  notes: string;
  exercises: DraftExercise[];
  loadedFrom: string | null;

  reset: (routine?: RoutineWithStructure | null) => void;
  fromWorkout: (w: ActiveWorkout) => void;
  setName: (name: string) => void;
  setNotes: (notes: string) => void;
  addExercise: (ex: { id: string; name: string; measure: string }) => void;
  removeExercise: (key: string) => void;
  move: (key: string, dir: -1 | 1) => void;
  setRest: (key: string, seconds: number | null) => void;
  addSet: (key: string) => void;
  updateSet: (key: string, index: number, patch: Partial<DraftExercise['sets'][number]>) => void;
  removeSet: (key: string, index: number) => void;
  toDraft: () => RoutineDraft;
};

let counter = 0;
const key = () => `d${Date.now().toString(36)}${(counter++).toString(36)}`;

export const useRoutineDraft = create<State>()((set, get) => ({
  id: null,
  name: '',
  notes: '',
  exercises: [],
  loadedFrom: null,

  reset: (routine) =>
    set({
      id: routine?.id ?? null,
      name: routine?.name ?? '',
      notes: routine?.notes ?? '',
      loadedFrom: routine?.id ?? 'new',
      exercises: (routine?.routine_exercises ?? []).map((re) => ({
        key: key(),
        exerciseId: re.exercise_id,
        name: re.exercise?.name ?? 'Exercise',
        measure: re.exercise?.measure ?? 'weight_reps',
        restSeconds: re.rest_seconds,
        supersetGroup: re.superset_group,
        notes: re.notes,
        sets: re.routine_sets.map((s) => ({
          setType: s.set_type, targetReps: s.target_reps, targetRepsMax: s.target_reps_max,
          targetWeightKg: s.target_weight_kg, targetRpe: s.target_rpe, targetSeconds: s.target_seconds,
        })),
      })),
    }),

  fromWorkout: (w) =>
    set({
      id: null,
      name: w.name,
      notes: '',
      loadedFrom: `workout:${w.id}`,
      exercises: w.exercises.map((b) => ({
        key: key(),
        exerciseId: b.exerciseId,
        name: b.name,
        measure: b.measure,
        restSeconds: b.restSeconds,
        supersetGroup: b.supersetGroup,
        notes: b.notes,
        sets: b.sets.map((s) => ({
          setType: s.setType, targetReps: s.reps, targetWeightKg: s.weightKg, targetSeconds: s.seconds, targetRpe: s.rpe,
        })),
      })),
    }),

  setName: (name) => set({ name }),
  setNotes: (notes) => set({ notes }),

  addExercise: (ex) =>
    set((s) => ({
      exercises: [
        ...s.exercises,
        { key: key(), exerciseId: ex.id, name: ex.name, measure: ex.measure, restSeconds: 90, supersetGroup: null, notes: null,
          sets: [{ setType: 'working', targetReps: null, targetWeightKg: null }, { setType: 'working', targetReps: null, targetWeightKg: null }, { setType: 'working', targetReps: null, targetWeightKg: null }] },
      ],
    })),

  removeExercise: (k) => set((s) => ({ exercises: s.exercises.filter((e) => e.key !== k) })),

  move: (k, dir) =>
    set((s) => {
      const i = s.exercises.findIndex((e) => e.key === k);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.exercises.length) return {};
      const next = [...s.exercises];
      [next[i], next[j]] = [next[j], next[i]];
      return { exercises: next };
    }),

  setRest: (k, seconds) => set((s) => ({ exercises: s.exercises.map((e) => (e.key === k ? { ...e, restSeconds: seconds } : e)) })),

  addSet: (k) =>
    set((s) => ({
      exercises: s.exercises.map((e) => {
        if (e.key !== k) return e;
        const last = e.sets[e.sets.length - 1];
        return { ...e, sets: [...e.sets, { setType: 'working', targetReps: last?.targetReps ?? null, targetWeightKg: last?.targetWeightKg ?? null }] };
      }),
    })),

  updateSet: (k, index, patch) =>
    set((s) => ({
      exercises: s.exercises.map((e) => (e.key === k ? { ...e, sets: e.sets.map((x, i) => (i === index ? { ...x, ...patch } : x)) } : e)),
    })),

  removeSet: (k, index) =>
    set((s) => ({ exercises: s.exercises.map((e) => (e.key === k ? { ...e, sets: e.sets.filter((_, i) => i !== index) } : e)) })),

  toDraft: () => {
    const s = get();
    return {
      id: s.id ?? undefined,
      name: s.name,
      notes: s.notes || null,
      exercises: s.exercises.map(({ key: _k, name: _n, measure: _m, ...rest }) => rest),
    };
  },
}));
