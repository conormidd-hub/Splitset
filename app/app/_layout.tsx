import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { queryClient, setupQueryFocus } from '@/lib/query';
import { SessionProvider, useSession } from '@/lib/session';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  useEffect(() => setupQueryFocus(), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <ThemeProvider>
            <SplashController />
            <RootNavigator />
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
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

  const header = {
    headerStyle: { backgroundColor: palette.bg },
    headerShadowVisible: false,
    headerTintColor: palette.ink,
    headerTitleStyle: { fontWeight: '700' as const },
    headerBackButtonDisplayMode: 'minimal' as const,
  };

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={name === 'night' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.bg } }}>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(app)" />
          {/* the first-run wizard: Today sends a new account here until it connects or skips */}
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          {/* above the tabs: reached from Today, Lift and the workout sheet alike */}
          <Stack.Screen name="pbs" options={{ headerShown: true, title: 'Personal bests', ...header }} />
          {/* one metric, opened from an In focus or At a glance tile; the page sets its own title */}
          <Stack.Screen name="metric/[id]" options={{ headerShown: true, title: '', ...header }} />
          {/* the month view: the streak, what was done and what is planned, from the flame on Today and the Plan */}
          <Stack.Screen name="calendar" options={{ headerShown: true, title: 'Calendar', ...header }} />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </NavThemeProvider>
  );
}
