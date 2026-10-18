// The engine's PB history from pb_history rows, the bests the PB screen shows, and the words
// for where a reference comes from. Pure: rows in, plain values out.

import { pbBefore } from './engine.ts';
import type { Thresholds } from './thresholds.ts';
import type { Model, PbBefore, PbRecord } from './types.ts';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;

/** The engine's clock: hours since the epoch (notes §7). */
export function hoursOf(iso: string | number): number {
  return (typeof iso === 'number' ? iso : Date.parse(iso)) / MS_PER_HOUR;
}

/** A pb_history row. */
export interface PbHistoryRow {
  exercise_id: string;
  e1rm: number;
  at: string;
  source: string;
  weight_kg: number | null;
  reps: number | null;
  set_type: string | null;
  workout_id: string | null;
  manual_pb_id: string | null;
}

/**
 * The engine's PB history: one record per row, keyed by the exercise's engine key (its slug, or
 * its id outside the library) and dated in hours. Rows for exercises keyOf does not know are
 * dropped.
 */
export function toPbHistory(rows: readonly PbHistoryRow[], keyOf: (exerciseId: string) => string | undefined): PbRecord[] {
  const out: PbRecord[] = [];
  for (const r of rows) {
    const slug = keyOf(r.exercise_id);
    if (slug === undefined || r.e1rm == null) continue;
    out.push({ slug, e1rm: r.e1rm, at: hoursOf(r.at), source: r.source === 'manual' ? 'manual' : 'logged' });
  }
  return out;
}

/**
 * The exercise ids whose pb_history rows can change how `exerciseIds` score: each exercise and
 * every exercise its pb_estimate chain reaches, walked as pbBefore walks it (up to
 * estimate_max_hops). `keyOf` maps exercise ids to engine keys. Finishing a workout reads only
 * these, dated before it started, instead of the whole history.
 */
export function historyScope(m: Model, keyOf: ReadonlyMap<string, string>, exerciseIds: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const id of exerciseIds) {
    const key = keyOf.get(id);
    if (key === undefined) continue;
    keys.add(key);
    let cur = m.lib.get(key);
    for (let hops = 0; cur?.pb_estimate && hops < m.c.pb.estimate_max_hops; hops++) {
      keys.add(cur.pb_estimate.from);
      cur = m.lib.get(cur.pb_estimate.from);
    }
  }
  return [...keyOf].filter(([, key]) => keys.has(key)).map(([id]) => id);
}

/** Best e1RM of one exercise over the PB window before `now` (both sources) and of all time. */
export function bests(m: Model, history: readonly PbRecord[], key: string, now: number): { window: number | null; allTime: number | null } {
  const from = now - m.c.pb.window_days * HOURS_PER_DAY;
  let window: number | null = null;
  let allTime: number | null = null;
  for (const h of history) {
    if (h.slug !== key || h.at > now) continue;
    if (allTime == null || h.e1rm > allTime) allTime = h.e1rm;
    if (h.at >= from && (window == null || h.e1rm > window)) window = h.e1rm;
  }
  return { window, allTime };
}

export type ReferenceTone = 'logged' | 'manual' | 'lapsed' | 'estimated' | 'calibrating';

/**
 * How the PB screen names a reference's source (Phase 3): logged, manual, lapsed, estimated from
 * <exercise>, or calibrating. `nameOf` turns an engine key into the exercise's name.
 */
export function referenceSource(c: Thresholds, ref: PbBefore, nameOf: (key: string) => string | undefined): { tone: ReferenceTone; label: string } {
  switch (ref.source) {
    case 'monthly':
      return ref.detail === 'manual'
        ? { tone: 'manual', label: 'Manual: your known best' }
        : { tone: 'logged', label: `Logged in the last ${c.pb.window_days} days` };
    case 'lapsed': {
      const less = Math.round((1 - c.pb.lapsed_factor) * 100);
      return { tone: 'lapsed', label: `Lapsed: your last ${ref.detail === 'manual' ? 'known best' : `${c.pb.window_days} days of sets`}, less ${less}%` };
    }
    case 'estimated':
      return { tone: 'estimated', label: `Estimated from ${(ref.detail && nameOf(ref.detail)) ?? 'a related lift'}` };
    default:
      return { tone: 'calibrating', label: 'Calibrating: your first session sets it' };
  }
}

/** The reference a session starting at `now` would use, and how to name its source. */
export function strengthReference(m: Model, key: string, now: number, history: readonly PbRecord[], nameOf: (key: string) => string | undefined) {
  const ref = pbBefore(m, key, now, history);
  return { ...ref, ...referenceSource(m.c, ref, nameOf) };
}

/** One line of the PB history list: the best set of a workout, or a manual entry. */
export interface PbHistoryItem {
  key: string;
  source: 'logged' | 'manual';
  at: string;
  e1rm: number;
  weightKg: number | null;
  reps: number | null;
  workoutId: string | null;
  manualPbId: string | null;
}

/** One exercise's history for the PB screen: each workout's best e1RM and each manual entry, newest first. */
export function pbHistoryItems(rows: readonly PbHistoryRow[], exerciseId: string): PbHistoryItem[] {
  const byWorkout = new Map<string, PbHistoryItem>();
  const manual: PbHistoryItem[] = [];
  for (const r of rows) {
    if (r.exercise_id !== exerciseId || r.e1rm == null) continue;
    const item: PbHistoryItem = {
      key: r.manual_pb_id ?? r.workout_id ?? r.at, source: r.source === 'manual' ? 'manual' : 'logged', at: r.at,
      e1rm: r.e1rm, weightKg: r.weight_kg, reps: r.reps, workoutId: r.workout_id, manualPbId: r.manual_pb_id,
    };
    if (item.source === 'manual' || !r.workout_id) manual.push(item);
    else {
      const prev = byWorkout.get(r.workout_id);
      if (!prev || item.e1rm > prev.e1rm) byWorkout.set(r.workout_id, item);
    }
  }
  return [...byWorkout.values(), ...manual].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
