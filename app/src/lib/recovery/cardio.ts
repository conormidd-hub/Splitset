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

/** One activity as save_activity_loads() takes it; no muscles clears its rows. */
export interface ActivityLoads { activity_id: string; muscles: ScoredActivity['muscles'] }

/** What save_activity_loads() takes for these activities: every countable one, scored. With
 *  cardio off (cardio.enabled_default, a user override) nothing counts. */
export function activityLoads(m: Model, activities: readonly ActivityRow[]): ActivityLoads[] {
  if (!m.c.cardio.enabled_default) return [];
  return activities.map((a) => scoreActivity(m, a)).filter((s): s is ScoredActivity => s != null)
    .map((s) => ({ activity_id: s.activity_id, muscles: s.muscles }));
}

/** A workout_muscle_loads row of an activity, as the app reads it back. */
export interface ActivityLoadRow {
  activity_id: string | null;
  muscle_id: string;
  load: number;
  recovery_hours: number;
  finished_at: string;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * What save_activity_loads() must be sent so the cached rows match the activities: every
 * countable activity whose score differs from its rows (new; or changed after it was first
 * scored: heart-rate zones that arrived late, a crop, a new start, Run to Ride, new thresholds),
 * and, with no muscles (which clears them), every activity with rows that no longer counts
 * (retyped to Walk; all of them with cardio off). `countable` is all of the user's countable
 * activities, `rows` all of their activity rows. An activity that scores nothing and has no rows
 * is left alone, so it isn't sent again on every catch-up.
 */
export function activityChanges(m: Model, countable: readonly ActivityRow[], rows: readonly ActivityLoadRow[]): ActivityLoads[] {
  const stored = new Map<string, ActivityLoadRow[]>();
  for (const r of rows) {
    if (!r.activity_id) continue;
    const list = stored.get(r.activity_id);
    if (list) list.push(r);
    else stored.set(r.activity_id, [r]);
  }
  const out: ActivityLoads[] = [];
  const counted = new Set<string>();
  for (const a of countable) {
    const s = m.c.cardio.enabled_default ? scoreActivity(m, a) : null;
    if (!s) continue;
    counted.add(a.id);
    const old = stored.get(a.id) ?? [];
    // t_w is start + elapsed (save_activity_loads works it out); to the second, as timestamps differ below that
    const same = old.length === s.muscles.length && s.muscles.every((x) => {
      const r = old.find((o) => o.muscle_id === x.muscle_id);
      return r != null && close(r.load, x.load) && close(r.recovery_hours, x.recovery_hours)
        && Math.abs(Date.parse(r.finished_at) / 3_600_000 - s.end) < 1 / 3600;
    });
    if (!same) out.push({ activity_id: a.id, muscles: s.muscles });
  }
  for (const id of stored.keys()) if (!counted.has(id)) out.push({ activity_id: id, muscles: [] });
  return out;
}
