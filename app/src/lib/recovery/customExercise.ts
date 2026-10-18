// Build phase 8: creating a custom exercise. Pure, so it is tested under Node. The screen
// (app/(app)/lift/exercises/new.tsx) keeps a Draft and calls these; Save sends toPayload() to
// create_custom_exercise() / update_custom_exercise(). Nothing here scores anything: a custom
// exercise is an ordinary engine entry (exerciseDef), and its PB resolves through the existing
// pbBefore, estimate links included (spec §3.4, F30).

import { isMuscleId, MUSCLE_IDS, ROLES, type MuscleId, type Role } from './library.ts';
import { MUSCLE_GROUPS } from './libraryOrder.ts';
import { loadSplit } from './screens.ts';
import { exerciseDef, setE1rm, type ExerciseRow } from './sets.ts';
import type { FatigueClass, Thresholds } from './thresholds.ts';
import type { LoadMode } from './types.ts';

// ---------------------------------------------------------------- the plan's fixed choices

/** "Compared with <that exercise>, you lift about: less / about the same / more" (build phase 8). */
export const RATIOS = { less: 0.6, same: 1.0, more: 1.3 } as const;
export type RatioChoice = keyof typeof RATIOS;

/** The bodyweight factor's range and presets (build phase 8). */
export const BW_FACTOR = { min: 0.2, max: 1.0, step: 0.05 } as const;
export const BW_PRESETS = [
  { label: 'Core', value: 0.3 }, { label: 'Push-up-like', value: 0.65 }, { label: 'Pull-up-like', value: 1.0 }, { label: 'Legs', value: 0.8 },
] as const;

export type EquipmentChoice = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'smith' | 'bodyweight' | 'assisted' | 'band' | 'timed';

/** What each equipment choice sets (build phase 8): load mode, how sets are logged, the stored
 *  equipment word, and the default fatigue class (machine / cable / band → low, else standard). */
export const EQUIPMENT: Record<EquipmentChoice, { label: string; equipment: string; loadMode: LoadMode; logAs: 'reps' | 'seconds'; fatigue: FatigueClass }> = {
  barbell: { label: 'Barbell', equipment: 'barbell', loadMode: 'weight', logAs: 'reps', fatigue: 'standard' },
  dumbbell: { label: 'Dumbbell', equipment: 'dumbbell', loadMode: 'weight', logAs: 'reps', fatigue: 'standard' },
  machine: { label: 'Machine', equipment: 'machine', loadMode: 'weight', logAs: 'reps', fatigue: 'low' },
  cable: { label: 'Cable', equipment: 'cable', loadMode: 'weight', logAs: 'reps', fatigue: 'low' },
  smith: { label: 'Smith', equipment: 'smith', loadMode: 'weight', logAs: 'reps', fatigue: 'standard' },
  bodyweight: { label: 'Bodyweight', equipment: 'bodyweight', loadMode: 'bodyweight', logAs: 'reps', fatigue: 'standard' },
  assisted: { label: 'Assisted machine', equipment: 'machine', loadMode: 'assisted', logAs: 'reps', fatigue: 'standard' },
  band: { label: 'Band', equipment: 'band', loadMode: 'fixed', logAs: 'reps', fatigue: 'low' },
  timed: { label: 'Timed', equipment: 'bodyweight', loadMode: 'fixed', logAs: 'seconds', fatigue: 'standard' },
};

/** Light / Normal / Heavy → the fatigue class, the only load control (build phase 8). */
export const HARDNESS: { label: string; fatigue: FatigueClass }[] = [
  { label: 'Light', fatigue: 'low' }, { label: 'Normal', fatigue: 'standard' }, { label: 'Heavy', fatigue: 'high' },
];

/** The older muscle_group words search and subtitles use, from the first primary muscle (as
 *  supabase/seed_library.py sets them for new rows). Forearms and adductors have none. */
