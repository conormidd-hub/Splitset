import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useConnectIntervals, useConnection, useDisconnectIntervals, usePauseConnection, useSetPushPlan, useSyncRuns, useVerifyConnection } from '@/api/connections';
import { requestPlanPush } from '@/api/sync';
import { ConnectSteps } from '@/components/onboarding/ConnectSteps';
import { SyncNowBar } from '@/components/sync/SyncNowBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, Segmented } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { relativeDay, shortTime } from '@/lib/dates';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

/**
 * intervals.icu in Settings: the same step-by-step wizard as the welcome screen while nothing is
 * connected, and the management card once something is: check the key, change it, pause,
 * disconnect, and what goes to the watch.
 */
export default function Connect() {
  const { palette } = useTheme();
  const connection = useConnection();
  const runs = useSyncRuns(5);
  const connect = useConnectIntervals();
  const disconnect = useDisconnectIntervals();
  const pause = usePauseConnection();
  const pushPlan = useSetPushPlan();
  const verify = useVerifyConnection();

  const conn = connection.data;
  const connected = !!conn && conn.status !== 'disconnected';
  // the wizard stays up once it is on screen: its last step runs the first sync after the
  // connection row appears, so a successful connect must not swap it for the management card
  const [wizard, setWizard] = useState<boolean | null>(null);
  if (wizard === null && connection.isSuccess && !connected) setWizard(true);
  const showWizard = wizard ?? false;

  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');

  const saveKey = () => {
    if (!conn || !apiKey.trim()) return;
    connect.mutate(
      { athleteId: conn.athlete_id, apiKey },
      {
        onSuccess: () => {
          setEditing(false);
          setApiKey('');
          // confirm the new key with intervals.icu straight away, so a typo shows here, not at the next sync
          void verify.start();
        },
      },
    );
  };

  const onDisconnect = async () => {
    const ok = await confirm('Disconnect intervals.icu', 'Your stored API key is deleted. Activities already synced stay in Splitset.', 'Disconnect', true);
    if (ok) disconnect.mutate();
  };

  const checking = verify.state.state === 'sending' || verify.state.state === 'pending';

  if (showWizard) {
    return (
      <Screen>
        <T tone="mut">
          Splitset reads your runs and your watch&apos;s health data from intervals.icu twice a day. Your key is stored encrypted, and nothing but the sync can read it.
        </T>
        <ConnectSteps mode="settings" onDone={() => { setWizard(null); router.back(); }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <T tone="mut">
        Splitset reads your runs and your watch&apos;s health data from intervals.icu twice a day. Your key is stored encrypted, and nothing but the sync can read it.
      </T>

      {connected && conn ? (
        <Card title="Connection" right={<Badge label={conn.status.replace('_', ' ')} tone={conn.status === 'active' ? 'pos' : conn.status === 'auth_failed' ? 'neg' : 'mut'} />}>
          <View style={{ gap: 4 }}>
            <T>Athlete {conn.athlete_id}</T>
            <T variant="small" tone="mut">History from {conn.oldest_date}</T>
            <T variant="small" tone="mut">
              Last successful sync: {conn.last_success_at ? `${relativeDay(conn.last_success_at)} ${shortTime(conn.last_success_at)}` : 'never'}
            </T>
            {conn.last_error ? <ErrorBanner message={conn.last_error} /> : null}
          </View>
          <View style={{ marginTop: space.sm }}>
            <SyncNowBar />
          </View>
          <View style={{ marginTop: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            {checking ? <ActivityIndicator size="small" color={palette.mut} /> : null}
            <View style={{ flex: 1 }}>
              {checking ? <T variant="small" tone="mut">Checking with intervals.icu…</T> : null}
              {verify.state.state === 'ok' ? (
                <T variant="small" tone="pos">Connected as {verify.state.athlete.name ?? 'you'}{verify.state.athlete.athleteId ? ` (${verify.state.athlete.athleteId})` : ''}</T>
              ) : null}
              {verify.state.state === 'failed' ? <ErrorBanner message={verify.state.message} /> : null}
            </View>
            <Button title="Check connection" variant="ghost" small disabled={checking} onPress={() => { void verify.start(); }} />
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
            <Button title={conn.status === 'auth_failed' ? 'Reconnect' : 'Change key'} small variant="secondary" onPress={() => setEditing(true)} />
            {conn.status === 'active' || conn.status === 'paused' ? (
              <Button title={conn.status === 'paused' ? 'Resume' : 'Pause'} small variant="secondary" loading={pause.isPending} onPress={() => pause.mutate(conn.status !== 'paused')} />
            ) : null}
            <Button title="Disconnect" small variant="danger" loading={disconnect.isPending} onPress={onDisconnect} />
          </View>
        </Card>
      ) : null}

      {editing && conn ? (
        <Card title="New API key" subtitle="intervals.icu → Settings → Developer Settings, at the very bottom of the page">
          <View style={{ gap: space.md }}>
            <TextField
              label="API key"
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="paste your key"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={saveKey}
              hint={`Saved for athlete ${conn.athlete_id}. The connection is checked as soon as it is saved.`}
            />
            <Button title="Save" loading={connect.isPending} disabled={!apiKey.trim()} onPress={saveKey} />
            <Button title="Cancel" variant="ghost" small onPress={() => { setEditing(false); setApiKey(''); connect.reset(); }} />
            <ErrorBanner message={connect.error ? errorMessage(connect.error) : null} />
          </View>
        </Card>
      ) : null}

      {connected && conn ? (
        <Card title="Planned runs on your watch" subtitle="Through intervals.icu to Garmin Connect">
          <View style={{ gap: space.sm }}>
            <Segmented<'off' | 'on'>
              options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
              value={conn.push_plan ? 'on' : 'off'}
              onChange={(v) => pushPlan.mutate(v === 'on', { onSuccess: () => { if (v === 'on') requestPlanPush(0); } })}
            />
            <T variant="small" tone="mut">
              At every sync, planned runs for the next two weeks that have a distance or a time go to your intervals.icu calendar,
              and intervals.icu passes them on to Garmin Connect and the watch when planned-workout upload is on in its Garmin
              settings. Moving a session on the calendar moves it there; skipping or deleting one removes it. Race day stays off the watch.
            </T>
            <ErrorBanner message={pushPlan.error ? errorMessage(pushPlan.error) : null} />
          </View>
        </Card>
      ) : null}

      {runs.data?.length ? (
        <Card title="Recent syncs">
          {runs.data.map((r, i) => (
            <ListRow
              key={r.id}
              first={i === 0}
              title={`${relativeDay(r.started_at)} ${shortTime(r.started_at)}`}
              subtitle={r.error ? r.error.split('\n').slice(-1)[0] : `${r.activities_fetched} activities · ${r.wellness_days} wellness days · ${r.streams_fetched} details${r.plan_pushed ? ` · ${r.plan_pushed} to watch` : ''}`}
              badge={<Badge label={r.status} tone={r.status === 'ok' ? 'pos' : r.status === 'running' ? 'mut' : 'neg'} />}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
