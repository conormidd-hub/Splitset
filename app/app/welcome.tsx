import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { keys } from '@/api/keys';
import { useProfile, useUpdateProfile, type Profile } from '@/api/profile';
import { ConnectSteps } from '@/components/onboarding/ConnectSteps';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { NumberInput } from '@/components/ui/NumberInput';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useUserId } from '@/lib/session';
import { space } from '@/theme/tokens';

type Sex = 'male' | 'female' | 'skip';

const THIS_YEAR = new Date().getFullYear();

/**
 * The first thing a new account sees: get the watch connected, say a little about yourself, go.
 * Today sends people here while the profile has no onboarded_at and nothing is connected; both
 * ways out stamp it, so the redirect never fires twice.
 */
export default function Welcome() {
  const uid = useUserId();
  const qc = useQueryClient();
  const profile = useProfile();
  const update = useUpdateProfile();
  const about = useUpdateProfile();
  const name = profile.data?.display_name?.trim() ?? '';

  const leave = () => {
    const onboarded_at = new Date().toISOString();
    // Today reads the profile query the moment it mounts: stamp it there first, or a slow write
    // would send a fresh Today straight back here
    qc.setQueryData<Profile>(keys.profile(uid), (p) => (p ? { ...p, onboarded_at } : p));
    update.mutate({ onboarded_at });
    // pushed from Settings: back to it. The first-run path replaced Today, so there is nowhere to go back to
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  // ---------------------------------------------------------------- about you
  // the year is held here until it is a whole one, so "19" on its way to "1990" never saves
  const [yearEdit, setYearEdit] = useState<number | null | undefined>(undefined);
  const year = yearEdit === undefined ? profile.data?.birth_year ?? null : yearEdit;
  // the pill moves on the tap, not when the profile comes back from the save
  const [sexEdit, setSexEdit] = useState<Sex | null>(null);
  const sex: Sex = sexEdit ?? (profile.data?.sex === 'male' || profile.data?.sex === 'female' ? profile.data.sex : 'skip');
  const setSex = (v: Sex) => {
    setSexEdit(v);
    about.mutate({ sex: v === 'skip' ? null : v });
  };
  const setYear = (v: number | null) => {
    setYearEdit(v);
    if (v == null || (v >= 1900 && v <= THIS_YEAR)) {
      if (v !== (profile.data?.birth_year ?? null)) about.mutate({ birth_year: v });
    }
  };
  const yearBad = year != null && (year < 1900 || year > THIS_YEAR);

  return (
    <Screen edges={['top', 'left', 'right']}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <T variant="label" tone="accent">Splitset</T>
          <T variant="display">{name ? `Hi ${name}` : 'Hi there'}</T>
        </View>
        <Button title="Skip for now" variant="ghost" small onPress={leave} />
      </View>
      <T tone="mut">
        Let&apos;s get your watch talking to Splitset. Five short steps, one thing to paste, and you can come back to any of it later from Settings.
      </T>

      <ConnectSteps mode="welcome" onDone={leave} />

      <Card title="About you" subtitle="So the VO2 max page can show your fitness level">
        <View style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <T variant="label" tone="mut">Birth year</T>
              {yearBad ? <T variant="small" tone="neg">A four-digit year, please.</T> : null}
            </View>
            <NumberInput value={year} onChange={setYear} integer width={96} placeholder="1990" />
          </View>
          <View>
            <T variant="label" tone="mut" style={{ marginBottom: space.xs }}>Sex</T>
            <Segmented<Sex>
              options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'skip', label: 'Skip' }]}
              value={sex}
              onChange={setSex}
            />
          </View>
          <T variant="small" tone="mut">Garmin&apos;s fitness levels are by age and sex. Leave either blank and the page still shows your number, just without the level.</T>
          <ErrorBanner message={about.error ? errorMessage(about.error) : null} />
        </View>
      </Card>
    </Screen>
  );
}
