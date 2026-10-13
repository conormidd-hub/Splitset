import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useConnection } from '@/api/connections';
import { useUnits } from '@/api/profile';
import { useTrainingSessions } from '@/api/streaks';
import { StreakButton } from '@/components/home/StreakButton';
import { DayView } from '@/components/plan/DayView';
import { MonthView } from '@/components/plan/MonthView';
import { isCalendarView, ViewSwitcher, type CalendarView } from '@/components/plan/ViewSwitcher';
import { WeekView, WEEKS_AHEAD } from '@/components/plan/WeekView';
import { SyncNowBar } from '@/components/sync/SyncNowBar';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { todayIso } from '@/lib/dates';
import { sessionsByDay, sessionsFrom, streakWeeks, weekStreak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * One calendar, three views of the same days: the month with the streak running down its side,
 * the week with the plan laid out and draggable, and the day in full. A single day in focus
 * carries across the views, so switching never loses your place. The flame on Today lands here
 * on the month.
 */
export default function PlanCalendar() {
  const { palette } = useTheme();
  const units = useUnits();
  const today = todayIso();
  const params = useLocalSearchParams<{ view?: string; date?: string; t?: string }>();
  const [view, setView] = useState<CalendarView>(isCalendarView(params.view) ? params.view : 'week');
  const [cursor, setCursor] = useState<string>(isDate(params.date) ? params.date : today);
  // bumped so the week view scrolls to the cursor again even when it has not changed
  const [jump, setJump] = useState(0);

  // a later arrival with ?view= or ?date= (the flame on Today) lands where it asked, a tick later
  useEffect(() => {
    const t = setTimeout(() => {
      if (isCalendarView(params.view)) setView(params.view);
      if (isDate(params.date)) setCursor(params.date);
      setJump((n) => n + 1);
    }, 0);
    return () => clearTimeout(t);
  }, [params.view, params.date, params.t]);

  const connection = useConnection();
  const pushOn = !!connection.data?.push_plan && connection.data.status === 'active';

  // the streak runs through all three views
  const training = useTrainingSessions();
  const { byDay, streak, streakNo, earliest } = useMemo(() => {
    const sessions = sessionsFrom(training.data?.activities ?? [], training.data?.workouts ?? [], units);
    return {
      byDay: sessionsByDay(sessions),
      streak: weekStreak(sessions, today, training.data?.oldest),
      streakNo: new Map(streakWeeks(sessions, today).map((w, i) => [w, i + 1])),
      earliest: sessions[0]?.date ?? training.data?.oldest ?? today,
    };
  }, [training.data, units, today]);

  const goToday = () => {
    setCursor(today);
    setJump((n) => n + 1);
  };
  const openDay = (iso: string) => {
    setCursor(iso);
    setView('day');
  };
  const openMonth = (iso: string) => {
    setCursor(iso);
    setView('month');
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <T variant="label" tone="mut">Plan</T>
          <T variant="display">Calendar</T>
        </View>
        {training.isSuccess ? <StreakButton streak={streak} compact onPress={() => setView('month')} /> : null}
        <Button title="Today" variant="secondary" small onPress={goToday} />
        <Button title="+ Add" small onPress={() => router.push(`/plan/new?date=${cursor}`)} />
      </View>
      <View style={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.xs }}>
        <ViewSwitcher value={view} onChange={setView} />
        <SyncNowBar />
      </View>

      {/* the views cross-fade; the leaving one sits on top of the new one for its last few frames */}
      <View style={{ flex: 1 }}>
        <Animated.View key={view} entering={FadeIn.duration(200)} exiting={FadeOut.duration(120)} style={StyleSheet.absoluteFill}>
          {view === 'week' ? (
            <WeekView
              cursor={cursor}
              jump={jump}
              today={today}
              units={units}
              pushOn={pushOn}
              streakNo={streakNo}
              onOpenMonth={openMonth}
              onPickDay={openDay}
            />
          ) : (
            <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled">
              {view === 'month' ? (
                <MonthView
                  cursor={cursor}
                  today={today}
                  byDay={byDay}
                  streak={streak}
                  streakNo={streakNo}
                  weeksAhead={WEEKS_AHEAD}
                  earliest={earliest}
                  onCursor={setCursor}
                  onPickDay={openDay}
                />
              ) : (
                <DayView cursor={cursor} today={today} units={units} pushOn={pushOn} byDay={byDay} onCursor={setCursor} />
              )}
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}
