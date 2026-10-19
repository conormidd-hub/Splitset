/**
 * Screen layout choices the app remembers on this device: whether Today's Latest activity card is
 * dropped open to show the last few. Persisted the same way as the map preferences.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { storage } from '@/lib/storage';

type State = {
  /** Today's Latest activity card shows the last three, not just the newest. */
  latestExpanded: boolean;
  setLatestExpanded: (v: boolean) => void;
};

export const useLayoutPrefs = create<State>()(
  persist(
    (set) => ({
      latestExpanded: false,
      setLatestExpanded: (latestExpanded) => set({ latestExpanded }),
    }),
    {
      name: 'splitset-layout-prefs',
      version: 2,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ latestExpanded: s.latestExpanded }),
      // version 1 remembered the Lift tab's collapsed recovery figure, which the tab no longer has
      migrate: (persisted, version) => {
        const old = (persisted ?? {}) as { latestExpanded?: boolean };
        if (version < 2) return { latestExpanded: false };
        return { latestExpanded: old.latestExpanded ?? false };
      },
    },
  ),
);
