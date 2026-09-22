import { useState } from 'react';
import { View } from 'react-native';

import { useConnectIntervals, useConnection, useDisconnectIntervals, usePauseConnection, useSyncRuns } from '@/api/connections';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { confirm } from '@/lib/confirm';
import { daysAgoIso, relativeDay, shortTime } from '@/lib/dates';
import { space } from '@/theme/tokens';

export default function Connect() {
  const connection = useConnection();
  const runs = useSyncRuns(5);
  const connect = useConnectIntervals();
  const disconnect = useDisconnectIntervals();
  const pause = usePauseConnection();

  const conn = connection.data;
  const connected = !!conn && conn.status !== 'disconnected';
  const [editing, setEditing] = useState(false);
  const [athleteId, setAthleteId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [oldest, setOldest] = useState(daysAgoIso(730));

  const showForm = !connected || editing;

  const submit = () => {
    if (!athleteId.trim() || !apiKey.trim()) return;
    connect.mutate(
      { athleteId, apiKey, oldest: /^\d{4}-\d{2}-\d{2}$/.test(oldest.trim()) ? oldest.trim() : undefined },
      { onSuccess: () => { setEditing(false); setApiKey(''); } },
    );
  };

  const onDisconnect = async () => {
    const ok = await confirm('Disconnect intervals.icu', 'Your stored API key is deleted. Activities already synced stay in Splitset.', 'Disconnect', true);
    if (ok) disconnect.mutate();
  };

  return (
    <Screen>
      <T tone="mut">
        Splitset reads your activities and wellness from intervals.icu twice a day. Your API key is stored encrypted and only the sync job can read it.
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
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
            <Button title={conn.status === 'auth_failed' ? 'Reconnect' : 'Change key'} small variant="secondary" onPress={() => { setAthleteId(conn.athlete_id); setEditing(true); }} />
            {conn.status === 'active' || conn.status === 'paused' ? (
              <Button title={conn.status === 'paused' ? 'Resume' : 'Pause'} small variant="secondary" loading={pause.isPending} onPress={() => pause.mutate(conn.status !== 'paused')} />
            ) : null}
            <Button title="Disconnect" small variant="danger" loading={disconnect.isPending} onPress={onDisconnect} />
          </View>
        </Card>
      ) : null}

      {showForm ? (
        <Card title={connected ? 'Update credentials' : 'Connect'} subtitle="From intervals.icu → Settings, bottom of the page">
          <View style={{ gap: space.md }}>
            <TextField label="Athlete ID" value={athleteId} onChangeText={setAthleteId} placeholder="i123456" autoCapitalize="none" autoCorrect={false} />
            <TextField label="API key" value={apiKey} onChangeText={setApiKey} placeholder="paste your key" autoCapitalize="none" autoCorrect={false} secureTextEntry />
            {!connected ? (
              <TextField label="History from" value={oldest} onChangeText={setOldest} placeholder="YYYY-MM-DD" autoCapitalize="none" hint="The first backfill starts here. Two years is a sensible default." />
            ) : null}
            <Button title={connected ? 'Save' : 'Connect'} loading={connect.isPending} disabled={!athleteId.trim() || !apiKey.trim()} onPress={submit} />
            {connected ? <Button title="Cancel" variant="ghost" small onPress={() => setEditing(false)} /> : null}
            <ErrorBanner message={connect.error ? errorMessage(connect.error) : null} />
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
              subtitle={r.error ? r.error.split('\n').slice(-1)[0] : `${r.activities_fetched} activities · ${r.wellness_days} wellness days · ${r.streams_fetched} details`}
              badge={<Badge label={r.status} tone={r.status === 'ok' ? 'pos' : r.status === 'running' ? 'mut' : 'neg'} />}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
