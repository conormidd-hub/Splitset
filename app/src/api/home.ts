import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { keys } from './keys';
import { useProfile, useUpdateProfile, type Profile } from './profile';
import { DEFAULT_GLANCE, RECOVERY, parseLayout as parseLayoutOf, sameLayout, type Layout } from '@/lib/homeLayout';
import { METRICS, type MetricId } from '@/lib/metrics';
import { useUserId } from '@/lib/session';
import { homeLayoutKey, storage } from '@/lib/storage';

/**
 * The Today screen's layout, Garmin Connect style: two In focus slots (a metric on the left; on
 * the right the recovery body figure, or another metric) above the At a glance tiles. It lives on
 * the profile row so every device shows the same home, with a copy in device storage so the
 * screen draws straight away and never flickers to the default while the profile loads.
 */
export type FocusId = MetricId | typeof RECOVERY;
export type HomeLayout = Layout<MetricId>;

export const DEFAULT_LAYOUT: HomeLayout = { v: 1, focus: 'readiness', focus2: RECOVERY, glance: DEFAULT_GLANCE as MetricId[] };

const isMetricId = (v: unknown): v is MetricId => typeof v === 'string' && v in METRICS;

/** A layout from storage or the profile, or null when it is not one (src/lib/homeLayout.ts). */
export const parseLayout = (json: unknown): HomeLayout | null => parseLayoutOf(json, isMetricId, DEFAULT_LAYOUT.glance);
export { RECOVERY, sameLayout };

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
