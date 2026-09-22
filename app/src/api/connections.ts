import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { keys } from './keys';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables } from '@/types/database';

export type Connection = Tables<'intervals_connections'>;
export type SyncRun = Tables<'sync_runs'>;

export function useConnection() {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.connection(uid),
    enabled: !!uid,
    queryFn: async (): Promise<Connection | null> => {
      const { data, error } = await supabase
        .from('intervals_connections')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useSyncRuns(limit = 5) {
  const uid = useUserId();
  return useQuery({
    queryKey: [...keys.syncRuns(uid), limit],
    enabled: !!uid,
    queryFn: async (): Promise<SyncRun[]> => {
      const { data, error } = await supabase
        .from('sync_runs')
        .select('*')
        .eq('user_id', uid)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },
  });
}

export function useConnectIntervals() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { athleteId: string; apiKey: string; oldest?: string }) => {
      const { error } = await supabase.rpc('connect_intervals', {
        p_athlete_id: input.athleteId.trim(),
        p_api_key: input.apiKey.trim(),
        ...(input.oldest ? { p_oldest: input.oldest } : {}),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.connection(uid) });
      qc.invalidateQueries({ queryKey: keys.syncRuns(uid) });
    },
  });
}

export function useDisconnectIntervals() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('disconnect_intervals');
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connection(uid) }),
  });
}

export function usePauseConnection() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paused: boolean) => {
      const { error } = await supabase
        .from('intervals_connections')
        .update({ status: paused ? 'paused' : 'active' })
        .eq('user_id', uid);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connection(uid) }),
  });
}
