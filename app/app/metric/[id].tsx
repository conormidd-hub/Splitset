import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';

import { useRecentActivities } from '@/api/activities';
import { useWorkouts } from '@/api/lifting';
import { useLiftPbs, useRunPbs } from '@/api/pbs';
import { useProfile, useUnits } from '@/api/profile';
import { useWellness } from '@/api/wellness';
import { HrvStatusDetail } from '@/components/metrics/HrvStatusDetail';
import { MetricDetail } from '@/components/metrics/MetricDetail';
import { ReadinessDetail } from '@/components/metrics/ReadinessDetail';
import { TrainingStatusDetail } from '@/components/metrics/TrainingStatusDetail';
import { Vo2maxDetail } from '@/components/metrics/Vo2maxDetail';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, Loading } from '@/components/ui/States';
import { todayIso } from '@/lib/dates';
import { isMetricId, METRICS, RANGES, snapshot, type MetricInputs, type Range } from '@/lib/metrics';

const isRange = (v: unknown): v is Range => RANGES.some((r) => r.value === v);

/**
 * One metric, opened from an In focus or At a glance tile: the daily timeline, then a week, a
 * month and a year of it. A year plus a warm-up of history is fetched once and every view is
 * cut from it, so the slicer never waits on the network.
 */
export default function MetricPage() {
  const { id, range: rangeParam } = useLocalSearchParams<{ id: string; range?: string }>();
  const metricId = isMetricId(id) ? id : null;
  const def = metricId ? METRICS[metricId] : null;
  // the range lives in the URL, so back and reload land on the same view
  const range: Range = isRange(rangeParam) ? rangeParam : 'week';
  const onRange = useCallback((r: Range) => router.setParams({ range: r }), []);

  const wellness = useWellness(400);
  const activities = useRecentActivities(400);
  const workouts = useWorkouts(200);
  const runPbs = useRunPbs();
  const liftPbs = useLiftPbs();
  const profile = useProfile();
  const units = useUnits();
  const today = todayIso();
  const inputs = useMemo<MetricInputs>(
    () => ({
      wellness: wellness.data ?? [],
      activities: activities.data ?? [],
      workouts: workouts.data ?? [],
      runPbs: runPbs.data,
      liftPbs: liftPbs.data,
      profile: profile.data ?? null,
      units,
      today,
    }),
    [wellness.data, activities.data, workouts.data, runPbs.data, liftPbs.data, profile.data, units, today],
  );
  const loading = wellness.isLoading || activities.isLoading;

  // two tiles are links rather than pages: the latest activity is its run, PBs are the cabinet
  const link = metricId === 'pbs' ? '/pbs' : metricId === 'last_activity' && !loading ? snapshot('last_activity', inputs).href ?? null : null;
  useEffect(() => {
    if (link) router.replace(link as Href);
  }, [link]);

  // the page sits above the tabs: going "home" is going back, not opening a second Today
  const goHome = () => { if (router.canGoBack()) router.back(); else router.replace('/'); };
  const goRuns = () => { if (router.canGoBack()) router.dismissTo('/run'); else router.replace('/run'); };

  const refreshing = wellness.isFetching || activities.isFetching;
  const refresh = () => {
    wellness.refetch();
    activities.refetch();
    workouts.refetch();
    runPbs.refetch();
    liftPbs.refetch();
  };

  let body: ReactNode;
  if (!metricId || !def) {
    body = <EmptyState title="Unknown metric" body="Nothing on the home screen goes by that name." action={{ title: 'Go home', onPress: goHome }} />;
  } else if (loading || link) {
    body = <Loading label={`Loading ${def.label.toLowerCase()}`} />;
  } else if (metricId === 'last_activity') {
    body = <EmptyState title="Nothing synced yet" body="Your latest activity opens here once one has arrived from intervals.icu." action={{ title: 'Runs', onPress: goRuns }} />;
  } else if (metricId === 'vo2max' || metricId === 'race_predictor') {
    body = <Vo2maxDetail inputs={inputs} range={range} onRange={onRange} focusRaces={metricId === 'race_predictor'} />;
  } else if (metricId === 'readiness') {
    body = <ReadinessDetail inputs={inputs} range={range} onRange={onRange} />;
  } else if (metricId === 'training_status') {
    body = <TrainingStatusDetail inputs={inputs} />;
  } else if (metricId === 'hrv_status') {
    body = <HrvStatusDetail inputs={inputs} range={range} onRange={onRange} />;
  } else {
    body = <MetricDetail id={metricId} inputs={inputs} range={range} onRange={onRange} />;
  }

  return (
    <>
      <Stack.Screen options={{ title: def?.label ?? 'Metric' }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        {body}
      </Screen>
    </>
  );
}
