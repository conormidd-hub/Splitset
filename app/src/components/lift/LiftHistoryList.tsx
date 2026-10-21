import { format } from 'date-fns';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';

import type { WorkoutListRow } from '@/api/liftTrends';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { parseDate, relativeDay } from '@/lib/dates';
import { formatDurationShort, formatWeight } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

/** Rows under one month's heading, newest first. */
type Month = { key: string; label: string; rows: WorkoutListRow[] };

/** Workouts (newest first) in their local calendar months. */
function byMonth(rows: readonly WorkoutListRow[]): Month[] {
  const out: Month[] = [];
  for (const w of rows) {
    const d = parseDate(w.started_at);
    const key = d ? format(d, 'yyyy-MM') : 'unknown';
    let m = out[out.length - 1];
    if (!m || m.key !== key) {
      m = { key, label: d ? format(d, 'LLLL yyyy') : 'Undated', rows: [] };
      out.push(m);
    }
    m.rows.push(w);
  }
  return out;
}

/**
 * The Lift tab's History: every finished workout, newest first, under its month. A row opens the
 * workout. The screen asks for the next page as the list nears its end (`onMore`, from the
 * page's scroll); "Show more" does the same for anyone who doesn't scroll that far.
 */
export function LiftHistoryList({ workouts, loading, error, hasMore, loadingMore, onMore }: {
  workouts: readonly WorkoutListRow[];
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
}) {
  const units = useUnits();
  const { palette } = useTheme();
  const months = useMemo(() => byMonth(workouts), [workouts]);

  if (loading) return <Loading label="Loading your workouts" />;
  return (
    <>
      <ErrorBanner message={error ? errorMessage(error) : null} />
      {!workouts.length && !error ? <EmptyState title="No workouts yet" body="Finished sessions show up here with their volume and duration." /> : null}
      {months.map((m) => (
        <Card key={m.key} title={m.label}>
          {m.rows.map((w, i) => (
            <ListRow
              key={w.id ?? i}
              first={i === 0}
              title={w.name ?? 'Workout'}
              subtitle={`${relativeDay(w.started_at)} · ${formatDurationShort(w.duration_s)} · ${w.sets_completed ?? 0} sets`}
              value={w.volume_kg ? formatWeight(w.volume_kg, units, 0) : undefined}
              valueSub={w.volume_kg ? 'volume' : undefined}
              onPress={() => router.push(`/workout/${w.id}`)}
            />
          ))}
        </Card>
      ))}
      {loadingMore ? (
        <View style={{ paddingVertical: space.md }}><ActivityIndicator color={palette.mut} /></View>
      ) : hasMore ? (
        <Button title="Show more" variant="ghost" small onPress={onMore} />
      ) : null}
    </>
  );
}
