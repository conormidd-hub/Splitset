// A unilateral exercise logged one side per set (side 'left' | 'right') counts the same as logged
// both sides at once (spec §4.4): a left + right pair is one set, and each side set adds half its
// volume. The same rule as the workout_summaries and exercise_records views
// (supabase/migrations/20261019000200_side_set_counts.sql), for the totals the app adds up itself.

type Sided = { side?: string | null };
type Volumed = Sided & { weight_kg: number | null; reps: number | null };

const isSide = (s: Sided) => s.side != null;

/** How many sets these are, a left + right pair counted once (an unpaired side rounds up). */
export function setCount(sets: readonly Sided[]): number {
  const sided = sets.filter(isSide).length;
  return sets.length - sided + Math.ceil(sided / 2);
}

/** Their volume, weight × reps, each side set counting half. */
export function volumeKg(sets: readonly Volumed[]): number {
  return sets.reduce((t, s) => t + (s.weight_kg ?? 0) * (s.reps ?? 0) * (isSide(s) ? 0.5 : 1), 0);
}
