// Build phase 7: what the screens show beside the figure. Pure, so it is tested under Node:
//
// - nextReady: muscles becoming trainable in the next 24 h (the Recovery screen's strip)
// - trainNext: Ready muscles, biggest body regions first, three exercises each
// - sessionRows: the workout summary's row per touched muscle
// - roleFigure: an exercise's primary / secondary / tertiary muscles as a figure map, in tints
// - loadSplit: where one set's load lands (the stored load_split, or spec §6's formula)
//
// Every level, time and colour comes from the maps (Phase 5) and the thresholds; the only fixed
// numbers are the plan's own: the 24 h strip and three exercises per muscle.

import { fmtHours } from './engine.ts';
import type { FigureMap } from './figure.ts';
import { isMuscleId, MUSCLE_IDS, ROLES, type MuscleId, type Role } from './library.ts';
import { LIBRARY_ORDER, MUSCLE_GROUPS } from './libraryOrder.ts';
import type { RecoveryMap, SessionMap } from './read.ts';
import type { Thresholds } from './thresholds.ts';

/** The "next ready" strip looks this far ahead (build phase 7). */
export const NEXT_READY_HOURS = 24;
/** Train next suggests this many exercises per muscle (build phase 7). */
export const TRAIN_NEXT_EXERCISES = 3;
/** Body regions, biggest first: Train next's order. */
export const REGION_ORDER = ['Legs', 'Back', 'Chest', 'Shoulders', 'Arms', 'Core'] as const;

// ---------------------------------------------------------------- next ready

export interface NextReady {
  muscle: MuscleId;
  label: string;
  /** Hours until trainable (level ≤ trainable_max_level). */
  in_h: number;
}

/** Muscles that are not trainable now but will be within NEXT_READY_HOURS, soonest first. */
export function nextReady(c: Thresholds, map: RecoveryMap): NextReady[] {
  return MUSCLE_IDS
    .filter((id) => map[id].level > c.trainable_max_level)
    .map((id) => ({ muscle: id, label: map[id].label, in_h: map[id].trainable_in_h }))
    .filter((r): r is NextReady => r.in_h != null && r.in_h > 0 && r.in_h <= NEXT_READY_HOURS)
    .sort((a, b) => a.in_h - b.in_h || MUSCLE_IDS.indexOf(a.muscle) - MUSCLE_IDS.indexOf(b.muscle));
}

/** The muscles most tired now, highest level then F first (the Today card's line). */
export function mostTired(map: RecoveryMap, n: number): MuscleId[] {
  return MUSCLE_IDS.filter((id) => map[id].level > 0)
    .sort((a, b) => map[b].level - map[a].level || map[b].F - map[a].F)
    .slice(0, n);
}

// ---------------------------------------------------------------- train next

/** An exercise as Train next needs it: id, name, library slug, its muscles by role, load split. */
export interface TrainExercise {
  id: string;
  name: string;
  slug: string | null;
  primary: readonly string[];
  split: Readonly<Record<string, number>>;
}

export interface TrainNext {
  muscle: MuscleId;
  group: string;
  exercises: TrainExercise[];
}

const libraryIndex = new Map(LIBRARY_ORDER.map((slug, i) => [slug, i]));

/**
 * Ready muscles (level 0), biggest regions first (REGION_ORDER, then spec §2 order inside a
 * region), each with up to three library exercises where it is primary: the largest share of
 * that muscle in load_split first, then library order. A Ready muscle with no such exercise is
 * left out.
 */
export function trainNext(map: RecoveryMap, exercises: readonly TrainExercise[]): TrainNext[] {
  const region = (id: MuscleId) => {
    const i = REGION_ORDER.indexOf(MUSCLE_GROUPS[id] as (typeof REGION_ORDER)[number]);
    return i < 0 ? REGION_ORDER.length : i;
  };
  return MUSCLE_IDS
    .filter((id) => map[id].level === 0)
    .sort((a, b) => region(a) - region(b) || MUSCLE_IDS.indexOf(a) - MUSCLE_IDS.indexOf(b))
    .map((muscle) => ({
      muscle,
      group: MUSCLE_GROUPS[muscle] ?? '',
      exercises: exercises
        .filter((e) => e.slug != null && libraryIndex.has(e.slug) && e.primary.includes(muscle))
        .sort((a, b) => (b.split[muscle] ?? 0) - (a.split[muscle] ?? 0) || libraryIndex.get(a.slug!)! - libraryIndex.get(b.slug!)!)
        .slice(0, TRAIN_NEXT_EXERCISES),
    }))
    .filter((t) => t.exercises.length > 0);
}

