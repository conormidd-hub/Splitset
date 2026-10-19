import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { SectionList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { historyItems, useHistory } from '@/api/history';
import { useUnits } from '@/api/profile';
import { FeedRow } from '@/components/home/LatestActivities';
import { Button } from '@/components/ui/Button';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { byMonth, inFilter, type HistoryFilter } from '@/lib/history';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'runs', label: 'Runs' },
  { key: 'lifts', label: 'Lifts' },
  { key: 'rides', label: 'Rides' },
  { key: 'other', label: 'Other' },
];

const EMPTY: Record<HistoryFilter, { title: string; body: string }> = {
  all: { title: 'Nothing here yet', body: 'Runs, rides and the rest arrive with each sync from intervals.icu, and workouts you finish in Lift show here too.' },
  runs: { title: 'No runs yet', body: 'Runs appear after the first sync from intervals.icu.' },
  lifts: { title: 'No workouts yet', body: 'Finish a workout in Lift and it shows here.' },
  rides: { title: 'No rides yet', body: 'Rides appear once your watch has synced one.' },
  other: { title: 'Nothing else yet', body: "Swims, walks, hikes and anything that isn't a run, ride or lift show here." },
};

const isFilter = (v: unknown): v is HistoryFilter => FILTERS.some((f) => f.key === v);

/** "October 2026" for "2026-10". */
function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Everything done, newest first, in month sections: every synced activity and every gym workout
 * logged in the app, with chips to narrow it to runs, lifts, rides or the rest. Reached from
 * Today's Latest activity card (and the Lift and Run tabs, which may open it on their own chip
 * with ?filter=lifts or ?filter=runs). Loads a page at a time as it scrolls.
 */
export default function History() {
  const { palette } = useTheme();
  const units = useUnits();
  const params = useLocalSearchParams<{ filter?: string }>();
  const [filter, setFilter] = useState<HistoryFilter>(isFilter(params.filter) ? params.filter : 'all');
  const q = useHistory(filter);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  const items = useMemo(
    () => historyItems(q.data?.pages, !!hasNextPage).filter((i) => inFilter(i.sport, filter)),
    [q.data, hasNextPage, filter],
  );
  const sections = useMemo(
    () => byMonth(items).map((m) => ({ key: m.month, title: monthTitle(m.month), data: m.items })),
    [items],
  );

  // never cancelling a refetch in flight (after a sync, or a stale reopen), which would leave its
  // new rows missing from the top
  const more = () => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage({ cancelRefetch: false });
  };
  // a page whose rows all wait on the next (or that the chip filtered out) would leave the list
  // empty with nothing to scroll; fetch on until something shows or the history runs out
  useEffect(() => {
    if (q.isSuccess && !items.length && hasNextPage && !isFetchingNextPage) void fetchNextPage({ cancelRefetch: false });
  }, [q.isSuccess, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs }}>
        <ChipRow>
          {FILTERS.map((f) => <Chip key={f.key} label={f.label} selected={f.key === filter} onPress={() => setFilter(f.key)} />)}
        </ChipRow>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, paddingBottom: space.xxl }}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={{ marginTop: space.sm }}>
            <T variant="label" tone="mut" style={{ marginBottom: space.sm }}>{section.title}</T>
            {/* the card's rounded top, above its first row (overlapping it, the row would square the corners off) */}
            <View style={{ height: radius.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, backgroundColor: palette.surface }} />
          </View>
        )}
        renderSectionFooter={() => (
          <View style={{ height: radius.lg, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, backgroundColor: palette.surface }} />
        )}
        renderItem={({ item, index }) => (
          <View style={{ paddingHorizontal: space.lg, backgroundColor: palette.surface }}>
            <FeedRow item={item} units={units} first={index === 0} />
          </View>
        )}
        ListFooterComponent={
          isFetchingNextPage && items.length ? <Loading />
            // a later page that failed: say so, or the list just looks finished
            : q.isFetchNextPageError ? (
              <View style={{ gap: space.sm, paddingTop: space.md }}>
                <ErrorBanner message={`Couldn't load older activities: ${errorMessage(q.error)}`} />
                <Button title="Try again" variant="ghost" small onPress={more} />
              </View>
            ) : null
        }
        ListEmptyComponent={
          q.isLoading || (q.isSuccess && hasNextPage) ? <Loading label="Loading your history" />
            : q.error ? <ErrorBanner message={errorMessage(q.error)} />
            : <EmptyState title={EMPTY[filter].title} body={EMPTY[filter].body} />
        }
        onEndReached={more}
        onEndReachedThreshold={0.5}
        refreshing={q.isRefetching && !isFetchingNextPage}
        onRefresh={() => { void q.refetch(); }}
      />
    </SafeAreaView>
  );
}
