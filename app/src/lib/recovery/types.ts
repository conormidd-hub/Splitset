// Plain-data shapes for the recovery engine (engine.ts). Inputs are library entries, sets, PB
// records and a Thresholds object: never database rows. Field names follow scripts/load_model.py
// and data/exercise_library.json, so a library entry or a fixture can be passed in as it is;
// results keep the spec's symbols (L_e, L_m, R, F, W) and the names Phase 5's API returns.

import type { MuscleId } from './library.ts';
import type { FatigueClass, Thresholds } from './thresholds.ts';

export type LoadMode = 'weight' | 'bodyweight' | 'assisted' | 'fixed';
export type Side = 'left' | 'right';

/** A library entry: exercises.slug and its columns, or an entry of data/exercise_library.json. */
export interface ExerciseDef {
  slug: string;
  load_mode: LoadMode;
  /** bodyweight × bw_factor is the effective weight in bodyweight and assisted modes. */
  bw_factor?: number | null;
  fatigue: FatigueClass;
  primary: readonly string[];
  secondary: readonly string[];
  tertiary: readonly string[];
  pb_estimate?: { from: string; ratio: number } | null;
  unilateral?: boolean;
}

/** Library entries by slug. */
export type Library = ReadonlyMap<string, ExerciseDef>;

/** Everything the engine reads besides its inputs: the constants (with a user's overrides) and
 *  the library. It replaces the module globals C and EX of the reference implementation. */
export interface Model {
  c: Thresholds;
  lib: Library;
}

/** One logged set (spec §3.3). */
export interface LiftSet {
  /** kg: the weight, the added load (bodyweight mode) or the assistance (assisted mode). */
  w?: number | null;
  r?: number | null;
  rpe?: number | null;
  warmup?: boolean;
  seconds?: number | null;
  side?: Side | null;
  /** kg, snapshotted when the set was saved (bodyweight and assisted modes). */
  bodyweight?: number | null;
}

/** One e1RM record in a user's PB history (spec §3.3). `at` is in hours. */
export interface PbRecord {
  slug: string;
  e1rm: number;
  at: number;
  source: 'logged' | 'manual';
}

/** A workout: start and end in hours, exercises in logged order. The same slug may appear
 *  twice (two blocks of one exercise, F28). */
export interface Workout {
  start: number;
  end: number;
  exercises: readonly (readonly [string, readonly LiftSet[]])[];
}

export type PbSource = 'monthly' | 'lapsed' | 'estimated' | 'calibration';

/** pbBefore's answer. `detail` is logged | manual for monthly and lapsed, the anchor slug for
 *  estimated, null for calibration. */
export interface PbBefore {
  pb: number | null;
  source: PbSource;
  detail: string | null;
}

/** One set as scored. Weighted sets carry w, r, ref and (unless a warm-up) I and inol; fixed-mode
 *  sets carry only cost. */
export interface SetDetail {
  w?: number;
  r?: number;
  ref?: number;
  I?: number;
  inol?: number;
  warmup?: boolean;
  cost?: number;
}

/** A new PB record from a scored set, before it is dated with the workout's end. */
export type NewRecord = Omit<PbRecord, 'at'>;

export interface ScoredExercise {
  L_e: number;
  /** Σ set loads before the fatigue factor. */
  raw: number;
  factor: number;
  sets: SetDetail[];
  pb_before: number | null;
  pb_source: PbSource | 'not needed';
  pb_via: string | null;
  records: NewRecord[];
  /** Highest reference reached; the next block of the same exercise starts here (F28). */
  best: number | null;
}

export interface ScoredWorkout {
  L_e: Record<string, number>;
  L_m: Record<MuscleId, number>;
  R: Record<MuscleId, number>;
  detail: Record<string, ScoredExercise>;
  end: number;
  /** The workout's PB records, dated at its end. The caller adds them to the history. */
  records: PbRecord[];
}

/** One workout's contribution to a muscle: finished at tw, load L, window R (hours). */
export type Term = readonly [tw: number, L: number, R: number];

export interface MuscleState {
  F: number;
  W: number;
  level: number;
  label: string;
  advice: string;
  fill: string;
  fill_dark: string;
  ready_in_h: number | null;
  trainable_in_h: number | null;
}

export interface SessionMuscle {
  L: number;
  level: number;
  label: string;
  fill: string;
  fill_dark: string;
  R: number;
  ready_in_h: number;
  trainable_in_h: number;
}
