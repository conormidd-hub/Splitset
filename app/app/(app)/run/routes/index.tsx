import { Stack, router } from 'expo-router';
import { View } from 'react-native';

import { useUnits } from '@/api/profile';
import { kindLabel, useRoutes } from '@/api/routes';
import { ROUTING_PROVIDER } from '@/api/routing';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { relativeDay } from '@/lib/dates';
import { formatDistance, formatElevation } from '@/lib/units';
import { space } from '@/theme/tokens';

/** Every route the user has drawn or generated and kept, newest first. */
export default function RoutesList() {
  const units = useUnits();
  const q = useRoutes();
  const routes = q.data ?? [];
  const openGenerator = () => router.push('/run/routes/new');
  const openDrawer = () => router.push('/run/routes/draw');

  return (
    <>
      <Stack.Screen options={{ title: 'Routes' }} />
      <Screen>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <T tone="mut" style={{ flex: 1 }}>
            {routes.length ? `${routes.length} saved ${routes.length === 1 ? 'route' : 'routes'}` : 'Routes you draw or generate and keep.'}
          </T>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Generate" variant="secondary" small onPress={openGenerator} />
            <Button title="Draw" small onPress={openDrawer} />
          </View>
        </View>

        {q.isLoading ? (
          <Loading label="Loading routes" />
        ) : q.error ? (
          <ErrorBanner message={errorMessage(q.error)} />
        ) : !routes.length ? (
          <EmptyState
            title="No saved routes"
            body="Draw a course point by point, or pick a start and a distance and Splitset builds loops and point-to-point routes along real roads and paths. Export any saved route as GPX for Garmin Connect."
            action={{ title: 'Draw a course', onPress: openDrawer }}
          />
        ) : (
          <Card>
            {routes.map((r, i) => (
              <ListRow
                key={r.id}
                first={i === 0}
                title={r.name}
                subtitle={`${formatElevation(r.elev_gain_m, units)} climb · ${relativeDay(r.created_at)}`}
                badge={<Badge label={kindLabel(r.kind, true)} tone={r.kind === 'loop' ? 'accent' : r.kind === 'drawn' ? 'pos' : 'mut'} />}
                value={formatDistance(r.distance_m, units)}
                onPress={() => router.push(`/run/routes/${r.id}`)}
              />
            ))}
          </Card>
        )}

        <T variant="tiny" tone="mut" align="center">Routing by {ROUTING_PROVIDER}</T>
      </Screen>
    </>
  );
}