const LEGACY_MUSCLE_GROUP: Record<MuscleId, string | null> = {
  chest: 'chest', traps: 'back', lats: 'back', lower_back: 'back', front_delts: 'shoulders', side_delts: 'shoulders',
  rear_delts: 'shoulders', biceps: 'biceps', triceps: 'triceps', forearms: null, abs: 'core', obliques: 'core',
  glutes: 'glutes', quads: 'quads', adductors: null, hamstrings: 'hamstrings', calves: 'calves',
};

// ---------------------------------------------------------------- "did you mean"

/** An exercise as matching sees it. */
export interface Named {
  id: string;
  name: string;
  slug: string | null;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * How well a name matches an exercise, 0 to 1: the share of the query's words found in its name
 * or slug, whole (1) or inside a longer word (0.8), so word order and joined words don't matter
 * ("pull down lat" finds "Lat pulldown"). Adjacent query words also count joined ("pull down" →
 * "pulldown").
 */
export function matchScore(query: string, e: Named): number {
  const q = words(query);
  if (!q.length) return 0;
  const tokens = words(`${e.name} ${e.slug ?? ''}`);
  const compact = tokens.join('');
  if (q.join('') === words(e.name).join('')) return 1;
  let got = 0;
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    const joined = i + 1 < q.length ? t + q[i + 1] : null;
    if (tokens.includes(t)) got += 1;
    else if (joined && tokens.includes(joined)) got += 1;
    else if (t.length >= 3 && compact.includes(t)) got += 0.8;
  }
  return got / q.length;
}

