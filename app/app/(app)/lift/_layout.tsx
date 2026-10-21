import { Stack } from 'expo-router';

import { useTheme } from '@/theme/ThemeProvider';

// Keep this tab's home screen under any deep link or reload, so a detail screen always has a back.
export const unstable_settings = { anchor: 'index' };

/**
 * The Lift tab's own screens: the live workout, the picker, the library, the routine editor. A
 * finished workout, an exercise and the recovery map live on the root stack (app/workout,
 * app/exercise, app/recovery), above the tabs, since every tab reaches them.
 */
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
      <Stack.Screen name="exercises/index" options={{ title: 'Exercises' }} />
      <Stack.Screen name="exercises/new" options={{ title: 'New exercise' }} />
      <Stack.Screen name="routines/[id]" options={{ title: 'Routine' }} />
      {/* development builds only, opened from Settings → Developer */}
      <Stack.Screen name="recovery-dev" options={{ title: 'Recovery map (dev)' }} />
    </Stack>
  );
}
