import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useExercises, type Exercise } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import {
  useCreateCustomExercise, useCurrentBodyweight, useExerciseRoles, useMuscleNames, useThresholds, useUpdateCustomExercise,
} from '@/api/recovery';
import { BodyMap } from '@/components/recovery/BodyMap';
import { LoadSplitBar, useRoleTints } from '@/components/recovery/ExerciseMuscles';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { todayIso } from '@/lib/dates';
import {
  BW_FACTOR, BW_PRESETS, customSlug, cycleRole, draftOf, emptyDraft, EQUIPMENT, fromSimilar, HARDNESS, matchExercises, RATIOS,
  roleCounts, rolesList, setRole, similarSuggestions, stepFactor, toPayload, validateDraft, withEquipment,
  type Draft, type EquipmentChoice, type RatioChoice, type SourceRow,
} from '@/lib/recovery/customExercise';
import { roleFigure } from '@/lib/recovery/screens';
import { MUSCLE_IDS, ROLES, type MuscleId, type Role } from '@/lib/recovery/library';
import { displayToKg, kgToDisplay } from '@/lib/units';
import { uuid, useActiveWorkout } from '@/stores/activeWorkout';
import { useRoutineDraft } from '@/stores/routineDraft';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const ROLE_SHORT: Record<Role, string> = { primary: 'P', secondary: 'S', tertiary: 'T' };
const MEASURE_OF: Record<EquipmentChoice, string> = Object.fromEntries(
  (Object.keys(EQUIPMENT) as EquipmentChoice[]).map((k) => [k, EQUIPMENT[k].logAs === 'seconds' ? 'duration' : EQUIPMENT[k].loadMode === 'fixed' ? 'reps' : 'weight_reps']),
) as Record<EquipmentChoice, string>;
const FIGURE_WIDTH = 120;

/**
 * Create a custom exercise (build phase 8), one screen top to bottom: name with "did you mean",
 * a similar exercise to start from, equipment, muscles by tapping the body, how hard it is, and
 * an optional known best. With `edit`, the same screen edits one of your exercises; how its sets
 * are logged can't change, so its sets keep their meaning.
 */
export default function NewExercise() {
  const params = useLocalSearchParams<{ name?: string; target?: 'workout' | 'routine'; edit?: string }>();
  const exercises = useExercises();
  const roles = useExerciseRoles();
  const editing = params.edit ? exercises.data?.find((e) => e.id === params.edit) : undefined;

  if (params.edit && (!exercises.data || !roles)) return <Screen><Loading /></Screen>;
  if (params.edit && !editing) return <Screen><ErrorBanner message="That exercise isn't one of yours." /></Screen>;
  return (
    <ExerciseEditor
      key={params.edit ?? 'new'}
      initial={editing ? draftOf(editing as SourceRow, roles?.get(editing.id) ?? []) : emptyDraft(params.name ?? '')}
      editing={editing ?? null}
      target={params.target ?? null}
    />
  );
}

