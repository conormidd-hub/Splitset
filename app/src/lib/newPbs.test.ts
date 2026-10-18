/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LiftPb, LiftPbIndex, PbPeriods, RunPb } from '@/api/pbs';
import { countNewPbs } from './newPbs.ts';

// "this month" is October 2026 here; run PBs carry a local wall-clock time, lift PBs an instant
const isNew = (at: string | null | undefined) => !!at && at >= '2026-10-01';
const run = (at: string) => ({ start_time_local: at }) as RunPb;
const lift = (at: string) => ({ achieved_at: at }) as LiftPb;
const lifts = (rows: Record<string, Record<string, PbPeriods<LiftPb>>>): LiftPbIndex =>
  new Map(Object.entries(rows).map(([id, byMetric]) => [id, new Map(Object.entries(byMetric))]));

test('nothing loaded yet: none', () => {
  assert.equal(countNewPbs(undefined, undefined, isNew), 0);
});

test('a new bench 1RM and no running PBs: one, as the trophy cabinet says', () => {
  const l = lifts({ bench: { '1rm': { all: lift('2026-10-14T18:02:00Z') } } });
  assert.equal(countNewPbs(new Map(), l, isNew), 1);
  assert.equal(countNewPbs(undefined, l, isNew), 1);
});

test('one per running distance and one per lift metric, all-time bests only', () => {
  const runs = new Map<string, PbPeriods<RunPb>>([
    ['5km', { all: run('2026-10-05T07:30:00'), month: run('2026-10-05T07:30:00') }],
    ['10km', { all: run('2026-09-20T08:00:00'), month: run('2026-10-11T08:00:00') }],
  ]);
  const l = lifts({
    bench: { '1rm': { all: lift('2026-10-14T18:02:00Z') }, '3rm': { all: lift('2026-10-14T18:02:00Z') } },
    squat: { '1rm': { all: lift('2026-08-02T17:00:00Z'), month: lift('2026-10-03T17:00:00Z') } },
    plank: { time: { month: lift('2026-10-09T12:00:00Z') } },
  });
  // the 5 km, bench 1RM and bench 3RM; the 10 km and the squat only bested their month
  assert.equal(countNewPbs(runs, l, isNew), 3);
});
