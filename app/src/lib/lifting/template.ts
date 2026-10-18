// Templates (routines) and the workouts started from them: whether a workout changed its template,
// the routine a workout becomes when it updates one, and how routines sit in their groups.
// Pure, so it is tested under Node; the Lift tab and the workout screen use it.

/** The sets a routine keeps from a workout's sets. A routine set has no side, so it replays as one
 *  set for both sides (1.0 under spec §4.4, where a per-side set counts 0.5): sets logged one side
 *  per set keep one target per left/right pair. */
export function pairedSets<S extends { side?: unknown }>(sets: readonly S[]): S[] {
  let sided = 0;
  return sets.filter((s) => !s.side || sided++ % 2 === 0);
}

/**
 * Whether a workout changed the template it started from: an exercise added or removed. A
 * different order, set count or load is the same template (progress is expected). Null when the
 * workout didn't start from a template, or started before the template's exercises were kept.
 */
export function templateChanged(baseline: readonly string[] | null | undefined, exerciseIds: readonly string[]): boolean | null {
  if (!baseline) return null;
  const count = new Map<string, number>();
  for (const id of baseline) count.set(id, (count.get(id) ?? 0) + 1);
  for (const id of exerciseIds) count.set(id, (count.get(id) ?? 0) - 1);
  return [...count.values()].some((n) => n !== 0);
}

type WorkoutLike = {
  exercises: readonly {
    exerciseId: string;
    restSeconds: number | null;
    supersetGroup: number | null;
    sets: readonly { setType: string; reps: number | null; weightKg: number | null; seconds: number | null; rpe: number | null; side?: unknown }[];
  }[];
};

export type TemplateExercise = {
  exerciseId: string;
  restSeconds: number | null;
  supersetGroup: number | null;
  notes: string | null;
  sets: { setType: string; targetReps: number | null; targetWeightKg: number | null; targetSeconds: number | null; targetRpe: number | null }[];
};

/**
 * A template's exercises taken from a workout ("Update template"): today's exercises in today's
 * order, today's sets with what was lifted as the targets. Template notes are notes about the
 * template, not the session, so each exercise keeps the note the template had for it.
 */
export function templateFromWorkout(w: WorkoutLike, templateNotes: ReadonlyMap<string, string | null> = new Map()): TemplateExercise[] {
  return w.exercises.map((b) => ({
    exerciseId: b.exerciseId,
    restSeconds: b.restSeconds,
    supersetGroup: b.supersetGroup,
    notes: templateNotes.get(b.exerciseId) ?? null,
    sets: pairedSets(b.sets).map((s) => ({
      setType: s.setType, targetReps: s.reps, targetWeightKg: s.weightKg, targetSeconds: s.seconds, targetRpe: s.rpe,
    })),
  }));
}

// ---------------------------------------------------------------- groups

export type Grouped = { id: string; group_id?: string | null; position: number; created_at: string };
export type GroupRow = { id: string; name: string; position: number; created_at: string };
export type Section<R> = { group: GroupRow | null; routines: R[] };

const byPosition = <X extends { position: number; created_at: string }>(a: X, b: X) =>
  a.position - b.position || a.created_at.localeCompare(b.created_at);

/** The groups in order, each with its routines in order, then "My routines" (no group, or a
 *  group that no longer exists) last. */
export function groupRoutines<R extends Grouped>(routines: readonly R[], groups: readonly GroupRow[]): Section<R>[] {
  const known = new Set(groups.map((g) => g.id));
  const sections: Section<R>[] = [...groups].sort(byPosition).map((g) => ({ group: g, routines: [] }));
  const loose: R[] = [];
  for (const r of routines) {
    const gid = r.group_id && known.has(r.group_id) ? r.group_id : null;
    if (gid) sections.find((s) => s.group?.id === gid)!.routines.push(r);
    else loose.push(r);
  }
  for (const s of sections) s.routines.sort(byPosition);
  return [...sections, { group: null, routines: loose.sort(byPosition) }];
}

/**
 * The writes that move a routine into a group (null: "My routines") at an index within it: the
 * moved routine's group and the new positions of every routine in that group, numbered from 0.
 * Only rows whose group or position changes are returned.
 */
export function moveRoutine<R extends Grouped>(sections: readonly Section<R>[], routineId: string, toGroupId: string | null, toIndex: number):
  { id: string; group_id: string | null; position: number }[] {
  const moving = sections.flatMap((s) => s.routines).find((r) => r.id === routineId);
  const target = sections.find((s) => (s.group?.id ?? null) === toGroupId);
  if (!moving || !target) return [];
  const rest = target.routines.filter((r) => r.id !== routineId);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  const ordered = [...rest.slice(0, at), moving, ...rest.slice(at)];
  return ordered
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => r.position !== i || (r.group_id ?? null) !== toGroupId)
    .map(({ r, i }) => ({ id: r.id, group_id: toGroupId, position: i }));
}

// ---------------------------------------------------------------- the View popup

type TargetSet = { set_type?: string | null; target_reps: number | null; target_weight_kg: number | null; target_seconds?: number | null };

/** A template exercise's sets in a few words: runs of the same target become "3 × 8 @ 100 kg";
 *  warm-ups are left out; with no targets at all, "3 sets". */
export function setsSummary(sets: readonly TargetSet[], fmtKg: (kg: number) => string): string {
  const work = sets.filter((s) => s.set_type !== 'warmup');
  if (!work.length) return sets.length ? `${sets.length} warm-up set${sets.length === 1 ? '' : 's'}` : 'No sets';
  if (work.every((s) => s.target_reps == null && s.target_weight_kg == null && s.target_seconds == null)) {
    return `${work.length} set${work.length === 1 ? '' : 's'}`;
  }
  const label = (s: TargetSet) => {
    const count = s.target_seconds != null ? `${s.target_seconds} s` : s.target_reps != null ? `${s.target_reps}` : '–';
    return s.target_weight_kg != null ? `${count} @ ${fmtKg(s.target_weight_kg)}` : count;
  };
  const runs: { text: string; n: number }[] = [];
  for (const s of work) {
    const text = label(s);
    const last = runs[runs.length - 1];
    if (last && last.text === text) last.n++;
    else runs.push({ text, n: 1 });
  }
  return runs.map((r) => `${r.n} × ${r.text}`).join(', ');
}
