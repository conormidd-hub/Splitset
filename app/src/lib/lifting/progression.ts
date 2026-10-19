// The Lift tab's progression charts, Strong style: one point per finished workout for an
// exercise, following the measure its card shows (best e1RM, heaviest set, volume or most reps).
// Pure, so it is tested under Node; src/api/liftTrends.ts reads the rows. Relative .ts imports,
// as in src/lib/recovery.

import { DEFAULT_LIFT_SLUGS, liftTrend, type LiftMeasure } from '../homeLayout.ts';
import { exerciseDef, setE1rm, type ExerciseRow } from '../recovery/sets.ts';
import type { Thresholds } from '../recovery/thresholds.ts';
import { kgToDisplay, type Units } from '../units.ts';
import { volumeKg } from './sideCounts.ts';

/** What the charts need to know about an exercise: the engine's columns and the bodyweight flag. */
export type ProgressExercise = ExerciseRow & { is_bodyweight: boolean };

/** A completed set of one exercise, with its workout, as src/api/liftTrends.ts reads it. */
export type ProgressSet = {
  workout_id: string;
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  e1rm: number | null;
  side: string | null;
  workout: { started_at: string; finished_at: string | null; bodyweight_kg: number | null };
};

/** One workout's bests for an exercise: kg for the weights, a count for reps. */
export type WorkoutBest = {
  workoutId: string;
  /** When the workout started, epoch ms. */
  at: number;
  e1rm: number | null;
  heaviest: number | null;
  volume: number | null;
  reps: number | null;
};

const MS_PER_DAY = 86_400_000;

/**
 * The measures a chart can follow for an exercise, its default first. Weight × reps has all four
 * while it has an e1RM: an assisted lift's weight is the help it had, so only its e1RM and reps
 * mean anything, and a bodyweight lift without a bodyweight share (or one saved by the old form,
 * with no load mode) has no e1RM, so it leads with reps. Reps-only lifts have reps, weighted
 * holds their heaviest, and timed holds nothing yet.
 */
export function liftMeasuresFor(ex: Pick<ProgressExercise, 'measure' | 'load_mode' | 'bw_factor' | 'is_bodyweight'>): LiftMeasure[] {
  if (ex.measure === 'reps') return ['reps'];
  if (ex.measure === 'weight_duration') return ['heaviest'];
  if (ex.measure !== 'weight_reps') return [];
  const relative = ex.load_mode === 'bodyweight' || ex.load_mode === 'assisted';
  const legacyBodyweight = ex.load_mode == null && ex.is_bodyweight;
  const hasE1rm = !legacyBodyweight && !(relative && ex.bw_factor == null);
  if (ex.load_mode === 'assisted') return hasE1rm ? ['e1rm', 'reps'] : ['reps'];
  return hasE1rm ? ['e1rm', 'heaviest', 'volume', 'reps'] : ['reps', 'heaviest', 'volume'];
}

/** The measure a new chart of the exercise starts on, or null when it can't be charted. */
export function defaultLiftMeasure(ex: Pick<ProgressExercise, 'measure' | 'load_mode' | 'bw_factor' | 'is_bodyweight'>): LiftMeasure | null {
  return liftMeasuresFor(ex)[0] ?? null;
}

/**
 * A set's e1RM as the app has it: the one stored when the set was saved (what the PBs read), or,
 * for a set saved before e1RMs were stored, the engine's own (src/lib/recovery/sets.ts) with the
 * workout's bodyweight snapshot, the user's rep cap and reps in reserve from RPE.
 */
export function e1rmOfSet(c: Thresholds, ex: ProgressExercise | undefined, s: ProgressSet): number | null {
  if (s.e1rm != null) return s.e1rm;
  if (!ex) return null;
  return setE1rm(c, exerciseDef(ex), { weightKg: s.weight_kg, reps: s.reps, rpe: s.rpe }, s.workout.bodyweight_kg);
}

