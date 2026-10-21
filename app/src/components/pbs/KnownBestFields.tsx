import { useState } from 'react';
import { View } from 'react-native';

import type { Exercise } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { useAddManualPb, useCurrentBodyweight, useThresholds } from '@/api/recovery';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/NumberInput';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { todayIso } from '@/lib/dates';
import { formatLoad } from '@/lib/pbs';
import { exerciseDef, setE1rm } from '@/lib/recovery/sets';
import { displayToKg } from '@/lib/units';
import { space } from '@/theme/tokens';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The sentence under the form: what a known best does, and how it goes. */
export function knownBestNote(c: { pb: { window_days: number; manual_policy: string } }): string {
  const replacedBy = c.pb.manual_policy === 'replace_on_log' ? 'your next logged set replaces it' : 'a heavier logged set replaces it';
  return `Counts in your PBs and scores your sets for ${c.pb.window_days} days; ${replacedBy}.`;
}

/**
 * "Add a known best": weight × reps, dated today unless another date is typed, with the estimated
 * 1RM it would give shown live. Shared by the exercise screen and the PBs tab's Add PB sheet.
 */
export function KnownBestFields({ exercise, onAdded, buttonTitle = 'Add known best' }: {
  exercise: Exercise;
  onAdded?: () => void;
  buttonTitle?: string;
}) {
  const units = useUnits();
  const c = useThresholds();
  const bodyweight = useCurrentBodyweight();
  const add = useAddManualPb();
  const [weight, setWeight] = useState<number | null>(null);
  const [reps, setReps] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const today = todayIso();
  const datedAt = date.trim() || today;
  const dateBad = !DATE.test(datedAt) || Number.isNaN(Date.parse(datedAt)) || datedAt > today;
  const bodyweightMode = exercise.load_mode === 'bodyweight' || exercise.load_mode === 'assisted';
  // a bodyweight or assisted best is stored with the bodyweight counted in, so it waits for the
  // real one rather than saving against the default (`ready` stays false while a read is loading
  // or has failed)
  const bodyweightPending = bodyweightMode && !bodyweight.ready;
  const ready = weight != null && weight >= 0 && reps != null && reps >= 1 && !dateBad && !bodyweightPending;
  // what it would count as, as the numbers are typed
  const preview = weight != null && reps != null && reps >= 1
    ? setE1rm(c, exerciseDef(exercise), { weightKg: displayToKg(weight, units), reps, rpe: null }, bodyweight.ready ? bodyweight.kg : null)
    : null;

  const submit = () => {
    if (!ready) return;
    add.mutate(
      { exercise, weightKg: displayToKg(weight, units), reps, datedAt, bodyweightKg: bodyweight.kg },
      { onSuccess: () => { setWeight(null); setReps(null); setDate(''); onAdded?.(); } },
    );
  };

  return (
    <View style={{ gap: space.sm }}>
      {bodyweightMode ? (
        <T variant="small" tone="mut">
          {exercise.load_mode === 'assisted' ? 'Weight is the assistance' : 'Weight is the added load'}; your bodyweight ({bodyweight.ready ? formatLoad(bodyweight.kg, units) : 'loading…'}) is counted in.
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <NumberInput value={weight} onChange={setWeight} placeholder={units === 'imperial' ? 'lb' : 'kg'} width={84} accessibilityLabel="Weight" />
        <T tone="mut">×</T>
        <NumberInput value={reps} onChange={setReps} integer placeholder="reps" width={72} accessibilityLabel="Reps" />
        <T variant="small" tone={preview != null ? 'accent' : 'mut'} weight="600" style={{ flex: 1, fontVariant: ['tabular-nums'] }}>
          {preview != null ? `= est. 1RM ${formatLoad(preview, units)}` : weight != null && reps != null ? 'no 1RM from that' : ''}
        </T>
      </View>
      {/* its own line, so the placeholder fits a phone and an error never moves the numbers;
          the error waits for a whole date, the hint gives the format until then */}
      <TextField
        value={date}
        onChangeText={setDate}
        placeholder={`today (${today})`}
        autoCapitalize="none"
        hint="Leave blank for today, or a past date as YYYY-MM-DD"
        error={date.trim().length >= 10 && dateBad ? 'A past date as YYYY-MM-DD' : undefined}
      />
      <T variant="tiny" tone="mut">{knownBestNote(c)}</T>
      {add.error ? <ErrorBanner message={errorMessage(add.error)} /> : null}
      <Button title={buttonTitle} small disabled={!ready} loading={add.isPending} onPress={submit} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}
