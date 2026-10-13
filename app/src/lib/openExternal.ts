import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

export const INTERVALS_SIGNUP = 'https://intervals.icu/signup';
export const INTERVALS_SETTINGS = 'https://intervals.icu/settings';

/**
 * Open a page on another site. On the web expo-linking swaps the current page for it, which
 * would throw the screen away (a wizard's step, a half-pasted key) on the way out to
 * intervals.icu; a new tab keeps the app where it was, so the person lands straight back where
 * they left. A popup blocker hands back null, and then the plain navigation is still better than nothing.
 */
export function openExternal(url: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const tab = window.open(url, '_blank');
    if (tab) {
      tab.opener = null;
      return;
    }
  }
  Linking.openURL(url).catch(() => {});
}
