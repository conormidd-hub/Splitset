import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';

import { T } from '@/components/ui/T';

import { useTheme } from '@/theme/ThemeProvider';

// Keep this tab's home screen under any deep link or reload, so a detail screen always has a back.
export const unstable_settings = { anchor: 'index' };

export default function SettingsStack() {
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
      {/* Settings opens from the gear on Today (it has no tab), so its first screen leads back there */}
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
          headerLeft: () => (
            <Pressable onPress={() => router.navigate('/')} accessibilityRole="button" accessibilityLabel="Back to Today" hitSlop={10} style={{ paddingRight: 8 }}>
              <T tone="accent" weight="600">‹ Today</T>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen name="connect" options={{ title: 'intervals.icu' }} />
      <Stack.Screen name="recovery" options={{ title: 'Recovery map' }} />
    </Stack>
  );
}
