import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables, TablesInsert, Views } from '@/types/database';

export type Exercise = Tables<'exercises'>;
export type Routine = Tables<'routines'>;
export type RoutineExercise = Tables<'routine_exercises'>;
export type RoutineSet = Tables<'routine_sets'>;
export type Workout = Tables<'workouts'>;
export type WorkoutExercise = Tables<'workout_exercises'>;
export type WorkoutSet = Tables<'workout_sets'>;
export type WorkoutSummary = Views<'workout_summaries'>;
export type ExerciseRecord = Views<'exercise_records'>;

export const liftKeys = {
  exercises: (uid: string) => ['exercises', uid] as const,
  routines: (uid: string) => ['routines', uid] as const,
  routine: (id: string) => ['routine', id] as const,
  workouts: (uid: string) => ['workouts', uid] as const,
  workout: (id: string) => ['workout', id] as const,
  records: (uid: string) => ['records', uid] as const,
  exerciseHistory: (uid: string, exerciseId: string) => ['exerciseHistory', uid, exerciseId] as const,
  previousSets: (uid: string, exerciseId: string) => ['previousSets', uid, exerciseId] as const,
};

// ---------------------------------------------------------------- exercises

export function useExercises() {
  const uid = useUserId();
  return useQuery({
    queryKey: liftKeys.exercises(uid),
    enabled: !!uid,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Exercise[]> => {
      const { data, error } = await supabase.from('exercises').select('*').eq('archived', false).order('name');
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateExercise() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Pick<TablesInsert<'exercises'>, 'name' | 'muscle_group' | 'equipment' | 'measure' | 'is_bodyweight' | 'is_unilateral'>) => {
      const { data, error } = await supabase
        .from('exercises')
        .insert({ ...input, owner_id: uid, name: input.name.trim() })
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: liftKeys.exercises(uid) }),
  });
}

// ---------------------------------------------------------------- routines

export type RoutineWithStructure = Routine & {
  routine_exercises: (RoutineExercise & { exercise: Pick<Exercise, 'id' | 'name' | 'measure' | 'muscle_group'> | null; routine_sets: RoutineSet[] })[];
};

const ROUTINE_SELECT = '*, routine_exercises(*, exercise:exercises(id, name, measure, muscle_group), routine_sets(*))';

function sortRoutine(r: RoutineWithStructure): RoutineWithStructure {
  r.routine_exercises.sort((a, b) => a.position - b.position);
  for (const re of r.routine_exercises) re.routine_sets.sort((a, b) => a.position - b.position);
  return r;
}

export function useRoutines() {
  const uid = useUserId();
  return useQuery({
    queryKey: liftKeys.routines(uid),
    enabled: !!uid,
    queryFn: async (): Promise<RoutineWithStructure[]> => {
      const { data, error } = await supabase
        .from('routines')
        .select(ROUTINE_SELECT)
        .eq('user_id', uid)
        .eq('archived', false)
        .order('position')
        .order('created_at');
      if (error) throw error;
      return (data as unknown as RoutineWithStructure[]).map(sortRoutine);
    },
  });
}

export function useRoutine(id: string | undefined) {
  return useQuery({
    queryKey: liftKeys.routine(id ?? ''),
    enabled: !!id && id !== 'new',
    queryFn: async (): Promise<RoutineWithStructure> => {
      const { data, error } = await supabase.from('routines').select(ROUTINE_SELECT).eq('id', id!).single();
      if (error) throw error;
      return sortRoutine(data as unknown as RoutineWithStructure);
    },
  });
}

/** What the routine editor and "save as routine" both submit. */
export type RoutineDraft = {
  id?: string;
  name: string;
  notes?: string | null;
  exercises: {
    exerciseId: string;
    restSeconds: number | null;
    supersetGroup: number | null;
    notes?: string | null;
    sets: { setType: string; targetReps: number | null; targetRepsMax?: number | null; targetWeightKg: number | null; targetRpe?: number | null; targetSeconds?: number | null }[];
  }[];
};

/** Create or fully replace a routine's structure. Child rows are recreated, which is fine
 *  because nothing references routine_exercises/routine_sets by id outside the routine. */
export function useSaveRoutine() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (draft: RoutineDraft): Promise<string> => {
      let routineId = draft.id;
      if (routineId) {
        const { error } = await supabase
          .from('routines')
          .update({ name: draft.name.trim(), notes: draft.notes ?? null, updated_at: new Date().toISOString() })
          .eq('id', routineId);
        if (error) throw error;
        const { error: delErr } = await supabase.from('routine_exercises').delete().eq('routine_id', routineId);
        if (delErr) throw delErr;
      } else {
        const { data, error } = await supabase
          .from('routines')
          .insert({ user_id: uid, name: draft.name.trim(), notes: draft.notes ?? null })
          .select('id')
          .single();
        if (error) throw error;
        routineId = data.id;
      }
      for (const [i, ex] of draft.exercises.entries()) {
        const { data: re, error } = await supabase
          .from('routine_exercises')
          .insert({
            routine_id: routineId, user_id: uid, exercise_id: ex.exerciseId, position: i,
            rest_seconds: ex.restSeconds, superset_group: ex.supersetGroup, notes: ex.notes ?? null,
          })
          .select('id')
          .single();
        if (error) throw error;
        if (ex.sets.length) {
          const { error: setErr } = await supabase.from('routine_sets').insert(
            ex.sets.map((s, j) => ({
              routine_exercise_id: re.id, user_id: uid, position: j, set_type: s.setType,
              target_reps: s.targetReps, target_reps_max: s.targetRepsMax ?? null,
              target_weight_kg: s.targetWeightKg, target_rpe: s.targetRpe ?? null, target_seconds: s.targetSeconds ?? null,
            })),
          );
          if (setErr) throw setErr;
        }
      }
      return routineId;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: liftKeys.routines(uid) });
      qc.invalidateQueries({ queryKey: liftKeys.routine(id) });
    },
  });
}

