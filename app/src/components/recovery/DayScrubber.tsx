import { useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
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

/** A sample's day and time as the slider shows it, e.g. "Tue 13 Oct, 14:00". */
export const historyLabel = (iso: string, timeZone?: string | null) =>
  fmt(iso, timeZone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The Recovery screen's history slider (build phase 9): one tick per day over the last 28, each
 * marked with its weekday's initial (Mondays stand out), dragged sideways or tapped along; a
 * vertical drag on it scrolls the page. ◀ and ▶ step a day, for screen readers too, and the strip
 * is adjustable with the day as its value. The last tick is now.
 */
export function DayScrubber({ times, index, onChange, timeZone }: Props) {
  const { palette } = useTheme();
  const [width, setWidth] = useState(0);
  const last = times.length - 1;
  const at = (x: number) => Math.max(0, Math.min(last, Math.floor((x / Math.max(1, width)) * times.length)));
  const move = (x: number) => { const i = at(x); if (i !== index) onChange(i); };
  // nothing moves on touch-down: the pan starts on a sideways drag and fails on a vertical one, so
  // the page's ScrollView keeps vertical scrolls; a tap is the Tap gesture's
  const gesture = Gesture.Race(
    Gesture.Pan().runOnJS(true).activeOffsetX([-6, 6]).failOffsetY([-10, 10])
      .onStart((e) => move(e.x)).onUpdate((e) => move(e.x)),
    Gesture.Tap().runOnJS(true).maxDistance(10).onEnd((e, ok) => { if (ok) move(e.x); }),
  );
  const labelAt = (i: number) => (i === last ? 'Now' : historyLabel(times[i], timeZone));
  const label = labelAt(index);
  // VoiceOver ignores the live region, and reads the strip's value before the new day reaches it
  // (the action runs asynchronously), so iOS is told the new day
  const step = (d: number) => {
    const i = Math.max(0, Math.min(last, index + d));
    if (i === index) return;
    onChange(i);
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(labelAt(i));
  };

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <StepButton label="◀" name="Previous day" disabled={index <= 0} onPress={() => step(-1)} />
        <T weight="700" align="center" style={{ flex: 1 }} accessibilityLiveRegion="polite">{label}</T>
        <StepButton label="▶" name="Next day" disabled={index >= last} onPress={() => step(1)} />
      </View>
      {/* pan-y so a vertical swipe on the strip still scrolls the page in a phone browser */}
      <GestureDetector gesture={gesture} touchAction="pan-y">
        <View
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="History"
          aria-valuetext={label}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
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
