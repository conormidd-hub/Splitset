import { addDays, format, parseISO } from 'date-fns';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { isRun, typeLabel } from '@/api/activities';
import { useRoutines } from '@/api/lifting';
import {
  PLAN_TYPES, RUN_SUBTYPES, STRENGTH_SUBTYPES, planTypeLabel, useActivitiesBetween, useDeletePlanSession,
  useLinkPlanSession, usePlanSession, useSavePlanSession, useSetPlanStatus, type PlanType,
} from '@/api/plan';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { isoDate, relativeDay, shortTime, todayIso } from '@/lib/dates';
import { KM_PER_MILE, formatDistance, formatPace, secPerKm } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Form = {
  date: string;
  type: PlanType;
  subtype: string | null;
  title: string;
  targetKm: number | null;
  targetMin: number | null;
  routineId: string | null;
  notes: string;
};

export default function PlanSessionEditor() {
  const { id, date: dateParam } = useLocalSearchParams<{ id: string; date?: string }>();
  const isNew = id === 'new';
  const existing = usePlanSession(isNew ? undefined : id);
  if (!isNew && existing.isLoading) return <Screen><Loading /></Screen>;
  if (!isNew && (existing.error || !existing.data)) return <Screen><ErrorBanner message={errorMessage(existing.error) || 'Session not found'} /></Screen>;
  return <Editor key={existing.data?.id ?? 'new'} session={existing.data ?? null} initialDate={dateParam ?? todayIso()} />;
}

