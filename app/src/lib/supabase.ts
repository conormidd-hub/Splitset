import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import type { Database } from '@/types/database';

// Both values are public client keys. They must be referenced exactly like this
// (dot access on process.env) for Expo to inline them at bundle time.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

// During static web export this module runs in Node, where there is no window and
// no localStorage; supabase-js falls back to an in-memory store when storage is undefined.
const hasWindow = typeof window !== 'undefined';

export const supabase = createClient<Database>(
  url ?? 'https://not-configured.supabase.co',
  anonKey ?? 'not-configured',
  {
    auth: {
      storage: hasWindow ? AsyncStorage : undefined,
      autoRefreshToken: true,
      persistSession: true,
      // magic links only make sense where a URL can be opened in the app: the web build
      detectSessionInUrl: Platform.OS === 'web',
    },
  },
);

// Refresh tokens only while the app is in the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
