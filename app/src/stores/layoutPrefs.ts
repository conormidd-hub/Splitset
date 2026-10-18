/**
 * Screen layout choices the app remembers on this device: whether the Lift tab's recovery
 * figure is collapsed into its header bubble. Persisted the same way as the map preferences.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { storage } from '@/lib/storage';

type State = {
  /** The Lift tab shows the recovery figure only as the bubble beside PBs. */
  liftFigureCollapsed: boolean;
  setLiftFigureCollapsed: (v: boolean) => void;
};

export const useLayoutPrefs = create<State>()(
  persist(
    (set) => ({
      liftFigureCollapsed: false,
      setLiftFigureCollapsed: (liftFigureCollapsed) => set({ liftFigureCollapsed }),
    }),
    {
      name: 'splitset-layout-prefs',
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ liftFigureCollapsed: s.liftFigureCollapsed }),
    },
  ),
);
