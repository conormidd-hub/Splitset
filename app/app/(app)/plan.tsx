import { Screen } from '@/components/ui/Screen';
import { EmptyState } from '@/components/ui/States';

export default function Plan() {
  return (
    <Screen title="Plan" subtitle="Training calendar">
      <EmptyState
        title="Coming in milestone 8"
        body="Planned sessions on a calendar, linked to the run or gym session that actually happened."
      />
    </Screen>
  );
}
