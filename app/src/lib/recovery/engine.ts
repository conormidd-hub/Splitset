// The Muscle Recovery Map's maths (docs/load-model-spec.md): a port of scripts/load_model.py,
// function by function and in the same order, checked against data/load_model_fixtures.json by
// engine.test.ts.
//
// Pure: no I/O, no clock (`now` is always passed in) and no mutation of the inputs. The
// reference's module globals become the first argument, a Model of thresholds and library, so a
// user's overrides or an extra exercise are just a different Model. Storage and UI call in here.
//
// Where Python relies on truthiness (`x or default`, `if not w`), the port spells out the same
// behaviour: a missing or zero value falls back, while an RPE of 0 still counts as an RPE.

import { isMuscleId, MUSCLE_IDS, ROLES, type MuscleId } from './library.ts';
import type { Level } from './thresholds.ts';
import type {
  ExerciseDef, Library, LiftSet, Model, MuscleState, NewRecord, PbBefore, PbRecord, ScoredExercise,
  ScoredWorkout, SessionMuscle, SetDetail, Term, Workout,
} from './types.ts';

const HOURS_PER_DAY = 24;
/** The RPE scale: RPE 10 leaves no reps in reserve, and RIR is clamped to 0..5 (the constants
 *  file states this rule as text, e1rm.rir_from_rpe). */
const RPE_MAX = 10;
const RIR_MIN = 0;
const RIR_MAX = 5;
/** The RPE at which a fixed-cost set costs fixed_set.base (spec §4.3). */
const FIXED_SET_RPE_PIVOT = 8;
/** INOL divides reps by percentage points from the max (spec §4.1). */
const PERCENT = 100;
/** Trainable and ready times are found on a 15-minute grid (spec §9). The fixtures were
 *  computed on it, so an exact solve would disagree with them (F24: 53.69 h, not 53.75). */
const SCAN_STEP_H = 0.25;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** The first item with the largest key, as Python's max() picks on a tie. */
function firstMax<T>(items: readonly T[], key: (x: T) => number): T {
  let best = items[0];
  for (const x of items) if (key(x) > key(best)) best = x;
  return best;
}

function maxOf(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return m;
}

/** A Library from library entries; a later entry with the same slug replaces an earlier one. */
export function buildLibrary(entries: Iterable<ExerciseDef>): Library {
  return new Map(Array.from(entries, (e) => [e.slug, e] as const));
}

// ---------------------------------------------------------------- §3.1 e1RM

export function rirFromRpe(rpe: number | null | undefined): number | null {
  return rpe == null ? null : clamp(RPE_MAX - rpe, RIR_MIN, RIR_MAX);
}

export function e1rm(m: Model, w: number, r: number, rir = 0): number {
  const reps = Math.min(r + rir, m.c.e1rm.max_reps);
  return reps <= 1 ? w : w * (1 + reps / m.c.e1rm.epley_divisor);
}

// ---------------------------------------------------------------- §3.2 effective weight

/** Effective weight of a set, or null when the mode has none (fixed) or the entry cannot say. */
export function effectiveWeight(s: LiftSet, ex: ExerciseDef, bodyweight: number): number | null {
  const bw = s.bodyweight || bodyweight;   // the snapshot on the set wins (F31)
  const added = s.w || 0;
  switch (ex.load_mode) {
    case 'weight':
      return s.w ?? null;
    case 'bodyweight':
      return ex.bw_factor == null ? null : bw * ex.bw_factor + added;
    case 'assisted':
      return ex.bw_factor == null ? null : Math.max(bw * ex.bw_factor - added, 0);
    default:
      return null;   // fixed
  }
}

// ---------------------------------------------------------------- §3.3–§3.5 PB before a session