/** "Did you mean …?": the best matches at or above `min`, best first, then the shorter name. */
export function matchExercises<E extends Named>(query: string, exercises: readonly E[], limit = 3, min = 0.6): E[] {
  if (words(query).join('').length < 3) return [];
  return exercises
    .map((e) => ({ e, s: matchScore(query, e) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s || a.e.name.length - b.e.name.length)
    .slice(0, limit)
    .map((x) => x.e);
}

/** The plan's keywords, each with the words that put a library exercise in its family. */
const FAMILIES: { keys: string[]; family: string[] }[] = [
  { keys: ['curl'], family: ['curl'] },
  { keys: ['row'], family: ['row'] },
  { keys: ['press'], family: ['press'] },
  { keys: ['raise'], family: ['raise'] },
  { keys: ['fly', 'flye'], family: ['fly'] },
  { keys: ['squat'], family: ['squat'] },
  { keys: ['lunge'], family: ['lunge', 'split squat'] },
  { keys: ['deadlift', 'rdl'], family: ['deadlift', 'rdl'] },
  { keys: ['pulldown', 'pull down'], family: ['pulldown'] },
  { keys: ['pull up', 'pullup', 'chin up', 'chinup'], family: ['pull up', 'chin up'] },
  { keys: ['extension'], family: ['extension'] },
  { keys: ['crunch'], family: ['crunch'] },
  { keys: ['plank'], family: ['plank'] },
];

/**
 * Library exercises to start from, pre-suggested from keywords in the name (build phase 8): the
 * family the name's keyword names, best name match first. With no keyword, the best matches from
 * the whole library.
 */
export function similarSuggestions<E extends Named>(name: string, library: readonly E[], limit = 3): E[] {
  const text = ` ${words(name).join(' ')} `;
  const fam = FAMILIES.find((f) => f.keys.some((k) => text.includes(` ${k} `) || text.includes(` ${k}s `)));
  const pool = fam
    ? library.filter((e) => { const t = ` ${words(`${e.name} ${e.slug ?? ''}`).join(' ')} `; return fam.family.some((w) => t.includes(` ${w}`)); })
    : library;
  return pool
    .map((e) => ({ e, s: matchScore(name, e) }))
    .filter((x) => fam || x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

// ---------------------------------------------------------------- the draft

export type Roles = Partial<Record<MuscleId, Role>>;

export interface Draft {
  name: string;
  /** The library exercise this one starts from, by slug, and how it compares. */
  similar: string | null;
  ratio: RatioChoice;
  /** The equipment chip, if one is chosen (a copied exercise may have equipment no chip names). */
  choice: EquipmentChoice | null;
  equipment: string | null;
  loadMode: LoadMode;
  logAs: 'reps' | 'seconds';
  bwFactor: number | null;
  unilateral: boolean;
  fatigue: FatigueClass;
  roles: Roles;
  /** "Your best", optional: weight × reps today. */
  best: { weightKg: number; reps: number } | null;
}

export const emptyDraft = (name = ''): Draft => ({
  name, similar: null, ratio: 'same', choice: null, equipment: null, loadMode: 'weight', logAs: 'reps', bwFactor: null,
  unilateral: false, fatigue: 'standard', roles: {}, best: null,
});

/** An existing exercise row with what this flow reads from it. */
export interface SourceRow extends ExerciseRow {
  name: string;
  equipment: string | null;
}

/** The exercises.measure a draft or an equipment chip saves: how its sets are logged. */
export const measureOf = (d: { loadMode: LoadMode; logAs: 'reps' | 'seconds' }) =>
  d.logAs === 'seconds' ? 'duration' : d.loadMode === 'fixed' ? 'reps' : 'weight_reps';

/** Logged as time. The seeded Farmer's walk kept the older 'weight_duration' (notes 15.3 item 9). */
const timedMeasure = (measure: string) => measure === 'duration' || measure === 'weight_duration';

/** The chip an exercise's equipment and load mode correspond to, if any. */
export function choiceOf(equipment: string | null, loadMode: string | null, measure: string): EquipmentChoice | null {
  if (loadMode === 'assisted') return 'assisted';
  if (loadMode === 'bodyweight') return 'bodyweight';
  if (loadMode === 'fixed') return timedMeasure(measure) ? 'timed' : equipment === 'band' ? 'band' : null;
  return equipment && equipment in EQUIPMENT && EQUIPMENT[equipment as EquipmentChoice].loadMode === 'weight' ? (equipment as EquipmentChoice) : null;
}

/** A saved exercise as Edit reads it; is_bodyweight matters only for rows saved before build phase 8. */
export type SavedRow = SourceRow & { muscle_group?: string | null; is_bodyweight?: boolean | null };

/** An exercise the old form saved as bodyweight and logged as weight × reps (no load mode). Edit
 *  reads its PB history before drafting it: see legacyLoadMode. */
export const legacyBodyweight = (row: Pick<SavedRow, 'measure' | 'load_mode' | 'equipment' | 'is_bodyweight'>) =>
  row.load_mode == null && row.measure === 'weight_reps' && (row.is_bodyweight === true || row.equipment === 'bodyweight');

/**
 * The load mode of an exercise the old form saved (no load_mode). Weight × reps is weight mode,
 * as the engine has always scored it, so the e1RMs its sets and known bests stored keep their
 * meaning; one the old form marked bodyweight becomes bodyweight mode only while it has stored
 * none (`scored` false: every set at 0 kg, no known best), since nothing rewrites them. A
 * bodyweight exercise logged as plain reps is bodyweight mode, as the library's Push-up is;
 * anything else is a fixed cost per set (Farmer's carry is the precedent for weight × time).
 * Neither of those was ever scored, so neither stored an e1RM.
 */
function legacyLoadMode(row: Pick<SavedRow, 'measure' | 'equipment' | 'is_bodyweight'>, scored: boolean): LoadMode {
  const bodyweight = row.is_bodyweight === true || row.equipment === 'bodyweight';
  if (row.measure === 'weight_reps') return bodyweight && !scored ? 'bodyweight' : 'weight';
  return row.measure === 'reps' && bodyweight ? 'bodyweight' : 'fixed';
}

/**
 * The equipment chips Edit offers (notes 23.3 item 9). Only those that log sets the same way,
 * since update_custom_exercise never changes measure; a bodyweight exercise can be logged as
 * plain reps, as the library's Push-up is. And only those with the load mode it is scored in,
 * so the e1RMs its sets and known bests stored keep their meaning (`scored`: whether its PB
 * history holds any, as for legacyLoadMode). An older exercise the engine never scored (no load
 * mode, not weight × reps) has stored none, so any of them will do.
 */
export function editChoices(row: Pick<SavedRow, 'measure' | 'load_mode' | 'equipment' | 'is_bodyweight'>, scored = true): EquipmentChoice[] {
  const keep = row.load_mode ?? (row.measure === 'weight_reps' ? legacyLoadMode(row, scored) : null);
  return (Object.keys(EQUIPMENT) as EquipmentChoice[]).filter((k) =>
    (measureOf(EQUIPMENT[k]) === row.measure || (k === 'bodyweight' && row.measure === 'reps'))
    && (keep == null || EQUIPMENT[k].loadMode === keep));
}

/** One line under the equipment chips naming how the draft's sets will be scored. */
export function scoringLine(d: { loadMode: LoadMode }): string {
  switch (d.loadMode) {
    case 'weight': return 'Scored from the weight × reps you log.';
    case 'bodyweight': return 'Scored from the share of your bodyweight it moves, plus any added weight.';
    case 'assisted': return 'Scored from the share of your bodyweight it moves, minus the assistance.';
    default: return 'Scored as a fixed cost per set, whatever weight, reps or time you log.';
  }
}

/** Choosing an equipment chip: its load mode and logging, a bodyweight factor when it needs one,
 *  and its default fatigue unless a similar exercise already set it. */
export function withEquipment(d: Draft, choice: EquipmentChoice): Draft {
  const e = EQUIPMENT[choice];
  const needsFactor = e.loadMode === 'bodyweight' || e.loadMode === 'assisted';
  return {
    ...d, choice, equipment: e.equipment, loadMode: e.loadMode, logAs: e.logAs,
    bwFactor: needsFactor ? d.bwFactor ?? (e.loadMode === 'assisted' ? 1.0 : 0.65) : null,
    fatigue: d.similar ? d.fatigue : e.fatigue,
  };
}

/** Starting from a similar exercise: its equipment, load mode, bodyweight factor, one-sidedness,
 *  fatigue class and all three muscle tiers; and its slug as the PB estimate's source. When
 *  editing (`keepLogging`), how the sets are logged and weighed stays as saved (notes 23.3 item
 *  9), so the similar exercise lends only its muscles, fatigue, one-sidedness and estimate. */
export function fromSimilar(d: Draft, similar: SourceRow, roles: readonly { muscle_id: string; role: string }[], keepLogging = false): Draft {
  const copied: Roles = {};
  for (const r of roles) if (isMuscleId(r.muscle_id) && (ROLES as readonly string[]).includes(r.role)) copied[r.muscle_id] = r.role as Role;
  const lent: Draft = {
    ...d, similar: similar.slug, unilateral: similar.is_unilateral, fatigue: (similar.fatigue ?? 'standard') as FatigueClass, roles: copied,
  };
  if (keepLogging) return lent;
  return {
    ...lent, choice: choiceOf(similar.equipment, similar.load_mode, similar.measure), equipment: similar.equipment,
    loadMode: (similar.load_mode ?? 'weight') as LoadMode, logAs: timedMeasure(similar.measure) ? 'seconds' : 'reps', bwFactor: similar.bw_factor,
  };
}

/** The bodyweight factor moved by `steps` × 0.05, kept in 0.2–1.0. */
export function stepFactor(f: number | null, steps: number): number {
  const v = Math.round(((f ?? 0.65) + steps * BW_FACTOR.step) * 100) / 100;
  return Math.min(BW_FACTOR.max, Math.max(BW_FACTOR.min, v));
}

// ---------------------------------------------------------------- muscles

const CYCLE: (Role | undefined)[] = [undefined, 'primary', 'secondary', 'tertiary'];

/** Muscles per role in a draft. */
export function roleCounts(roles: Roles): Record<Role, number> {
  const n = { primary: 0, secondary: 0, tertiary: 0 };
  for (const r of Object.values(roles)) if (r) n[r] += 1;
  return n;
}

/** A tap on a muscle: none → primary → secondary → tertiary → none, skipping any role already at
 *  its role_caps limit. */
export function cycleRole(c: Thresholds, roles: Roles, muscle: MuscleId): Roles {
  const others = { ...roles };
  delete others[muscle];
  const counts = roleCounts(others);
  let i = CYCLE.indexOf(roles[muscle]);
  for (let tries = 0; tries < CYCLE.length; tries++) {
    i = (i + 1) % CYCLE.length;
    const role = CYCLE[i];
    if (!role || counts[role] < c.role_caps[role]) return role ? { ...others, [muscle]: role } : others;
  }
  return others;
}

/** Setting a muscle's role directly (the text list's chips); null clears it. Refused (returns the
 *  roles unchanged) when the role is at its cap. */
export function setRole(c: Thresholds, roles: Roles, muscle: MuscleId, role: Role | null): Roles {
  const others = { ...roles };
  delete others[muscle];
  if (!role) return others;
  return roleCounts(others)[role] < c.role_caps[role] ? { ...others, [muscle]: role } : roles;
}

export const rolesList = (roles: Roles) =>
  MUSCLE_IDS.filter((id) => roles[id]).map((id) => ({ muscle_id: id, role: roles[id] as Role }));

// ---------------------------------------------------------------- saving

/** The most reps a known best may have: manual_pbs' check (20261016000200_recovery_sets_pbs.sql). */
export const MANUAL_PB_MAX_REPS = 100;

/** What stops a draft saving, in words; empty when it can be saved. `taken` is the names of the
 *  user's other exercises: the database refuses a second one with the same name, in any case. */
export function validateDraft(c: Thresholds, d: Draft, taken: readonly string[] = []): string[] {
  const out: string[] = [];
  const name = d.name.trim();
  if (name.length < 2) out.push('Give it a name.');
  else if (taken.some((t) => t.trim().toLowerCase() === name.toLowerCase())) out.push(`You already have an exercise called ${name}.`);
  const n = roleCounts(d.roles);
  if (n.primary < 1) out.push('Pick at least one primary muscle.');
  for (const role of ROLES) if (n[role] > c.role_caps[role]) out.push(`At most ${c.role_caps[role]} ${role} muscles.`);
  if ((d.loadMode === 'bodyweight' || d.loadMode === 'assisted')
      && (d.bwFactor == null || d.bwFactor < BW_FACTOR.min || d.bwFactor > BW_FACTOR.max)) {
    out.push(`Set how much of your bodyweight it moves (${BW_FACTOR.min}–${BW_FACTOR.max}).`);
  }
  // a fixed-cost exercise has no best (the screen hides it and toPayload drops it); in weight
  // mode a best needs a weight, where bodyweight and assisted take 0 (no added load, no assistance)
  if (d.best && d.loadMode !== 'fixed') {
    const weightOk = d.loadMode === 'weight' ? d.best.weightKg > 0 : d.best.weightKg >= 0;
    if (!weightOk || !(d.best.reps >= 1)) out.push('Your best needs a weight and at least one rep.');
    else if (d.best.reps > MANUAL_PB_MAX_REPS) out.push(`Your best can be at most ${MANUAL_PB_MAX_REPS} reps.`);
  }
  return out;
}

export interface Payload {
  exercise: {
    name: string; slug: string; group: string; equipment: string | null; measure: string; is_bodyweight: boolean;
    is_unilateral: boolean; muscle_group: string | null; load_mode: LoadMode; bw_factor: number | null; fatigue: FatigueClass;
    pb_estimate_from: string | null; pb_estimate_ratio: number | null; load_split: Record<string, number>;
  };
  muscles: { muscle_id: MuscleId; role: Role }[];
  best: { weight_kg: number; reps: number; e1rm: number; dated_at: string } | null;
}

/**
 * The rows Save writes: the exercise (slug custom_<id>, kept on edit), its muscles, and the
 * known best with its e1RM from the existing setE1rm. `today` is the user's date (YYYY-MM-DD);
 * `bodyweightKg` is today's, for a bodyweight or assisted best.
 */
export function toPayload(c: Thresholds, d: Draft, opts: { slug: string; today: string; bodyweightKg: number | null }): Payload {
  const muscles = rolesList(d.roles);
  const first = muscles.find((m) => m.role === 'primary')!.muscle_id;
  const measure = measureOf(d);
  const exercise: Payload['exercise'] = {
    name: d.name.trim(), slug: opts.slug, group: MUSCLE_GROUPS[first], equipment: d.equipment, measure,
    // a timed hold, or an old bodyweight exercise kept in weight mode (draftOf), is still bodyweight work
    is_bodyweight: d.loadMode === 'bodyweight' || d.equipment === 'bodyweight',
    is_unilateral: d.unilateral, muscle_group: LEGACY_MUSCLE_GROUP[first], load_mode: d.loadMode,
    bw_factor: d.loadMode === 'bodyweight' || d.loadMode === 'assisted' ? d.bwFactor : null, fatigue: d.fatigue,
    pb_estimate_from: d.similar, pb_estimate_ratio: d.similar ? RATIOS[d.ratio] : null,
    load_split: Object.fromEntries(loadSplit(c, null, muscles).map((p) => [p.muscle, p.pct])),
  };
  let best: Payload['best'] = null;
  if (d.best && d.loadMode !== 'fixed') {
    const row: ExerciseRow = { id: 'new', ...exercise };
    const e1rm = setE1rm(c, exerciseDef(row, muscles.map((m) => ({ exercise_id: 'new', ...m }))),
      { weightKg: d.best.weightKg, reps: d.best.reps, rpe: null }, opts.bodyweightKg);
    if (e1rm != null) best = { weight_kg: d.best.weightKg, reps: d.best.reps, e1rm, dated_at: opts.today };
  }
  return { exercise, muscles, best };
}

/** A new custom exercise's slug. */
export const customSlug = (uuid: string) => `custom_${uuid.replace(/-/g, '')}`;

/**
 * A saved exercise back into a draft, for Edit. One the old form saved (no load mode) reads as
 * legacyLoadMode says (`scored`: whether its PB history holds anything), with the chip that
 * matches it, so a bodyweight one that stored no e1RM becomes bodyweight: its factor starts
 * unset, so Save asks for one. One that did stays weight mode, still marked bodyweight. With no
 * fatigue class it gets its equipment's default, as choosing the chip would (build phase 8).
 */
export function draftOf(row: SavedRow, roles: readonly { muscle_id: string; role: string }[], scored = true): Draft {
  const copied: Roles = {};
  for (const r of roles) if (isMuscleId(r.muscle_id) && (ROLES as readonly string[]).includes(r.role)) copied[r.muscle_id] = r.role as Role;
  const ratio = (Object.entries(RATIOS).find(([, v]) => v === row.pb_estimate_ratio)?.[0] ?? 'same') as RatioChoice;
  const loadMode = (row.load_mode ?? legacyLoadMode(row, scored)) as LoadMode;
  const choice = choiceOf(row.equipment, loadMode, row.measure);
  // toPayload's is_bodyweight reads the equipment word, as the old form set it
  const equipment = legacyBodyweight(row) ? 'bodyweight' : row.equipment;
  return {
    name: row.name, similar: row.pb_estimate_from, ratio, choice, equipment, loadMode,
    logAs: timedMeasure(row.measure) ? 'seconds' : 'reps', bwFactor: row.bw_factor, unilateral: row.is_unilateral,
    fatigue: (row.fatigue ?? (choice ? EQUIPMENT[choice].fatigue : row.equipment === 'band' ? 'low' : 'standard')) as FatigueClass,
    roles: copied, best: null,
  };
}

// ---------------------------------------------------------------- the role chips

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const ch = [0, 1, 2].map((i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The text tone that reads better on a selected role chip's tint: no one tone does for every
 *  role in both themes (the primary tint is the accent itself). */
export function readableTone(bg: string, palette: { ink: string; onAccent: string }): 'ink' | 'onAccent' {
  return contrastRatio(palette.ink, bg) >= contrastRatio(palette.onAccent, bg) ? 'ink' : 'onAccent';
}
