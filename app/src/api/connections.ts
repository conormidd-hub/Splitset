import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

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

/** Send the plan's runs to intervals.icu (and so Garmin) at each sync. */
export function useSetPushPlan() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (on: boolean) => {
      const { error } = await supabase.from('intervals_connections').update({ push_plan: on }).eq('user_id', uid);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connection(uid) }),
  });
}

// ---------------------------------------------------------------- is the key right?

export type VerifyState =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'pending'; check: number }
  | { state: 'ok'; athlete: VerifiedAthlete }
  | { state: 'failed'; message: string; httpStatus?: number };

/** What intervals.icu tells us about the athlete once the key checks out. */
export type VerifiedAthlete = {
  athleteId: string | null;
  name: string | null;
  timezone: string | null;
  sex: 'male' | 'female' | null;
  dateOfBirth: string | null;
  /** Garmin is connected to intervals.icu (null when intervals.icu didn't say). */
  garminHealth: boolean | null;
  /** "Download wellness data" is ticked under Garmin there, and which fields. */
  garminWellness: boolean | null;
  garminWellnessKeys: string[];
};

type VerifyRequest = { status: string; check?: number };
type VerifyStatus = {
  state: string; name?: string | null; timezone?: string | null; athlete_id?: string | null; sex?: string | null;
  date_of_birth?: string | null; garmin_health?: boolean | null; garmin_wellness?: boolean | null;
  garmin_wellness_keys?: unknown; http_status?: number; message?: string;
};

const VERIFY_POLL_MS = 1500;
const VERIFY_GIVE_UP_MS = 45_000;

const VERIFY_WHY_NOT: Record<string, string> = {
  not_connected: 'Paste your API key first.',
  bad_key: 'That is too short to be an API key. Copy the whole key from intervals.icu.',
};

/**
 * Ask intervals.icu whether a key works, through public.verify_intervals_key: a pasted key
 * (the wizard, before anything is stored) or, with no argument, the one already in Vault. The
 * database makes the call and the app polls for the answer, which names the athlete, their id
 * and time zone, and whether Garmin wellness is switched on over there.
 */
export function useVerifyConnection() {
  const uid = useUserId();
  const qc = useQueryClient();
  const [state, setState] = useState<VerifyState>({ state: 'idle' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const set = (next: VerifyState) => { if (alive.current) setState(next); };

  const start = useCallback(async (apiKey?: string) => {
    set({ state: 'sending' });
    try {
      const key = apiKey?.trim();
      const { data, error } = await supabase.rpc('verify_intervals_key', key ? { p_api_key: key } : {});
      if (error) throw error;
      const r = (data as VerifyRequest | null) ?? { status: 'unknown' };
      if (r.status !== 'sent' || r.check == null) {
        set({ state: 'failed', message: VERIFY_WHY_NOT[r.status] ?? (r.status === 'too_soon' ? 'Checking already. Give it a few seconds.' : `Couldn't check the key (${r.status}).`) });
        return;
      }
      set({ state: 'pending', check: r.check });
      const began = Date.now();
      // poll until pg_net has intervals.icu's answer
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
        if (!alive.current) return;
        const { data: st, error: err } = await supabase.rpc('intervals_verify_status', { p_check: r.check });
        if (err) throw err;
        const s = (st as VerifyStatus | null) ?? { state: 'unknown' };
        if (s.state === 'ok') {
          qc.invalidateQueries({ queryKey: keys.connection(uid) });
          set({
            state: 'ok',
            athlete: {
              athleteId: s.athlete_id ?? null,
              name: s.name ?? null,
              timezone: s.timezone ?? null,
              sex: s.sex === 'male' || s.sex === 'female' ? s.sex : null,
              dateOfBirth: s.date_of_birth ?? null,
              garminHealth: typeof s.garmin_health === 'boolean' ? s.garmin_health : null,
              garminWellness: typeof s.garmin_wellness === 'boolean' ? s.garmin_wellness : null,
              garminWellnessKeys: Array.isArray(s.garmin_wellness_keys) ? s.garmin_wellness_keys.filter((k): k is string => typeof k === 'string') : [],
            },
          });
          return;
        }
        if (s.state === 'failed') {
          qc.invalidateQueries({ queryKey: keys.connection(uid) });
          set({ state: 'failed', message: s.message ?? 'intervals.icu turned the key down.', httpStatus: s.http_status });
          return;
        }
        if (s.state === 'unknown') {
          set({ state: 'failed', message: 'Lost track of the check. Try again.' });
          return;
        }
        if (Date.now() - began > VERIFY_GIVE_UP_MS) {
          set({ state: 'failed', message: 'intervals.icu is taking too long to answer. Your key is saved; try the check again in a minute.' });
          return;
        }
      }
    } catch (e) {
      set({ state: 'failed', message: e instanceof Error ? e.message : 'Could not check the key.' });
    }
  }, [qc, uid]);

  const reset = useCallback(() => set({ state: 'idle' }), []);
  return { state, start, reset };
}
