/// <reference types="node" />

// Save as routine: a workout logged one side per set becomes a routine whose sets carry the same
// load (spec §4.4), since a routine set has no side.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ActiveWorkout, ExerciseBlock, SetRow, Side } from './activeWorkout.ts';
import { useRoutineDraft } from './routineDraft.ts';

const T = '2026-10-19T09:00:00Z';
const set = (blockId: string, position: number, side: Side | null, weightKg = 30, reps = 10): SetRow => ({
  id: `${blockId}-${position}`, workoutExerciseId: blockId, exerciseId: `ex-${blockId}`, position, setType: 'working',
  weightKg, reps, rpe: null, seconds: null, side, completed: true, completedAt: T, notes: null, updatedAt: T,
});
const block = (id: string, sets: SetRow[], perSide = false): ExerciseBlock => ({
  id, exerciseId: `ex-${id}`, name: id, measure: 'weight_reps', position: 0, restSeconds: 90, supersetGroup: null,
  notes: null, sets, updatedAt: T, perSide,
});
const workout = (exercises: ExerciseBlock[]): ActiveWorkout => ({
  id: 'w1', userId: 'u1', routineId: null, name: 'Pull', startedAt: T, notes: null, bodyweightKg: 80, exercises, updatedAt: T,
});

test('a block logged L, R, L, R, L, R saves three both-sides targets; a block without sides keeps every set', () => {
  const sides: Side[] = ['left', 'right', 'left', 'right', 'left', 'right'];
  useRoutineDraft.getState().fromWorkout(workout([
    block('row', sides.map((s, i) => set('row', i, s)), true),
    block('curl', [0, 1, 2].map((i) => set('curl', i, null, 12, 12))),
  ]));
  const [row, curl] = useRoutineDraft.getState().toDraft().exercises;
  assert.equal(row.sets.length, 3);
  for (const s of row.sets) assert.deepEqual([s.targetWeightKg, s.targetReps], [30, 10]);
  assert.equal(curl.sets.length, 3);
});

test('an odd side out still gets its own target, and each pair keeps its first side\'s figures', () => {
  useRoutineDraft.getState().fromWorkout(workout([
    block('row', [set('row', 0, 'left', 30), set('row', 1, 'right', 30), set('row', 2, 'left', 32, 8)], true),
  ]));
  const [row] = useRoutineDraft.getState().toDraft().exercises;
  assert.deepEqual(row.sets.map((s) => [s.targetWeightKg, s.targetReps]), [[30, 10], [32, 8]]);
});
