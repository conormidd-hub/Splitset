import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { LIST_COLUMNS, type ActivityListRow } from './activities';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables, TablesInsert } from '@/types/database';

export type PlanSession = Tables<'plan_sessions'>;
export type PlanType = 'run' | 'ride' | 'strength' | 'walk' | 'rest' | 'other';
export type PlanStatus = 'planned' | 'done' | 'skipped';

export const PLAN_TYPES: { value: PlanType; label: string }[] = [
  { value: 'run', label: 'Run' },
  { value: 'strength', label: 'Gym' },
  { value: 'ride', label: 'Ride' },
  { value: 'walk', label: 'Walk' },
  { value: 'rest', label: 'Rest' },
  { value: 'other', label: 'Other' },
];
export const RUN_SUBTYPES = ['easy', 'long', 'tempo', 'intervals', 'hills', 'strides', 'recovery', 'race'];
export const STRENGTH_SUBTYPES = ['lower', 'upper', 'full body', 'mobility'];

export const planKeys = {
  range: (uid: string, from: string, to: string) => ['plan', uid, from, to] as const,
  session: (id: string) => ['planSession', id] as const,
  actualsRange: (uid: string, from: string, to: string) => ['actuals', uid, from, to] as const,
};

/** Sessions with date in [from, to], ordered by date then position. */
export function usePlanRange(from: string, to: string) {
  const uid = useUserId();
  return useQuery({
    queryKey: planKeys.range(uid, from, to),
    enabled: !!uid,
    queryFn: async (): Promise<PlanSession[]> => {
      const { data, error } = await supabase
        .from('plan_sessions')
        .select('*')
        .eq('user_id', uid)
        .gte('date', from)
        .lte('date', to)
        .order('date')
        .order('position');
      if (error) throw error;
      return data;
    },
  });
}

export function usePlanSession(id: string | undefined) {
  return useQuery({
    queryKey: planKeys.session(id ?? ''),
    enabled: !!id && id !== 'new',
    queryFn: async (): Promise<PlanSession> => {
      const { data, error } = await supabase.from('plan_sessions').select('*').eq('id', id!).single();
      if (error) throw error;
      return data;
    },
  });
}

/** Activities whose local date falls in [from, to], for the week view and the link picker. */
export function useActivitiesBetween(from: string, to: string) {
  const uid = useUserId();
  return useQuery({
    queryKey: planKeys.actualsRange(uid, from, to),
    enabled: !!uid,
    queryFn: async (): Promise<ActivityListRow[]> => {
      const { data, error } = await supabase
        .from('activities')
        .select(LIST_COLUMNS)
        .eq('user_id', uid)
        .gte('start_time_local', `${from}T00:00:00`)
        .lt('start_time_local', `${to}T23:59:59`)
        .order('start_time');
      if (error) throw error;
      return data;
    },
  });
}

function invalidatePlan(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['plan'] });
  qc.invalidateQueries({ queryKey: ['planSession'] });
}

export type PlanSessionInput = Pick<
  TablesInsert<'plan_sessions'>,
  'date' | 'type' | 'subtype' | 'title' | 'target_distance_m' | 'target_seconds' | 'routine_id' | 'notes' | 'position'
> & { id?: string };

export function useSavePlanSession() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PlanSessionInput): Promise<string> => {
      const row = { ...input, user_id: uid, updated_at: new Date().toISOString() };
      if (input.id) {
        const { error } = await supabase.from('plan_sessions').update(row).eq('id', input.id);
        if (error) throw error;
        return input.id;
      }
      const { data, error } = await supabase.from('plan_sessions').insert(row).select('id').single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: () => invalidatePlan(qc),
  });
}

export function useDeletePlanSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('plan_sessions').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidatePlan(qc),
  });
}

export function useSetPlanStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: PlanStatus }) => {
      const patch = status === 'done'
        ? { status, linked_by: 'manual', updated_at: new Date().toISOString() }
        : { status, updated_at: new Date().toISOString() };
      const { error } = await supabase.from('plan_sessions').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidatePlan(qc),
  });
}

/**
 * Manual linking. activityId null with keep=true means "leave unlinked, sync must not touch";
 * keep=false hands the decision back to the sync job.
 */
export function useLinkPlanSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, activityId, keep = true }: { id: string; activityId: string | null; keep?: boolean }) => {
      const patch = activityId
        ? { activity_id: activityId, workout_id: null, status: 'done', linked_by: 'manual', updated_at: new Date().toISOString() }
        : { activity_id: null, workout_id: null, status: 'planned', linked_by: keep ? 'manual' : null, updated_at: new Date().toISOString() };
      const { error } = await supabase.from('plan_sessions').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidatePlan(qc);
      qc.invalidateQueries({ queryKey: ['actuals'] });
    },
  });
}

/** Called when a workout finishes: fulfil an unlinked strength session planned for that day. */
export async function linkWorkoutToPlan(uid: string, workoutId: string, dateIso: string): Promise<boolean> {
  const { data } = await supabase
    .from('plan_sessions')
    .select('id')
    .eq('user_id', uid)
    .eq('date', dateIso)
    .eq('type', 'strength')
    .eq('status', 'planned')
    .is('workout_id', null)
    .is('activity_id', null)
    .or('linked_by.is.null,linked_by.neq.manual')
    .order('position')
    .limit(1);
  const target = data?.[0];
  if (!target) return false;
  const { error } = await supabase
    .from('plan_sessions')
    .update({ workout_id: workoutId, status: 'done', linked_by: 'auto', updated_at: new Date().toISOString() })
    .eq('id', target.id);
  return !error;
}

export function planTypeLabel(type: string): string {
  return PLAN_TYPES.find((t) => t.value === type)?.label ?? type;
}
