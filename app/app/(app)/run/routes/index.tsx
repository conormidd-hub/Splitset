import { Stack, router } from 'expo-router';
import { View } from 'react-native';

import { useUnits } from '@/api/profile';
import { useRoutes, type SavedRoute } from '@/api/routes';
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

function kindLabel(kind: SavedRoute['kind']): string {
  return kind === 'loop' ? 'Loop' : 'A to B';
}

/** Every route the user has generated and kept, newest first. */
export default function RoutesList() {
  const units = useUnits();
  const q = useRoutes();
  const routes = q.data ?? [];
  const openBuilder = () => router.push('/run/routes/new');

  return (
    <>
      <Stack.Screen options={{ title: 'Routes' }} />
      <Screen>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <T tone="mut" style={{ flex: 1 }}>
            {routes.length ? `${routes.length} saved ${routes.length === 1 ? 'route' : 'routes'}` : 'Routes you generate and keep.'}
          </T>
          <Button title="New route" small onPress={openBuilder} />
        </View>

        {q.isLoading ? (
          <Loading label="Loading routes" />
        ) : q.error ? (
          <ErrorBanner message={errorMessage(q.error)} />
        ) : !routes.length ? (
          <EmptyState
            title="No saved routes"
            body="Pick a start on the map and a distance, and Splitset builds loops or point-to-point routes along real roads and paths. Save the ones you like."
            action={{ title: 'New route', onPress: openBuilder }}
          />
        ) : (
          <Card>
            {routes.map((r, i) => (
              <ListRow
                key={r.id}
                first={i === 0}
                title={r.name}
                subtitle={`${formatElevation(r.elev_gain_m, units)} climb · ${relativeDay(r.created_at)}`}
                badge={<Badge label={kindLabel(r.kind)} tone={r.kind === 'loop' ? 'accent' : 'mut'} />}
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
