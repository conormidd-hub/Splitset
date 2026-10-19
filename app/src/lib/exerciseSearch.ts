// Search and group filter for the exercise picker and the exercise library screen.

/** The fields the filter reads; an exercises row has them all. */
export interface SearchableExercise {
  name: string;
  slug: string | null;
  group: string | null;
  muscle_group: string | null;
}

/**
 * Exercises whose name, slug, library group or older muscle group contains the query
 * (case-insensitive; "rdl" finds both Romanian deadlifts by slug), limited to one library
 * group when one is chosen. Exercises outside the library have no group, so only "All" shows them.
 */
export function filterExercises<T extends SearchableExercise>(all: readonly T[], query: string, group: string | null): T[] {
  const q = query.trim().toLowerCase();
  return all.filter((e) => {
    if (group && e.group !== group) return false;
    if (!q) return true;
    return [e.name, e.slug, e.group, e.muscle_group].some((f) => f?.toLowerCase().includes(q));
  });
}
