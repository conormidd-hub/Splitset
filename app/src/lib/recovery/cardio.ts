// Build phase 10: imported activities (intervals.icu, which brings in Garmin and Strava) on the
// body map. Each countable activity becomes equivalent fixed-cost sets of a library entry built
// from cardio.activity_muscles, and goes through the same engine as lifting: fixedCost,
// muscleLoads with the lifting role weights, recoveryHours. Pure; the app saves the result to
// workout_muscle_loads with source = activity (save_activity_loads).

import { buildLibrary, fixedCost, muscleLoads, recoveryHours } from './engine.ts';
import { MUSCLE_IDS, type MuscleId, type Role } from './library.ts';
import type { ActivityKind } from './thresholds.ts';
import type { ExerciseDef, Model } from './types.ts';

/** intervals.icu activity types → the five kinds of cardio.activity_muscles. Anything else (Walk,
 *  Workout, WeightTraining, Tennis, Golf …) doesn't count; WeightTraining is logged as lifting. */
const KINDS: Record<string, ActivityKind> = {
  Run: 'run', VirtualRun: 'run', TrailRun: 'run', Treadmill: 'run',
  Ride: 'ride', VirtualRide: 'ride', GravelRide: 'ride', MountainBikeRide: 'ride', EBikeRide: 'ride', EMountainBikeRide: 'ride',
  Swim: 'swim', OpenWaterSwim: 'swim',
  Hike: 'hike',
  Rowing: 'row', VirtualRow: 'row',
};

/** The activity types that count, for querying. */
export const CARDIO_TYPES: readonly string[] = Object.keys(KINDS);

export function cardioKind(type: string | null | undefined): ActivityKind | null {
  return (type && KINDS[type]) || null;
}

/** An activities row as far as scoring needs it. */
export interface ActivityRow {
  id: string;
  type: string;
  name: string | null;
  start_time: string;
  moving_time_s: number | null;
  elapsed_time_s: number | null;
  /** Seconds in each heart-rate zone, zone 1 first (icu_hr_zone_times). */
  hr_zone_times: readonly number[] | null;
}

/** Minutes at or above hard_hr_zone_min, the rest, and the equivalent sets they make (spec
 *  build phase 10). With no zone data, every minute is easy. */
export function equivalentSets(m: Model, a: ActivityRow): { hardMin: number; easyMin: number; sets: number } {
  const c = m.c.cardio;
  const minutes = Math.max(0, (a.moving_time_s ?? a.elapsed_time_s ?? 0) / 60);
  const zones = a.hr_zone_times ?? [];
  const zoneSum = zones.reduce((s, x) => s + (x > 0 ? x : 0), 0);
  const hardSec = zoneSum > 0 ? zones.slice(c.hard_hr_zone_min - 1).reduce((s, x) => s + (x > 0 ? x : 0), 0) : 0;
  const hardMin = Math.min(minutes, hardSec / 60);
  const easyMin = minutes - hardMin;
  return { hardMin, easyMin, sets: (hardMin / 10) * c.equiv_sets_per_10min_hard + (easyMin / 10) * c.equiv_sets_per_10min_easy };
}

/** The library entry an activity kind scores as: fixed-cost sets, fatigue standard, its muscles
 *  from cardio.activity_muscles. */
export function cardioDef(m: Model, kind: ActivityKind): ExerciseDef {
  const roles = m.c.cardio.activity_muscles[kind];
  return {
    slug: `cardio_${kind}`, load_mode: 'fixed', bw_factor: null, fatigue: 'standard',
    primary: roles.primary ?? [], secondary: roles.secondary ?? [], tertiary: roles.tertiary ?? [], pb_estimate: null, unilateral: false,
  };
}

/** A muscle's role in an activity kind, or null. */
export function cardioRole(m: Model, kind: ActivityKind, muscle: MuscleId): Role | null {
  const roles = m.c.cardio.activity_muscles[kind];
  for (const role of ['primary', 'secondary', 'tertiary'] as const) if (roles[role]?.includes(muscle)) return role;
  return null;
}

export interface ScoredActivity {
  activity_id: string;
  kind: ActivityKind;
  sets: number;
  /** L_e: equivalent sets × fixed_set.base × the standard fatigue factor. */
  load: number;
  /** t_w: start + elapsed time, in engine hours. */
  end: number;
  muscles: { muscle_id: MuscleId; load: number; recovery_hours: number }[];
}

/** One activity scored, or null when it doesn't count. */
export function scoreActivity(m: Model, a: ActivityRow): ScoredActivity | null {
  const kind = cardioKind(a.type);
  if (!kind) return null;
  const { sets } = equivalentSets(m, a);
  const load = sets * fixedCost(m, null) * m.c.fatigue_factors.standard;
  const def = cardioDef(m, kind);
  const L_m = muscleLoads({ c: m.c, lib: buildLibrary([def]) }, { [def.slug]: load });
  const end = (Date.parse(a.start_time) + 1000 * (a.elapsed_time_s ?? a.moving_time_s ?? 0)) / 3_600_000;
  return {
    activity_id: a.id, kind, sets, load, end,
    muscles: MUSCLE_IDS.filter((id) => L_m[id] > 0).map((id) => ({ muscle_id: id, load: L_m[id], recovery_hours: recoveryHours(m, L_m[id], id) })),
  };
}

/** What save_activity_loads() takes for these activities: every countable one, scored. With
 *  cardio off (cardio.enabled_default, a user override) nothing counts. */
export function activityLoads(m: Model, activities: readonly ActivityRow[]): { activity_id: string; muscles: ScoredActivity['muscles'] }[] {
  if (!m.c.cardio.enabled_default) return [];
  return activities.map((a) => scoreActivity(m, a)).filter((s): s is ScoredActivity => s != null)
    .map((s) => ({ activity_id: s.activity_id, muscles: s.muscles }));
}
