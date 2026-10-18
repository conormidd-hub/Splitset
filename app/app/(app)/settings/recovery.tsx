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
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import {
  afterEdits, isOverridden, settingDefs, stepValue, validateEdits, valueAt,
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
];

const fmt = (def: NumberSetting, v: number) => `${def.integer ? v.toFixed(0) : String(Math.round(v * 100) / 100)}${def.unit ? ` ${def.unit}` : ''}`;

/**
 * Recovery map settings (build phase 9): per-user overrides of the model's constants, each with
 * a one-line explanation and "Reset to default". Edits are held until "Save changes", which
 * writes them and rescores every workout so the figure follows. The defaults never change.
 */
export default function RecoverySettings() {
  const uid = useUserId();
  const rows = useThresholdRows();
  const names = useMuscleNames();
  const save = useSaveThresholds();
  const updating = useRecomputeStatus((s) => s.running > 0);
  const recomputeError = useRecomputeStatus((s) => s.lastError);
  const [edits, setEdits] = useState<Edits>({});
  const [tried, setTried] = useState(false);

  if (!rows.data) return <Screen>{rows.error ? <ErrorBanner message={errorMessage(rows.error)} /> : <Loading />}</Screen>;

  const base = DEFAULT_THRESHOLDS;
  const defs = settingDefs(base, names);
  const now = afterEdits(base, uid, rows.data, edits);
  const problems = validateEdits(base, uid, rows.data, edits, defs);
  const dirty = Object.keys(edits).length > 0;
  const edit = (key: string, value: number | string | null) => setEdits((cur) => ({ ...cur, [key]: value }));
  const onSave = () => {
    setTried(true);
    if (problems.length) return;
    save.mutate(edits, { onSuccess: () => { setEdits({}); setTried(false); } });
  };

  return (
    <Screen>
      <T tone="mut">
        Tune the recovery map to how you recover. These change only your own figure, and the defaults stay as they are. Saving
        rescores your workouts.
      </T>
      {updating ? <T variant="small" tone="accent">Rescoring your workouts…</T> : null}
      {recomputeError ? <ErrorBanner message={`The last rescore failed: ${recomputeError}`} /> : null}

      {GROUPS.map((g) => (
        <Card key={g.id} title={g.title} subtitle={g.subtitle}>
          {defs.filter((d) => d.group === g.id).map((d, i) => (
            <SettingRow
              key={d.key}
              def={d}
              first={i === 0}
              value={valueAt(now, d.key)}
              overridden={isOverridden(rows.data, edits, d.key)}
              onChange={(v) => edit(d.key, v)}
              onReset={() => edit(d.key, null)}
            />
          ))}
        </Card>
      ))}

      {dirty ? (
        <View style={{ gap: space.sm }}>
          {tried && problems.length ? <ErrorBanner message={problems.join(' ')} /> : null}
          <ErrorBanner message={save.error ? errorMessage(save.error) : null} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Save changes" loading={save.isPending} onPress={onSave} />
            <Button title="Discard" variant="ghost" onPress={() => { setEdits({}); setTried(false); }} />
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

function SettingRow({ def, first, value, overridden, onChange, onReset }: {
  def: Setting; first: boolean; value: number | string; overridden: boolean;
  onChange: (v: number | string) => void; onReset: () => void;
}) {
  const { palette } = useTheme();
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
        <Segmented options={def.choices} value={value as string} onChange={onChange} />
      ) : null}
      {overridden ? (
        <Pressable onPress={onReset} accessibilityRole="button" hitSlop={6}>
          <T variant="small" tone="accent" weight="600">Reset to default ({String(valueAt(DEFAULT_THRESHOLDS, def.key))}{def.kind === 'number' && def.unit ? ` ${def.unit}` : ''})</T>
        </Pressable>
      ) : null}
    </View>
  );
}

function Stepper({ label, onPress, disabled, name }: { label: string; onPress: () => void; disabled: boolean; name: string }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={name}
      style={({ pressed }) => ({ width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
        backgroundColor: palette.surface2, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 })}>
      <T weight="700">{label}</T>
    </Pressable>
  );
}
