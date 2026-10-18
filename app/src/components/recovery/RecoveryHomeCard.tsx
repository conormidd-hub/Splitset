import { router } from 'expo-router';
import { View } from 'react-native';

import { FigurePair } from './FigurePair';
import { useMuscleNames, useRecoveryMap, useThresholds } from '@/api/recovery';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { fmtHours } from '@/lib/recovery/engine';
import { mostTired, nextReady } from '@/lib/recovery/screens';
import { space } from '@/theme/tokens';

const FIGURE_WIDTH = 52;

/** The compact Recovery card on Today (build phase 7): a small front-and-back figure, the most
 *  tired muscles, and the next to become trainable. Tapping it opens the Recovery screen. */
export function RecoveryHomeCard() {
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const c = useThresholds();
  const open = () => router.push('/lift/recovery');
  const m = map.data;
  const tired = m ? mostTired(m, 2) : [];
  const next = m ? nextReady(c, m)[0] : undefined;

  return (
    <Card title="Recovery" onPress={open} right={<Button title="Open" variant="ghost" small onPress={open} />}>
      {!m ? <Loading /> : (
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
      )}
    </Card>
  );
}
