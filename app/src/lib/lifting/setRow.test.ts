/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseConstants } from '../recovery/thresholds.ts';
import { setRowPayload, usesBodyweight, type ExerciseFacts, type SetRow } from './setRow.ts';

const C = parseConstants(JSON.parse(readFileSync(new URL('../../../../data/recovery_constants.json', import.meta.url), 'utf8')));
const workout = { id: 'w1', userId: 'u1', bodyweightKg: 80 };
const benchFacts: ExerciseFacts = { exerciseId: 'e1', measure: 'weight_reps', slug: 'bench_press_bb', loadMode: 'weight', bwFactor: null };
const set = (patch: Partial<SetRow>): SetRow => ({
  id: 's1', workoutExerciseId: 'we1', exerciseId: 'e1', position: 0, setType: 'working', weightKg: 115, reps: 3, rpe: null,
  seconds: null, completed: true, completedAt: '2026-10-16T09:00:00Z', notes: null, updatedAt: 'x', ...patch,
});

test('the saved row carries every workout_sets column the logger writes, e1rm and side included', () => {
  assert.deepEqual(setRowPayload(C, workout, benchFacts, set({}), '2026-10-16T09:00:01Z'), {
    id: 's1', workout_exercise_id: 'we1', workout_id: 'w1', exercise_id: 'e1', user_id: 'u1', position: 0, set_type: 'working',
    weight_kg: 115, reps: 3, rpe: null, seconds: null, side: null, e1rm: 126.50000000000001,
    completed: true, completed_at: '2026-10-16T09:00:00Z', notes: null, updated_at: '2026-10-16T09:00:01Z',
  });
});

test('F02 through the logger: 115 × 3 and 125 × 1 save 126.5 and 125.0', () => {
  const rows = [set({ weightKg: 115, reps: 3 }), set({ id: 's2', position: 1, weightKg: 125, reps: 1 })]
    .map((s) => setRowPayload(C, workout, benchFacts, s, 'now'));
  assert.ok(Math.abs(rows[0].e1rm! - 126.5) < 1e-9);
  assert.equal(rows[1].e1rm, 125);
});

test('a warm-up and an unticked set still store their e1RM; a side is saved as given', () => {
  assert.equal(setRowPayload(C, workout, benchFacts, set({ setType: 'warmup', weightKg: 60, reps: 1 }), 'now').e1rm, 60);
  assert.equal(setRowPayload(C, workout, benchFacts, set({ completed: false, weightKg: 100, reps: 1 }), 'now').e1rm, 100);
  assert.equal(setRowPayload(C, workout, { ...benchFacts, unilateral: true }, set({ side: 'left' }), 'now').side, 'left');
});

test('bodyweight exercises use the workout snapshot', () => {
  const pullUp: ExerciseFacts = { exerciseId: 'e2', measure: 'weight_reps', slug: 'pull_up', loadMode: 'bodyweight', bwFactor: 1 };
  assert.ok(usesBodyweight(pullUp) && !usesBodyweight(benchFacts));
  const e1rm = setRowPayload(C, workout, pullUp, set({ weightKg: 10, reps: 5 }), 'now').e1rm!;
  assert.ok(Math.abs(e1rm - 90 * (1 + 5 / 30)) < 1e-9);
});

test('a block from before Phase 3 (measure only) still gets a weight-mode e1RM; no block, none', () => {
  assert.equal(setRowPayload(C, workout, { exerciseId: 'e1', measure: 'weight_reps' }, set({ weightKg: 100, reps: 1 }), 'now').e1rm, 100);
  assert.equal(setRowPayload(C, workout, { exerciseId: 'e3', measure: 'duration' }, set({ seconds: 60 }), 'now').e1rm, null);
  assert.equal(setRowPayload(C, workout, undefined, set({}), 'now').e1rm, null);
});
