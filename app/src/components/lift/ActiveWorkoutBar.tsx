import { router, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable } from 'react-native';

import { T } from '@/components/ui/T';
import { useNowSeconds } from '@/lib/clock';
import { armIdleNotice, disarmIdleNotice } from '@/lib/idleTimer';
import { elapsedSeconds, formatElapsed, idleAt, shouldPause } from '@/lib/lifting/elapsed';
import { formatClock, useRestRemaining } from '@/lib/restTimer';
import { useActiveWorkout } from '@/stores/activeWorkout';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export const WORKOUT_PATH = '/lift/workout';
const BAR_HEIGHT = 44;

/**
 * The workout in progress, pinned above the tab bar on every tab: a pulsing dot, the workout's
 * name, its clock (or the rest countdown while one runs, and "Rest over" on an accent bar when it
 * ends), and Resume. Tapping anywhere reopens the workout. Hidden while the workout screen itself
 * is open, but mounted all the time: it is also where the idle clock is watched, pausing the
 * workout ten minutes after its last edit and keeping the "Still lifting?" notification set.
 */
export function ActiveWorkoutBar() {
  const { palette } = useTheme();
  const workout = useActiveWorkout((s) => s.workout);
  const pathname = usePathname();
  const nowSeconds = useNowSeconds();
  const rest = useRestRemaining();
  const [pulse] = useState(() => new Animated.Value(1));
  const paused = !!workout?.pausedAt;
  const visible = !!workout && pathname !== WORKOUT_PATH;

  // the idle watch, once a second
  useEffect(() => {
    if (workout && shouldPause(workout, nowSeconds * 1000)) {
      useActiveWorkout.getState().pause(new Date(idleAt(workout)).toISOString());
    }
  }, [workout, nowSeconds]);

  // the notification for the idle moment follows the last edit; none while paused or finished
  const workoutId = workout?.id;
  const name = workout?.name ?? 'Your workout';
  const lastActiveAt = workout?.lastActiveAt ?? workout?.startedAt;
  useEffect(() => {
    if (workoutId && lastActiveAt && !paused) void armIdleNotice(lastActiveAt, name);
    else void disarmIdleNotice();
  }, [workoutId, lastActiveAt, paused, name]);

  // the dot breathes while the workout is live; it holds while paused
  useEffect(() => {
    if (!visible || paused) {
      pulse.setValue(1);
      return;
    }
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.3, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [visible, paused, pulse]);

  if (!workout || !visible) return null;

  const elapsed = formatElapsed(elapsedSeconds(workout, nowSeconds * 1000));
  const restOver = !!rest && rest.remaining === 0;
  const middle = rest ? (restOver ? 'Rest over' : `Rest ${formatClock(rest.remaining)}`) : paused ? `${elapsed} · paused` : elapsed;
  const textTone = restOver ? 'onAccent' : rest ? 'accent' : paused ? 'mut' : 'ink2';

  return (
    <Pressable
      onPress={() => router.push(WORKOUT_PATH, { withAnchor: true })}
      accessibilityRole="button"
      accessibilityLabel={`Workout in progress: ${workout.name}, ${middle}. Opens it.`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, height: BAR_HEIGHT,
        backgroundColor: restOver ? palette.accent : palette.surface, borderTopWidth: 1, borderTopColor: palette.hair,
        opacity: pressed ? 0.85 : 1,
      })}>
      <Animated.View
        style={{ width: 8, height: 8, borderRadius: 4, opacity: pulse, backgroundColor: restOver ? palette.onAccent : paused ? palette.mut : palette.accent }}
      />
      <T variant="small" weight="700" numberOfLines={1} tone={restOver ? 'onAccent' : 'ink'} style={{ flex: 1 }}>{workout.name}</T>
      <T variant="small" weight="600" tone={textTone} style={{ fontVariant: ['tabular-nums'] }}>{middle}</T>
      <T variant="small" weight="700" tone={restOver ? 'onAccent' : 'accent'}>Resume ›</T>
    </Pressable>
  );
}
