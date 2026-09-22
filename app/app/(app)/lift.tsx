import { Screen } from '@/components/ui/Screen';
import { EmptyState } from '@/components/ui/States';

export default function Lift() {
  return (
    <Screen title="Lift" subtitle="Strength">
      <EmptyState
        title="Coming in milestone 7"
        body="A live sheet for the gym: routines, sets with weight, reps and RPE, a rest timer, and records that update the moment you save."
      />
    </Screen>
  );
}
