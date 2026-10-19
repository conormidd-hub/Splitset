import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useUnits } from '@/api/profile';
import { useLiftPbs, useRunPbs } from '@/api/pbs';
import { LiftPbsList } from '@/components/lift/LiftPbsList';
import { PbTable } from '@/components/pbs/PbTable';
import { runRows } from '@/components/pbs/rows';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';

type Tab = 'running' | 'lifting';

export default function PersonalBests() {
  const units = useUnits();
  // ?tab=running opens on the running PBs (the Lift tab's link)
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'running' ? 'running' : 'lifting');
  const runs = useRunPbs();
  // read here too (the list shares the query) so a pull refreshes it
  const lifts = useLiftPbs();

  return (
    <Screen refreshing={runs.isFetching || lifts.isFetching} onRefresh={() => { runs.refetch(); lifts.refetch(); }}>
      <Segmented<Tab> options={[{ value: 'lifting', label: 'Lifting' }, { value: 'running', label: 'Running' }]} value={tab} onChange={setTab} />

      {tab === 'running' ? (
        runs.isLoading ? <Loading /> : (
          <>
            <ErrorBanner message={runs.error ? errorMessage(runs.error) : null} />
            <Card title="Running" subtitle="Fastest stretch inside any run. Tap a row for the run.">
              <PbTable rows={runRows(runs.data, units, true)} />
            </Card>
            <T variant="small" tone="mut">
              {"Month and year are the calendar month and year so far. Best efforts come from your watch's GPS once a run has synced."}
            </T>
          </>
        )
      ) : (
        <>
          {/* the lifting half is shared with the Lift tab's PBs */}
          <LiftPbsList />
          <View style={{ height: 8 }} />
        </>
      )}
    </Screen>
  );
}
