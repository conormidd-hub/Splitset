import { Screen } from '@/components/ui/Screen';
import { EmptyState } from '@/components/ui/States';

export default function Trends() {
  return (
    <Screen title="Trends" subtitle="Over time">
      <EmptyState
        title="Coming in milestone 9"
        body="Resting heart rate, HRV, load, fitness and fatigue, cadence and records over any range."
      />
    </Screen>
  );
}
