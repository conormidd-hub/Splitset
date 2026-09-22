import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isRun, typeLabel, useActivities, type ActivityFilter, type ActivityListRow } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { Badge, Chip, ChipRow } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState, Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay, shortTime } from '@/lib/dates';
import { formatDistance, formatDuration, formatPace, secPerKm } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'runs', label: 'Runs' },
  { value: 'strength', label: 'Gym' },
  { value: 'other', label: 'Other' },
];

export default function RunList() {
  const { palette } = useTheme();
  const units = useUnits();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const q = useActivities(filter);
  const rows = useMemo(() => q.data?.pages.flat() ?? [], [q.data]);

  const renderItem = ({ item, index }: { item: ActivityListRow; index: number }) => {
    const run = isRun(item.type);
    const pace = run ? formatPace(secPerKm(item.distance_m, item.moving_time_s), units) : undefined;
    return (
      <View style={{ paddingHorizontal: space.lg, backgroundColor: palette.surface }}>
        <ListRow
          first={index === 0}
          title={item.name ?? typeLabel(item.type)}
          subtitle={`${relativeDay(item.start_time_local)} · ${shortTime(item.start_time_local)}${item.avg_hr ? ` · ${item.avg_hr} bpm` : ''}`}
          badge={<Badge label={typeLabel(item.type)} tone={run ? 'accent' : 'mut'} />}
          value={item.distance_m ? formatDistance(item.distance_m, units) : formatDuration(item.moving_time_s)}
          valueSub={pace ?? (item.load ? `load ${Math.round(item.load)}` : undefined)}
          onPress={() => router.push(`/run/${item.id}`)}
        />
      </View>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(a) => a.id}
        renderItem={renderItem}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.md }}>
            <View>
              <T variant="label" tone="mut">Activities</T>
              <T variant="display">Run</T>
            </View>
            <ChipRow>
              {FILTERS.map((f) => (
                <Chip key={f.value} label={f.label} selected={filter === f.value} onPress={() => setFilter(f.value)} />
              ))}
            </ChipRow>
            {rows.length ? <View style={{ height: radius.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, backgroundColor: palette.surface, marginBottom: -radius.lg }} /> : null}
          </View>
        }
        ListFooterComponent={
          <View>
            {q.isFetchingNextPage ? <Loading /> : null}
            {rows.length ? <View style={{ height: radius.lg, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, backgroundColor: palette.surface }} /> : null}
          </View>
        }
        ListEmptyComponent={
          q.isLoading ? <Loading label="Loading activities" /> : (
            <EmptyState title="Nothing here yet" body="Activities appear after the first sync from intervals.icu." />
          )
        }
        onEndReached={() => {
          if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        refreshing={q.isRefetching}
        onRefresh={() => q.refetch()}
      />
    </SafeAreaView>
  );
}
