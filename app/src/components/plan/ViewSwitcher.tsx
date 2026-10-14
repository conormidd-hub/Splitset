import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { T } from '@/components/ui/T';
import type { IconName } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { radius } from '@/theme/tokens';

export type CalendarView = 'month' | 'week' | 'day';

export const VIEWS: { value: CalendarView; label: string; icon: IconName }[] = [
  { value: 'month', label: 'Month', icon: { ios: 'calendar', android: 'calendar_month', web: 'calendar_month' } },
  { value: 'week', label: 'Week', icon: { ios: 'rectangle.split.3x1', android: 'view_week', web: 'view_week' } },
  { value: 'day', label: 'Day', icon: { ios: 'calendar.day.timeline.left', android: 'calendar_view_day', web: 'calendar_view_day' } },
];

export const isCalendarView = (v: unknown): v is CalendarView => v === 'month' || v === 'week' || v === 'day';

/** Month, week or day: icons for all three, and the word only on the one you are in. */
export function ViewSwitcher({ value, onChange }: { value: CalendarView; onChange: (v: CalendarView) => void }) {
  const { palette } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', backgroundColor: palette.surface2, borderRadius: radius.md, padding: 3 }}>
      {VIEWS.map((v) => {
        const on = v.value === value;
        return (
          <Pressable
            key={v.value}
            onPress={() => onChange(v.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${v.label} view`}
            style={({ pressed }) => ({
              flex: 1, height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
              borderRadius: radius.sm, backgroundColor: on ? palette.surface : 'transparent',
              opacity: pressed ? 0.7 : 1,
            })}>
            <SymbolView name={v.icon} tintColor={on ? palette.accent : palette.mut} size={18} />
            {on ? (
              <Animated.View entering={FadeIn.duration(160)}>
                <T variant="small" weight="700" tone="ink">{v.label}</T>
              </Animated.View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
