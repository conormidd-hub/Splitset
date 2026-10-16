// The constants loader: every tunable number of docs/load-model-spec.md, as one typed
// Thresholds object. The defaults come from data/recovery_constants.json (read once, in
// constants.ts); a user's rows in user_thresholds override them by dotted key, e.g.
// `pb.manual_policy`, `base_recovery_hours.default` or `levels.3.min`. Everything downstream
// (the engine, storage, the figure) takes a Thresholds and never reads a number from anywhere else.
//
// Pure: no I/O, and the result is frozen, so no caller can change a shared default.

import { isMuscleId, type MuscleId, type Role } from './library.ts';

export type FatigueClass = 'high' | 'standard' | 'low';
export type ManualPolicy = 'max' | 'replace_on_log';
export type ActivityKind = 'run' | 'ride' | 'swim' | 'hike' | 'row';

export interface Level {
  level: number;
  key: string;
  label: string;
  /** Lowest fatigue F at this level (§9). */
  min: number;
  /** null at level 0: the figure uses ready_fill there. */
  fill: string | null;
  fill_dark: string | null;
  advice: string;
}

export interface Thresholds {
  version: string;
  role_weights: Record<Role, number>;
  role_caps: Record<Role, number>;
  fatigue_factors: Record<FatigueClass, number>;
  e1rm: { epley_divisor: number; max_reps: number; rir_from_rpe: string; rir_default: number };
  intensity_cap: number;
  pb: {
    window_days: number;
    lapsed_factor: number;
    estimate_discount: number;
    estimate_max_hops: number;
    manual_policy: ManualPolicy;
    calibration_rir: number;
  };
  fixed_set: { base: number; per_rpe_point: number; min: number; max: number };
  unilateral_side_factor: number;
  bodyweight_default_kg: number;
  recovery: { intercept: number; slope: number; min_multiplier: number; max_multiplier: number };
  /** `default` plus any muscle with its own window. */
  base_recovery_hours: { default: number } & Partial<Record<MuscleId, number>>;
  fatigue: { weekly_window_hours: number; weekly_cap: number; weekly_cap_min_level: number };
  levels: Level[];
  trainable_max_level: number;
  ready_fill: string;
  ready_fill_dark: string;
  silhouette_fill: string;
  silhouette_fill_dark: string;
  region_stroke: string;
  region_stroke_dark: string;
  cardio: {
    enabled_default: boolean;
    equiv_sets_per_10min_hard: number;
    equiv_sets_per_10min_easy: number;
    hard_hr_zone_min: number;
    activity_muscles: Record<ActivityKind, Record<Role, MuscleId[]>>;
  };
}

/** A user_thresholds row. `value` is the row's jsonb, so any JSON value can arrive here. */
export interface ThresholdOverride {
  user_id: string;
  key: string;
  value: unknown;
}

/** Overridable strings with a fixed set of values. */
const STRING_CHOICES: Record<string, readonly string[]> = {
  'pb.manual_policy': ['max', 'replace_on_log'] satisfies ManualPolicy[],
};

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function stripDocs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDocs);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_doc').map(([k, x]) => [k, stripDocs(x)]));
  }
  return v;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The parsed contents of data/recovery_constants.json: `_doc` notes dropped, frozen. */
export function parseConstants(raw: unknown): Thresholds {
  const t = stripDocs(raw) as Partial<Thresholds> | null;
  if (!t || typeof t !== 'object' || !t.role_weights || !t.pb || !t.recovery || !Array.isArray(t.levels)) {
    throw new Error('recovery constants: not the shape of data/recovery_constants.json');
  }
  return deepFreeze(t as Thresholds);
}

/** The existing value at a dotted key, or `missing` when the path does not lead to one. */
function lookup(t: Thresholds, path: string[]): { found: true; value: unknown } | { found: false } {
  let cur: unknown = t;
  for (const seg of path) {
    if (FORBIDDEN_SEGMENTS.has(seg) || seg === '') return { found: false };
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= cur.length) return { found: false };
      cur = cur[Number(seg)];
    } else if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

/**
 * Whether a user_thresholds row may apply. An override replaces one existing leaf with a value
 * of the same type (a finite number for a number; one of the listed choices where a string
 * has them), or adds a per-muscle `base_recovery_hours.<muscle>`. Anything else, including a
 * whole section or a key the constants file no longer has, is invalid.
 */
export function isValidOverride(t: Thresholds, key: string, value: unknown): boolean {
  const path = key.split('.');
  const hit = lookup(t, path);
  let expected: unknown;
  if (hit.found) {
    expected = hit.value;
  } else if (path.length === 2 && path[0] === 'base_recovery_hours' && isMuscleId(path[1])) {
    expected = t.base_recovery_hours.default;
  } else {
    return false;
  }
  if (expected !== null && typeof expected === 'object') return false;   // leaves only
  if (expected === null) return value === null || typeof value === 'string';
  if (typeof value !== typeof expected) return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  const choices = STRING_CHOICES[key];
  return !choices || choices.includes(value as string);
}

function setAt(target: unknown, path: string[], value: unknown): void {
  let cur = target as Record<string, unknown>;
  for (const seg of path.slice(0, -1)) cur = cur[seg] as Record<string, unknown>;
  cur[path[path.length - 1]] = value;
}

/** A copy of `t` with one override applied. Throws if the override is invalid. */
export function withOverride(t: Thresholds, key: string, value: unknown): Thresholds {
  if (!isValidOverride(t, key, value)) throw new Error(`invalid threshold override ${key} = ${JSON.stringify(value)}`);
  const copy = JSON.parse(JSON.stringify(t)) as Thresholds;
  setAt(copy, key.split('.'), value);
  return deepFreeze(copy);
}

/**
 * One user's thresholds: `base` with that user's rows applied. Rows for other users are
 * ignored, and so are invalid rows, so a stale key left by an older version can never break
 * the map (the settings screen checks isValidOverride before it writes). With nothing to
 * apply it returns `base` itself.
 */
export function thresholdsFor(base: Thresholds, userId: string, rows: readonly ThresholdOverride[]): Thresholds {
  const mine = rows.filter((r) => r.user_id === userId && isValidOverride(base, r.key, r.value));
  if (mine.length === 0) return base;
  const copy = JSON.parse(JSON.stringify(base)) as Thresholds;
  for (const r of mine) setAt(copy, r.key.split('.'), r.value);
  return deepFreeze(copy);
}
