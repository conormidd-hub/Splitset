import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useConnection } from '@/api/connections';
import { useDeleteAccount, useProfile, useUnits, useUpdateProfile } from '@/api/profile';
import { useCurrentBodyweight } from '@/api/recovery';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { relativeDay } from '@/lib/dates';
import { isDemoUser } from '@/lib/demo';
import { formatLoad } from '@/lib/pbs';
import { useSession } from '@/lib/session';
import { displayToKg, kgToDisplay } from '@/lib/units';
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

  // Inputs show the saved value until the user edits them; edits live here until saved.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [tzEdit, setTzEdit] = useState<string | null>(null);
  const [yearEdit, setYearEdit] = useState<number | null | undefined>(undefined);
  const [sexEdit, setSexEdit] = useState<Sex | undefined>(undefined);
  const [bwEdit, setBwEdit] = useState<number | null | undefined>(undefined);   // display units
  const name = nameEdit ?? profile.data?.display_name ?? '';
  const tz = tzEdit ?? profile.data?.timezone ?? '';
  const year = yearEdit === undefined ? profile.data?.birth_year ?? null : yearEdit;
  const sex = sexEdit ?? sexOf(profile.data?.sex);
  const yearBad = year != null && (year < 1900 || year > THIS_YEAR);
  const savedBw = profile.data?.bodyweight_kg ?? null;
  const bwShown = bwEdit === undefined ? (savedBw == null ? null : kgToDisplay(savedBw, units)) : bwEdit;
  const bwKg = bwShown == null ? null : displayToKg(bwShown, units);
  const bwBad = bwKg != null && (bwKg < BODYWEIGHT_KG.min || bwKg > BODYWEIGHT_KG.max);
  const bwChanged = bwEdit !== undefined && (bwKg == null ? savedBw != null : savedBw == null || Math.abs(bwKg - savedBw) >= 0.05);
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
    <Screen title="Settings" subtitle={session?.user.email ?? ''}>
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
            <NumberInput value={year} onChange={setYearEdit} integer width={96} placeholder="1990" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <T variant="label" tone="mut">Bodyweight</T>
              <T variant="small" tone={bwBad ? 'neg' : 'mut'}>
                {bwBad
                  ? `Between ${formatLoad(BODYWEIGHT_KG.min, units)} and ${formatLoad(BODYWEIGHT_KG.max, units)}, please.`
                  : bodyweight.source === 'weigh-in'
                    ? savedBw == null
                      ? `For bodyweight exercises. Using your latest weigh-in: ${formatLoad(bodyweight.kg, units)} (${relativeDay(bodyweight.date)}).`
                      : `For bodyweight exercises. Your weigh-in of ${formatLoad(bodyweight.kg, units)} (${relativeDay(bodyweight.date)}) is newer, so it's used.`
                    : bodyweight.source === 'default'
                      ? `For bodyweight exercises, which use ${formatLoad(bodyweight.kg, units)} until you enter yours.`
                      : 'For bodyweight exercises. A newer Garmin weigh-in takes over.'}
              </T>
            </View>
            <NumberInput value={bwShown} onChange={setBwEdit} width={96} placeholder={units === 'imperial' ? 'lb' : 'kg'} />
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
