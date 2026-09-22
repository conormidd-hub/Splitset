import { Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

type IconName = SymbolViewProps['name'];

const icons = {
  today: { ios: 'house.fill', android: 'home', web: 'home' },
  plan: { ios: 'calendar', android: 'calendar_month', web: 'calendar_month' },
  lift: { ios: 'dumbbell.fill', android: 'fitness_center', web: 'fitness_center' },
  run: { ios: 'figure.run', android: 'directions_run', web: 'directions_run' },
  trends: { ios: 'chart.bar.fill', android: 'bar_chart', web: 'bar_chart' },
  settings: { ios: 'gear', android: 'settings', web: 'settings' },
} satisfies Record<string, IconName>;

function TabIcon({ name, color }: { name: IconName; color: ColorValue }) {
  return <SymbolView name={name} tintColor={typeof color === 'string' ? color : undefined} size={24} />;
}

function tabIcon(name: IconName) {
  const Icon = ({ color }: { color: ColorValue }) => <TabIcon name={name} color={color} />;
  Icon.displayName = 'TabBarIcon';
  return Icon;
}

export default function AppTabs() {
  const { palette } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.mut,
        tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.hair },
        sceneStyle: { backgroundColor: palette.bg },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: tabIcon(icons.today) }} />
      <Tabs.Screen name="plan" options={{ title: 'Plan', tabBarIcon: tabIcon(icons.plan) }} />
      <Tabs.Screen name="lift" options={{ title: 'Lift', tabBarIcon: tabIcon(icons.lift) }} />
      <Tabs.Screen name="run" options={{ title: 'Run', tabBarIcon: tabIcon(icons.run) }} />
      <Tabs.Screen name="trends" options={{ title: 'Trends', tabBarIcon: tabIcon(icons.trends) }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: tabIcon(icons.settings) }} />
    </Tabs>
  );
}
