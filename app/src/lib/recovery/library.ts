// Names the recovery map shares with data/exercise_library.json and the database. These are
// identifiers, not tunable numbers: tunables live in data/recovery_constants.json (thresholds.ts).
//
// Imports in src/lib/recovery use relative paths with the .ts extension and no enums, so Node's
// test runner can load these files directly (npm test).

/** The 17 muscle IDs of docs/load-model-spec.md §2, in that order. Used exactly, everywhere. */
export const MUSCLE_IDS = [
  'chest', 'traps', 'lats', 'lower_back', 'front_delts', 'side_delts', 'rear_delts',
  'biceps', 'triceps', 'forearms', 'abs', 'obliques',
  'glutes', 'quads', 'adductors', 'hamstrings', 'calves',
] as const;
export type MuscleId = (typeof MUSCLE_IDS)[number];

export function isMuscleId(s: string): s is MuscleId {
  return (MUSCLE_IDS as readonly string[]).includes(s);
}

/** The library's exercise groups, in library order: the picker's filters. */
export const EXERCISE_GROUPS = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core', 'Full body'] as const;
export type ExerciseGroup = (typeof EXERCISE_GROUPS)[number];

/** How an exercise loads a muscle; exercise_muscles.role. */
export const ROLES = ['primary', 'secondary', 'tertiary'] as const;
export type Role = (typeof ROLES)[number];