function ExerciseEditor({ initial, editing, target }: { initial: Draft; editing: Exercise | null; target: 'workout' | 'routine' | null }) {
  const c = useThresholds();
  const units = useUnits();
  const { palette, name: themeName } = useTheme();
  const exercises = useExercises();
  const roles = useExerciseRoles();
  const names = useMuscleNames();
  const bodyweight = useCurrentBodyweight();
  const { tints, ready } = useRoleTints();
  const create = useCreateCustomExercise();
  const update = useUpdateCustomExercise();
  const [d, setD] = useState<Draft>(initial);
  const [similarQuery, setSimilarQuery] = useState('');
  const [tried, setTried] = useState(false);
  const unit = units === 'imperial' ? 'lb' : 'kg';

  const all = exercises.data ?? [];
  const library = all.filter((e) => e.slug && !e.owner_id);
  const didYouMean = editing ? [] : matchExercises(d.name, all);
  const suggestions = similarSuggestions(d.name, library);
  const searched = similarQuery.trim() ? matchExercises(similarQuery, library, 5, 0.5) : [];
  const similar = d.similar ? library.find((e) => e.slug === d.similar) : undefined;
  const problems = validateDraft(c, d);
  const counts = roleCounts(d.roles);
  const choices = (Object.keys(EQUIPMENT) as EquipmentChoice[]).filter((k) => !editing || MEASURE_OF[k] === editing.measure);
  const busy = create.isPending || update.isPending;

  const use = (e: Exercise) => {
    if (target === 'workout') useActiveWorkout.getState().addExercise(e);
    else if (target === 'routine') useRoutineDraft.getState().addExercise({ id: e.id, name: e.name, measure: e.measure });
    if (target) router.back();
    else router.replace(`/lift/exercises/${e.id}`);
  };
  const pickSimilar = (e: Exercise) => {
    setD((cur) => fromSimilar({ ...cur, ratio: 'same' }, e as SourceRow, roles?.get(e.id) ?? []));
    setSimilarQuery('');
  };
  const save = () => {
    setTried(true);
    if (problems.length) return;
    const payload = toPayload(c, d, {
      slug: editing?.slug ?? customSlug(uuid()), today: todayIso(), bodyweightKg: bodyweight.ready ? bodyweight.kg : null,
    });
    if (editing) update.mutate({ id: editing.id, payload }, { onSuccess: () => router.back() });
    else create.mutate(payload, { onSuccess: use });
  };

  return (
    <>
      <Stack.Screen options={{ title: editing ? `Edit ${editing.name}` : 'New exercise' }} />
      <Screen>
        {/* 1. name */}
        <Card title="Name">
          <View style={{ gap: space.sm }}>
            <TextField value={d.name} onChangeText={(name) => setD({ ...d, name })} placeholder="Incline Smith press" autoCapitalize="sentences" autoFocus={!editing} />
            {didYouMean.length ? (
              <View style={{ gap: space.xs }}>
                <T variant="label" tone="mut">Did you mean …?</T>
                {didYouMean.map((e) => (
                  <Pressable key={e.id} onPress={() => use(e)} accessibilityRole="button"
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md,
                      backgroundColor: palette.surface2, opacity: pressed ? 0.7 : 1 })}>
                    <T variant="small" weight="600" style={{ flex: 1 }}>{e.name}</T>
                    <T variant="small" tone="accent" weight="700">{target ? 'Use this' : 'Open'}</T>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        </Card>

        {/* 2. similar exercise */}
        <Card title="Start from a similar exercise" subtitle="Recommended: copies its equipment, muscles and how hard it is, and estimates your best from yours on it">
          <View style={{ gap: space.sm }}>
            {similar ? (
              <View style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <T weight="700" style={{ flex: 1 }}>{similar.name}</T>
                  <Button title="Clear" small variant="ghost" onPress={() => setD({ ...d, similar: null })} />
                </View>
                <T variant="small" tone="ink2">Compared with {similar.name}, you lift about:</T>
                <Segmented<RatioChoice>
                  options={[{ value: 'less', label: `Less (×${RATIOS.less})` }, { value: 'same', label: 'The same' }, { value: 'more', label: `More (×${RATIOS.more})` }]}
                  value={d.ratio}
                  onChange={(ratio) => setD({ ...d, ratio })}
                />
              </View>
            ) : (
              <>
                {suggestions.length ? (
                  <ChipRow>{suggestions.map((e) => <Chip key={e.id} label={e.name} onPress={() => pickSimilar(e)} />)}</ChipRow>
                ) : null}
                <TextField value={similarQuery} onChangeText={setSimilarQuery} placeholder="Search the library" autoCapitalize="none" />
                {searched.length ? <ChipRow>{searched.map((e) => <Chip key={e.id} label={e.name} onPress={() => pickSimilar(e)} />)}</ChipRow> : null}
              </>
            )}
          </View>
        </Card>

        {/* 3. equipment */}
        <Card title="Equipment" subtitle={editing ? "How its sets are logged can't change once it has been created" : undefined}>
          <View style={{ gap: space.md }}>
            <ChipRow>
              {choices.map((k) => <Chip key={k} label={EQUIPMENT[k].label} selected={d.choice === k} onPress={() => setD(withEquipment(d, k))} />)}
            </ChipRow>
            {d.loadMode === 'bodyweight' || d.loadMode === 'assisted' ? (
              <View style={{ gap: space.sm }}>
                <T variant="small" tone="ink2">How much of your bodyweight it moves{d.loadMode === 'assisted' ? ', before the assistance' : ''}</T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Button title="−" small variant="secondary" onPress={() => setD({ ...d, bwFactor: stepFactor(d.bwFactor, -1) })} />
                  <T variant="h2" style={{ minWidth: 56, textAlign: 'center', fontVariant: ['tabular-nums'] }} accessibilityLabel={`Bodyweight factor ${d.bwFactor}`}>
                    {(d.bwFactor ?? 0).toFixed(2)}
                  </T>
                  <Button title="+" small variant="secondary" onPress={() => setD({ ...d, bwFactor: stepFactor(d.bwFactor, 1) })} />
                  <T variant="tiny" tone="mut">{BW_FACTOR.min}–{BW_FACTOR.max}</T>
                </View>
                <ChipRow>
                  {BW_PRESETS.map((p) => <Chip key={p.label} label={`${p.label} ${p.value}`} selected={d.bwFactor === p.value} onPress={() => setD({ ...d, bwFactor: p.value })} />)}
                </ChipRow>
              </View>
            ) : null}
            <ChipRow>
              <Chip label="One side at a time" selected={d.unilateral} onPress={() => setD({ ...d, unilateral: !d.unilateral })} />
            </ChipRow>
          </View>
        </Card>

        {/* 4. muscles */}
        <Card title="Muscles" subtitle="Tap a muscle to cycle it: primary → secondary → tertiary → none">
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.lg }}>
              {(['front', 'back'] as const).map((view) => (
                <BodyMap
                  key={view}
                  map={roleFigure(rolesList(d.roles), tints, ready)}
                  view={view}
                  mode="session"
                  theme={themeName === 'night' ? 'dark' : 'light'}
                  thresholds={c}
                  width={FIGURE_WIDTH}
                  nameOf={names}
                  onSelect={(m) => setD({ ...d, roles: cycleRole(c, d.roles, m) })}
                />
              ))}
            </View>
            <T variant="small" tone="mut">
              {ROLES.map((r) => `${r} ${counts[r]}/${c.role_caps[r]}`).join(' · ')}
            </T>
            {rolesList(d.roles).length ? <LoadSplitBar split={null} roles={rolesList(d.roles)} nameOf={names} /> : null}
            <View accessibilityLabel="Muscles as a list">
              {MUSCLE_IDS.map((id, i) => (
                <MuscleRoleRow
                  key={id}
                  name={names(id)}
                  first={i === 0}
                  role={d.roles[id] ?? null}
                  tint={(r: Role) => tints[r]}
                  onChange={(role) => setD({ ...d, roles: setRole(c, d.roles, id as MuscleId, role) })}
                  full={(r: Role) => d.roles[id] !== r && counts[r] >= c.role_caps[r]}
                />
              ))}
            </View>
          </View>
        </Card>

        {/* 5. how hard */}
        <Card title="How hard is this on the body?" subtitle="The only load control: load always comes from your sets against your best">
          <Segmented
            options={HARDNESS.map((h) => ({ value: h.fatigue, label: h.label }))}
            value={d.fatigue}
            onChange={(fatigue) => setD({ ...d, fatigue })}
          />
        </Card>

        {/* 6. your best */}
        {!editing && d.loadMode !== 'fixed' ? (
          <Card title="Your best (optional)" subtitle={d.similar ? 'Skip it and your best is estimated from the similar exercise' : 'Skip it and your first session sets it'}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <NumberInput
                value={d.best ? kgToDisplay(d.best.weightKg, units) : null}
                onChange={(v) => setD({ ...d, best: v == null && !d.best?.reps ? null : { weightKg: v == null ? 0 : displayToKg(v, units), reps: d.best?.reps ?? 0 } })}
                placeholder={d.loadMode === 'assisted' ? 'assist' : unit}
                width={96}
              />
              <T tone="mut">×</T>
              <NumberInput
                value={d.best?.reps || null}
                onChange={(v) => setD({ ...d, best: v == null && !d.best?.weightKg ? null : { weightKg: d.best?.weightKg ?? 0, reps: v ?? 0 } })}
                placeholder="reps"
                integer
                width={80}
              />
              {d.best ? <Button title="Clear" small variant="ghost" onPress={() => setD({ ...d, best: null })} /> : null}
            </View>
          </Card>
        ) : null}

        {tried && problems.length ? <ErrorBanner message={problems.join(' ')} /> : null}
        <ErrorBanner message={create.error ? errorMessage(create.error) : update.error ? errorMessage(update.error) : null} />
        <Button title={editing ? 'Save changes' : target === 'workout' ? 'Save and add to workout' : 'Save exercise'} loading={busy} onPress={save} />
      </Screen>
    </>
  );
}

/** One muscle in the text list: its name and the role chips (P / S / T / none). */
function MuscleRoleRow({ name, first, role, tint, onChange, full }: {
  name: string; first: boolean; role: Role | null; tint: (r: Role) => string; onChange: (r: Role | null) => void; full: (r: Role) => boolean;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6, borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair }}>
      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: role ? tint(role) : palette.surface3 }} />
      <T variant="small" style={{ flex: 1 }}>{name}</T>
      {ROLES.map((r) => (
        <Pressable
          key={r}
          onPress={() => onChange(role === r ? null : r)}
          disabled={full(r)}
          accessibilityRole="button"
          accessibilityState={{ selected: role === r, disabled: full(r) }}
          accessibilityLabel={`${name} ${r}`}
          style={{ width: 30, height: 26, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center',
            backgroundColor: role === r ? tint(r) : palette.surface2, opacity: full(r) ? 0.35 : 1 }}>
          <T variant="tiny" weight="700" tone={role === r ? 'ink' : 'ink2'}>{ROLE_SHORT[r]}</T>
        </Pressable>
      ))}
    </View>
  );
}
