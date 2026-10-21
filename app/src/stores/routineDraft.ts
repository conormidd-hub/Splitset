/** Scratch state for the routine editor, so the exercise picker screen can add to it. */

import { create } from 'zustand';

import type { RoutineDraft, RoutineWithStructure, WorkoutWithStructure } from '@/api/lifting';
import { linkSuperset, unlinkSuperset } from '../lib/lifting/superset.ts';
import { pairedSets } from '../lib/lifting/template.ts';
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
  /** A template from a finished workout in the history: its exercises, with what was lifted as the targets. */
  fromSavedWorkout: (w: WorkoutWithStructure) => void;
  setName: (name: string) => void;
  setNotes: (notes: string) => void;
  /** Add an exercise at the end; with `supersetWith` (another draft exercise's key) linked into a superset with it. */
  addExercise: (ex: { id: string; name: string; measure: string }, supersetWith?: string | null) => void;
  removeExercise: (key: string) => void;
  move: (key: string, dir: -1 | 1) => void;
  /** Move an exercise to another place (a drag). */
  moveTo: (key: string, toIndex: number) => void;
  /** Put the exercises in this order (keys; any left out keep their order at the end). */
  reorder: (keys: readonly string[]) => void;
  /** Link an exercise into a superset with another (it moves next to it), or take it out (null). */
  setSuperset: (key: string, partnerKey: string | null) => void;
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
        sets: pairedSets(b.sets).map((s) => ({
          setType: s.setType, targetReps: s.reps, targetWeightKg: s.weightKg, targetSeconds: s.seconds, targetRpe: s.rpe,
        })),
      })),
    }),

  fromSavedWorkout: (w) =>
    set({
      id: null,
      name: w.name,
      notes: '',
      loadedFrom: `workout:${w.id}`,
      exercises: w.workout_exercises.map((e) => ({
        key: key(),
        exerciseId: e.exercise_id,
        name: e.exercise?.name ?? 'Exercise',
        measure: e.exercise?.measure ?? 'weight_reps',
        restSeconds: e.rest_seconds,
        supersetGroup: e.superset_group,
        notes: e.notes,
        // skipped sets were still planned, so they stay in the template
        sets: pairedSets(e.workout_sets).map((s) => ({
          setType: s.set_type, targetReps: s.reps, targetWeightKg: s.weight_kg, targetSeconds: s.seconds, targetRpe: s.rpe,
        })),
      })),
    }),

  setName: (name) => set({ name }),
  setNotes: (notes) => set({ notes }),

  addExercise: (ex, supersetWith) =>
    set((s) => {
      const added: DraftExercise = {
        key: key(), exerciseId: ex.id, name: ex.name, measure: ex.measure, restSeconds: 90, supersetGroup: null, notes: null,
        sets: [{ setType: 'working', targetReps: null, targetWeightKg: null }, { setType: 'working', targetReps: null, targetWeightKg: null }, { setType: 'working', targetReps: null, targetWeightKg: null }],
      };
      const all = [...s.exercises, added];
      return { exercises: supersetWith ? linkSuperset(all, added.key, supersetWith, (e) => e.key) : all };
    }),

  removeExercise: (k) => set((s) => ({ exercises: unlinkSuperset(s.exercises, k, (e) => e.key).filter((e) => e.key !== k) })),

  reorder: (keys) =>
    set((s) => {
      const byKey = new Map(s.exercises.map((e) => [e.key, e]));
      const ordered = keys.map((k) => byKey.get(k)).filter((e): e is DraftExercise => !!e);
      for (const e of s.exercises) if (!ordered.includes(e)) ordered.push(e);
      return { exercises: ordered };
    }),

  setSuperset: (k, partnerKey) =>
    set((s) => ({
      exercises: partnerKey ? linkSuperset(s.exercises, k, partnerKey, (e) => e.key) : unlinkSuperset(s.exercises, k, (e) => e.key),
    })),

  move: (k, dir) =>
    set((s) => {
      const i = s.exercises.findIndex((e) => e.key === k);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.exercises.length) return {};
      const next = [...s.exercises];
      [next[i], next[j]] = [next[j], next[i]];
      return { exercises: next };
    }),

  moveTo: (k, toIndex) =>
    set((s) => {
      const i = s.exercises.findIndex((e) => e.key === k);
      if (i < 0) return {};
      const next = [...s.exercises];
      const [e] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, e);
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
