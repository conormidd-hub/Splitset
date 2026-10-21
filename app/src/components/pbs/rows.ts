import type { LiftPb, PbPeriods, RunPb } from '@/api/pbs';
import type { Units } from '@/lib/units';
// relative .ts import (the rest are types), so Node can load this file in tests
import {
  bodyweightRelative, formatLiftPb, formatLoad, formatRunPb, isNewThisMonth, LIFT_METRICS, liftMetricApplies, mergeSession, RUN_PBS,
  type LiftMetric, type SessionBest,
} from '../../lib/pbs.ts';

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
 *  otherwise the set it was estimated from ("132.5×5"). A bodyweight or assisted lift's 1RM
 *  includes bodyweight (D4), so its set reads "BW+20×5", "BW×8" or "BW−30×8". */
export function oneRmNote(r: LiftPb | undefined, units: Units, loadMode?: string | null): string | undefined {
  if (!r?.reps) return undefined;
  const num = (kg: number) => formatLoad(kg, units).split(' ')[0];
  if (bodyweightRelative(loadMode)) {
    return `BW${r.weight_kg ? `${loadMode === 'assisted' ? '−' : '+'}${num(r.weight_kg)}` : ''}×${r.reps}`;
  }
  if (r.weight_kg == null) return undefined;
  const tested = r.reps === 1 && r.value != null && Math.abs(r.value - r.weight_kg) < 0.05;
  return tested ? 'tested' : `${num(r.weight_kg)}×${r.reps}`;
}

/**
 * One row per metric an exercise has, Month / Year / All time. With `session`, sets ticked in the
 * workout on screen are folded in, so the numbers move as the lifter beats them. Known bests the
 * user entered by hand already sit in the index (source 'manual') and their cells say "manual";
 * `manualAll` is the live panel's best manual entry per metric, counted as the all-time best to
 * beat. `loadMode` words the 1RM's set and drops what an assisted lift has no best in.
 */
export function liftRows(
  byMetric: Map<string, PbPeriods<LiftPb>> | undefined,
  units: Units,
  opts: {
    session?: Partial<Record<LiftMetric, SessionBest>>; highlight?: LiftMetric | null; only?: LiftMetric[];
    manualAll?: Partial<Record<LiftMetric, number | null>>; loadMode?: string | null;
  } = {},
): PbRow[] {
  return LIFT_METRICS.flatMap(({ key, label }) => {
    if (opts.only && !opts.only.includes(key)) return [];
    if (!liftMetricApplies(key, opts.loadMode)) return [];
    const stored = byMetric?.get(key);
    const session = opts.session?.[key];
    const manual = opts.manualAll?.[key] ?? null;
    if (!stored && !session && manual == null && !opts.only) return [];
    const m = mergeSession(stored, session, manual);
    // a manual entry above every logged set is the all-time best, so the logged one is neither its note nor new
    const manualWins = manual != null && !(stored?.all?.value != null && stored.all.value >= manual);
    const fmt = (v: number | null): string => formatLiftPb(key, v, units);
    const note = key === '1rm' ? (r: LiftPb | undefined) => oneRmNote(r, units, opts.loadMode) : () => undefined;
    // a known best's cell says so, whatever set it was
    const sub = (r: LiftPb | undefined) => (r?.source === 'manual' ? 'manual' : note(r));
    return [{
      key, label,
      cells: [
        { value: fmt(m.month), sub: sub(stored?.month) },
        { value: fmt(m.year), sub: sub(stored?.year) },
        { value: fmt(m.all), sub: m.beatsAllTime ? 'this session' : manualWins ? 'manual' : sub(stored?.all) },
      ],
      isNew: m.beatsAllTime || (!manualWins && isNewThisMonth(stored?.all?.achieved_at)),
      highlight: opts.highlight === key,
    }];
  });
}
