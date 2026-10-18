// Build phase 5: the read side. recovery_map(user, at), session_map(workout) and
// recovery_history(user, from, to, step) over the per-workout cache that phase 4 writes, as
// recovery_loads() returns it. Pure: rows in, plain values out, and every number comes from the
// Phase 2 engine. The app (src/api/recovery.ts) and app/scripts/recovery-cli.ts (the database
// tests) both call these.
//
// Times are engine hours (epoch ms ÷ 3,600,000). A map at `at` only ever sees workouts finished by
// `at`, so a past moment reads as it did then, ready and trainable times included.

import { cardioKind, cardioRole } from './cardio.ts';
import { lookbackHours, recoveryHours, sessionMap } from './engine.ts';
import { isMuscleId, MUSCLE_IDS, ROLES, type MuscleId, type Role } from './library.ts';
import { hoursOf } from './pbHistory.ts';
import type { Model, MuscleState, ScoredWorkout, SessionMuscle } from './types.ts';
import { recoveryMapFromLoads, type MuscleLoadRow } from './workoutLoads.ts';

const MS_PER_HOUR = 3_600_000;
/** recovery_history refuses more samples than this. */
export const MAX_SAMPLES = 1000;

// ---------------------------------------------------------------- rows

/** A workout_muscle_loads row as recovery_loads() returns it. */
export interface WindowMuscleRow extends MuscleLoadRow {
  workout_id: string | null;
  activity_id?: string | null;
  source?: string;
}

/** A workout_exercise_loads row as recovery_loads() returns it: with the exercise's name and its
 *  workout's finish time. */
export interface WindowExerciseRow {
  workout_id: string;
  exercise_id: string;
  name: string;
  load: number;
  pb_source: string;
  pb_detail: string | null;
  pb_value: number | null;
  finished_at: string;
}

/** An imported activity in the window (build phase 10), for its contributions. */
export interface WindowActivityRow {
  activity_id: string;
  name: string | null;
  type: string;
  finished_at: string;
}

/** What recovery_loads(from, to) returns. */
export interface LoadWindow {
  muscles: readonly WindowMuscleRow[];
  exercises: readonly WindowExerciseRow[];
  /** Imported activities with rows in the window (build phase 10). */
  activities?: readonly WindowActivityRow[];
}

// ---------------------------------------------------------------- results

/** One exercise's share of a muscle's weekly load, for the tap detail (spec §10). */
export interface Contribution {
  exercise_id: string;
  /** The exercise's name. */
  exercise: string;
  workout_id: string;
  /** The workout's finish time (t_w), ISO. */
  workout_date: string;
  role: Role;
  /** role_weight × L_e */
  load: number;
  pb_source: string;
  pb_detail: string | null;
}

export type RecoveryMuscle = MuscleState & { contributing: Contribution[] };
export type RecoveryMap = Record<MuscleId, RecoveryMuscle>;

/** One muscle on the session view: this workout's own load, and hours after it finished until the
 *  muscle is trainable and ready (spec §7). */
export interface SessionMapMuscle {
  L: number;
  level: number;
  label: string;
  fill: string;
  fill_dark: string;
  R: number;
  trainable_after_h: number;
  ready_after_h: number;
}
export type SessionMap = Record<MuscleId, SessionMapMuscle>;

export interface RecoverySample {
  /** ISO */
  at: string;
  map: RecoveryMap;
}

// ---------------------------------------------------------------- windows

/** An instant in engine hours as ISO. */
export function isoOfHours(h: number): string {
  return new Date(Math.round(h * MS_PER_HOUR)).toISOString();
}

/** How far back a map reads: the longest recovery window plus the weekly window (build phase 5). */
export function readSpanHours(m: Model): number {
  return lookbackHours(m) + m.c.fatigue.weekly_window_hours;
}

/** The rows a map at `at` needs: finished in (at − span, at]. */
export function readWindow(m: Model, at: number): { from: number; to: number } {
  return { from: at - readSpanHours(m), to: at };
}

/** The rows a history from `from` to `to` needs. */
export function historyWindow(m: Model, from: number, to: number): { from: number; to: number } {
  return { from: from - readSpanHours(m), to };
}

// ---------------------------------------------------------------- recovery_map

/**
 * Every muscle's state at `at` from the cache (spec §8–§9), each with the exercises behind its
 * weekly load: those of workouts finished in the weekly window before `at` (the same window W
 * sums), with role_weight × L_e, largest first. The contributions add up to W. Rows finished
 * after `at` are left out. `keyOf` maps exercise ids to the library's keys, for their roles.
 */
