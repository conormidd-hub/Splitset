import { create } from 'zustand';

import { queryClient } from '@/lib/query';
import { supabase } from '@/lib/supabase';

/**
 * Starting the sync job from the app. public.request_sync dispatches the GitHub Actions sync
 * workflow for the signed-in athlete; nothing here holds a token. Two kinds:
 *   sync  "Sync now": the full sync (activities, wellness, details, links, and the plan push)
 *   push  after a plan change: only send planned runs to intervals.icu, and so the watch
 */

type Kind = 'sync' | 'push';
type RequestResult = { status: string; request?: number };
type RequestStatus = { state: 'pending' | 'ok' | 'failed' | 'unknown'; http_status?: number; message?: string };

async function requestSync(kind: Kind): Promise<RequestResult> {
  const { data, error } = await supabase.rpc('request_sync', { p_kind: kind });
  if (error) throw error;
  return (data as RequestResult | null) ?? { status: 'unknown' };
}

const WHY_NOT: Record<string, string> = {
  too_soon: 'A sync started a moment ago.',
  not_configured: 'Sync now needs the GitHub token set up in Supabase Vault (see the README).',
  paused: 'intervals.icu sync is paused: resume it in Settings.',
  auth_failed: 'intervals.icu turned down the API key: reconnect in Settings.',
  disconnected: 'Connect intervals.icu first.',
  not_connected: 'Connect intervals.icu first.',
};

// ---------------------------------------------------------------- instant plan push

/** Whether recently changed plan sessions may still be on their way to the watch. */
export const usePlanPush = create<{ polling: boolean }>()(() => ({ polling: false }));

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * After a plan change: send the athlete's planned runs to intervals.icu now. Debounced, so a few
 * quick edits become one run; the server ignores it when "Planned runs on your watch" is off.
 * If it doesn't go through, the next scheduled sync sends the change anyway.
 */
export function requestPlanPush(delayMs = 1500, attempt = 0): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const r = await requestSync('push');
      if (r.status === 'too_soon' && attempt < 3) return requestPlanPush(6000, attempt + 1);
      if (r.status !== 'sent') return;
      // watch the calendar for the change to land (a GitHub run takes about half a minute)
      usePlanPush.setState({ polling: true });
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => usePlanPush.setState({ polling: false }), 3 * 60_000);
    } catch {
      // offline or signed out: the scheduled sync catches up
    }
  }, delayMs);
}

// ---------------------------------------------------------------- Sync now

type Phase = 'idle' | 'starting' | 'waiting' | 'running' | 'done' | 'failed';
type SyncNow = { phase: Phase; message: string | null; start: () => Promise<void> };

const POLL_MS = 3000;
const GIVE_UP_MS = 6 * 60_000;
let syncPoll: ReturnType<typeof setInterval> | null = null;

/** One Sync now at a time, shared by every screen that shows the button. */
export const useSyncNow = create<SyncNow>()((set, get) => ({
  phase: 'idle',
  message: null,
  start: async () => {
    if (['starting', 'waiting', 'running'].includes(get().phase)) return;
    set({ phase: 'starting', message: null });
    try {
      // the run we're waiting for is the first one newer than this
      const { data: latest } = await supabase.from('sync_runs').select('id').order('id', { ascending: false }).limit(1);
      const baseline = latest?.[0]?.id ?? 0;
      const r = await requestSync('sync');
      if (r.status !== 'sent' || r.request == null) {
        set({ phase: 'idle', message: WHY_NOT[r.status] ?? `Couldn't start a sync (${r.status}).` });
        return;
      }
      set({ phase: 'waiting', message: null });
      const began = Date.now();
      if (syncPoll) clearInterval(syncPoll);
      syncPoll = setInterval(async () => {
        const stop = (phase: Phase, message: string | null) => {
          if (syncPoll) clearInterval(syncPoll);
          syncPoll = null;
          set({ phase, message });
        };
        try {
          const { data: sent } = await supabase.rpc('sync_request_status', { p_request: r.request! });
          const s = sent as RequestStatus | null;
          if (s?.state === 'failed') {
            return stop('failed', `GitHub didn't start the sync (${s.http_status}${s.message ? `: ${s.message}` : ''}).`);
          }
          const { data: runs } = await supabase
            .from('sync_runs')
            .select('id, status, activities_fetched, wellness_days')
            .gt('id', baseline)
            .order('id', { ascending: false })
            .limit(1);
          const run = runs?.[0];
          if (run?.status === 'running') {
            if (get().phase !== 'running') set({ phase: 'running' });
          } else if (run) {
            await queryClient.invalidateQueries();
            return stop(run.status === 'ok' ? 'done' : 'failed', run.status === 'ok'
              ? `Synced: ${run.activities_fetched} activities, ${run.wellness_days} wellness days.`
              : `The sync finished with ${run.status.replace('_', ' ')}: see Settings, intervals.icu.`);
          }
          if (Date.now() - began > GIVE_UP_MS) {
            stop('idle', 'Still waiting on GitHub: the run will show under Recent syncs when it starts.');
          }
        } catch {
          // a dropped poll; the next one tries again
        }
      }, POLL_MS);
    } catch (e) {
      set({ phase: 'failed', message: e instanceof Error ? e.message : 'Could not start a sync.' });
    }
  },
}));