export function useArchiveRoutine() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('routines').update({ archived: true, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: liftKeys.routines(uid) }),
  });
}

// ---------------------------------------------------------------- workouts

export function useWorkouts(limit = 30) {
  const uid = useUserId();
  return useQuery({
    queryKey: [...liftKeys.workouts(uid), limit],
    enabled: !!uid,
    queryFn: async (): Promise<WorkoutSummary[]> => {
      const { data, error } = await supabase
        .from('workout_summaries')
        .select('*')
        .eq('user_id', uid)
        .not('finished_at', 'is', null)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },
  });
}

export type WorkoutWithStructure = Workout & {
  workout_exercises: (WorkoutExercise & { exercise: Pick<Exercise, 'id' | 'name' | 'measure'> | null; workout_sets: WorkoutSet[] })[];
};

export function useWorkout(id: string | undefined) {
  return useQuery({
    queryKey: liftKeys.workout(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<WorkoutWithStructure> => {
      const { data, error } = await supabase
        .from('workouts')
        .select('*, workout_exercises(*, exercise:exercises(id, name, measure), workout_sets(*))')
        .eq('id', id!)
        .single();
      if (error) throw error;
      const w = data as unknown as WorkoutWithStructure;
      w.workout_exercises.sort((a, b) => a.position - b.position);
      for (const we of w.workout_exercises) we.workout_sets.sort((a, b) => a.position - b.position);
      return w;
    },
  });
}

export function useDeleteWorkout() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('workouts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: liftKeys.workouts(uid) });
      qc.invalidateQueries({ queryKey: liftKeys.records(uid) });
    },
  });
}

// ---------------------------------------------------------------- records and history

export function useRecords() {
  const uid = useUserId();
  return useQuery({
    queryKey: liftKeys.records(uid),
    enabled: !!uid,
    queryFn: async (): Promise<ExerciseRecord[]> => {
      const { data, error } = await supabase.from('exercise_records').select('*').eq('user_id', uid);
      if (error) throw error;
      return data;
    },
  });
}

export type HistorySet = Pick<WorkoutSet, 'id' | 'workout_id' | 'position' | 'set_type' | 'weight_kg' | 'reps' | 'rpe' | 'seconds' | 'completed_at'>;
export type HistoryWorkout = { workoutId: string; name: string; startedAt: string; sets: HistorySet[]; bestWeight: number | null; volume: number };

/** Completed sets of one exercise, grouped by workout, newest first. */
export function useExerciseHistory(exerciseId: string | undefined, workouts = 30) {
  const uid = useUserId();
  return useQuery({
    queryKey: [...liftKeys.exerciseHistory(uid, exerciseId ?? ''), workouts],
    enabled: !!uid && !!exerciseId,
    queryFn: async (): Promise<HistoryWorkout[]> => {
      const { data, error } = await supabase
        .from('workout_sets')
        .select('id, workout_id, position, set_type, weight_kg, reps, rpe, seconds, completed_at, workout:workouts!inner(name, started_at, finished_at)')
        .eq('user_id', uid)
        .eq('exercise_id', exerciseId!)
        .eq('completed', true)
        .order('completed_at', { ascending: false })
        .limit(workouts * 8);
      if (error) throw error;
      const groups = new Map<string, HistoryWorkout>();
      for (const row of data as unknown as (HistorySet & { workout: { name: string; started_at: string; finished_at: string | null } })[]) {
        if (!row.workout.finished_at) continue;
        let g = groups.get(row.workout_id);
        if (!g) {
          g = { workoutId: row.workout_id, name: row.workout.name, startedAt: row.workout.started_at, sets: [], bestWeight: null, volume: 0 };
          groups.set(row.workout_id, g);
        }
        g.sets.push(row);
        if (row.set_type !== 'warmup') {
          if (row.weight_kg != null && (g.bestWeight == null || row.weight_kg > g.bestWeight)) g.bestWeight = row.weight_kg;
          g.volume += (row.weight_kg ?? 0) * (row.reps ?? 0);
        }
      }
      const out = [...groups.values()].slice(0, workouts);
      for (const g of out) g.sets.sort((a, b) => a.position - b.position);
      return out;
    },
  });
}

/** The sets from the most recent finished workout containing this exercise: the placeholders. */
export function usePreviousSets(exerciseId: string | undefined) {
  const history = useExerciseHistory(exerciseId, 1);
  return { ...history, data: history.data?.[0]?.sets ?? [] };
}

export function epley(weightKg: number | null | undefined, reps: number | null | undefined): number | null {
  if (weightKg == null || reps == null || reps <= 0) return null;
  if (reps === 1) return weightKg;
  if (reps > 12) return null;
  return weightKg * (1 + reps / 30);
}