/** A slug's PB records from before `at`, after the manual-PB policy (§3.6). */
function records(m: Model, slug: string, at: number, history: readonly PbRecord[]): PbRecord[] {
  let recs = history.filter((h) => h.slug === slug && h.at < at);
  if (m.c.pb.manual_policy === 'replace_on_log') {
    const logged = recs.filter((h) => h.source === 'logged').map((h) => h.at);
    if (logged.length) {
      const newest = maxOf(logged);
      recs = recs.filter((h) => h.source === 'logged' || h.at > newest);
    }
  }
  return recs;
}

/** Rules 1–2 of §3.4: the monthly or lapsed PB and whether it was logged or manual. */
function ownPb(m: Model, slug: string, at: number, history: readonly PbRecord[]):
  { pb: number; source: 'monthly' | 'lapsed'; kind: PbRecord['source'] } | null {
  const win = m.c.pb.window_days * HOURS_PER_DAY;
  const recs = records(m, slug, at, history);
  const inWin = recs.filter((h) => h.at >= at - win);
  if (inWin.length) {
    const best = firstMax(inWin, (h) => h.e1rm);
    return { pb: best.e1rm, source: 'monthly', kind: best.source };
  }
  if (recs.length) {
    const last = maxOf(recs.map((h) => h.at));
    const best = firstMax(recs.filter((h) => h.at >= last - win), (h) => h.e1rm);
    return { pb: best.e1rm * m.c.pb.lapsed_factor, source: 'lapsed', kind: best.source };
  }
  return null;
}

/**
 * The reference PB for `slug` at the start of a session (§3.4): monthly, else lapsed, else
 * estimated through pb_estimate links (an anchor's lapsed factor and the estimate discount both
 * apply), else calibration. A link to an exercise missing from the library ends the chain.
 */
export function pbBefore(m: Model, slug: string, at: number, history: readonly PbRecord[]): PbBefore {
  const own = ownPb(m, slug, at, history);
  if (own) return { pb: own.pb, source: own.source, detail: own.kind };
  let ratio = 1;
  let cur = m.lib.get(slug);
  let hops = 0;
  while (cur?.pb_estimate && hops < m.c.pb.estimate_max_hops) {
    const est = cur.pb_estimate;
    ratio *= est.ratio;
    hops += 1;
    const base = ownPb(m, est.from, at, history);
    if (base) return { pb: base.pb * ratio * m.c.pb.estimate_discount, source: 'estimated', detail: est.from };
    cur = m.lib.get(est.from);
  }
  return { pb: null, source: 'calibration', detail: null };
}

// ---------------------------------------------------------------- §4 set load

export function fixedCost(m: Model, rpe: number | null | undefined): number {
  const f = m.c.fixed_set;
  if (rpe == null) return f.base;
  return clamp(f.base + f.per_rpe_point * (rpe - FIXED_SET_RPE_PIVOT), f.min, f.max);
}

/** INOL of one set and the relative intensity I it used. */
export function inol(m: Model, w: number, r: number, ref: number): { inol: number; I: number } {
  const I = Math.min(w / ref, m.c.intensity_cap);
  const reps = Math.min(r, m.c.e1rm.max_reps);
  return { inol: reps / (PERCENT * (1 - I)), I };
}

export function sideFactor(m: Model, s: LiftSet): number {
  return s.side === 'left' || s.side === 'right' ? m.c.unilateral_side_factor : 1;
}

/**
 * §3–§5 for one exercise in one session: per-set detail, the exercise load L_e and the e1RM
 * records its sets produce. `sessionBest` is the e1RM already reached on this exercise earlier
 * in the same workout, so an exercise logged in two blocks keeps one running reference (F28).
 * Sets with no effective weight above zero, or no reps, are skipped (§14), and so are sets with
 * negative or non-finite reps, which would score negative INOL and cancel real sets.
 */
