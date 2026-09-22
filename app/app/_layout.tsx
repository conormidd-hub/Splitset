import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { queryClient, setupQueryFocus } from '@/lib/query';
import { SessionProvider, useSession } from '@/lib/session';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  useEffect(() => setupQueryFocus(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ThemeProvider>
          <SplashController />
          <RootNavigator />
        </ThemeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function SplashController() {
  const { isLoading } = useSession();
  useEffect(() => {
    if (!isLoading) SplashScreen.hideAsync().catch(() => {});
  }, [isLoading]);
  return null;
}

function RootNavigator() {
  const { session, isLoading } = useSession();
  const { name, palette } = useTheme();
  const base = name === 'night' ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.accent,
      background: palette.bg,
      card: palette.surface,
      text: palette.ink,
      border: palette.hair,
      notification: palette.accent,
    },
  };

  if (isLoading) return null;

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={name === 'night' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.bg } }}>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </NavThemeProvider>
  );
}
