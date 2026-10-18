import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useMuscleNames, useSaveThresholds, useThresholdRows } from '@/api/recovery';
import { useRecomputeStatus } from '@/api/workoutLoads';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { confirm } from '@/lib/confirm';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import {
  afterEdits, followsDefault, isOverridden, resetValue, settingDefs, stepValue, validateEdits, valueAt, withEdit,
  type Edits, type NumberSetting, type Setting, type SettingGroup,
} from '@/lib/recovery/settings';
import { useUserId } from '@/lib/session';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const GROUPS: { id: SettingGroup; title: string; subtitle: string }[] = [
  { id: 'load', title: 'Muscle load', subtitle: 'How a set\'s load is shared out' },
  { id: 'recovery', title: 'Recovery', subtitle: 'How long each muscle takes to recover' },
  { id: 'figure', title: 'The figure', subtitle: 'Where each colour starts' },
  { id: 'pbs', title: 'PBs', subtitle: 'Which best your sets are scored against' },
  { id: 'cardio', title: 'Cardio', subtitle: 'Runs, rides and more from your watch' },
];

const fmt = (def: NumberSetting, v: number) => `${def.integer ? v.toFixed(0) : String(Math.round(v * 100) / 100)}${def.unit ? ` ${def.unit}` : ''}`;

/**
 * Recovery map settings (build phase 9): per-user overrides of the model's constants, each with
 * a one-line explanation and "Reset to default". Edits are held until "Save changes", which
 * writes them and rescores every workout so the figure follows. The defaults never change.
 * While there are edits, the Save bar stays pinned under the list, and leaving asks first.
 */
export default function RecoverySettings() {
  const uid = useUserId();
  const rows = useThresholdRows();
  const names = useMuscleNames();
  const save = useSaveThresholds();
  const navigation = useNavigation();
  const { palette } = useTheme();
  const updating = useRecomputeStatus((s) => s.recomputing > 0);   // not the activity catch-up
  const recomputeError = useRecomputeStatus((s) => s.lastError);
  const [edits, setEdits] = useState<Edits>({});
  const [tried, setTried] = useState(false);
  const changes = Object.keys(edits).length;
  // back, a swipe back or the Settings tab again would drop the edits without a word
  usePreventRemove(changes > 0 && !save.isPending, ({ data }) => {
    void confirm('Discard unsaved changes?', 'Your recovery map changes haven\'t been saved.', 'Discard', true)
      .then((ok) => { if (ok) navigation.dispatch(data.action); });
  });

  if (!rows.data) return <Screen>{rows.error ? <ErrorBanner message={errorMessage(rows.error)} /> : <Loading />}</Screen>;

  const saved = rows.data;
  const base = DEFAULT_THRESHOLDS;
  const defs = settingDefs(base, names);
  const now = afterEdits(base, uid, saved, edits);
  const problems = validateEdits(base, uid, saved, edits, defs);
  const edit = (key: string, value: number | string | boolean | null) => setEdits((cur) => withEdit(base, uid, saved, cur, key, value));
  const discard = () => { setEdits({}); setTried(false); };
  const onSave = () => {
    setTried(true);
    if (problems.length) return;
    save.mutate({ edits, rows: saved }, { onSuccess: discard });
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <Screen>
        <T tone="mut">
          Tune the recovery map to how you recover. These change only your own figure, and the defaults stay as they are. Saving
          rescores your workouts.
        </T>
        {updating ? <T variant="small" tone="accent">Rescoring your workouts…</T> : null}
        {recomputeError ? <ErrorBanner message={`The last rescore failed: ${recomputeError}`} /> : null}

        {GROUPS.map((g) => (
          <Card key={g.id} title={g.title} subtitle={g.subtitle}>
            {defs.filter((d) => d.group === g.id).map((d, i) => {
              const overridden = isOverridden(saved, edits, d.key);
              return (
                <SettingRow
                  key={d.key}
                  def={d}
                  first={i === 0}
                  value={valueAt(now, d.key)}
                  overridden={overridden}
                  resetTo={overridden ? resetValue(base, uid, saved, edits, d.key) : null}
                  follows={followsDefault(base, d.key)}
                  onChange={(v) => edit(d.key, v)}
                  onReset={() => edit(d.key, null)}
                />
              );
            })}
          </Card>
        ))}
      </Screen>

      {changes > 0 ? (
        <View style={{ gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: palette.hair, backgroundColor: palette.surface }}>
          <T variant="small" tone="mut">{changes} unsaved change{changes === 1 ? '' : 's'}</T>
          {tried && problems.length ? <ErrorBanner message={problems.join(' ')} /> : null}
          <ErrorBanner message={save.error ? errorMessage(save.error) : null} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Save changes" loading={save.isPending} onPress={onSave} />
            <Button title="Discard" variant="ghost" onPress={discard} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function SettingRow({ def, first, value, overridden, resetTo, follows, onChange, onReset }: {
  def: Setting; first: boolean; value: number | string | boolean; overridden: boolean;
  /** The value a reset gives (shown while overridden). */
  resetTo: number | string | boolean | null;
  /** A muscle's hours that follow "Every other muscle" once reset. */
  follows: boolean;
  onChange: (v: number | string | boolean) => void; onReset: () => void;
}) {
  const { palette } = useTheme();
  const resetText = resetTo == null ? '' : def.kind === 'toggle' ? (resetTo ? 'on' : 'off')
    : def.kind === 'choice' ? (def.choices.find((c) => c.value === resetTo)?.label ?? String(resetTo))
    : fmt(def, resetTo as number);
  const resetLabel = follows ? `Reset to follow Every other muscle (${resetText})` : `Reset to default (${resetText})`;
  return (
    <View style={{ gap: space.xs, paddingVertical: space.md, borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <T weight="600" style={{ flex: 1 }}>{def.label}</T>
        {def.kind === 'number' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
            <Stepper label="−" onPress={() => onChange(stepValue(def, value as number, -1))} disabled={(value as number) <= def.min} name={`Decrease ${def.label}`} />
            <T weight="700" style={{ minWidth: 64, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{fmt(def, value as number)}</T>
            <Stepper label="+" onPress={() => onChange(stepValue(def, value as number, 1))} disabled={(value as number) >= def.max} name={`Increase ${def.label}`} />
          </View>
        ) : null}
      </View>
      <T variant="small" tone="mut">{def.help}</T>
      {def.kind === 'choice' ? (
        <Segmented options={def.choices} value={value as string} onChange={onChange} label={def.label} />
      ) : null}
      {def.kind === 'toggle' ? (
        <Segmented
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
          value={value ? 'on' : 'off'}
          onChange={(v) => onChange(v === 'on')}
          label={def.label}
        />
      ) : null}
      {overridden ? (
        <Pressable onPress={onReset} accessibilityRole="button" accessibilityLabel={`${def.label}: ${resetLabel}`} hitSlop={6}>
          <T variant="small" tone="accent" weight="600">{resetLabel}</T>
        </Pressable>
      ) : null}
    </View>
  );
}

/** − or +: 34 pt across, with a 6 pt slop so the target is 46 pt (as DayScrubber's step buttons). */
function Stepper({ label, onPress, disabled, name }: { label: string; onPress: () => void; disabled: boolean; name: string }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={name}
      hitSlop={6}
      style={({ pressed }) => ({ width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
        backgroundColor: palette.surface2, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 })}>
      <T weight="700">{label}</T>
    </Pressable>
  );
}
