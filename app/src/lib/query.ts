import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { AppState, Platform, type AppStateStatus } from 'react-native';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/** Make TanStack Query treat "app came to the foreground" as window focus on native. */
export function setupQueryFocus(): () => void {
  if (Platform.OS === 'web') return () => {};
  const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
    focusManager.setFocused(status === 'active');
  });
  onlineManager.setOnline(true);
  return () => sub.remove();
}
