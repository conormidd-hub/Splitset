import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { useProfile } from '@/api/profile';
import { useActivityCatchUp, useMuscleNames, useRecoveryHistory, useRecoveryMap, useThresholds, type RecoveryMap } from '@/api/recovery';
import { DayScrubber, historyLabel } from '@/components/recovery/DayScrubber';
import { NextReadyStrip, TrainNextCard } from '@/components/recovery/RecoveryExtras';
import { RecoveryFigure } from '@/components/recovery/RecoveryFigure';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { useNowHour } from '@/lib/clock';
import { HISTORY_DAYS, HISTORY_STEP_HOURS } from '@/lib/recovery/settings';
import { space } from '@/theme/tokens';

const HOUR_MS = 3_600_000;

/**
 * The Recovery screen (build phases 7 and 9): the recovery view now, a slider back through the
 * last 28 days (recovery_history, one sample a day, the figure crossfading between them), what
 * becomes trainable in the next 24 h, and what to train next. "Next ready" and Train next always
 * describe now. A failed refresh keeps the last map it read on screen, with a note above it.
 */
export default function Recovery() {
  useActivityCatchUp();
  const live = useRecoveryMap();
  const names = useMuscleNames();
  const c = useThresholds();
  const profile = useProfile();
  const timeZone = profile.data?.timezone ?? null;
  // the history ends on the current hour; its last sample is replaced by the live map. Its days
  // keep to this hour on the profile's clock, so a DST change neither skips nor repeats one
  const nowHour = useNowHour();
  const history = useRecoveryHistory(nowHour - HISTORY_DAYS * HISTORY_STEP_HOURS * HOUR_MS, nowHour, HISTORY_STEP_HOURS, timeZone);
  const [index, setIndex] = useState<number | null>(null);   // null: the last day, now
  const [previous, setPrevious] = useState<RecoveryMap | null>(null);
  // stable, so a render mid-crossfade doesn't restart it
  const onFaded = useCallback(() => setPrevious(null), []);

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
      <Card title="Fatigue" subtitle="Colour is how much each muscle is still carrying from recent workouts and activities">
        {shown ? (
          <View style={{ gap: space.md }}>
            {live.error ? <ErrorBanner message={`Couldn't refresh (${errorMessage(live.error)}), so the map may miss your latest workouts and activities.`} /> : null}
            {samples.length > 1 ? (
              <DayScrubber times={samples.map((s, i) => (i === last ? live.at : s.at))} index={at} onChange={choose} timeZone={timeZone} />
            ) : !history.data && history.error ? (
              <T variant="small" tone="mut">Couldn&apos;t load the last {HISTORY_DAYS} days.</T>
            ) : null}
            <RecoveryFigure
              map={shown}
              mode="recovery"
              nameOf={names}
              thresholds={c}
              timeZone={timeZone}
              previous={previous}
              fadeKey={at}
              onFaded={onFaded}
              context={at < last ? `fatigue on ${historyLabel(samples[at].at, timeZone)}` : undefined}
            />
          </View>
        ) : live.error ? <ErrorBanner message={errorMessage(live.error)} />
          : <Loading />}
      </Card>
      {live.data ? <NextReadyStrip map={live.data} nameOf={names} /> : null}
      {live.data ? <TrainNextCard map={live.data} nameOf={names} /> : null}
    </Screen>
  );
}
