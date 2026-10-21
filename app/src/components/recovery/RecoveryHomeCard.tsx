import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { View } from 'react-native';

import { KeyButton } from './FigureKey';
import { FigurePair } from './FigurePair';
import { recoveryKeys, useActivityCatchUp, useMuscleNames, useRecoveryMap, useThresholds } from '@/api/recovery';
import { loadKeys } from '@/api/workoutLoads';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { fmtHours } from '@/lib/recovery/engine';
import { mostTired, nextReady } from '@/lib/recovery/screens';
import { useUserId } from '@/lib/session';
import { space } from '@/theme/tokens';

const FIGURE_WIDTH = 52;

/** The compact Recovery card on Today (build phase 7): a small front-and-back figure, the most
 *  tired muscles, and the next to become trainable. Tapping it opens the Recovery screen. If the
 *  map can't be read and nothing is cached, it says so and offers a retry. */
export function RecoveryHomeCard() {
  useActivityCatchUp();
  const qc = useQueryClient();
  const uid = useUserId();
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const c = useThresholds();
  const open = () => router.push('/lift/recovery');
  const retry = () => {
    void qc.invalidateQueries({ queryKey: loadKeys.all(uid) });
    void qc.invalidateQueries({ queryKey: recoveryKeys.libraryRows() });
  };
  const m = map.data;
  // while it shows the error the card is a plain View, so a screen reader reaches Retry on its own
  const failed = !m && !!map.error;
  const tired = m ? mostTired(m, 2) : [];
  const next = m ? nextReady(c, m)[0] : undefined;
  // one short line for screen readers, instead of both figures' summaries and every text in the card
  const summary = !m ? 'Recovery, loading'
    : `Recovery. ${tired.length ? `Most tired: ${tired.map((id) => `${names(id)} ${m[id].label}`).join(', ')}` : 'Every muscle is ready'}` +
      (next ? `. ${names(next.muscle)} trainable in ${fmtHours(next.in_h)}` : '');

  return (
    <View>
    {/* the key and Open sit over the card's corner as siblings: a button inside the card's button is not HTML */}
    <Card title="Recovery" onPress={failed ? undefined : open} accessibilityLabel={summary} accessibilityHint="Opens the Recovery screen"
      right={<View style={{ width: 96 }} />}>
      {m ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <FigurePair map={m} mode="recovery" figureWidth={FIGURE_WIDTH} nameOf={names} />
          <View style={{ flex: 1, gap: space.xs }}>
            {tired.length ? (
              <>
                <T variant="label" tone="mut">Most tired</T>
                {tired.map((id) => <T key={id} variant="small" weight="600">{names(id)} · {m[id].label}</T>)}
              </>
            ) : (
              <T variant="small" weight="600">Every muscle is ready.</T>
            )}
            {next ? (
              <T variant="small" tone="mut">{names(next.muscle)} trainable in {fmtHours(next.in_h)}</T>
            ) : null}
          </View>
        </View>
      ) : failed ? (
        <View style={{ gap: space.sm }}>
          <ErrorBanner message={`Couldn't load the recovery map. ${errorMessage(map.error)}`} />
          <Button title="Retry" variant="secondary" small onPress={retry} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : <Loading />}
    </Card>
    <View style={{ position: 'absolute', top: space.md, right: space.md, flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
      <KeyButton mode="recovery" size={26} />
      <Button title="Open" variant="ghost" small onPress={open} />
    </View>
    </View>
  );
}