// ---------------------------------------------------------------- workout summary

export interface SessionRow {
  muscle: MuscleId;
  level: number;
  /** "Chest · load 2.48 · High · trainable in 24 h · ready in 2.2 days" */
  text: string;
}

const inHours = (h: number) => (fmtHours(h) === 'now' ? 'now' : `in ${fmtHours(h)}`);

/** One row per muscle the workout loaded (L > 0), heaviest first. Times count from its finish. */
export function sessionRows(session: SessionMap, nameOf: (id: MuscleId) => string): SessionRow[] {
  return MUSCLE_IDS.filter((id) => session[id].L > 0)
    .sort((a, b) => session[b].L - session[a].L)
    .map((id) => {
      const s = session[id];
      return {
        muscle: id, level: s.level,
        text: `${nameOf(id)} · load ${s.L.toFixed(2)} · ${s.label} · trainable ${inHours(s.trainable_after_h)} · ready ${inHours(s.ready_after_h)}`,
      };
    });
}

// ---------------------------------------------------------------- an exercise's muscles

/** #rrggbb mixed with another: t = 0 gives a, t = 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Three tints of one colour, strongest for primary, fading towards the body's grey. */
export function roleTints(colour: string, base: string): Record<Role, string> {
  return { primary: colour, secondary: mixHex(colour, base, 0.45), tertiary: mixHex(colour, base, 0.72) };
}

const ROLE_LABEL: Record<Role, string> = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };

/** An exercise's muscles as a figure map: each role in its tint, every other muscle the ready
 *  colour. `roles` is the exercise's exercise_muscles rows. */
export function roleFigure(roles: readonly { muscle_id: string; role: string }[], tints: Record<Role, string>, ready: string): FigureMap {
  const map = Object.fromEntries(MUSCLE_IDS.map((id) => [id, { level: 0, label: 'Not used', fill: ready, fill_dark: ready }])) as Record<MuscleId,
    { level: number; label: string; fill: string; fill_dark: string }>;
  for (const r of roles) {
    if (!isMuscleId(r.muscle_id) || !(ROLES as readonly string[]).includes(r.role)) continue;
    const role = r.role as Role;
    map[r.muscle_id] = { level: ROLES.indexOf(role) + 1, label: ROLE_LABEL[role], fill: tints[role], fill_dark: tints[role] };
  }
  return map;
}

/**
 * Where one set's load lands, as whole percentages in the library's order of roles: the stored
 * load_split when there is one, else spec §6's formula from the roles (role weight ÷ the sum,
 * rounded so the parts add to 100).
 */
export function loadSplit(c: Thresholds, stored: unknown, roles: readonly { muscle_id: string; role: string }[]): { muscle: MuscleId; pct: number }[] {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const parts = Object.entries(stored as Record<string, unknown>)
      .filter((e): e is [MuscleId, number] => isMuscleId(e[0]) && typeof e[1] === 'number' && e[1] > 0);
    if (parts.length) return parts.map(([muscle, pct]) => ({ muscle, pct }));
  }
  const weighted = ROLES.flatMap((role) => roles.filter((r) => r.role === role && isMuscleId(r.muscle_id))
    .map((r) => ({ muscle: r.muscle_id as MuscleId, w: c.role_weights[role] })));
  const total = weighted.reduce((s, x) => s + x.w, 0);
  if (!total) return [];
  // largest remainder, so the rounded parts add to exactly 100
  const raw = weighted.map((x) => ({ muscle: x.muscle, exact: (100 * x.w) / total }));
  const out = raw.map((x) => ({ muscle: x.muscle, pct: Math.floor(x.exact) }));
  let left = 100 - out.reduce((s, x) => s + x.pct, 0);
  for (const i of raw.map((x, i) => [x.exact - Math.floor(x.exact), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left-- <= 0) break;
    out[i].pct += 1;
  }
  return out;
}
