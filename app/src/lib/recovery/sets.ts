// From stored rows to engine inputs, and the e1RM a set stores when it is saved (spec §3.3).
// Shared by the logger, the manual-PB form, the PB screens and app/scripts/recovery-cli.ts (the
// backfill and the database tests), so a set gets the same e1RM wherever it is computed.
// Every number comes from the Phase 2 engine; nothing here is new maths.

import { e1rm, effectiveWeight, rirFromRpe } from './engine.ts';
import { ROLES } from './library.ts';
import type { FatigueClass, Thresholds } from './thresholds.ts';
import type { ExerciseDef, LoadMode, Model } from './types.ts';

/** The exercises columns the engine reads. A database row has them all. */
export interface ExerciseRow {
  id: string;
  slug: string | null;
  measure: string;
  load_mode: string | null;
  bw_factor: number | null;
  fatigue: string | null;
  pb_estimate_from: string | null;
  pb_estimate_ratio: number | null;
  is_unilateral: boolean;
}

/** An exercise_muscles row. */
export interface ExerciseMuscleRow {
  exercise_id: string;
  muscle_id: string;
  role: string;
}

const LOAD_MODES: readonly string[] = ['weight', 'bodyweight', 'assisted', 'fixed'] satisfies LoadMode[];
const FATIGUE: readonly string[] = ['high', 'standard', 'low'] satisfies FatigueClass[];

/**
 * The key an exercise has in the engine's library and PB history: its slug, or its id when it
 * has none (an exercise outside the library). pb_estimate links name slugs, so they resolve.
 */
export function engineKey(ex: { id: string; slug: string | null }): string {
  return ex.slug ?? ex.id;
}

/**
 * The engine's view of an exercise row, or null when the engine cannot weigh its sets. A library
 * exercise (it has a load_mode) maps as it is. One outside the library that is logged as
 * weight × reps is taken as plain weight mode, so custom and legacy lifts still get an e1RM; it
 * loads no muscles until it is mapped (Phase 8). Anything else (holds, carries, cardio) is null.
 */
export function exerciseDef(row: ExerciseRow, muscles: readonly ExerciseMuscleRow[] = []): ExerciseDef | null {
  const roles = { primary: [] as string[], secondary: [] as string[], tertiary: [] as string[] };
  for (const m of muscles) {
    if (m.exercise_id === row.id && (ROLES as readonly string[]).includes(m.role)) roles[m.role as keyof typeof roles].push(m.muscle_id);
  }
  const pb_estimate = row.pb_estimate_from && row.pb_estimate_ratio ? { from: row.pb_estimate_from, ratio: row.pb_estimate_ratio } : null;
  if (row.load_mode && LOAD_MODES.includes(row.load_mode)) {
    return {
      slug: engineKey(row), load_mode: row.load_mode as LoadMode, bw_factor: row.bw_factor,
      fatigue: (row.fatigue && FATIGUE.includes(row.fatigue) ? row.fatigue : 'standard') as FatigueClass,
      ...roles, pb_estimate, unilateral: row.is_unilateral,
    };
  }
  if (row.measure === 'weight_reps') {
    return { slug: engineKey(row), load_mode: 'weight', bw_factor: null, fatigue: 'standard', ...roles, pb_estimate, unilateral: row.is_unilateral };
  }
  return null;
}

/** The fields of a set that its e1RM depends on. */
export interface SetForE1rm {
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
}

/**
 * The e1RM a set stores (spec §3.3): the engine's effective weight for the exercise's load mode,
 * with the workout's bodyweight snapshot (else `fallbackBodyweight`), and reps plus reps in
 * reserve from RPE, or rir_default without one. The same rule scoreExercise uses for the
 * records it creates. Null when the set has no effective weight above zero or no reps.
 */
export function setE1rm(
  c: Thresholds, def: ExerciseDef | null, s: SetForE1rm, workoutBodyweight: number | null, fallbackBodyweight?: number | null,
): number | null {
  if (!def) return null;
  const w = effectiveWeight({ w: s.weightKg, r: s.reps, bodyweight: workoutBodyweight }, def, fallbackBodyweight || c.bodyweight_default_kg);
  if (!w || w <= 0 || s.reps == null) return null;
  const model: Model = { c, lib: new Map() };
  return e1rm(model, w, s.reps, rirFromRpe(s.rpe) ?? c.e1rm.rir_default);
}

/** Where the current bodyweight comes from. */
export type BodyweightSource = 'profile' | 'weigh-in' | 'default';

/**
 * The bodyweight to snapshot now: whichever is newer of the one the user typed in their profile
 * and their latest weigh-in (Garmin, through intervals.icu), else bodyweight_default_kg. A
 * profile entry made on the day of a weigh-in wins, since the user typed it.
 */
export function currentBodyweight(
  c: Thresholds,
  profile: { bodyweight_kg: number | null; bodyweight_updated_at: string | null } | null | undefined,
  weighIn: { weight_kg: number | null; date: string } | null | undefined,
): { kg: number; source: BodyweightSource; date: string | null } {
  const typed = profile?.bodyweight_kg != null ? { kg: profile.bodyweight_kg, at: profile.bodyweight_updated_at } : null;
  const weighed = weighIn?.weight_kg != null ? { kg: weighIn.weight_kg, date: weighIn.date } : null;
  if (typed && (!weighed || !typed.at || Date.parse(typed.at) >= Date.parse(`${weighed.date}T00:00:00Z`))) {
    return { kg: typed.kg, source: 'profile', date: typed.at };
  }
  if (weighed) return { kg: weighed.kg, source: 'weigh-in', date: weighed.date };
  return { kg: c.bodyweight_default_kg, source: 'default', date: null };
}
