/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LiftPb, PbPeriods } from '@/api/pbs';
import { liftRows, oneRmNote } from './rows.ts';

const pb = (metric: string, value: number, patch: Partial<LiftPb> = {}): LiftPb => ({
  user_id: 'u1', exercise_id: 'e1', metric, period: 'all', value, weight_kg: null, reps: null, seconds: null,
  set_id: 's0', workout_id: 'w0', achieved_at: '2026-01-01T00:00:00Z', ...patch,
});
const allTime = (row: LiftPb): PbPeriods<LiftPb> => ({ all: row });

test('the live panel counts the manual best as the all-time 1RM, as the card does', () => {
  // manual 130, logged 120 this month, a ticked 125 now
  const stored = new Map([['1rm', allTime(pb('1rm', 120, { weight_kg: 120, reps: 1, achieved_at: new Date().toISOString() }))]]);
  const session = { '1rm': { value: 125, setId: 's1' } };
  const [withManual] = liftRows(stored, 'metric', { session, only: ['1rm'], manualAll: { '1rm': 130 } });
  assert.deepEqual(withManual.cells[2], { value: '130 kg', sub: 'manual' });
  assert.equal(withManual.isNew, false);
  const [logged] = liftRows(stored, 'metric', { session, only: ['1rm'] });
  assert.deepEqual(logged.cells[2], { value: '125 kg', sub: 'this session' });
  assert.equal(logged.isNew, true);
});

test('a manual best alone still fills the 1RM row', () => {
  const [row] = liftRows(undefined, 'metric', { manualAll: { '1rm': 130 } });
  assert.equal(row.cells[2].value, '130 kg');
  assert.equal(row.cells[0].value, '–');
  assert.deepEqual(liftRows(undefined, 'metric'), []);
});

test('an assisted lift has no 3RM row: its heaviest is its most assistance', () => {
  const stored = new Map([['1rm', allTime(pb('1rm', 63.3, { weight_kg: 30, reps: 8 }))], ['3rm', allTime(pb('3rm', 40, { weight_kg: 40, reps: 5 }))]]);
  assert.deepEqual(liftRows(stored, 'metric', { loadMode: 'assisted' }).map((r) => r.key), ['1rm']);
  assert.deepEqual(liftRows(stored, 'metric').map((r) => r.key), ['1rm', '3rm']);
});

test('a 1RM that includes bodyweight shows its set against bodyweight', () => {
  assert.equal(oneRmNote(pb('1rm', 108.3, { weight_kg: 20, reps: 5 }), 'metric', 'bodyweight'), 'BW+20×5');
  assert.equal(oneRmNote(pb('1rm', 92.2, { weight_kg: 0, reps: 8 }), 'metric', 'bodyweight'), 'BW×8');
  assert.equal(oneRmNote(pb('1rm', 92.2, { weight_kg: null, reps: 8 }), 'metric', 'bodyweight'), 'BW×8');
  assert.equal(oneRmNote(pb('1rm', 63.3, { weight_kg: 30, reps: 8 }), 'metric', 'assisted'), 'BW−30×8');
  // a bodyweight single is the set, never "tested" against the added load
  assert.equal(oneRmNote(pb('1rm', 20, { weight_kg: 20, reps: 1 }), 'metric', 'bodyweight'), 'BW+20×1');
  assert.equal(oneRmNote(pb('1rm', 140, { weight_kg: 140, reps: 1 }), 'metric'), 'tested');
  assert.equal(oneRmNote(pb('1rm', 154.6, { weight_kg: 132.5, reps: 5 }), 'metric', 'weight'), '132.5×5');
  assert.equal(oneRmNote(pb('1rm', 100, { weight_kg: null, reps: 5 }), 'metric'), undefined);
  const [row] = liftRows(new Map([['1rm', allTime(pb('1rm', 108.3, { weight_kg: 20, reps: 5 }))]]), 'metric', { loadMode: 'bodyweight' });
  assert.equal(row.cells[2].sub, 'BW+20×5');
});
