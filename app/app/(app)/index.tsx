import { useQueryClient } from '@tanstack/react-query';
import { parseISO, subDays } from 'date-fns';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { isRun, useRecentActivities } from '@/api/activities';
import { useConnection, useSyncRuns } from '@/api/connections';
import { useWorkouts } from '@/api/lifting';
import { planTypeLabel, usePlanRange } from '@/api/plan';
import { useProfile, useUnits } from '@/api/profile';
import { latest, rollingMean, useWellness } from '@/api/wellness';
import { PbButton } from '@/components/pbs/PbButton';
import { TrophyCabinet } from '@/components/pbs/TrophyCabinet';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { T } from '@/components/ui/T';
import { isoDate, longDate, relativeDay, shortTime, todayIso, weekStartIso } from '@/lib/dates';
import { formatDistance, formatDuration, formatDurationShort, formatPace, formatWeight, secPerKm } from '@/lib/units';
import { useActiveWorkout } from '@/stores/activeWorkout';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Today() {
  const units = useUnits();
  const qc = useQueryClient();
  const profile = useProfile();
  const connection = useConnection();
  const syncRuns = useSyncRuns(1);
  const recent = useRecentActivities(14);
  const wellness = useWellness(60);
  const today = todayIso();
  const plan = usePlanRange(today, today);
  const workouts = useWorkouts(1);
  const active = useActiveWorkout((s) => s.workout);
  const lastLift = workouts.data?.[0];

  const refreshing = recent.isFetching || wellness.isFetching;
  const refresh = () => {
    recent.refetch();
    wellness.refetch();
    workouts.refetch();
    qc.invalidateQueries({ queryKey: ['pbs'] });
    syncRuns.refetch();
    connection.refetch();
  };

  const week = useMemo(() => {
    const rows = recent.data ?? [];
    const start = weekStartIso();
    const lastStart = isoDate(subDays(parseISO(start), 7));
    const thisWeek = rows.filter((a) => a.start_time_local >= start);
    const lastWeek = rows.filter((a) => a.start_time_local >= lastStart && a.start_time_local < start);
    const km = (list: typeof rows) => list.filter((a) => isRun(a.type)).reduce((s, a) => s + (a.distance_m ?? 0), 0);
    const longest = thisWeek.filter((a) => isRun(a.type)).reduce((m, a) => Math.max(m, a.distance_m ?? 0), 0);
    return {
      runM: km(thisWeek),
      lastRunM: km(lastWeek),
      runs: thisWeek.filter((a) => isRun(a.type)).length,
      strength: thisWeek.filter((a) => a.type === 'WeightTraining' || a.type === 'Workout').length,
      minutes: thisWeek.reduce((s, a) => s + (a.moving_time_s ?? 0), 0),
      longestM: longest,
      last: rows.length ? rows[rows.length - 1] : null,
    };
  }, [recent.data]);

  const ready = useMemo(() => {
    const rows = wellness.data ?? [];
    const rhr = latest(rows, 'resting_hr');
    const hrv = latest(rows, 'hrv');
    const sleep = latest(rows, 'sleep_s');
    const ctl = latest(rows, 'ctl');
    const atl = latest(rows, 'atl');
    return {
      rhr, hrv, sleep, ctl, atl,
      rhr7: rollingMean(rows, 'resting_hr', 7),
      hrv7: rollingMean(rows, 'hrv', 7),
      sleep7: rollingMean(rows, 'sleep_s', 7),
    };
  }, [wellness.data]);

  const delta = (v: number | null | undefined, mean: number | null, lowerIsBetter: boolean) => {
    if (v == null || mean == null) return { text: undefined, tone: 'mut' as const };
    const d = v - mean;
    const good = lowerIsBetter ? d <= 0 : d >= 0;
    return { text: `${d >= 0 ? '+' : ''}${d.toFixed(0)} vs 7-day`, tone: Math.abs(d) < 2 ? ('mut' as const) : good ? ('pos' as const) : ('neg' as const) };
  };
  const rhrDelta = delta(ready.rhr?.value, ready.rhr7, true);
  const hrvDelta = delta(ready.hrv?.value, ready.hrv7, false);

  const lastSync = syncRuns.data?.[0];
  const conn = connection.data;
  const name = profile.data?.display_name ?? '';

  return (
    <Screen
      title={name ? `${greeting()}, ${name}` : greeting()}
      subtitle={longDate(new Date().toISOString())}
      right={<PbButton />}
      refreshing={refreshing}
      onRefresh={refresh}>
      {connection.isSuccess && !conn ? (
        <Card tone="accent" title="Connect intervals.icu" subtitle="Your runs and wellness arrive from there twice a day." onPress={() => router.push('/settings/connect')}>
          <Button title="Connect" small onPress={() => router.push('/settings/connect')} />
        </Card>
      ) : null}
      {conn?.status === 'auth_failed' ? (
        <Card tone="neg" title="intervals.icu sync is failing" subtitle={conn.last_error ?? 'The API key was rejected.'} onPress={() => router.push('/settings/connect')} />
      ) : null}

      <Card title="Today's plan" right={<Button title="Plan" variant="ghost" small onPress={() => router.push('/plan')} />}>
        {plan.data?.length ? (
          plan.data.map((s, i) => (
            <ListRow
              key={s.id}
              first={i === 0}
              title={s.title}
              subtitle={[planTypeLabel(s.type), s.subtype, s.target_distance_m ? formatDistance(s.target_distance_m, units, 1) : null].filter(Boolean).join(' · ')}
              badge={<Badge label={s.status} tone={s.status === 'done' ? 'pos' : s.status === 'skipped' ? 'neg' : 'mut'} />}
              onPress={() => router.push(`/plan/${s.id}`)}
            />
          ))
        ) : (
          <T tone="mut">Nothing planned today.{plan.isSuccess ? ' Rest day, or add a session from the Plan tab.' : ''}</T>
        )}
      </Card>

      <Card title="Readiness" subtitle={ready.rhr ? relativeDay(ready.rhr.date) : 'No wellness data yet'}>
        <Grid>
          <StatTile label="Resting HR" value={ready.rhr ? `${ready.rhr.value}` : '–'} sub={rhrDelta.text} subTone={rhrDelta.tone} />
          <StatTile label="HRV" value={ready.hrv ? `${Math.round(ready.hrv.value)}` : '–'} sub={hrvDelta.text} subTone={hrvDelta.tone} />
          <StatTile label="Sleep" value={ready.sleep ? `${(ready.sleep.value / 3600).toFixed(1)}h` : '–'} sub={ready.sleep7 ? `${(ready.sleep7 / 3600).toFixed(1)}h avg` : undefined} />
          <StatTile label="Fitness" value={ready.ctl ? ready.ctl.value.toFixed(0) : '–'} sub="CTL" />
          <StatTile label="Fatigue" value={ready.atl ? ready.atl.value.toFixed(0) : '–'} sub="ATL" />
          <StatTile label="Form" value={ready.ctl && ready.atl ? (ready.ctl.value - ready.atl.value).toFixed(0) : '–'} sub="CTL − ATL" />
        </Grid>
      </Card>

      <TrophyCabinet units={units} />

      <Card title="This week" subtitle="Monday to today">
        <Grid>
          <StatTile
            label="Running"
            value={formatDistance(week.runM, units, week.runM >= 100000 ? 0 : 1)}
            sub={`last week ${formatDistance(week.lastRunM, units, 0)}`}
          />
          <StatTile label="Sessions" value={`${week.runs + week.strength}`} sub={`${week.runs} runs · ${week.strength} gym`} />
          <StatTile label="Time" value={formatDurationShort(week.minutes)} sub={week.longestM ? `longest ${formatDistance(week.longestM, units)}` : undefined} />
        </Grid>
      </Card>

      {week.last ? (
        <Card title="Latest activity">
          <ListRow
            first
            title={week.last.name ?? week.last.type}
            subtitle={`${relativeDay(week.last.start_time_local)} · ${shortTime(week.last.start_time_local)}`}
            badge={<Badge label={week.last.type} />}
            value={week.last.distance_m ? formatDistance(week.last.distance_m, units) : formatDuration(week.last.moving_time_s)}
            valueSub={week.last.distance_m ? formatPace(secPerKm(week.last.distance_m, week.last.moving_time_s), units) : undefined}
            onPress={() => router.push(`/run/${week.last!.id}`)}
          />
        </Card>
      ) : null}

      <Card title="Lifting" right={<Button title="Lift" variant="ghost" small onPress={() => router.push('/lift')} />}>
        {active ? (
          <ListRow
            first
            title="Workout in progress"
            subtitle={`${active.name} · started ${shortTime(active.startedAt)} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}`}
            badge={<Badge label="live" tone="accent" />}
            onPress={() => router.push('/lift/workout')}
          />
        ) : lastLift ? (
          <ListRow
            first
            title={lastLift.name ?? 'Workout'}
            subtitle={`${relativeDay(lastLift.started_at)} · ${formatDurationShort(lastLift.duration_s)} · ${lastLift.sets_completed ?? 0} sets`}
            value={lastLift.volume_kg ? formatWeight(lastLift.volume_kg, units, 0) : undefined}
            valueSub={lastLift.volume_kg ? 'volume' : undefined}
            onPress={() => router.push(`/lift/history/${lastLift.id}`)}
          />
        ) : (
          <View style={{ gap: 12 }}>
            <T tone="mut">No workouts logged yet. Routines, sets, the rest timer and records live in the Lift tab.</T>
            <Button title="Start a workout" variant="secondary" small onPress={() => router.push('/lift')} />
          </View>
        )}
      </Card>

      {lastSync ? (
        <T variant="small" tone="mut" align="center">
          Last sync {relativeDay(lastSync.started_at)} {shortTime(lastSync.started_at)} · {lastSync.status}
          {lastSync.activities_fetched ? ` · ${lastSync.activities_fetched} activities` : ''}
        </T>
      ) : null}
    </Screen>
  );
}
