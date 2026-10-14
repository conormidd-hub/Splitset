/**
 * What the run map remembers between visits: which metrics colour the trail (any mix of pace,
 * heart rate, cadence and elevation) and whether the extra charts are open. Persisted the same
 * way as the active workout.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { Metric } from '@/lib/runAnalysis';
import { storage } from '@/lib/storage';

type State = {
  /** Selected metrics in the order they were chosen; empty draws the plain trail. */
  metrics: Metric[];
  showCharts: boolean;
  /** Select a metric, or unselect it when it is already on. */
  toggleMetric: (m: Metric) => void;
  setMetrics: (ms: Metric[]) => void;
  setShowCharts: (v: boolean) => void;
};

export const useMapPrefs = create<State>()(
  persist(
    (set) => ({
      metrics: ['pace'],
      showCharts: false,
      toggleMetric: (m) => set((s) => ({ metrics: s.metrics.includes(m) ? s.metrics.filter((x) => x !== m) : [...s.metrics, m] })),
      setMetrics: (metrics) => set({ metrics }),
      setShowCharts: (showCharts) => set({ showCharts }),
    }),
    {
      name: 'splitset-map-prefs',
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ metrics: s.metrics, showCharts: s.showCharts }),
      // version 0 stored a single `metric`
      migrate: (persisted, version) => {
        const old = persisted as { metric?: Metric; metrics?: Metric[]; showCharts?: boolean };
        if (version < 1) return { metrics: old.metric ? [old.metric] : ['pace'], showCharts: old.showCharts ?? false };
        return old as { metrics: Metric[]; showCharts: boolean };
      },
    },
  ),
);
