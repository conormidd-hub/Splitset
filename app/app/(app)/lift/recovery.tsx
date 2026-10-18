import { useProfile } from '@/api/profile';
import { useMuscleNames, useRecoveryMap, useThresholds } from '@/api/recovery';
import { NextReadyStrip, TrainNextCard } from '@/components/recovery/RecoveryExtras';
import { RecoveryFigure } from '@/components/recovery/RecoveryFigure';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';

/**
 * The Recovery screen (build phase 7): the recovery view now (front first on a phone, both views
 * side by side when wide, the list one tap away), what becomes trainable in the next 24 h, and
 * what to train next.
 */
export default function Recovery() {
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const c = useThresholds();
  const profile = useProfile();
  const timeZone = profile.data?.timezone ?? null;

  return (
    <Screen>
      <Card title="Fatigue now" subtitle="Colour is how much each muscle is still carrying from recent workouts">
        {map.error ? <ErrorBanner message={errorMessage(map.error)} />
          : !map.data ? <Loading />
          : <RecoveryFigure map={map.data} mode="recovery" nameOf={names} thresholds={c} timeZone={timeZone} />}
      </Card>
      {map.data ? <NextReadyStrip map={map.data} nameOf={names} /> : null}
      {map.data ? <TrainNextCard map={map.data} nameOf={names} /> : null}
    </Screen>
  );
}
