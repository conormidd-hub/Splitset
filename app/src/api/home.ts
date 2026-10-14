import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { keys } from './keys';
import { useProfile, useUpdateProfile, type Profile } from './profile';
import { METRICS, type MetricId } from '@/lib/metrics';
import { useUserId } from '@/lib/session';
import { homeLayoutKey, storage } from '@/lib/storage';

/**
 * The Today screen's layout, Garmin Connect style: one In focus metric above the At a glance
 * tiles. It lives on the profile row so every device shows the same home, with a copy in device
 * storage so the screen draws straight away and never flickers to the default while the profile
 * loads.
 */
export type HomeLayout = { v: 1; focus: MetricId | null; glance: MetricId[] };

export const DEFAULT_LAYOUT: HomeLayout = {
  v: 1,
  focus: 'readiness',
  glance: ['resting_hr', 'hrv', 'sleep', 'training_status', 'vo2max', 'steps', 'weekly_distance', 'fitness'],
};

const isMetricId = (v: unknown): v is MetricId => typeof v === 'string' && v in METRICS;

/** A layout from storage or the profile, or null when it is not one. Unknown ids are dropped, repeats folded. */
export function parseLayout(json: unknown): HomeLayout | null {
  const raw = typeof json === 'string' ? safeParse(json) : json;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { v?: unknown; focus?: unknown; glance?: unknown };
  if (o.v !== 1 || !Array.isArray(o.glance)) return null;
  const glance: MetricId[] = [];
  for (const id of o.glance) if (isMetricId(id) && !glance.includes(id)) glance.push(id);
  return { v: 1, focus: isMetricId(o.focus) ? o.focus : null, glance };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function sameLayout(a: HomeLayout, b: HomeLayout): boolean {
  return a.focus === b.focus && a.glance.length === b.glance.length && a.glance.every((id, i) => id === b.glance[i]);
}

export function useHomeLayout() {
  const uid = useUserId();
  const qc = useQueryClient();
  const profile = useProfile();
  const update = useUpdateProfile();
  // the device copy, tagged with whose it is, so a sign-out and sign-in never shows the last account's
  const [cachedFor, setCachedFor] = useState<{ uid: string; layout: HomeLayout | null } | undefined>(undefined);
  const cached = cachedFor?.uid === uid ? cachedFor.layout : undefined;
  // the choice being saved, so a profile refetch racing the write can't flick the screen back
  const [pending, setPending] = useState<HomeLayout | null>(null);

  useEffect(() => {
    let mounted = true;
    storage.getItem(homeLayoutKey(uid))
      .then((v) => { if (mounted) setCachedFor({ uid, layout: parseLayout(v) }); })
      .catch(() => { if (mounted) setCachedFor({ uid, layout: null }); });
    return () => { mounted = false; };
  }, [uid]);

  const fromProfile = useMemo(() => (profile.data ? parseLayout(profile.data.home_layout) : null), [profile.data]);

  // the device copy only speaks until the profile has answered: once it has, a null there means
  // the default, not whatever the last account on this phone chose
  const layout: HomeLayout = pending ?? (profile.data ? fromProfile ?? DEFAULT_LAYOUT : cached ?? DEFAULT_LAYOUT);

  const { mutate } = update;
  const save = useCallback((next: HomeLayout) => {
    setPending(next);
    storage.setItem(homeLayoutKey(uid), JSON.stringify(next)).catch(() => {});
    // the home screen reads the profile query: update it now so nothing waits on the network, and
    // stop a refetch already in flight from landing an older row on top of it
    const key = keys.profile(uid);
    const stamp = (p: Profile | undefined) => (p ? { ...p, home_layout: next } : p);
    void qc.cancelQueries({ queryKey: key });
    qc.setQueryData<Profile>(key, stamp);
    mutate({ home_layout: next }, {
      onSettled: () => setPending((cur) => {
        if (cur !== next) return cur;
        qc.setQueryData<Profile>(key, stamp);
        return null;
      }),
    });
  }, [qc, uid, mutate]);

  return {
    layout,
    loaded: cached !== undefined || !!profile.data,
    save,
    saving: update.isPending,
    error: update.error,
  };
}
