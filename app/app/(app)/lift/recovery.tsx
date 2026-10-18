import { useState } from 'react';
import { View } from 'react-native';

import { useProfile } from '@/api/profile';
import { useMuscleNames, useRecoveryHistory, useRecoveryMap, useThresholds, type RecoveryMap } from '@/api/recovery';
import { DayScrubber } from '@/components/recovery/DayScrubber';
import { NextReadyStrip, TrainNextCard } from '@/components/recovery/RecoveryExtras';
import { RecoveryFigure } from '@/components/recovery/RecoveryFigure';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { useNowHour } from '@/lib/clock';
import { HISTORY_DAYS, HISTORY_STEP_HOURS } from '@/lib/recovery/settings';
import { space } from '@/theme/tokens';

const HOUR_MS = 3_600_000;

/**
 * The Recovery screen (build phases 7 and 9): the recovery view now, a slider back through the
 * last 28 days (recovery_history, one sample a day, the figure crossfading between them), what
 * becomes trainable in the next 24 h, and what to train next. "Next ready" and Train next always
 * describe now.
 */
export default function Recovery() {
  const live = useRecoveryMap();
  const names = useMuscleNames();
  const c = useThresholds();
  const profile = useProfile();
  const timeZone = profile.data?.timezone ?? null;
  // the history ends on the current hour; its last sample is replaced by the live map
  const nowHour = useNowHour();
  const history = useRecoveryHistory(nowHour - HISTORY_DAYS * HISTORY_STEP_HOURS * HOUR_MS, nowHour, HISTORY_STEP_HOURS);
  const [index, setIndex] = useState<number | null>(null);   // null: the last day, now
  const [previous, setPrevious] = useState<RecoveryMap | null>(null);

  const samples = history.data ?? [];
  const last = samples.length - 1;
  const at = index ?? last;
  const mapAt = (i: number) => (i >= last ? live.data : samples[i]?.map) ?? null;
  const shown = mapAt(at);
  const choose = (i: number) => {
    if (i === at) return;
    setPrevious(shown);
    setIndex(i >= last ? null : i);
  };

  return (
    <Screen>
      <Card title="Fatigue" subtitle="Colour is how much each muscle is still carrying from recent workouts">
        {live.error ? <ErrorBanner message={errorMessage(live.error)} />
          : !shown ? <Loading />
          : (
            <View style={{ gap: space.md }}>
              {samples.length > 1 ? (
                <DayScrubber times={samples.map((s, i) => (i === last ? live.at : s.at))} index={at} onChange={choose} timeZone={timeZone} />
              ) : null}
              <RecoveryFigure
                map={shown}
                mode="recovery"
                nameOf={names}
                thresholds={c}
                timeZone={timeZone}
                previous={previous}
                fadeKey={at}
                onFaded={() => setPrevious(null)}
              />
            </View>
          )}
      </Card>
      {live.data ? <NextReadyStrip map={live.data} nameOf={names} /> : null}
      {live.data ? <TrainNextCard map={live.data} nameOf={names} /> : null}
    </Screen>
  );
}
