/**
 * What the run map remembers between visits: which metric colours the trail and whether the
 * extra charts are open. Persisted the same way as the active workout.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { Metric } from '@/lib/runAnalysis';
import { storage } from '@/lib/storage';

type State = {
  metric: Metric;
  showCharts: boolean;
  setMetric: (m: Metric) => void;
  setShowCharts: (v: boolean) => void;
};

export const useMapPrefs = create<State>()(
  persist(
    (set) => ({
      metric: 'pace',
      showCharts: false,
      setMetric: (metric) => set({ metric }),
      setShowCharts: (showCharts) => set({ showCharts }),
    }),
    {
      name: 'splitset-map-prefs',
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ metric: s.metric, showCharts: s.showCharts }),
    },
  ),
);
