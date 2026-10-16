import type { LiftPb, PbPeriods, RunPb } from '@/api/pbs';
import { formatLiftPb, formatLoad, formatRunPb, isNewThisMonth, LIFT_METRICS, mergeSession, RUN_PBS, type LiftMetric, type SessionBest } from '@/lib/pbs';
import type { Units } from '@/lib/units';

import type { PbCell, PbRow } from './PbTable';

/** One row per running PB that has ever been set (or every row, with `all`). */
export function runRows(index: Map<string, PbPeriods<RunPb>> | undefined, units: Units, all = false): PbRow[] {
  return RUN_PBS.flatMap(({ key, label }) => {
    const p = index?.get(key);
    if (!p?.all && !all) return [];
    const cell = (r: RunPb | undefined): PbCell => formatRunPb(r, units);
    return [{
      key, label,
      cells: [cell(p?.month), cell(p?.year), cell(p?.all)],
      isNew: isNewThisMonth(p?.all?.start_time_local),
      href: p?.all?.activity_id ? `/run/${p.all.activity_id}` : undefined,
    }];
  });
}

/** How a 1RM was arrived at: "tested" for a single that is its own e1RM (no reps in reserve),
 *  otherwise the set it was estimated from ("132.5×5"). */
function oneRmNote(r: LiftPb | undefined, units: Units): string | undefined {
  if (!r?.reps || r.weight_kg == null) return undefined;
  const tested = r.reps === 1 && r.value != null && Math.abs(r.value - r.weight_kg) < 0.05;
  return tested ? 'tested' : `${formatLoad(r.weight_kg, units).split(' ')[0]}×${r.reps}`;
}

/**
 * One row per metric an exercise has, Month / Year / All time. With `session`, sets ticked in the
 * workout on screen are folded in, so the numbers move as the lifter beats them.
 */
export function liftRows(
  byMetric: Map<string, PbPeriods<LiftPb>> | undefined,
  units: Units,
  opts: { session?: Partial<Record<LiftMetric, SessionBest>>; highlight?: LiftMetric | null; only?: LiftMetric[] } = {},
): PbRow[] {
  return LIFT_METRICS.flatMap(({ key, label }) => {
    if (opts.only && !opts.only.includes(key)) return [];
    const stored = byMetric?.get(key);
    const session = opts.session?.[key];
    if (!stored && !session && !opts.only) return [];
    const m = mergeSession(stored, session);
    const fmt = (v: number | null): string => formatLiftPb(key, v, units);
    const note = key === '1rm' ? (r: LiftPb | undefined) => oneRmNote(r, units) : () => undefined;
    return [{
      key, label,
      cells: [
        { value: fmt(m.month), sub: note(stored?.month) },
        { value: fmt(m.year), sub: note(stored?.year) },
        { value: fmt(m.all), sub: m.beatsAllTime ? 'this session' : note(stored?.all) },
      ],
      isNew: m.beatsAllTime || isNewThisMonth(stored?.all?.achieved_at),
      highlight: opts.highlight === key,
    }];
  });
}
