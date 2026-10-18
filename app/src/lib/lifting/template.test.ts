import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupRoutines, moveRoutine, setsSummary, templateChanged, templateFromWorkout } from './template.ts';

test('a template changes only when an exercise is added or removed', () => {
  const base = ['squat', 'rdl', 'calf'];
  assert.equal(templateChanged(base, ['squat', 'rdl', 'calf']), false);
  assert.equal(templateChanged(base, ['calf', 'squat', 'rdl']), false);          // reordered
  assert.equal(templateChanged(base, ['squat', 'rdl', 'calf', 'plank']), true);   // added
  assert.equal(templateChanged(base, ['squat', 'rdl']), true);                    // removed
  assert.equal(templateChanged(base, ['squat', 'rdl', 'lunge']), true);           // swapped
  assert.equal(templateChanged(['squat', 'squat'], ['squat']), true);             // one of two removed
  assert.equal(templateChanged(null, ['squat']), null);                           // no template
});

test("updating a template takes today's order, sets and loads, and keeps the template's notes", () => {
  const set = (w: number, r: number, side?: string) => ({ setType: 'working', weightKg: w, reps: r, seconds: null, rpe: null, side });
  const out = templateFromWorkout({
    exercises: [
      { exerciseId: 'bss', restSeconds: null, supersetGroup: null, sets: [set(20, 10, 'left'), set(20, 10, 'right'), set(22, 8, 'left'), set(22, 8, 'right')] },
      { exerciseId: 'squat', restSeconds: 120, supersetGroup: null, sets: [set(100, 5), set(105, 5)] },
    ],
  }, new Map([['squat', 'Belt on'], ['bss', null]]));
  assert.deepEqual(out.map((e) => e.exerciseId), ['bss', 'squat']);
  assert.deepEqual(out[0].sets.map((s) => [s.targetWeightKg, s.targetReps]), [[20, 10], [22, 8]]);   // one per pair
  assert.deepEqual(out[1].sets.map((s) => s.targetWeightKg), [100, 105]);
  assert.equal(out[1].notes, 'Belt on');
  assert.equal(out[0].notes, null);
});

const r = (id: string, group_id: string | null, position: number) => ({ id, group_id, position, created_at: `2026-10-0${position + 1}` });
const groups = [{ id: 'g2', name: 'Upper/Lower', position: 1, created_at: '2026-10-01' }, { id: 'g1', name: 'PPL', position: 0, created_at: '2026-10-01' }];

test('routines sit in their groups in order, ungrouped and orphaned ones under My routines last', () => {
  const s = groupRoutines([r('push', 'g1', 1), r('pull', 'g1', 0), r('upper', 'g2', 0), r('legs', null, 0), r('old', 'gone', 1)], groups);
  assert.deepEqual(s.map((x) => x.group?.name ?? 'mine'), ['PPL', 'Upper/Lower', 'mine']);
  assert.deepEqual(s.map((x) => x.routines.map((y) => y.id)), [['pull', 'push'], ['upper'], ['legs', 'old']]);
});

test('moving a routine renumbers its new group and writes only what changed', () => {
  const s = groupRoutines([r('pull', 'g1', 0), r('push', 'g1', 1), r('legs', 'g1', 2), r('upper', 'g2', 0)], groups);
  // within the group: legs to the top
  assert.deepEqual(moveRoutine(s, 'legs', 'g1', 0), [
    { id: 'legs', group_id: 'g1', position: 0 }, { id: 'pull', group_id: 'g1', position: 1 }, { id: 'push', group_id: 'g1', position: 2 },
  ]);
  // into another group, at the end
  assert.deepEqual(moveRoutine(s, 'push', 'g2', 9), [{ id: 'push', group_id: 'g2', position: 1 }]);
  // out of every group
  assert.deepEqual(moveRoutine(s, 'upper', null, 0), [{ id: 'upper', group_id: null, position: 0 }]);
  assert.deepEqual(moveRoutine(s, 'nope', 'g1', 0), []);
});

test('a template exercise reads as runs of the same target', () => {
  const kg = (x: number) => `${x} kg`;
  const s = (r: number | null, w: number | null, extra = {}) => ({ set_type: 'working', target_reps: r, target_weight_kg: w, ...extra });
  assert.equal(setsSummary([s(8, 100), s(8, 100), s(8, 100)], kg), '3 × 8 @ 100 kg');
  assert.equal(setsSummary([{ ...s(10, 60), set_type: 'warmup' }, s(5, 120), s(5, 120), s(3, 130)], kg), '2 × 5 @ 120 kg, 1 × 3 @ 130 kg');
  assert.equal(setsSummary([s(null, null), s(null, null)], kg), '2 sets');
  assert.equal(setsSummary([s(12, null), s(10, null)], kg), '1 × 12, 1 × 10');
  assert.equal(setsSummary([s(null, null, { target_seconds: 45 }), s(null, null, { target_seconds: 45 })], kg), '2 × 45 s');
  assert.equal(setsSummary([], kg), 'No sets');
});