export function scoreExercise(
  m: Model, slug: string, sets: readonly LiftSet[], start: number, history: readonly PbRecord[],
  bodyweight: number, sessionBest: number | null = null,
): ScoredExercise {
  const ex = m.lib.get(slug);
  if (!ex) throw new Error(`scoreExercise: ${slug} is not in the library`);
  const f = m.c.fatigue_factors[ex.fatigue];
  const detail: SetDetail[] = [];

  if (ex.load_mode === 'fixed') {
    let total = 0;
    for (const s of sets) {
      if (s.warmup) continue;
      const cost = fixedCost(m, s.rpe) * sideFactor(m, s);
      detail.push({ cost });
      total += cost;
    }
    return { L_e: f * total, raw: total, factor: f, sets: detail, pb_before: null, pb_source: 'not needed',
             pb_via: null, records: [], best: null };
  }

  const { pb: pb0, source, detail: via } = pbBefore(m, slug, start, history);
  const calibrating = source === 'calibration';
  let best = Math.max(pb0 || 0, sessionBest || 0);
  let total = 0;
  const newRecords: NewRecord[] = [];
  for (const s of sets) {
    const w = effectiveWeight(s, ex, bodyweight);
    if (!w || w <= 0 || !Number.isFinite(w) || s.r == null || !Number.isFinite(s.r) || s.r < 0) continue;
    const r = s.r;
    const rir = rirFromRpe(s.rpe);
    const scoringRir = rir ?? (calibrating ? m.c.pb.calibration_rir : m.c.e1rm.rir_default);
    const storedRir = rir ?? m.c.e1rm.rir_default;
    best = Math.max(best, e1rm(m, w, r, scoringRir));
    newRecords.push({ slug, e1rm: e1rm(m, w, r, storedRir), source: 'logged' });
    if (s.warmup) {
      detail.push({ w, r, warmup: true, ref: best });
      continue;
    }
    const set = inol(m, w, r, best);
    const load = set.inol * sideFactor(m, s);
    detail.push({ w, r, ref: best, I: set.I, inol: load });
    total += load;
  }
  return { L_e: f * total, raw: total, factor: f, sets: detail, pb_before: pb0, pb_source: source,
           pb_via: via, records: newRecords, best };
}

// ---------------------------------------------------------------- §6 muscle load

/** L_m for every muscle from {slug: L_e}. Exercises outside the library contribute nothing. */
export function muscleLoads(m: Model, exerciseLoads: Readonly<Record<string, number>>): Record<MuscleId, number> {
  const out = Object.fromEntries(MUSCLE_IDS.map((id) => [id, 0])) as Record<MuscleId, number>;
  for (const [slug, le] of Object.entries(exerciseLoads)) {
    const ex = m.lib.get(slug);
    if (!ex) continue;
    for (const role of ROLES) {
      for (const muscle of ex[role]) {
        if (isMuscleId(muscle)) out[muscle] += m.c.role_weights[role] * le;
      }
    }
  }
  return out;
}

/**
 * Scores a finished workout (§3–§7). Unlike the reference, it does not append to `history`:
 * its PB records come back in `records`, dated at the workout's end, for the caller to add
 * (scoreWorkouts does). Exercises missing from the library are skipped (§14).
 */
export function scoreWorkout(m: Model, workout: Workout, history: readonly PbRecord[], bodyweight?: number | null): ScoredWorkout {
  const bw = bodyweight || m.c.bodyweight_default_kg;
  const L_e: Record<string, number> = {};
  const detail: Record<string, ScoredExercise> = {};
  const sessionBest = new Map<string, number>();
  const newRecords: NewRecord[] = [];
  for (const [slug, sets] of workout.exercises) {
    if (!m.lib.has(slug)) continue;
    let res = scoreExercise(m, slug, sets, workout.start, history, bw, sessionBest.get(slug) ?? null);
    sessionBest.set(slug, res.best ?? 0);
    newRecords.push(...res.records);
    L_e[slug] = (L_e[slug] ?? 0) + res.L_e;
    const prev = detail[slug];
    if (prev) {   // second block of the same exercise: merge
      res = { ...prev, L_e: prev.L_e + res.L_e, raw: prev.raw + res.raw, sets: [...prev.sets, ...res.sets],
              records: [...prev.records, ...res.records], best: res.best };
    }
    detail[slug] = res;
  }
  const L_m = muscleLoads(m, L_e);
  const R = Object.fromEntries(MUSCLE_IDS.map((id) => [id, recoveryHours(m, L_m[id], id)])) as Record<MuscleId, number>;
  return { L_e, L_m, R, detail, end: workout.end, records: newRecords.map((r) => ({ ...r, at: workout.end })) };
}