export function recoveryMapAt(m: Model, keyOf: ReadonlyMap<string, string>, loads: LoadWindow, at: number): RecoveryMap {
  const { from } = readWindow(m, at);
  const inWindow = (iso: string) => {
    const t = hoursOf(iso);
    return t > from && t <= at;
  };
  const states = recoveryMapFromLoads(m, loads.muscles.filter((r) => inWindow(r.finished_at)), at);

  const week = m.c.fatigue.weekly_window_hours;
  const contributing = Object.fromEntries(MUSCLE_IDS.map((id) => [id, [] as Contribution[]])) as Record<MuscleId, Contribution[]>;
  for (const x of loads.exercises) {
    const age = at - hoursOf(x.finished_at);
    if (!(age >= 0 && age < week) || !(x.load > 0)) continue;
    const def = m.lib.get(keyOf.get(x.exercise_id) ?? '');
    if (!def) continue;
    for (const role of ROLES) {
      for (const muscle of def[role]) {
        if (!isMuscleId(muscle)) continue;
        contributing[muscle].push({
          exercise_id: x.exercise_id, exercise: x.name, workout_id: x.workout_id, workout_date: x.finished_at, role,
          load: m.c.role_weights[role] * x.load, pb_source: x.pb_source, pb_detail: x.pb_detail,
        });
      }
    }
  }
  // imported activities: each of their rows is already role_weight × L_e for that muscle
  const activities = new Map((loads.activities ?? []).map((a) => [a.activity_id, a]));
  for (const r of loads.muscles) {
    if (!r.activity_id || !isMuscleId(r.muscle_id) || !(r.load > 0)) continue;
    const age = at - hoursOf(r.finished_at);
    if (!(age >= 0 && age < week)) continue;
    const act = activities.get(r.activity_id);
    const kind = cardioKind(act?.type);
    contributing[r.muscle_id].push({
      exercise_id: r.activity_id, exercise: act?.name || act?.type || 'Activity', workout_id: r.activity_id, workout_date: r.finished_at,
      role: (kind && cardioRole(m, kind, r.muscle_id)) || 'primary', load: r.load, pb_source: 'not needed', pb_detail: null,
    });
  }
  const order = (a: Contribution, b: Contribution) =>
    b.load - a.load || hoursOf(b.workout_date) - hoursOf(a.workout_date) || a.exercise.localeCompare(b.exercise);

  return Object.fromEntries(MUSCLE_IDS.map((id) => [id, { ...states[id], contributing: contributing[id].sort(order) }])) as RecoveryMap;
}

// ---------------------------------------------------------------- session_map

/** The engine's session view with the read API's names: hours after the workout, not from now. */
export function sessionView(s: Record<MuscleId, SessionMuscle>): SessionMap {
  return Object.fromEntries(MUSCLE_IDS.map((id) => {
    const { ready_in_h, trainable_in_h, ...rest } = s[id];
    return [id, { ...rest, trainable_after_h: trainable_in_h, ready_after_h: ready_in_h }];
  })) as SessionMap;
}

/**
 * One finished workout's session view (spec §10) from its cache rows: the engine's sessionMap
 * over the cached L and R. A muscle with no row was not loaded: L 0, and the R the engine gives
 * an unloaded muscle, so the result equals scoring the workout afresh.
 */
export function sessionMapFromLoads(m: Model, rows: readonly { muscle_id: string; load: number; recovery_hours: number }[]): SessionMap {
  const L_m = Object.fromEntries(MUSCLE_IDS.map((id) => [id, 0])) as Record<MuscleId, number>;
  const R = Object.fromEntries(MUSCLE_IDS.map((id) => [id, recoveryHours(m, 0, id)])) as Record<MuscleId, number>;
  for (const r of rows) {
    if (!isMuscleId(r.muscle_id)) continue;
    L_m[r.muscle_id] = r.load;
    R[r.muscle_id] = r.recovery_hours;
  }
  const scored: ScoredWorkout = { L_e: {}, L_m, R, detail: {}, end: 0, records: [] };
  return sessionView(sessionMap(m, scored));
}

// ---------------------------------------------------------------- recovery_history

/** The sample times of a history: `to`, `to − step`, … while after `from`, oldest first. */
export function sampleTimes(from: number, to: number, step: number): number[] {
  if (!(step > 0) || !Number.isFinite(step)) throw new Error(`step must be a positive number of hours, not ${step}`);
  if (!(to > from)) return [];
  const n = Math.ceil((to - from) / step - 1e-9);
  if (n > MAX_SAMPLES) throw new Error(`${n} samples is more than ${MAX_SAMPLES}; use a longer step`);
  return Array.from({ length: n }, (_, k) => to - (n - 1 - k) * step);
}

/** recovery_map at each sample time from `from` to `to` (hours), oldest first. `loads` must cover
 *  historyWindow(m, from, to). */
export function recoveryHistory(
  m: Model, keyOf: ReadonlyMap<string, string>, loads: LoadWindow, from: number, to: number, step = 24,
): RecoverySample[] {
  return sampleTimes(from, to, step).map((t) => ({ at: isoOfHours(t), map: recoveryMapAt(m, keyOf, loads, t) }));
}
