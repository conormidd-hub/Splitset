/// <reference types="node" />

// The recovery engine for scripts outside the app: JSON on stdin, JSON on stdout.
//
//   node app/scripts/recovery-cli.ts < request.json
//
// supabase/backfill_e1rm.py and the database tests (supabase/tests/test_pb_storage.py) use it,
// so a set gets exactly the e1RM the app would give it and a PB reference is resolved exactly as
// the PB screen resolves it, without porting any maths to Python. It imports only the pure
// modules (src/lib/recovery, src/lib/lifting/setRow.ts), so plain Node 22.18+ runs it.
//
// Requests (each may carry `thresholds_rows` and `user_id`: that user's user_thresholds rows):
//   { "command": "set-rows",   "workout": WorkoutRef, "exercise": ExerciseRow, "sets": SetRow[], "updated_at": iso }
//       → the workout_sets rows the logger would save
//   { "command": "e1rm",       "sets": [{ "id", "exercise": ExerciseRow, "weight_kg", "reps", "rpe", "workout_bodyweight" }],
//                              "fallback_bodyweight": kg }
//       → [{ "id", "e1rm" }]
//   { "command": "bodyweight", "profile": { bodyweight_kg, bodyweight_updated_at } | null, "weigh_in": { weight_kg, date } | null }
//       → { "kg", "source", "date" }
//   { "command": "reference",  "exercises": (ExerciseRow & { name })[], "rows": PbHistoryRow[], "exercise_id", "at": iso }
//       → { "pb", "source", "detail", "tone", "label" }
//   { "command": "score-workouts", "exercises", "muscles", "workouts", "blocks", "sets", "history" }   (ScoringRows)
//       → WorkoutLoads[]: the cache rows of every finished workout, in time order (build phase 4)
//   { "command": "recovery-map", "exercises", "muscles", "loads": LoadWindow, "at": iso }
//       → RecoveryMap at that instant: recovery_map(user, at) of build phase 5 over what
//         recovery_loads() returned. "rows" (muscle rows only) may stand in for "loads"; the
//         contributing lists are then empty
//   { "command": "session-map", "rows": [{ muscle_id, load, recovery_hours }] }
//       → SessionMap: session_map(workout) over that workout's workout_muscle_loads rows
//   { "command": "recovery-history", "exercises", "muscles", "loads": LoadWindow, "from": iso, "to": iso, "step_h"?: 24 }
//       → RecoverySample[]: recovery_history(user, from, to, step)

import { readFileSync } from 'node:fs';

import { setRowPayload, type ExerciseFacts, type SetRow, type WorkoutRef } from '../src/lib/lifting/setRow.ts';
import { buildLibrary } from '../src/lib/recovery/engine.ts';
import { hoursOf, strengthReference, toPbHistory, type PbHistoryRow } from '../src/lib/recovery/pbHistory.ts';
import { currentBodyweight, engineKey, exerciseDef, setE1rm, type ExerciseRow } from '../src/lib/recovery/sets.ts';
import { parseConstants, thresholdsFor, type ThresholdOverride } from '../src/lib/recovery/thresholds.ts';
import type { ExerciseDef } from '../src/lib/recovery/types.ts';
import {
  recoveryHistory, recoveryMapAt, sessionMapFromLoads, type LoadWindow, type WindowMuscleRow,
} from '../src/lib/recovery/read.ts';
import { libraryFromRows, scoreFinishedWorkouts, type MuscleLoadRow, type ScoringRows } from '../src/lib/recovery/workoutLoads.ts';
import type { ExerciseMuscleRow } from '../src/lib/recovery/sets.ts';

type Request = Record<string, unknown> & { command: string; user_id?: string; thresholds_rows?: ThresholdOverride[] };

const DEFAULTS = parseConstants(JSON.parse(readFileSync(new URL('../../data/recovery_constants.json', import.meta.url), 'utf8')));

const factsOf = (e: ExerciseRow): ExerciseFacts => ({
  exerciseId: e.id, measure: e.measure, slug: e.slug, loadMode: e.load_mode, bwFactor: e.bw_factor, unilateral: e.is_unilateral,
});

function handle(req: Request): unknown {
  const c = req.user_id && req.thresholds_rows ? thresholdsFor(DEFAULTS, req.user_id, req.thresholds_rows) : DEFAULTS;
  switch (req.command) {
    case 'set-rows': {
      const exercise = req.exercise as ExerciseRow;
      return (req.sets as SetRow[]).map((s) =>
        setRowPayload(c, req.workout as WorkoutRef, factsOf(exercise), s, String(req.updated_at)));
    }
    case 'e1rm': {
      const sets = req.sets as { id: string; exercise: ExerciseRow; weight_kg: number | null; reps: number | null; rpe: number | null; workout_bodyweight: number | null }[];
      return sets.map((s) => ({
        id: s.id,
        e1rm: setE1rm(c, exerciseDef(s.exercise), { weightKg: s.weight_kg, reps: s.reps, rpe: s.rpe }, s.workout_bodyweight,
          req.fallback_bodyweight as number | null),
      }));
    }
    case 'bodyweight':
      return currentBodyweight(c, req.profile as never, req.weigh_in as never);
    case 'reference': {
      const exercises = req.exercises as (ExerciseRow & { name: string })[];
      const defs: ExerciseDef[] = [];
      const keyOf = new Map<string, string>();
      const nameOf = new Map<string, string>();
      for (const e of exercises) {
        keyOf.set(e.id, engineKey(e));
        nameOf.set(engineKey(e), e.name);
        const def = exerciseDef(e);
        if (def) defs.push(def);
      }
      const history = toPbHistory(req.rows as PbHistoryRow[], (id) => keyOf.get(id));
      const key = keyOf.get(String(req.exercise_id));
      if (!key) throw new Error(`unknown exercise ${String(req.exercise_id)}`);
      return strengthReference({ c, lib: buildLibrary(defs) }, key, hoursOf(String(req.at)), history, (k) => nameOf.get(k));
    }
    case 'score-workouts':
      return scoreFinishedWorkouts({ ...(req as unknown as Omit<ScoringRows, 'thresholds'>), thresholds: c });
    case 'recovery-map': {
      const { lib, keyOf } = libraryFromRows(req.exercises as ExerciseRow[], req.muscles as ExerciseMuscleRow[]);
      const loads = (req.loads as LoadWindow | undefined) ?? { muscles: req.rows as WindowMuscleRow[], exercises: [] };
      return recoveryMapAt({ c, lib }, keyOf, loads, hoursOf(String(req.at)));
    }
    case 'session-map':
      return sessionMapFromLoads({ c, lib: buildLibrary([]) }, req.rows as MuscleLoadRow[]);
    case 'recovery-history': {
      const { lib, keyOf } = libraryFromRows(req.exercises as ExerciseRow[], req.muscles as ExerciseMuscleRow[]);
      return recoveryHistory({ c, lib }, keyOf, req.loads as LoadWindow, hoursOf(String(req.from)), hoursOf(String(req.to)),
        (req.step_h as number | undefined) ?? 24);
    }
    default:
      throw new Error(`unknown command ${req.command}`);
  }
}

const input = readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify(handle(JSON.parse(input) as Request)));