/**
 * Scores workouts in the order given (the order they happened), each against the PB history
 * so far plus the records of the workouts before it, as the reference does by appending to one
 * list. Returns the scored workouts and the history with every new record added.
 */
export function scoreWorkouts(
  m: Model, workouts: readonly Workout[], history: readonly PbRecord[], bodyweight?: number | null,
): { scored: ScoredWorkout[]; history: PbRecord[] } {
  let hist = [...history];
  const scored: ScoredWorkout[] = [];
  for (const w of workouts) {
    const s = scoreWorkout(m, w, hist, bodyweight);
    scored.push(s);
    hist = hist.concat(s.records);
  }
  return { scored, history: hist };
}

// ---------------------------------------------------------------- §7 recovery window

export function baseHours(m: Model, muscle: MuscleId): number {
  const b = m.c.base_recovery_hours;
  return b[muscle] ?? b.default;
}

export function recoveryHours(m: Model, L: number, muscle: MuscleId): number {
  const r = m.c.recovery;
  return baseHours(m, muscle) * clamp(r.intercept + r.slope * L, r.min_multiplier, r.max_multiplier);
}

/** For a single workout term: hours after the workout until F < threshold. */
export function hoursUntilBelow(L: number, R: number, threshold: number): number {
  return L < threshold ? 0 : R * (1 - threshold / L);
}

// ---------------------------------------------------------------- §8 fatigue over time

/** Longest possible recovery window: no older workout can still be non-zero. */
export function lookbackHours(m: Model): number {
  return maxOf(Object.values(m.c.base_recovery_hours) as number[]) * m.c.recovery.max_multiplier;
}

export function termsFor(scored: readonly ScoredWorkout[], muscle: MuscleId): Term[] {
  return scored.filter((s) => s.L_m[muscle] > 0).map((s) => [s.end, s.L_m[muscle], s.R[muscle]] as const);
}

export function fatigue(terms: readonly Term[], t: number): number {
  let F = 0;
  for (const [tw, L, R] of terms) if (tw <= t) F += L * Math.max(0, 1 - (t - tw) / R);
  return F;
}

export function weekly(m: Model, terms: readonly Term[], t: number): number {
  const win = m.c.fatigue.weekly_window_hours;
  let W = 0;
  for (const [tw, L] of terms) if (t - tw >= 0 && t - tw < win) W += L;
  return W;
}

// ---------------------------------------------------------------- §9 levels

/** The level whose band holds F; lower bounds are inclusive. */
export function levelFor(m: Model, F: number): number {
  let lvl = 0;
  for (const band of m.c.levels) if (F >= band.min && band.level > 0) lvl = band.level;
  return lvl;
}

/** levelFor, raised to weekly_cap_min_level while the weekly load is at the cap (§8). */
export function displayedLevel(m: Model, F: number, W: number): number {
  const lvl = levelFor(m, F);
  return W >= m.c.fatigue.weekly_cap ? Math.max(lvl, m.c.fatigue.weekly_cap_min_level) : lvl;
}

export function levelInfo(m: Model, lvl: number): Level {
  return m.c.levels[lvl];
}

/**
 * First t ≥ now on the 15-minute grid where pred(t) holds, or null within the horizon (by
 * default the longest window plus a week). F only falls and W only drops at workout
 * anniversaries, so the scan is exact enough for display.
 */
