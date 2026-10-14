import { Stack } from 'expo-router';

import { useTheme } from '@/theme/ThemeProvider';

// Keep this tab's home screen under any deep link or reload, so a detail screen always has a back.
export const unstable_settings = { anchor: 'index' };

export default function RunStack() {
  const { palette } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: palette.bg },
        headerShadowVisible: false,
        headerTintColor: palette.ink,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: palette.bg },
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ title: '' }} />
      <Stack.Screen name="heatmap" options={{ title: 'Maps' }} />
      <Stack.Screen name="segments/index" options={{ title: 'Segments' }} />
      <Stack.Screen name="segments/[id]" options={{ title: 'Segment' }} />
      <Stack.Screen name="routes/index" options={{ title: 'Routes' }} />
      <Stack.Screen name="routes/new" options={{ title: 'New route' }} />
      <Stack.Screen name="routes/[id]" options={{ title: 'Route' }} />
    </Stack>
  );
}
