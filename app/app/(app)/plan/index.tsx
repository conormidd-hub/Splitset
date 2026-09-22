import { addDays, format, parseISO } from 'date-fns';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { isRun, typeLabel, type ActivityListRow } from '@/api/activities';
import { planTypeLabel, useActivitiesBetween, usePlanRange, type PlanSession } from '@/api/plan';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { isoDate, todayIso, weekStartIso } from '@/lib/dates';
import { formatDistance, formatDurationShort, formatPace, secPerKm } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const STATUS_TONE = { planned: 'mut', done: 'pos', skipped: 'neg' } as const;

export default function PlanWeek() {
  const { palette } = useTheme();
  const units = useUnits();
  const [weekStart, setWeekStart] = useState(weekStartIso());
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => isoDate(addDays(parseISO(weekStart), i))), [weekStart]);
  const weekEnd = days[6];
  const today = todayIso();

  const plan = usePlanRange(weekStart, weekEnd);
  const actuals = useActivitiesBetween(weekStart, weekEnd);
  const linkedIds = useMemo(() => new Set((plan.data ?? []).map((s) => s.activity_id).filter(Boolean)), [plan.data]);

  const byDay = useMemo(() => {
    const m = new Map<string, { sessions: PlanSession[]; extras: ActivityListRow[] }>();
    for (const d of days) m.set(d, { sessions: [], extras: [] });
    for (const s of plan.data ?? []) m.get(s.date)?.sessions.push(s);
    for (const a of actuals.data ?? []) {
      if (linkedIds.has(a.id)) continue;
      m.get(a.start_time_local.slice(0, 10))?.extras.push(a);
    }
    return m;
  }, [days, plan.data, actuals.data, linkedIds]);

  const shift = (weeks: number) => setWeekStart(isoDate(addDays(parseISO(weekStart), weeks * 7)));
  const plannedKm = (plan.data ?? []).filter((s) => s.type === 'run').reduce((t, s) => t + (s.target_distance_m ?? 0), 0);
  const doneCount = (plan.data ?? []).filter((s) => s.status === 'done').length;

  return (
    <Screen
      title={format(parseISO(weekStart), 'd MMM') + ' – ' + format(parseISO(weekEnd), 'd MMM')}
      subtitle="Plan"
      refreshing={plan.isFetching}
      onRefresh={() => { plan.refetch(); actuals.refetch(); }}
      right={
        <View style={{ flexDirection: 'row', gap: space.xs }}>
          <Button title="‹" variant="secondary" small onPress={() => shift(-1)} />
          <Button title="Today" variant="secondary" small onPress={() => setWeekStart(weekStartIso())} />
          <Button title="›" variant="secondary" small onPress={() => shift(1)} />
        </View>
      }>
      {/* day strip */}
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {days.map((d) => {
          const info = byDay.get(d);
          const isToday = d === today;
          return (
            <Pressable
              key={d}
              onPress={() => router.push(`/plan/new?date=${d}`)}
              style={{ flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: isToday ? palette.accentSoft : palette.surface, borderWidth: 1, borderColor: isToday ? palette.accentLine : palette.hair }}>
              <T variant="tiny" tone="mut">{format(parseISO(d), 'EEE')}</T>
              <T variant="h3" tone={isToday ? 'accent' : 'ink'}>{format(parseISO(d), 'd')}</T>
              <View style={{ flexDirection: 'row', gap: 3, marginTop: 4, minHeight: 6 }}>
                {info?.sessions.map((s) => (
                  <View key={s.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: s.status === 'done' ? palette.pos : s.status === 'skipped' ? palette.neg : palette.mut }} />
                ))}
                {info?.extras.map((a) => (
                  <View key={a.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.blue, opacity: 0.6 }} />
                ))}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T variant="small" tone="mut">{plan.data?.length ?? 0} planned · {doneCount} done{plannedKm ? ` · ${formatDistance(plannedKm, units, 0)} planned running` : ''}</T>
        <Pressable onPress={() => router.push(`/plan/new?date=${today}`)}><T variant="small" tone="accent" weight="600">+ Add session</T></Pressable>
      </View>

      {plan.isLoading ? <Loading /> : null}

      {days.map((d) => {
        const info = byDay.get(d)!;
        if (!info.sessions.length && !info.extras.length) return null;
        const past = d < today;
        return (
          <Card key={d} title={d === today ? 'Today' : format(parseISO(d), 'EEEE d MMMM')} subtitle={past && info.sessions.some((s) => s.status === 'planned') ? 'has unfinished sessions' : undefined}>
            {info.sessions.map((s, i) => (
              <Pressable key={s.id} onPress={() => router.push(`/plan/${s.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
                <Badge label={planTypeLabel(s.type)} tone={s.type === 'run' ? 'accent' : 'mut'} />
                <View style={{ flex: 1 }}>
                  <T variant="h3" numberOfLines={1}>{s.title}</T>
                  <T variant="small" tone="mut">
                    {[s.subtype, s.target_distance_m ? formatDistance(s.target_distance_m, units, 1) : null, s.target_seconds ? formatDurationShort(s.target_seconds) : null].filter(Boolean).join(' · ') || planTypeLabel(s.type)}
                  </T>
                </View>
                <Badge label={s.status === 'planned' && past ? 'missed' : s.status} tone={s.status === 'planned' && past ? 'neg' : STATUS_TONE[s.status as keyof typeof STATUS_TONE]} />
              </Pressable>
            ))}
            {info.extras.map((a, i) => (
              <Pressable key={a.id} onPress={() => router.push(`/run/${a.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderTopWidth: i || info.sessions.length ? 1 : 0, borderTopColor: palette.hair, opacity: 0.8 }}>
                <Badge label={typeLabel(a.type)} />
                <View style={{ flex: 1 }}>
                  <T numberOfLines={1}>{a.name ?? typeLabel(a.type)}</T>
                  <T variant="small" tone="mut">
                    unplanned · {a.distance_m ? `${formatDistance(a.distance_m, units)}${isRun(a.type) ? ` · ${formatPace(secPerKm(a.distance_m, a.moving_time_s), units)}` : ''}` : formatDurationShort(a.moving_time_s)}
                  </T>
                </View>
              </Pressable>
            ))}
          </Card>
        );
      })}

      {!plan.isLoading && !(plan.data?.length) && !(actuals.data?.length) ? (
        <Card title="An empty week" subtitle="Tap a day above or Add session to plan it. Runs and gym sessions link to what you actually do.">
          <Button title="Add a session" small onPress={() => router.push(`/plan/new?date=${today}`)} />
        </Card>
      ) : null}
    </Screen>
  );
}
