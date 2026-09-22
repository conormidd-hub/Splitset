import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useConnection } from '@/api/connections';
import { useDeleteAccount, useProfile, useUpdateProfile } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { useSession } from '@/lib/session';
import { useTheme, type ThemeChoice } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

const STATUS_TONE = { active: 'pos', paused: 'mut', auth_failed: 'neg', disconnected: 'mut' } as const;

export default function Settings() {
  const { session, signOut } = useSession();
  const { choice, setChoice } = useTheme();
  const profile = useProfile();
  const update = useUpdateProfile();
  const del = useDeleteAccount();
  const connection = useConnection();

  // Inputs show the saved value until the user edits them; edits live here until saved.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [tzEdit, setTzEdit] = useState<string | null>(null);
  const name = nameEdit ?? profile.data?.display_name ?? '';
  const tz = tzEdit ?? profile.data?.timezone ?? '';
  const dirty = !!profile.data && (name.trim() !== profile.data.display_name || tz.trim() !== profile.data.timezone);
  const save = () =>
    update.mutate(
      { display_name: name.trim() || profile.data?.display_name, timezone: tz.trim() || 'UTC' },
      { onSuccess: () => { setNameEdit(null); setTzEdit(null); } },
    );
  const conn = connection.data;

  const onDelete = async () => {
    const ok = await confirm('Delete account', 'This removes your account and every activity, wellness day, workout and plan session. It cannot be undone.', 'Delete everything', true);
    if (ok) del.mutate();
  };

  return (
    <Screen title="Settings" subtitle={session?.user.email ?? ''}>
      <Card title="Data sources">
        <ListRow
          first
          title="intervals.icu"
          subtitle={conn ? `Athlete ${conn.athlete_id}` : 'Not connected'}
          badge={conn ? <Badge label={conn.status.replace('_', ' ')} tone={STATUS_TONE[conn.status as keyof typeof STATUS_TONE] ?? 'mut'} /> : undefined}
          onPress={() => router.push('/settings/connect')}
        />
      </Card>

      <Card title="Profile">
        <View style={{ gap: space.md }}>
          <TextField label="Display name" value={name} onChangeText={setNameEdit} autoCapitalize="words" />
          <TextField label="Time zone" value={tz} onChangeText={setTzEdit} autoCapitalize="none" hint="An IANA name such as Australia/Melbourne." />
          <View>
            <T variant="label" tone="mut" style={{ marginBottom: space.xs }}>Units</T>
            <Segmented
              options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }]}
              value={profile.data?.units ?? 'metric'}
              onChange={(units) => update.mutate({ units })}
            />
          </View>
          {dirty ? (
            <Button title="Save" small loading={update.isPending} onPress={save} />
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
          <Button title="Delete account and all data" variant="danger" loading={del.isPending} onPress={onDelete} />
          <ErrorBanner message={del.error ? errorMessage(del.error) : null} />
        </View>
      </Card>

      <T variant="tiny" tone="mut" align="center">Splitset 0.1.0</T>
    </Screen>
  );
}
