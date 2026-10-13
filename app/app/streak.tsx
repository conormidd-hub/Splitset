import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { useUnits } from '@/api/profile';
import { useTrainingSessions } from '@/api/streaks';
import { StreakCalendar } from '@/components/home/StreakCalendar';
import { StreakHeat } from '@/components/home/StreakHeat';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { todayIso } from '@/lib/dates';
import { ICONS } from '@/lib/icons';
import { monthsBetween, sessionsByDay, sessionsFrom, sessionsLast7, weekStreak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const MONTHS_AT_A_TIME = 3;

/**
 * The flame's page: how many weeks in a row, how hot the last seven days burn, and a Strava
 * style calendar of every workout, month by month, newest first.
 */
export default function StreakPage() {
  const { palette } = useTheme();
  const units = useUnits();
  const today = todayIso();
  const training = useTrainingSessions();
  const [shown, setShown] = useState(MONTHS_AT_A_TIME);
  const [selected, setSelected] = useState<string | null>(null);

  const sessions = useMemo(
    () => sessionsFrom(training.data?.activities ?? [], training.data?.workouts ?? [], units),
    [training.data, units],
  );
  const byDay = useMemo(() => sessionsByDay(sessions), [sessions]);
  const streak = weekStreak(sessions, today, training.data?.oldest);
  const last7 = sessionsLast7(sessions, today);
  const months = useMemo(() => monthsBetween(today, sessions[0]?.date ?? today), [today, sessions]);
  const lit = streak.weeks > 0;

  return (
    <Screen refreshing={training.isFetching} onRefresh={() => training.refetch()}>
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
            <T variant="small" tone="mut">
              {lit
                ? streak.thisWeek ? 'This week already counts.' : 'One workout this week keeps it alive.'
                : 'A week counts once it has a workout. Start one this week.'}
            </T>
          </View>
        </View>
        <StreakHeat count={last7} style={{ marginTop: space.md }} />
      </Card>

      <T variant="small" tone="mut">
        Every workout counts: runs, rides, swims and anything else your watch recorded, plus gym workouts logged here. Weeks run Monday to Sunday.
      </T>

      {training.error ? <ErrorBanner message={errorMessage(training.error)} /> : null}
      {training.isLoading ? <Loading label="Loading your training" /> : null}
      {training.isSuccess && !sessions.length ? (
        <EmptyState title="Nothing recorded yet" body="Workouts show up here as soon as they sync from your watch, or when you finish one in the Lift tab." />
      ) : null}

      {months.slice(0, shown).map((m) => (
        <StreakCalendar key={`${m.year}-${m.month0}`} year={m.year} month0={m.month0} byDay={byDay} today={today} selected={selected} onSelect={setSelected} />
      ))}
      {months.length > shown ? (
        <Button title="Show earlier months" variant="ghost" small onPress={() => setShown((n) => n + MONTHS_AT_A_TIME)} />
      ) : null}
    </Screen>
  );
}
