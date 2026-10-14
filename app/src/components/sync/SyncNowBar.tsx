import { ActivityIndicator, View } from 'react-native';

import { useSyncRuns } from '@/api/connections';
import { useSyncNow } from '@/api/sync';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { relativeDay, shortTime } from '@/lib/dates';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

/** "Last sync Today 17:46 · ok" with a Sync now button; "Syncing…" while one runs. */
export function SyncNowBar() {
  const { palette } = useTheme();
  const { phase, message, start } = useSyncNow();
  const runs = useSyncRuns(1);
  const last = runs.data?.[0];
  const busy = phase === 'starting' || phase === 'waiting' || phase === 'running';
  const status = busy
    ? phase === 'running' ? 'Syncing…' : 'Starting a sync…'
    : message ?? (last ? `Last sync ${relativeDay(last.started_at).toLowerCase()} ${shortTime(last.started_at)} · ${last.status.replace('_', ' ')}` : 'Not synced yet');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {busy ? <ActivityIndicator size="small" color={palette.mut} /> : null}
      <T variant="small" tone={phase === 'failed' ? 'neg' : 'mut'} style={{ flex: 1 }}>{status}</T>
      <Button title="Sync now" variant="ghost" small disabled={busy} onPress={() => { void start(); }} />
    </View>
  );
}
