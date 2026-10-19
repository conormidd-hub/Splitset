import { router } from 'expo-router';
import { useMemo, useState } from 'react';

import { useExercises, useRecords } from '@/api/lifting';
import { useLiftPbs } from '@/api/pbs';
import { useUnits } from '@/api/profile';
import { useThresholds } from '@/api/recovery';
import { PbTable } from '@/components/pbs/PbTable';
import { liftRows } from '@/components/pbs/rows';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';

/**
 * The lifting PBs: a find-a-lift field once there are a few, how they are worked out, and a card
 * per lift (most recently done first) with its bests this month, this year and of all time. The
 * PBs screen and the Lift tab's PBs both draw this, so the two never drift apart.
 */
export function LiftPbsList({ onSearchFocus }: {
  /** The find-a-lift field took focus: a page that doesn't make room for the keyboard can bring it up. */
  onSearchFocus?: () => void;
}) {
  const units = useUnits();
  const [query, setQuery] = useState('');
  const lifts = useLiftPbs();
  const exercises = useExercises();
  const records = useRecords();
  // the rep cap of the e1RM, from the user's thresholds (the constants forbid hard-coding it)
  const maxReps = useThresholds().e1rm.max_reps;

  const liftList = useMemo(() => {
    const byId = new Map((exercises.data ?? []).map((e) => [e.id, e]));
    const lastDone = new Map((records.data ?? []).map((r) => [r.exercise_id, r.last_completed_at ?? '']));
    const q = query.trim().toLowerCase();
    return [...(lifts.data?.entries() ?? [])]
      .map(([id, byMetric]) => ({ id, exercise: byId.get(id), byMetric, last: lastDone.get(id) ?? '' }))
      .filter((l) => !q || (l.exercise?.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.last.localeCompare(a.last));
  }, [lifts.data, exercises.data, records.data, query]);

  if (lifts.isLoading) return <Loading />;

  return (
    <>
      <ErrorBanner message={lifts.error ? errorMessage(lifts.error) : null} />
      {/* above the explanation, so the keyboard doesn't come up over it */}
      {(lifts.data?.size ?? 0) > 6 ? (
        <TextField value={query} onChangeText={setQuery} onFocus={onSearchFocus} placeholder="Find a lift" autoCapitalize="none" />
      ) : null}
      <T variant="small" tone="mut">
        {`1RM is your best estimate from any set: Epley on weight × reps, with reps (plus reps in reserve when you log RPE) capped at ${maxReps}. Bodyweight and assisted lifts count your bodyweight in. The small print shows the set, e.g. 132.5×5, or BW+20×5 with weight added to bodyweight; "tested" is a single with nothing in reserve. 3RM is the heaviest weight (the added load, for bodyweight lifts) you've moved for 3 or more reps; assisted lifts have no 3RM, since more assistance is easier. Warm-ups don't count.`}
      </T>
      {liftList.length === 0 ? (
        query.trim() && lifts.data?.size
          ? <T tone="mut" align="center">{`No lift matches “${query.trim()}”.`}</T>
          : <EmptyState title="No lifting PBs yet" body="Tick sets in a workout and finish it: every lift builds its own PBs from there." />
      ) : null}
      {liftList.map((l) => (
        <Card
          key={l.id}
          title={l.exercise?.name ?? 'Exercise'}
          subtitle={[l.exercise?.muscle_group, l.exercise?.equipment].filter(Boolean).join(' · ') || undefined}
          right={<Button title="History" variant="ghost" small onPress={() => router.push(`/lift/exercises/${l.id}`)} />}>
          <PbTable rows={liftRows(l.byMetric, units, { loadMode: l.exercise?.load_mode })} />
        </Card>
      ))}
    </>
  );
}
