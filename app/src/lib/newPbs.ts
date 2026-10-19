// How many all-time bests were set this month: the Today PBs tile's number. Kept apart from
// metrics.ts (which reaches the API layer) so Node can test it; only type imports.

import type { LiftPbIndex, PbPeriods, RunPb } from '@/api/pbs';

/**
 * New all-time bests, running and lifting, counted the way the trophy cabinet counts them: one
 * per running distance and one per lift metric whose all-time best `isNew` accepts. `isNew` is
 * lib/pbs's isNewThisMonth, passed in so the month rule lives in one place.
 */
export function countNewPbs(
  runs: Map<string, PbPeriods<RunPb>> | undefined,
  lifts: LiftPbIndex | undefined,
  isNew: (achieved: string | null | undefined) => boolean,
): number {
  let n = 0;
  for (const p of runs?.values() ?? []) if (isNew(p.all?.start_time_local)) n++;
  for (const byMetric of lifts?.values() ?? []) {
    for (const p of byMetric.values()) if (isNew(p.all?.achieved_at)) n++;
  }
  return n;
}
