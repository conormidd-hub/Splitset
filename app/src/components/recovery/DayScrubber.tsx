import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  /** The sample times, oldest first, ISO; the last is now. */
  times: readonly string[];
  index: number;
  onChange: (index: number) => void;
  /** IANA zone for the labels (profiles.timezone). */
  timeZone?: string | null;
};

const fmt = (iso: string, timeZone: string | null | undefined, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: timeZone ?? undefined }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
  }
};

/**
 * The Recovery screen's history slider (build phase 9): one tick per day over the last 28, each
 * marked with its weekday's initial (Mondays stand out), dragged or tapped along; ◀ and ▶ step a
 * day, for screen readers too. The last tick is now.
 */
export function DayScrubber({ times, index, onChange, timeZone }: Props) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);
  const last = times.length - 1;
  const at = (x: number) => Math.max(0, Math.min(last, Math.floor((x / Math.max(1, width)) * times.length)));
  const move = (x: number) => { const i = at(x); if (i !== index) onChange(i); };
  const gesture = Gesture.Race(
    Gesture.Pan().runOnJS(true).minDistance(2).onBegin((e) => move(e.x)).onUpdate((e) => move(e.x)),
    Gesture.Tap().runOnJS(true).onEnd((e) => move(e.x)),
  );
  const label = index === last ? 'Now' : fmt(times[index], timeZone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <StepButton label="◀" name="Previous day" disabled={index <= 0} onPress={() => onChange(index - 1)} />
        <T weight="700" align="center" style={{ flex: 1 }} accessibilityLiveRegion="polite">{label}</T>
        <StepButton label="▶" name="Next day" disabled={index >= last} onPress={() => onChange(index + 1)} />
      </View>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`History, ${label}`}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => onChange(Math.max(0, Math.min(last, index + (e.nativeEvent.actionName === 'increment' ? 1 : -1))))}
          style={{ flexDirection: 'row', height: 40, alignItems: 'flex-end' }}>
          {times.map((t, i) => {
            const monday = fmt(t, timeZone, { weekday: 'short' }).startsWith('Mon');
            const on = i === index;
            return (
              <View key={t} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                <View style={{ width: on ? 6 : 3, height: on ? 22 : monday ? 16 : 10, borderRadius: radius.pill,
                  backgroundColor: on ? palette.accent : monday ? palette.ink2 : palette.hair }} />
                <T variant="tiny" tone={on ? 'accent' : 'mut'} style={{ fontSize: 9 }}>{fmt(t, timeZone, { weekday: 'narrow' })}</T>
              </View>
            );
          })}
        </View>
      </GestureDetector>
    </View>
  );
}

function StepButton({ label, name, disabled, onPress }: { label: string; name: string; disabled: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={name} hitSlop={6}
      style={({ pressed }) => ({ width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
        backgroundColor: palette.surface2, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 })}>
      <T weight="700">{label}</T>
    </Pressable>
  );
}
