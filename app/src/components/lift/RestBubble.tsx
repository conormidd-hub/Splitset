import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { QuickView } from '@/components/recovery/FigureBubble';
import { formatClock, stopRest } from '@/lib/restTimer';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** The rest lengths offered as chips; ±15 s reaches anything between. */
export const REST_CHOICES = [30, 60, 90, 120, 150, 180, 240, 300];
export const REST_MIN = 15;
export const REST_MAX = 600;

/**
 * The workout's rest timer, in the header: "⏱ Off" or "⏱ 1:30". Its panel turns it on or off and
 * sets how long; while it's on, ticking a set starts the countdown. Changeable all workout.
 */
export function RestBubble() {
  const { palette } = useTheme();
  const rest = useActiveWorkout((s) => s.workout?.rest) ?? { on: false, seconds: 90 };
  const setRest = useActiveWorkout((s) => s.setRest);
  const [open, setOpen] = useState(false);
  const step = (d: number) => setRest({ seconds: Math.max(REST_MIN, Math.min(REST_MAX, rest.seconds + d)) });
  const turn = (on: boolean) => {
    setRest({ on });
    if (!on) void stopRest();
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={rest.on ? `Rest timer on, ${formatClock(rest.seconds)}` : 'Rest timer off'}
        accessibilityHint="Turn the rest timer on or off, or change its length"
        hitSlop={4}
        style={({ pressed }) => ({
          height: 40, paddingHorizontal: space.md, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', gap: 4,
          backgroundColor: rest.on ? palette.accentSoft : palette.surface2, borderWidth: 1.5, borderColor: rest.on ? palette.accent : palette.hair,
          opacity: pressed ? 0.8 : 1,
        })}>
        <T variant="small">⏱</T>
        <T variant="small" weight="700" tone={rest.on ? 'accent' : 'mut'} style={{ fontVariant: ['tabular-nums'] }}>
          {rest.on ? formatClock(rest.seconds) : 'Off'}
        </T>
      </Pressable>
      <QuickView visible={open} onClose={() => setOpen(false)} title="Rest timer">
        <T variant="h3">Rest timer</T>
        <Segmented
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
          value={rest.on ? 'on' : 'off'}
          onChange={(v) => turn(v === 'on')}
        />
        <T variant="small" tone="mut">
          {rest.on ? 'Ticking a set starts the countdown.' : 'No timer between sets. Turn it on any time.'}
        </T>
        <View style={{ gap: space.sm, opacity: rest.on ? 1 : 0.5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, justifyContent: 'center' }}>
            <Button title="−15 s" small variant="secondary" disabled={rest.seconds <= REST_MIN} onPress={() => step(-15)} />
            <T variant="h1" style={{ minWidth: 80, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{formatClock(rest.seconds)}</T>
            <Button title="+15 s" small variant="secondary" disabled={rest.seconds >= REST_MAX} onPress={() => step(15)} />
          </View>
          <ChipRow>
            {REST_CHOICES.map((s) => (
              <Chip key={s} label={formatClock(s)} selected={rest.seconds === s} onPress={() => setRest({ seconds: s, on: true })} />
            ))}
          </ChipRow>
        </View>
        <Button title="Done" small onPress={() => setOpen(false)} />
      </QuickView>
    </>
  );
}