export function firstTime(m: Model, now: number, pred: (t: number) => boolean, horizon?: number | null, step = SCAN_STEP_H): number | null {
  const h = horizon || lookbackHours(m) + m.c.fatigue.weekly_window_hours;
  for (let t = now; t <= now + h; t += step) if (pred(t)) return t;
  return null;
}

/** One muscle on the recovery view (§8–§10): fatigue now, weekly load, level and colours, and
 *  hours until it is trainable (level ≤ trainable_max_level) and ready (level 0). */
export function muscleState(m: Model, terms: readonly Term[], now: number): MuscleState {
  const F = fatigue(terms, now);
  const W = weekly(m, terms, now);
  const lvl = displayedLevel(m, F, W);
  const levelAt = (t: number) => displayedLevel(m, fatigue(terms, t), weekly(m, terms, t));
  const ready = firstTime(m, now, (t) => levelAt(t) === 0);
  const trainable = firstTime(m, now, (t) => levelAt(t) <= m.c.trainable_max_level);
  const info = levelInfo(m, lvl);
  return {
    F, W, level: lvl, label: info.label, advice: info.advice,
    fill: info.fill || m.c.ready_fill, fill_dark: info.fill_dark || m.c.ready_fill_dark,
    ready_in_h: ready == null ? null : ready - now,
    trainable_in_h: trainable == null ? null : trainable - now,
  };
}

/** The recovery view: every muscle's state at `now` from the scored workouts. */
export function recoveryMap(m: Model, scored: readonly ScoredWorkout[], now: number): Record<MuscleId, MuscleState> {
  return Object.fromEntries(MUSCLE_IDS.map((id) => [id, muscleState(m, termsFor(scored, id), now)])) as Record<MuscleId, MuscleState>;
}

/** The session view (§10): colour by this workout's own L_m, with recovery times from it alone. */
export function sessionMap(m: Model, scored: ScoredWorkout): Record<MuscleId, SessionMuscle> {
  const c = m.c;
  return Object.fromEntries(MUSCLE_IDS.map((id) => {
    const L = scored.L_m[id];
    const R = scored.R[id];
    const lvl = levelFor(m, L);
    const info = levelInfo(m, lvl);
    return [id, {
      L, level: lvl, label: info.label,
      fill: info.fill || c.ready_fill, fill_dark: info.fill_dark || c.ready_fill_dark,
      R, ready_in_h: hoursUntilBelow(L, R, c.levels[1].min),
      trainable_in_h: hoursUntilBelow(L, R, c.levels[c.trainable_max_level + 1].min),
    } satisfies SessionMuscle];
  })) as Record<MuscleId, SessionMuscle>;
}

/**
 * x to `digits` decimal places the way Python formats it: an exact tie goes to the even
 * neighbour (2.25 → "2.2"), where toFixed would round up. x is an exact tie only when
 * x × 2^(digits+1) is an odd integer, and multiplying by a power of two is exact.
 */
function fixedHalfEven(x: number, digits: number): string {
  const halves = x * 2 ** (digits + 1);
  if (!Number.isInteger(halves) || halves % 2 === 0) return x.toFixed(digits);
  const scale = 10 ** digits;
  const lower = Math.floor(x * scale);
  return ((lower % 2 === 0 ? lower : lower + 1) / scale).toFixed(digits);
}

/** "now", "N h" under a day, otherwise "N.N days" (§9). "—" when there is no time. Half an hour
 *  or less reads "< 1 h", where the reference would say "0 h" for a muscle not yet trainable. */
export function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—';
  if (h <= 0) return 'now';
  if (h < HOURS_PER_DAY) {
    const whole = fixedHalfEven(h, 0);
    return whole === '0' ? '< 1 h' : `${whole} h`;
  }
  return `${fixedHalfEven(h / HOURS_PER_DAY, 1)} days`;
}
