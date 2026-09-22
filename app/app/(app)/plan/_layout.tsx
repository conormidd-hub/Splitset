import { Stack } from 'expo-router';

import { useTheme } from '@/theme/ThemeProvider';

export default function PlanStack() {
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
      <Stack.Screen name="[id]" options={{ title: 'Session' }} />
    </Stack>
  );
}
