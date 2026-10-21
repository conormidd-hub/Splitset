import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useExercises, useRecords } from '@/api/lifting';
import { useLiftPbs, useRunPbs, type Period } from '@/api/pbs';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { formatLiftPb, formatRunPb, isNewThisMonth, liftMetricOrder, liftMetricShort, PERIODS, RUN_PBS } from '@/lib/pbs';
import type { Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const TOP_LIFTS = 5;

/** Today's PB board: running bests as tiles, the most recently trained lifts as rows. */
export function TrophyCabinet({ units }: { units: Units }) {
  const { palette } = useTheme();
  const [period, setPeriod] = useState<Period>('all');
  const runs = useRunPbs();
  const lifts = useLiftPbs();
  const exercises = useExercises();
  const records = useRecords();

  const liftList = useMemo(() => {
    const byId = new Map((exercises.data ?? []).map((e) => [e.id, e]));
    const lastDone = new Map((records.data ?? []).map((r) => [r.exercise_id, r.last_completed_at ?? '']));
    return [...(lifts.data?.entries() ?? [])]
      // the load mode says what the weight means: an assisted lift has no 3RM, a bodyweight one's 1RM includes bodyweight
      .map(([id, byMetric]) => ({ id, name: byId.get(id)?.name ?? 'Exercise', loadMode: byId.get(id)?.load_mode ?? null, byMetric, last: lastDone.get(id) ?? '' }))
      .sort((a, b) => b.last.localeCompare(a.last))
      .slice(0, TOP_LIFTS);
  }, [lifts.data, exercises.data, records.data]);

  const fresh = useMemo(() => {
    let n = 0;
    for (const p of runs.data?.values() ?? []) if (isNewThisMonth(p.all?.start_time_local)) n++;
    for (const byMetric of lifts.data?.values() ?? []) {
      for (const p of byMetric.values()) if (isNewThisMonth(p.all?.achieved_at)) n++;
    }
    return n;
  }, [runs.data, lifts.data]);

  const runTiles = RUN_PBS.filter(({ key }) => runs.data?.get(key)?.all);
  const empty = !runTiles.length && !liftList.length;

  return (
    <Card
      title="🏆 Trophy cabinet"
      subtitle={fresh ? `${fresh} new PB${fresh === 1 ? '' : 's'} this month` : 'Your personal bests'}
      right={<Button title="All PBs" variant="ghost" small onPress={() => router.push('/pbs')} />}>
      {empty ? (
        <T tone="mut">PBs fill in by themselves: runs from your watch, lifts as you tick sets.</T>
      ) : (
        <View style={{ gap: space.md }}>
          <Segmented options={PERIODS} value={period} onChange={setPeriod} />

          {runTiles.length ? (
            <View style={{ gap: space.sm }}>
              <T variant="label" tone="mut">Running</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {runTiles.map(({ key, label }) => {
                  const p = runs.data?.get(key);
                  const row = p?.[period];
                  const { value, sub } = formatRunPb(row, units);
                  const isNew = isNewThisMonth(p?.all?.start_time_local);
                  return (
                    <Pressable
                      key={key}
                      onPress={() => row?.activity_id && router.push(`/run/${row.activity_id}`)}
                      style={{
                        flexGrow: 1, flexBasis: '30%', minWidth: 92, padding: space.sm, borderRadius: radius.md,
                        backgroundColor: palette.surface2, borderWidth: 1, borderColor: isNew ? palette.amber : 'transparent',
                      }}>
                      <T variant="label" tone="mut">{label}</T>
                      <T variant="h3" tone={value === '–' ? 'mut' : 'ink'} style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
                      <T variant="tiny" tone="mut" style={{ fontVariant: ['tabular-nums'] }}>{isNew ? 'new this month' : sub ?? ' '}</T>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {liftList.length ? (
            <View>
              <T variant="label" tone="mut" style={{ marginBottom: 2 }}>Lifting</T>
              {liftList.map((l, i) => {
                const metrics = liftMetricOrder(l.loadMode).filter((k) => l.byMetric.has(k)).slice(0, 2);
                const isNew = metrics.some((k) => isNewThisMonth(l.byMetric.get(k)?.all?.achieved_at));
                return (
                  <Pressable
                    key={l.id}
                    onPress={() => router.push(`/lift/exercises/${l.id}`)}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
                    <View style={{ flex: 1 }}>
                      <T weight="600" numberOfLines={1}>{l.name}</T>
                      {isNew ? <T variant="tiny" weight="700" style={{ color: palette.amber }}>NEW PB this month</T> : null}
                    </View>
                    {metrics.map((k) => {
                      const cell = l.byMetric.get(k)?.[period];
                      return (
                        <View key={k} style={{ alignItems: 'flex-end', marginLeft: space.md, minWidth: 64 }}>
                          <T variant="tiny" tone="mut">{liftMetricShort(k, l.loadMode)}</T>
                          <T weight="700" style={{ fontVariant: ['tabular-nums'] }}>{formatLiftPb(k, cell?.value, units)}</T>
                          {cell?.source === 'manual' ? <T variant="tiny" tone="accent" weight="700">manual</T> : null}
                        </View>
                      );
                    })}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      )}
    </Card>
  );
}
