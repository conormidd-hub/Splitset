import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { LIST_COLUMNS, type ActivityListRow } from './activities';
import { requestPlanPush } from './sync';
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
export function usePlanRange(from: string, to: string, opts: { pollWhile?: (rows: PlanSession[]) => boolean } = {}) {
  const uid = useUserId();
  const { pollWhile } = opts;
  return useQuery({
    queryKey: planKeys.range(uid, from, to),
    enabled: !!uid,
    // e.g. while a moved session is on its way to the watch
    refetchInterval: (q) => (pollWhile && q.state.data && pollWhile(q.state.data) ? 4000 : false),
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

/** Watch recordings already paired with an app workout in [from, to]: shown through the workout, not again. */
export function useWorkoutActivityIds(from: string, to: string) {
  const uid = useUserId();
  return useQuery({
    queryKey: ['workoutActivities', uid, from, to],
    enabled: !!uid,
    queryFn: async (): Promise<Set<string>> => {
      const { data, error } = await supabase
        .from('workouts')
        .select('activity_id')
        .eq('user_id', uid)
        .not('activity_id', 'is', null)
        .gte('started_at', `${from}T00:00:00`)
        .lte('started_at', `${to}T23:59:59`);
      if (error) throw error;
      return new Set(data.map((w) => w.activity_id as string));
    },
  });
}

/** The plan changed: refresh what shows it, and send planned runs to the watch straight away. */
function planChanged(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['plan'] });
  qc.invalidateQueries({ queryKey: ['planSession'] });
  requestPlanPush();
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
    onSuccess: () => planChanged(qc),
  });
}

/**
 * Move a session to another day (drag and drop on the calendar). The calendar updates at once;
 * a failed write puts it back. The next sync carries the move to intervals.icu and the watch.
 */
export function useMovePlanSession() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, date, position }: { id: string; date: string; position: number }) => {
      const { error } = await supabase
        .from('plan_sessions')
        .update({ date, position, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onMutate: async ({ id, date, position }) => {
      await qc.cancelQueries({ queryKey: ['plan', uid] });
      const before = qc.getQueriesData<PlanSession[]>({ queryKey: ['plan', uid] });
      for (const [key, rows] of before) {
        if (!rows) continue;
        const moved = rows.map((s) => (s.id === id ? { ...s, date, position } : s));
        qc.setQueryData(key, moved.sort((a, b) => a.date.localeCompare(b.date) || a.position - b.position));
      }
      return { before };
    },
    onError: (_e, _v, ctx) => {
      for (const [key, rows] of ctx?.before ?? []) qc.setQueryData(key, rows);
    },
    onSettled: () => planChanged(qc),
  });
}

export function useDeletePlanSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('plan_sessions').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => planChanged(qc),
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
    onSuccess: () => planChanged(qc),
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
      planChanged(qc);
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