const best = (a: number | null, b: number | null | undefined) => (b == null || !Number.isFinite(b) || b <= 0 ? a : a == null || b > a ? b : a);
/** lift_pbs keeps its bests to 0.1, so the chart's points match the PBs. */
const tenth = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * Each finished workout's bests, oldest first. Warm-ups never count, as on the PBs; a set from a
 * workout still going is left until it is finished. Volume counts a one-side set as half.
 */
export function workoutBests(sets: readonly ProgressSet[], e1rmOf: (s: ProgressSet) => number | null): WorkoutBest[] {
  const byWorkout = new Map<string, { at: number; sets: ProgressSet[] }>();
  for (const s of sets) {
    if (s.set_type === 'warmup' || !s.workout.finished_at) continue;
    const at = Date.parse(s.workout.started_at);
    if (Number.isNaN(at)) continue;
    const g = byWorkout.get(s.workout_id) ?? { at, sets: [] };
    g.sets.push(s);
    byWorkout.set(s.workout_id, g);
  }
  const out: WorkoutBest[] = [];
  for (const [workoutId, g] of byWorkout) {
    let e1rm: number | null = null;
    let heaviest: number | null = null;
    let reps: number | null = null;
    for (const s of g.sets) {
      e1rm = best(e1rm, e1rmOf(s));
      heaviest = best(heaviest, s.weight_kg);
      reps = best(reps, s.reps);
    }
    const volume = volumeKg(g.sets);
    out.push({ workoutId, at: g.at, e1rm: tenth(e1rm), heaviest, volume: volume > 0 ? tenth(volume) : null, reps });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Whether a measure is a weight (shown in the user's units) rather than a count. */
export const isWeightMeasure = (m: LiftMeasure) => m !== 'reps';

/**
 * The chart's points for one measure since `since` (epoch ms; null for all time), in the user's
 * units. Workouts without a value for the measure are left out rather than drawn as gaps.
 */
export function progressPoints(bests: readonly WorkoutBest[], measure: LiftMeasure, units: Units, since: number | null): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const b of bests) {
    const v = b[measure];
    if (v == null || (since != null && b.at < since)) continue;
    out.push({ x: b.at, y: isWeightMeasure(measure) ? kgToDisplay(v, units) : v });
  }
  return out;
}

/** The start of a range of `days` before `now`, or null for all time. */
export const rangeStart = (now: number, days: number | null) => (days == null ? null : now - days * MS_PER_DAY);

/** The latest and best points of a chart and how far the latest has moved from the first. */
export function progressSummary(points: readonly { x: number; y: number }[]): { latest: number; best: number; change: number } | null {
  if (!points.length) return null;
  const latest = points[points.length - 1].y;
  return { latest, best: Math.max(...points.map((p) => p.y)), change: latest - points[0].y };
}

/**
 * The Lift tab's charts until its owner changes them: the main compound lifts (by library slug)
 * that have completed sets, each on its default measure; failing those, the four lifts with the
 * most sets. `logged` is exercise_records: completed sets per exercise.
 */
export function defaultLiftTrends(
  exercises: readonly Pick<ProgressExercise, 'id' | 'slug' | 'measure' | 'load_mode' | 'bw_factor' | 'is_bodyweight'>[],
  logged: readonly { exercise_id: string | null; completed_sets: number | null }[],
  slugs: readonly string[] = DEFAULT_LIFT_SLUGS,
  fallback = 4,
): string[] {
  const sets = new Map(logged.map((r) => [r.exercise_id ?? '', r.completed_sets ?? 0]));
  const idOf = (ex: (typeof exercises)[number]) => {
    const m = defaultLiftMeasure(ex);
    return m ? liftTrend(ex.id, m) : null;
  };
  const main = slugs
    .map((slug) => exercises.find((e) => e.slug === slug))
    .filter((e): e is (typeof exercises)[number] => !!e && (sets.get(e.id) ?? 0) > 0)
    .map(idOf)
    .filter((id): id is string => id != null);
  if (main.length) return main;
  const byId = new Map(exercises.map((e) => [e.id, e]));
  return [...sets.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .map((e) => (e ? idOf(e) : null))
    .filter((id): id is string => id != null)
    .slice(0, fallback);
}
