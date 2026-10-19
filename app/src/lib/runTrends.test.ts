import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dayMs, paceOf, perRun, rangeStart, rollingMean, weekOf, weekly, weeklyZones, weeksBetween, type RunTrendRow,
} from './runTrends.ts';

const run = (start: string, over: Partial<RunTrendRow> = {}): RunTrendRow => ({
  id: start, start_time_local: start, distance_m: 5000, moving_time_s: 1500, avg_hr: 150, cadence: 170, elev_gain_m: 40,
  hr_zone_times: null, stride_m: null, gct_ms: null, vert_osc_cm: null, avg_power_w: null, ...over,
});

test('a run belongs to the Monday of its week, Sunday included', () => {
  assert.equal(weekOf('2026-10-12T07:00:00'), '2026-10-12'); // Monday
  assert.equal(weekOf('2026-10-18T21:30:00'), '2026-10-12'); // Sunday
  assert.equal(weekOf('2026-10-19T06:00:00'), '2026-10-19');
});

test('range chips start that many days back, and All has no start', () => {
  assert.equal(rangeStart(91, '2026-10-19'), '2026-07-20');
  assert.equal(rangeStart(0, '2026-10-19'), null);
  // a Wednesday: 91 days back is a Wednesday too, and the range opens on that week's Monday
  assert.equal(rangeStart(91, '2026-10-21'), '2026-07-20');
});

test('the weeks between two dates are every Monday, across a clock change', () => {
  assert.deepEqual(weeksBetween('2026-10-15', '2026-11-04'), ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
  assert.deepEqual(weeksBetween('2026-11-04', '2026-10-15'), []);
});

test('weekly sums fill quiet weeks with zero and run to the current week', () => {
  const rows = [run('2026-09-29T07:00:00', { distance_m: 8000 }), run('2026-10-02T07:00:00', { distance_m: 4000 }), run('2026-10-14T07:00:00', { distance_m: 10000 })];
  const pts = weekly(rows, (r) => r.distance_m, 'sum', { from: null, to: '2026-10-19' });
  assert.deepEqual(pts, [
    { x: dayMs('2026-09-28'), y: 12000 },
    { x: dayMs('2026-10-05'), y: 0 },
    { x: dayMs('2026-10-12'), y: 10000 },
    { x: dayMs('2026-10-19'), y: 0 },
  ]);
});

test('a range start sets the first week even before the first run', () => {
  const pts = weekly([run('2026-10-14T07:00:00')], (r) => r.distance_m, 'sum', { from: '2026-10-01', to: '2026-10-14' });
  assert.deepEqual(pts.map((p) => p.y), [0, 0, 5000]);
});

test('the long run is the week’s largest, and a week without one has none', () => {
  const rows = [run('2026-10-13T07:00:00', { distance_m: 6000 }), run('2026-10-18T07:00:00', { distance_m: 21100 }), run('2026-10-28T07:00:00', { distance_m: 5000 })];
  const pts = weekly(rows, (r) => r.distance_m, 'max', { from: null, to: '2026-10-28' });
  assert.deepEqual(pts.map((p) => p.y), [21100, null, 5000]);
});

test('counting runs ignores the value, and nothing at all gives an empty chart', () => {
  const rows = [run('2026-10-13T07:00:00', { distance_m: null }), run('2026-10-15T07:00:00')];
  assert.deepEqual(weekly(rows, () => null, 'count', { from: null, to: '2026-10-18' }).map((p) => p.y), [2]);
  assert.deepEqual(weekly(rows, () => null, 'sum', { from: '2026-09-01', to: '2026-10-19' }), []);
});

test('zone times add up per week, folding zones past five into the last', () => {
  const rows = [
    run('2026-10-13T07:00:00', { hr_zone_times: [60, 600, 300, 0, 30, 20, 10] }),
    run('2026-10-15T07:00:00', { hr_zone_times: [0, 1200, 0, 0, 0, 0, 0] }),
    run('2026-10-21T07:00:00'),
  ];
  const z = weeklyZones(rows, { from: null, to: '2026-10-21' });
  assert.equal(z.zones, 5);
  assert.equal(z.folded, true);
  assert.deepEqual(z.weeks, [
    { x: dayMs('2026-10-12'), values: [60, 1800, 300, 0, 60] },
    { x: dayMs('2026-10-19'), values: [0, 0, 0, 0, 0] },
  ]);
});

test('three-zone data stays three columns and is not folded', () => {
  const z = weeklyZones([run('2026-10-13T07:00:00', { hr_zone_times: [100, 200, 300] })], { from: null, to: '2026-10-13' });
  assert.deepEqual(z, { weeks: [{ x: dayMs('2026-10-12'), values: [100, 200, 300] }], zones: 3, folded: false });
  assert.deepEqual(weeklyZones([run('2026-10-13T07:00:00')], { from: null, to: '2026-10-13' }), { weeks: [], zones: 0, folded: false });
});

test('per-run points skip short runs and missing values, oldest first', () => {
  const rows = [
    run('2026-10-15T07:00:00', { cadence: 172 }),
    run('2026-10-13T07:00:00', { cadence: 168 }),
    run('2026-10-14T07:00:00', { cadence: 180, distance_m: 400 }),
    run('2026-10-16T07:00:00', { cadence: null }),
  ];
  assert.deepEqual(perRun(rows, (r) => r.cadence).map((p) => p.y), [168, 172]);
});

test('pace is seconds per km, and walks or GPS faults are dropped', () => {
  assert.equal(paceOf({ distance_m: 10000, moving_time_s: 3000 }), 300);
  assert.equal(paceOf({ distance_m: 1000, moving_time_s: 1200 }), null); // 20:00 /km: a walk
  assert.equal(paceOf({ distance_m: 10000, moving_time_s: 600 }), null); // 1:00 /km: a fault
  assert.equal(paceOf({ distance_m: null, moving_time_s: 600 }), null);
});

test('the rolling mean trails over the values that are there', () => {
  const pts = [{ x: 1, y: 10 }, { x: 2, y: null }, { x: 3, y: 20 }, { x: 4, y: 30 }];
  assert.deepEqual(rollingMean(pts, 2).map((p) => p.y), [10, 10, 15, 25]);
});
