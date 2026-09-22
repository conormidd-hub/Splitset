import { Stack } from 'expo-router';

import { useTheme } from '@/theme/ThemeProvider';

export default function LiftStack() {
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
      <Stack.Screen name="workout" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="picker" options={{ title: 'Add exercise', presentation: 'modal' }} />
      <Stack.Screen name="history/[id]" options={{ title: 'Workout' }} />
      <Stack.Screen name="exercises/index" options={{ title: 'Exercises' }} />
      <Stack.Screen name="exercises/[id]" options={{ title: '' }} />
      <Stack.Screen name="routines/[id]" options={{ title: 'Routine' }} />
    </Stack>
  );
}
