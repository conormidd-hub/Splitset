import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useConnection } from '@/api/connections';
import { useDeleteAccount, useProfile, useRestSettings, useUnits, useUpdateProfile } from '@/api/profile';
import { REST_CHOICES, REST_MAX, REST_MIN } from '@/components/lift/RestBubble';
import { useCurrentBodyweight } from '@/api/recovery';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { relativeDay } from '@/lib/dates';
import { formatClock } from '@/lib/restTimer';
import { isDemoUser } from '@/lib/demo';
import { formatLoad } from '@/lib/pbs';
import { useSession } from '@/lib/session';
import { displayToKg, kgToDisplay, sameWeightShown, weightRangeShown } from '@/lib/units';
import { useTheme, type ThemeChoice } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const STATUS_TONE = { active: 'pos', paused: 'mut', auth_failed: 'neg', disconnected: 'mut' } as const;

type Sex = 'male' | 'female' | 'none';
const THIS_YEAR = new Date().getFullYear();

const sexOf = (v: string | null | undefined): Sex => (v === 'male' || v === 'female' ? v : 'none');
/** profiles.bodyweight_kg is checked to this range. */
const BODYWEIGHT_KG = { min: 20, max: 400 };

export default function Settings() {
  const { session, signOut } = useSession();
  const { choice, setChoice } = useTheme();
  const profile = useProfile();
  const update = useUpdateProfile();
  const del = useDeleteAccount();
  const connection = useConnection();
  const units = useUnits();
  const bodyweight = useCurrentBodyweight();
  const rest = useRestSettings();
  const restUpdate = useUpdateProfile();
  const setRestSeconds = (s: number) => restUpdate.mutate({ rest_seconds: Math.max(REST_MIN, Math.min(REST_MAX, s)) });

  // Inputs show the saved value until the user edits them; edits live here until saved.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [tzEdit, setTzEdit] = useState<string | null>(null);
  const [yearEdit, setYearEdit] = useState<number | null | undefined>(undefined);
  const [sexEdit, setSexEdit] = useState<Sex | undefined>(undefined);
  const [bwEdit, setBwEdit] = useState<number | null | undefined>(undefined);   // kg, so switching units cannot re-read it
  const name = nameEdit ?? profile.data?.display_name ?? '';
  const tz = tzEdit ?? profile.data?.timezone ?? '';
  const year = yearEdit === undefined ? profile.data?.birth_year ?? null : yearEdit;
  const sex = sexEdit ?? sexOf(profile.data?.sex);
  const yearBad = year != null && (year < 1900 || year > THIS_YEAR);
  const savedBw = profile.data?.bodyweight_kg ?? null;
  const bwKg = bwEdit === undefined ? savedBw : bwEdit;
  const bwShown = bwKg == null ? null : kgToDisplay(bwKg, units);
  const bwUnit = units === 'imperial' ? 'lb' : 'kg';
  const bwBad = bwKg != null && (bwKg < BODYWEIGHT_KG.min || bwKg > BODYWEIGHT_KG.max);
  const bwRange = weightRangeShown(BODYWEIGHT_KG.min, BODYWEIGHT_KG.max, units);
  const bwError = `Between ${bwRange.min} ${bwRange.unit} and ${bwRange.max} ${bwRange.unit}, please.`;
  // Compared as the field shows it, so a 0.1 lb step counts. While a newer weigh-in is used, typing
  // any value (the saved one too) counts, so saving it stamps it newer and it wins again.
  const bwChanged = bwEdit !== undefined
    && (!sameWeightShown(bwEdit, savedBw, units) || (bwEdit != null && bodyweight.source === 'weigh-in'));
  const dirty = !!profile.data && (
    name.trim() !== profile.data.display_name
    || tz.trim() !== profile.data.timezone
    || year !== (profile.data.birth_year ?? null)
    || sex !== sexOf(profile.data.sex)
    || bwChanged
  );
  const save = () =>
    update.mutate(
      {
        display_name: name.trim() || profile.data?.display_name,
        timezone: tz.trim() || 'UTC',
        birth_year: year,
        sex: sex === 'none' ? null : sex,
        ...(bwChanged ? { bodyweight_kg: bwKg, bodyweight_updated_at: bwKg == null ? null : new Date().toISOString() } : {}),
      },
      { onSuccess: () => { setNameEdit(null); setTzEdit(null); setYearEdit(undefined); setSexEdit(undefined); setBwEdit(undefined); } },
    );
  const conn = connection.data;
  const connected = !!conn && conn.status !== 'disconnected';

  const onDelete = async () => {
    const ok = await confirm('Delete account', 'This removes your account and every activity, wellness day, workout and plan session. It cannot be undone.', 'Delete everything', true);
    if (ok) del.mutate();
  };

  return (
    <Screen>
      {session?.user.email ? <T variant="small" tone="mut">Signed in as {session.user.email}</T> : null}
      <Card title="Data sources">
        {connected && conn ? (
          <ListRow
            first
            title="intervals.icu"
            subtitle={`Athlete ${conn.athlete_id}`}
            badge={<Badge label={conn.status.replace('_', ' ')} tone={STATUS_TONE[conn.status as keyof typeof STATUS_TONE] ?? 'mut'} />}
            onPress={() => router.push('/settings/connect')}
          />
        ) : (
          <ListRow first title="Connect your watch" subtitle="intervals.icu · not connected" onPress={() => router.push('/settings/connect')} />
        )}
      </Card>

      <Card title="Home screen">
        <ListRow first title="Edit In focus and At a glance" subtitle="Choose, reorder and remove the tiles on Today" onPress={() => router.push({ pathname: '/', params: { edit: '1' } })} />
        <ListRow title="Run the setup again" subtitle="The step-by-step connect guide" onPress={() => router.push('/welcome')} />
      </Card>

      <Card title="Profile">
        <View style={{ gap: space.md }}>
          <TextField label="Display name" value={name} onChangeText={setNameEdit} autoCapitalize="words" />
          <TextField label="Time zone" value={tz} onChangeText={setTzEdit} autoCapitalize="none" hint="An IANA name such as Australia/Melbourne." />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <T variant="label" tone="mut">Birth year</T>
              <T variant="small" tone={yearBad ? 'neg' : 'mut'}>{yearBad ? 'A four-digit year, please.' : 'For the fitness level on the VO2 max page.'}</T>
            </View>
            <NumberInput
              value={year} onChange={setYearEdit} integer width={96} placeholder="1990"
              accessibilityLabel="Birth year" accessibilityHint={yearBad ? 'A four-digit year, please.' : undefined}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <T variant="label" tone="mut">Bodyweight ({bwUnit})</T>
              <T variant="small" tone={bwBad ? 'neg' : 'mut'}>
                {bwBad
                  ? bwError
                  : bodyweight.source === 'weigh-in'
                    ? savedBw == null
                      ? `For bodyweight exercises. Using your latest weigh-in: ${formatLoad(bodyweight.kg, units)} (${relativeDay(bodyweight.date)}).`
                      : `For bodyweight exercises. Your weigh-in of ${formatLoad(bodyweight.kg, units)} (${relativeDay(bodyweight.date)}) is newer, so it's used. To use yours, type it and save.`
                    : bodyweight.source === 'default'
                      ? `For bodyweight exercises, which use ${formatLoad(bodyweight.kg, units)} until you enter yours.`
                      : 'For bodyweight exercises. A newer Garmin weigh-in takes over.'}
              </T>
            </View>
            {/* Keyed on units: a units tap need not blur the field (taps persist), so remount it to
                drop the text typed in the old unit and show the pending value converted. */}
            <NumberInput
              key={units}
              value={bwShown}
              onChange={(v) => setBwEdit(v == null ? null : displayToKg(v, units))}
              width={96}
              placeholder={bwUnit}
              accessibilityLabel={`Bodyweight in ${units === 'imperial' ? 'pounds' : 'kilograms'}`}
              accessibilityHint={bwBad ? bwError : undefined}
            />
          </View>
          <View>
            <T variant="label" tone="mut" style={{ marginBottom: space.xs }}>Sex</T>
            <Segmented<Sex>
              options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'none', label: 'Not set' }]}
              value={sex}
              onChange={setSexEdit}
            />
          </View>
          <View>
            <T variant="label" tone="mut" style={{ marginBottom: space.xs }}>Units</T>
            <Segmented
              options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }]}
              value={profile.data?.units ?? 'metric'}
              onChange={(units) => update.mutate({ units })}
            />
          </View>
          {dirty ? (
            <Button title="Save" small loading={update.isPending} disabled={yearBad || bwBad} onPress={save} />
          ) : null}
          <ErrorBanner message={update.error ? errorMessage(update.error) : null} />
        </View>
      </Card>

      <Card title="Appearance">
        <Segmented<ThemeChoice>
          options={[{ value: 'auto', label: 'Auto' }, { value: 'race', label: 'Race' }, { value: 'night', label: 'Night' }]}
          value={choice}
          onChange={setChoice}
        />
      </Card>

      <Card title="Workout" subtitle="The rest timer between sets. In a workout, ⏱ at the top turns it on or off and changes its length.">
        <View style={{ gap: space.md }}>
          <View style={{ gap: space.xs }}>
            <T weight="600">Start workouts with the rest timer</T>
            <Segmented
              label="Start workouts with the rest timer"
              options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
              value={rest.on ? 'on' : 'off'}
              onChange={(v) => restUpdate.mutate({ rest_timer_on: v === 'on' })}
            />
          </View>
          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <T weight="600" style={{ flex: 1 }}>Default rest</T>
              <Button title="−15 s" small variant="secondary" disabled={rest.seconds <= REST_MIN} onPress={() => setRestSeconds(rest.seconds - 15)} />
              <T weight="700" style={{ minWidth: 52, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{formatClock(rest.seconds)}</T>
              <Button title="+15 s" small variant="secondary" disabled={rest.seconds >= REST_MAX} onPress={() => setRestSeconds(rest.seconds + 15)} />
            </View>
            <ChipRow>
              {REST_CHOICES.map((s) => <Chip key={s} label={formatClock(s)} selected={rest.seconds === s} onPress={() => setRestSeconds(s)} />)}
            </ChipRow>
          </View>
          <ErrorBanner message={restUpdate.error ? errorMessage(restUpdate.error) : null} />
        </View>
      </Card>

      <Card title="Recovery map" subtitle="Recovery times, load shares, colour boundaries, PB rules and cardio" onPress={() => router.push('/settings/recovery')}>
        <Button title="Tune the recovery map" variant="secondary" small onPress={() => router.push('/settings/recovery')} />
      </Card>

      {/* development builds only: the recovery map at any instant, light or dark (build phase 6) */}
      {__DEV__ ? (
        <Card title="Developer" subtitle="Only in development builds">
          <Button title="Recovery map preview" variant="secondary" small onPress={() => router.push('/lift/recovery-dev')} />
        </Card>
      ) : null}

      <Card title="Account">
        <View style={{ gap: space.sm }}>
          <Button title="Sign out" variant="secondary" onPress={() => signOut()} />
          {isDemoUser(session?.user.email) ? (
            <T variant="small" tone="mut">This is the demo athlete. Its data is sample data and is rebuilt by supabase/seed_demo.py.</T>
          ) : (
            <Button title="Delete account and all data" variant="danger" loading={del.isPending} onPress={onDelete} />
          )}
          <ErrorBanner message={del.error ? errorMessage(del.error) : null} />
        </View>
      </Card>

      <T variant="tiny" tone="mut" align="center">Splitset 0.1.0</T>
    </Screen>
  );
}