function Editor({ session, initialDate }: { session: NonNullable<ReturnType<typeof usePlanSession>['data']> | null; initialDate: string }) {
  const { palette } = useTheme();
  const units = useUnits();
  const save = useSavePlanSession();
  const del = useDeletePlanSession();
  const setStatus = useSetPlanStatus();
  const link = useLinkPlanSession();
  const routines = useRoutines();
  const toKm = (m: number | null | undefined) => (m == null ? null : Math.round((units === 'imperial' ? m / 1000 / KM_PER_MILE : m / 1000) * 10) / 10);

  const [form, setForm] = useState<Form>({
    date: session?.date ?? initialDate,
    type: (session?.type as PlanType) ?? 'run',
    subtype: session?.subtype ?? null,
    title: session?.title ?? '',
    targetKm: toKm(session?.target_distance_m),
    targetMin: session?.target_seconds ? Math.round(session.target_seconds / 60) : null,
    routineId: session?.routine_id ?? null,
    notes: session?.notes ?? '',
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const from = isoDate(addDays(parseISO(form.date), -1));
  const to = isoDate(addDays(parseISO(form.date), 1));
  const nearby = useActivitiesBetween(from, to);

  const defaultTitle = () => {
    if (form.type === 'run') return form.subtype ? `${form.subtype[0].toUpperCase()}${form.subtype.slice(1)} run` : 'Run';
    if (form.type === 'strength') return routines.data?.find((r) => r.id === form.routineId)?.name ?? 'Gym';
    return planTypeLabel(form.type);
  };

  const onSave = () =>
    save.mutate(
      {
        id: session?.id,
        date: form.date,
        type: form.type,
        subtype: form.subtype,
        title: form.title.trim() || defaultTitle(),
        target_distance_m: form.targetKm == null ? null : Math.round(form.targetKm * 1000 * (units === 'imperial' ? KM_PER_MILE : 1)),
        target_seconds: form.targetMin == null ? null : form.targetMin * 60,
        routine_id: form.type === 'strength' ? form.routineId : null,
        notes: form.notes.trim() || null,
        position: session?.position ?? 0,
      },
      { onSuccess: () => router.back() },
    );

  const onDelete = async () => {
    if (!session) return;
    if (await confirm('Delete session', 'Remove this planned session? Any linked activity stays.', 'Delete', true)) {
      del.mutate(session.id, { onSuccess: () => router.back() });
    }
  };

  const subtypes = form.type === 'run' ? RUN_SUBTYPES : form.type === 'strength' ? STRENGTH_SUBTYPES : [];
  const linked = session?.activity_id ? nearby.data?.find((a) => a.id === session.activity_id) : null;

  return (
    <>
      <Stack.Screen options={{ title: session ? 'Edit session' : 'New session' }} />
      <Screen>
        <Card>
          <View style={{ gap: space.md }}>
            <View style={{ gap: space.xs }}>
              <T variant="label" tone="mut">Date</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Button title="‹" small variant="secondary" onPress={() => set('date', isoDate(addDays(parseISO(form.date), -1)))} />
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <T variant="h3">{format(parseISO(form.date), 'EEEE d MMMM')}</T>
                  <T variant="small" tone="mut">{relativeDay(form.date)}</T>
                </View>
                <Button title="›" small variant="secondary" onPress={() => set('date', isoDate(addDays(parseISO(form.date), 1)))} />
              </View>
            </View>

            <View style={{ gap: space.xs }}>
              <T variant="label" tone="mut">Type</T>
              <Segmented<PlanType> options={PLAN_TYPES} value={form.type} onChange={(t) => setForm((f) => ({ ...f, type: t, subtype: null }))} />
            </View>

            {subtypes.length ? (
              <ChipRow>
                {subtypes.map((s) => <Chip key={s} label={s} selected={form.subtype === s} onPress={() => set('subtype', form.subtype === s ? null : s)} />)}
              </ChipRow>
            ) : null}

            <TextField label="Title" value={form.title} onChangeText={(v) => set('title', v)} placeholder={defaultTitle()} />

            {form.type === 'run' || form.type === 'ride' || form.type === 'walk' ? (
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <View style={{ gap: space.xs }}>
                  <T variant="label" tone="mut">Target {units === 'imperial' ? 'mi' : 'km'}</T>
                  <NumberInput value={form.targetKm} onChange={(v) => set('targetKm', v)} width={96} placeholder="–" muted />
                </View>
                <View style={{ gap: space.xs }}>
                  <T variant="label" tone="mut">Or minutes</T>
                  <NumberInput value={form.targetMin} onChange={(v) => set('targetMin', v)} integer width={96} placeholder="–" muted />
                </View>
              </View>
            ) : null}

            {form.type === 'strength' ? (
              <View style={{ gap: space.xs }}>
                <T variant="label" tone="mut">Routine</T>
                <ChipRow>
                  <Chip label="None" selected={!form.routineId} onPress={() => set('routineId', null)} />
                  {routines.data?.map((r) => <Chip key={r.id} label={r.name} selected={form.routineId === r.id} onPress={() => set('routineId', r.id)} />)}
                </ChipRow>
              </View>
            ) : null}

            <TextField label="Notes" value={form.notes} onChangeText={(v) => set('notes', v)} placeholder="Pace, heart-rate cap, kit…" multiline />
            <Button title={session ? 'Save' : 'Add to plan'} loading={save.isPending} onPress={onSave} />
            <ErrorBanner message={save.error ? errorMessage(save.error) : null} />
          </View>
        </Card>

        {session ? (
          <Card title="Status" right={<Badge label={session.status} tone={session.status === 'done' ? 'pos' : session.status === 'skipped' ? 'neg' : 'mut'} />}>
            <View style={{ gap: space.sm }}>
              {linked ? (
                <Pressable onPress={() => router.push(`/run/${linked.id}`)}>
                  <T variant="small" tone="mut">Fulfilled by</T>
                  <T variant="h3" tone="accent">{linked.name ?? typeLabel(linked.type)} · {linked.distance_m ? formatDistance(linked.distance_m, units) : ''}</T>
                  <T variant="small" tone="mut">{relativeDay(linked.start_time_local)} {shortTime(linked.start_time_local)} · linked {session.linked_by === 'auto' ? 'automatically' : 'by you'}</T>
                </Pressable>
              ) : session.workout_id ? (
                <Pressable onPress={() => router.push(`/lift/history/${session.workout_id}`)}>
                  <T variant="small" tone="mut">Fulfilled by</T>
                  <T variant="h3" tone="accent">Gym workout</T>
                </Pressable>
              ) : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {session.status !== 'skipped' ? (
                  <Button title="Skip" small variant="secondary" onPress={() => setStatus.mutate({ id: session.id, status: 'skipped' })} />
                ) : (
                  <Button title="Back on" small variant="secondary" onPress={() => setStatus.mutate({ id: session.id, status: 'planned' })} />
                )}
                {session.status !== 'done' && !linked ? (
                  <Button title="Mark done" small variant="secondary" onPress={() => setStatus.mutate({ id: session.id, status: 'done' })} />
                ) : null}
                {linked || session.workout_id ? (
                  <Button title="Unlink" small variant="secondary" onPress={() => link.mutate({ id: session.id, activityId: null, keep: true })} />
                ) : null}
                {session.linked_by === 'manual' && !linked && !session.workout_id ? (
                  <Button title="Let sync link it" small variant="ghost" onPress={() => link.mutate({ id: session.id, activityId: null, keep: false })} />
                ) : null}
              </View>
            </View>
          </Card>
        ) : null}

        {session && !linked && !session.workout_id && session.type !== 'rest' ? (
          <Card title="Link an activity" subtitle="Recorded within a day of this session">
            {nearby.isLoading ? <Loading /> : null}
            {nearby.data?.length === 0 ? <T tone="mut">Nothing recorded near this date yet.</T> : null}
            {nearby.data?.map((a, i) => (
              <Pressable key={a.id} onPress={() => link.mutate({ id: session.id, activityId: a.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
                <Badge label={typeLabel(a.type)} tone={isRun(a.type) ? 'accent' : 'mut'} />
                <View style={{ flex: 1 }}>
                  <T numberOfLines={1}>{a.name ?? typeLabel(a.type)}</T>
                  <T variant="small" tone="mut">{relativeDay(a.start_time_local)} {shortTime(a.start_time_local)}{a.distance_m ? ` · ${formatDistance(a.distance_m, units)}` : ''}{isRun(a.type) ? ` · ${formatPace(secPerKm(a.distance_m, a.moving_time_s), units)}` : ''}</T>
                </View>
                <T tone="accent" weight="700">Link</T>
              </Pressable>
            ))}
          </Card>
        ) : null}

        {session ? <Button title="Delete session" variant="danger" small loading={del.isPending} onPress={onDelete} /> : null}
      </Screen>
    </>
  );
}
