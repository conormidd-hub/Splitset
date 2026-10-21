import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LiftPb, PbPeriods } from '../api/pbs';
import { foldManualPbs } from './pbs.ts';

const logged = (metric: string, period: string, value: number, achieved_at = '2026-10-03T10:00:00Z'): LiftPb => ({
  user_id: 'u', exercise_id: 'bench', metric, period, value, weight_kg: value, reps: 1, seconds: null, set_id: 's', workout_id: 'w', achieved_at,
});
const index = (...rows: LiftPb[]) => {
  const out = new Map<string, Map<string, PbPeriods<LiftPb>>>();
  for (const r of rows) {
    const byMetric = out.get(r.exercise_id!) ?? new Map<string, PbPeriods<LiftPb>>();
    byMetric.set(r.metric!, { ...byMetric.get(r.metric!), [r.period!]: r });
    out.set(r.exercise_id!, byMetric);
  }
  return out;
};
const TODAY = '2026-10-21';

test('a known best above every logged set takes Month, Year and All time, marked manual', () => {
  const out = foldManualPbs(index(logged('1rm', 'all', 120), logged('1rm', 'year', 120), logged('1rm', 'month', 110)),
    [{ id: 'm1', exercise_id: 'bench', weight_kg: 125, reps: 3, e1rm: 137.5, dated_at: '2026-10-05' }], TODAY);
  const one = out.get('bench')!.get('1rm')!;
  assert.equal(one.all?.value, 137.5);
  assert.equal(one.all?.source, 'manual');
  assert.equal(one.month?.value, 137.5);
  assert.equal(one.year?.value, 137.5);
  // three reps also give a 3RM
  assert.equal(out.get('bench')!.get('3rm')?.all?.value, 125);
  assert.equal(out.get('bench')!.get('3rm')?.month?.source, 'manual');
});

test('a heavier logged set keeps its cell; the manual entry only fills what it beats', () => {
  const out = foldManualPbs(index(logged('1rm', 'all', 140), logged('1rm', 'year', 140), logged('1rm', 'month', 110)),
    [{ id: 'm1', exercise_id: 'bench', weight_kg: 130, reps: 1, e1rm: 130, dated_at: '2026-10-05' }], TODAY);
  const one = out.get('bench')!.get('1rm')!;
  assert.equal(one.all?.value, 140);
  assert.equal(one.all?.source, undefined);
  assert.equal(one.month?.value, 130);
  assert.equal(one.month?.source, 'manual');
  // a single is no 3RM
  assert.equal(out.get('bench')!.get('3rm'), undefined);
});

test('a known best dated last year counts for all time only; last month for the year too', () => {
  const out = foldManualPbs(new Map(), [
    { id: 'a', exercise_id: 'squat', weight_kg: 180, reps: 1, e1rm: 180, dated_at: '2025-06-01' },
    { id: 'b', exercise_id: 'dead', weight_kg: 200, reps: 1, e1rm: 200, dated_at: '2026-09-28' },
  ], TODAY);
  assert.deepEqual(Object.keys(out.get('squat')!.get('1rm')!), ['all']);
  assert.deepEqual(Object.keys(out.get('dead')!.get('1rm')!).sort(), ['all', 'year']);
  // dated at local noon, so a month-boundary date reads as that date in any zone
  assert.equal(out.get('dead')!.get('1rm')!.all?.achieved_at, '2026-09-28T12:00:00');
});

test('a tie goes to the logged set', () => {
  const out = foldManualPbs(index(logged('1rm', 'all', 130)), [{ id: 'm', exercise_id: 'bench', weight_kg: 130, reps: 1, e1rm: 130, dated_at: '2026-10-05' }], TODAY);
  assert.equal(out.get('bench')!.get('1rm')!.all?.source, undefined);
});
