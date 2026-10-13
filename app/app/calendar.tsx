import { addDays, format, parseISO } from 'date-fns';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { usePlanRange, type PlanSession } from '@/api/plan';
import { useUnits } from '@/api/profile';
import { useTrainingSessions } from '@/api/streaks';
import { MonthCalendar } from '@/components/calendar/MonthCalendar';
import { StreakHeat } from '@/components/home/StreakHeat';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { isoDate, relativeDay, todayIso, weekStartIso } from '@/lib/dates';
import { ICONS } from '@/lib/icons';
import { monthGrid, sessionsByDay, sessionsFrom, sessionsLast7, weekStreak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** The plan tab shows eight weeks ahead; the month view goes no further. */
const WEEKS_AHEAD = 8;

type Month = { year: number; month0: number };

const monthOf = (iso: string): Month => ({ year: parseInt(iso.slice(0, 4), 10), month0: parseInt(iso.slice(5, 7), 10) - 1 });
const monthKey = (m: Month) => `${m.year}-${String(m.month0 + 1).padStart(2, '0')}`;
const shift = (m: Month, by: number): Month => {
  const d = new Date(m.year, m.month0 + by, 1);
  return { year: d.getFullYear(), month0: d.getMonth() };
};

/**
 * The month view of the same days the Plan tab shows week by week, with the streak on top:
 * weeks in a row, how hot the last seven days burn, what keeps this week alive, then one month
 * at a time of what was done and what is planned. Tap a day for its workouts and the way into
 * the plan.
 */
export default function CalendarPage() {
  const { palette } = useTheme();
  const units = useUnits();
  const today = todayIso();
  const params = useLocalSearchParams<{ month?: string; date?: string }>();
  const [cursor, setCursor] = useState<Month>(() => (params.month && /^\d{4}-\d{2}$/.test(params.month) ? monthOf(`${params.month}-01`) : monthOf(today)));
  const [selected, setSelected] = useState<string | null>(params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null);

  const training = useTrainingSessions();
  const sessions = useMemo(
    () => sessionsFrom(training.data?.activities ?? [], training.data?.workouts ?? [], units),
    [training.data, units],
  );
  const byDay = useMemo(() => sessionsByDay(sessions), [sessions]);
  const streak = weekStreak(sessions, today, training.data?.oldest);
  const last7 = sessionsLast7(sessions, today);

  // the plan for the days on screen, and for the rest of this week
  const grid = monthGrid(cursor.year, cursor.month0);
  const from = grid[0][0].date;
  const to = grid[grid.length - 1][6].date;
  const plan = usePlanRange(from, to);
  const planByDay = useMemo(() => {
    const m = new Map<string, PlanSession[]>();
    for (const p of plan.data ?? []) m.set(p.date, [...(m.get(p.date) ?? []), p]);
    return m;
  }, [plan.data]);
  const thisWeek = weekStartIso(parseISO(today));
  const weekEnd = isoDate(addDays(parseISO(thisWeek), 6));
  const rest = usePlanRange(today, weekEnd);
  const keeper = (rest.data ?? []).find((p) => p.status === 'planned' && p.type !== 'rest');

  // how far the arrows go: back to the oldest workout we hold, forward to the plan's horizon
  const earliest = monthKey(monthOf(sessions[0]?.date ?? training.data?.oldest ?? today));
  const latest = monthKey(monthOf(isoDate(addDays(parseISO(thisWeek), 7 * WEEKS_AHEAD))));
  const key = monthKey(cursor);
  const canPrev = key > earliest;
  const canNext = key < latest;
  const lit = streak.weeks > 0;

  const openInPlan = (date: string) => router.navigate({ pathname: '/plan', params: { date } });

  return (
    <Screen refreshing={training.isFetching || plan.isFetching} onRefresh={() => { training.refetch(); plan.refetch(); rest.refetch(); }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: lit ? palette.accentSoft : palette.surface2, alignItems: 'center', justifyContent: 'center' }}>
            <SymbolView name={ICONS.flame} tintColor={lit ? palette.amber : palette.mut} size={32} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <T variant="display" tone={lit ? 'ink' : 'mut'} style={{ fontVariant: ['tabular-nums'] }}>{streak.weeks}{streak.capped ? '+' : ''}</T>
              <T variant="h3" tone={lit ? 'ink' : 'mut'}>week{streak.weeks === 1 && !streak.capped ? '' : 's'} in a row</T>
            </View>
            {streak.thisWeek ? (
              <T variant="small" tone="pos">This week already counts.</T>
            ) : keeper ? (
              <Pressable onPress={() => router.push(`/plan/${keeper.id}`)} accessibilityRole="button" accessibilityLabel={`Open ${keeper.title}`}>
                <T variant="small" tone="ink2">
                  {relativeDay(keeper.date)} · <T variant="small" weight="700">{keeper.title}</T> keeps it alive ›
                </T>
              </Pressable>
            ) : (
              <T variant="small" tone="mut">{lit ? 'Nothing planned this week yet.' : 'A week counts once it has a workout.'}</T>
            )}
          </View>
        </View>
        {!streak.thisWeek && !keeper ? (
          <Button title="Plan a workout this week" variant="secondary" small onPress={() => router.push(`/plan/new?date=${today}`)} style={{ marginTop: space.md, alignSelf: 'flex-start' }} />
        ) : null}
        <StreakHeat count={last7} style={{ marginTop: space.md }} />
      </Card>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Arrow dir="prev" enabled={canPrev} onPress={() => setCursor((m) => shift(m, -1))} />
        <T variant="h2" align="center" style={{ flex: 1 }}>{format(new Date(cursor.year, cursor.month0, 1), 'MMMM yyyy')}</T>
        <Arrow dir="next" enabled={canNext} onPress={() => setCursor((m) => shift(m, 1))} />
        {key !== monthKey(monthOf(today)) ? (
          <Button title="Today" variant="ghost" small onPress={() => { setCursor(monthOf(today)); setSelected(today); }} />
        ) : null}
      </View>

      {training.error ? <ErrorBanner message={errorMessage(training.error)} /> : null}
      {plan.error ? <ErrorBanner message={errorMessage(plan.error)} /> : null}
      {training.isLoading ? <Loading label="Loading your training" /> : (
        <MonthCalendar
          year={cursor.year}
          month0={cursor.month0}
          byDay={byDay}
          planByDay={planByDay}
          today={today}
          selected={selected}
          onSelect={setSelected}
          onOpenInPlan={openInPlan}
        />
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <Key swatch={{ backgroundColor: palette.surface2 }} label="done" />
        <Key swatch={{ borderWidth: 1, borderStyle: 'dashed', borderColor: palette.accentLine }} label="planned" />
        <Key swatch={{ backgroundColor: palette.neg }} dot label="missed" />
        <Key swatch={{ borderWidth: 1.5, borderColor: palette.accent }} label="today" />
      </View>
      <T variant="small" tone="mut">
        Every workout counts: runs, rides, swims and anything else your watch recorded, plus gym workouts logged here. Weeks run Monday to Sunday, the same weeks as the Plan tab.
      </T>
    </Screen>
  );
}

function Arrow({ dir, enabled, onPress }: { dir: 'prev' | 'next'; enabled: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={dir === 'prev' ? 'Previous month' : 'Next month'}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: !enabled ? 0.3 : pressed ? 0.7 : 1 })}>
      <T variant="h2" tone="ink2">{dir === 'prev' ? '‹' : '›'}</T>
    </Pressable>
  );
}

function Key({ swatch, dot, label }: { swatch: ViewStyle; dot?: boolean; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={[dot ? { width: 6, height: 6, borderRadius: 3 } : { width: 14, height: 14, borderRadius: radius.sm - 4 }, swatch]} />
      <T variant="tiny" tone="mut">{label}</T>
    </View>
  );
}
