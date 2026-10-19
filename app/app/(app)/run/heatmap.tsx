import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, View } from 'react-native';

import { useUnits } from '@/api/profile';
import { FrequentRouteRow, HubMap, MapsChips, MapsState, routesSummary, useMapsHub } from '@/components/run/RunMaps';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { EmptyState } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import type { RouteGroup } from '@/lib/routeSimilarity';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Tab = 'heat' | 'routes';

const TABS: { value: Tab; label: string }[] = [
  { value: 'heat', label: 'Heat map' },
  { value: 'routes', label: 'Frequent routes' },
];

/**
 * The Maps hub, full screen: the heat map of every run with a GPS trace filling the page, the
 * "trails you run most" list, and the doors to Segments and Routes. `?focus=<activity_id>` (from a
 * run's detail) frames that run and its surroundings until a range or area chip is pressed. The
 * state and parts are shared with the Run tab's Maps (src/components/run/RunMaps.tsx).
 */
export default function Maps() {
  const { palette } = useTheme();
  const units = useUnits();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const hub = useMapsHub({ focus });
  const [tab, setTab] = useState<Tab>('heat');

  const openTab = (t: Tab) => {
    setTab(t);
    if (t === 'routes') hub.wantGroups();
  };
  const showGroup = (g: RouteGroup) => {
    hub.showGroup(g);
    setTab('heat');
  };

  const state = <MapsState hub={hub} />;
  const blocked = hub.q.isLoading || !!hub.q.error || !hub.cluster;

  return (
    <>
      <Stack.Screen options={{ title: 'Maps' }} />
      <Screen scroll={false} style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button title="Segments" variant="secondary" small style={{ flex: 1 }} onPress={() => router.push('/run/segments')} />
          <Button title="Routes" variant="secondary" small style={{ flex: 1 }} onPress={() => router.push('/run/routes')} />
        </View>

        <Segmented options={TABS} value={tab} onChange={openTab} />

        <MapsChips hub={hub} />

        {blocked ? state : tab === 'routes' ? (
          hub.areaGroups.length ? (
            <FlatList
              data={hub.areaGroups}
              keyExtractor={(g) => g.key}
              style={{ flex: 1 }}
              initialNumToRender={12}
              contentContainerStyle={{
                backgroundColor: palette.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.lg,
              }}
              ListHeaderComponent={<T variant="small" tone="mut" style={{ paddingTop: space.md }}>{routesSummary(hub)}</T>}
              renderItem={({ item, index }) => <FrequentRouteRow group={item} units={units} first={index === 0} onPress={() => showGroup(item)} />}
            />
          ) : (
            <EmptyState title="No routes to group" body="Runs that follow the same path are grouped here once they have GPS traces." />
          )
        ) : (
          <HubMap hub={hub} units={units} />
        )}
      </Screen>
    </>
  );
}
