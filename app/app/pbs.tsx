import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { useExercises, useRecords } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { useLiftPbs, useRunPbs } from '@/api/pbs';
import { PbTable } from '@/components/pbs/PbTable';
import { liftRows, runRows } from '@/components/pbs/rows';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';

type Tab = 'running' | 'lifting';

export default function PersonalBests() {
  const units = useUnits();
  const [tab, setTab] = useState<Tab>('lifting');
  const [query, setQuery] = useState('');
  const runs = useRunPbs();
  const lifts = useLiftPbs();
  const exercises = useExercises();
  const records = useRecords();

  const liftList = useMemo(() => {
    const byId = new Map((exercises.data ?? []).map((e) => [e.id, e]));
    const lastDone = new Map((records.data ?? []).map((r) => [r.exercise_id, r.last_completed_at ?? '']));
    const q = query.trim().toLowerCase();
    return [...(lifts.data?.entries() ?? [])]
      .map(([id, byMetric]) => ({ id, exercise: byId.get(id), byMetric, last: lastDone.get(id) ?? '' }))
      .filter((l) => !q || (l.exercise?.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.last.localeCompare(a.last));
  }, [lifts.data, exercises.data, records.data, query]);

  const error = runs.error ?? lifts.error;

  return (
    <Screen refreshing={runs.isFetching || lifts.isFetching} onRefresh={() => { runs.refetch(); lifts.refetch(); }}>
      <Segmented<Tab> options={[{ value: 'lifting', label: 'Lifting' }, { value: 'running', label: 'Running' }]} value={tab} onChange={setTab} />
      {error ? <ErrorBanner message={errorMessage(error)} /> : null}

      {tab === 'running' ? (
        runs.isLoading ? <Loading /> : (
          <>
            <Card title="Running" subtitle="Fastest stretch inside any run. Tap a row for the run.">
              <PbTable rows={runRows(runs.data, units, true)} />
            </Card>
            <T variant="small" tone="mut">
              {"Month and year are the calendar month and year so far. Best efforts come from your watch's GPS once a run has synced."}
            </T>
          </>
        )
      ) : lifts.isLoading ? <Loading /> : (
        <>
          <T variant="small" tone="mut">
            {"1RM is your best single, or an estimate from a set of up to 12 reps (Epley; the small print shows the set, e.g. 132.5×5). 3RM is the heaviest weight you've moved for 3 or more reps. Warm-ups don't count."}
          </T>
          {(lifts.data?.size ?? 0) > 6 ? (
            <TextField value={query} onChangeText={setQuery} placeholder="Find a lift" autoCapitalize="none" />
          ) : null}
          {liftList.length === 0 ? (
            <EmptyState title="No lifting PBs yet" body="Tick sets in a workout and finish it: every lift builds its own PBs from there." />
          ) : null}
          {liftList.map((l) => (
            <Card
              key={l.id}
              title={l.exercise?.name ?? 'Exercise'}
              subtitle={[l.exercise?.muscle_group, l.exercise?.equipment].filter(Boolean).join(' · ') || undefined}
              right={<Button title="History" variant="ghost" small onPress={() => router.push(`/lift/exercises/${l.id}`)} />}>
              <PbTable rows={liftRows(l.byMetric, units)} />
            </Card>
          ))}
          <View style={{ height: 8 }} />
        </>
      )}
    </Screen>
  );
}
