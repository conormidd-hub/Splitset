/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { buildLibrary } from './engine.ts';
import { bests, hoursOf, pbHistoryItems, referenceSource, strengthReference, toPbHistory, type PbHistoryRow } from './pbHistory.ts';
import { parseConstants, withOverride } from './thresholds.ts';
import type { ExerciseDef, Model } from './types.ts';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const LIBRARY = (read('../../../../data/exercise_library.json') as { exercises: (ExerciseDef & { name: string })[] }).exercises;
const C = parseConstants(read('../../../../data/recovery_constants.json'));
const m: Model = { c: C, lib: buildLibrary(LIBRARY) };
const nameOf = (slug: string) => LIBRARY.find((e) => e.slug === slug)?.name;
const keyOf = (id: string) => id.replace(/^id-/, '');   // ids in these rows are "id-<slug>"
const DAY0 = '2026-09-01T00:00:00Z';
const day = (n: number) => new Date(Date.parse(DAY0) + n * 86_400_000).toISOString();
const row = (slug: string, e1rm: number, at: string, source = 'logged', extra: Partial<PbHistoryRow> = {}): PbHistoryRow => ({
  exercise_id: `id-${slug}`, e1rm, at, source, weight_kg: null, reps: null, set_type: null,
  workout_id: source === 'logged' ? `w-${at}` : null, manual_pb_id: source === 'manual' ? `m-${at}` : null, ...extra,
});

describe('toPbHistory', () => {
  test('one engine record per row, keyed by slug and dated in hours; unknown exercises dropped', () => {
    const recs = toPbHistory([row('bench_press_bb', 120, DAY0), row('bench_press_bb', 130, day(1), 'manual')], keyOf);
    assert.deepEqual(recs, [
      { slug: 'bench_press_bb', e1rm: 120, at: hoursOf(DAY0), source: 'logged' },
      { slug: 'bench_press_bb', e1rm: 130, at: hoursOf(DAY0) + 24, source: 'manual' },
    ]);
    assert.deepEqual(toPbHistory([row('bench_press_bb', 120, DAY0)], () => undefined), []);
  });
});

describe('the reference and its source (build phase 3 tests, through the engine)', () => {
  test('F18: a manual PB of 130 on day 0 is the reference on day 1, monthly and manual', () => {
    const history = toPbHistory([row('bench_press_bb', 130, DAY0, 'manual')], keyOf);
    const ref = strengthReference(m, 'bench_press_bb', hoursOf(day(1)), history, nameOf);
    assert.deepEqual([ref.pb, ref.source, ref.detail, ref.tone], [130, 'monthly', 'manual', 'manual']);
  });

  test('F14: an exercise never logged is estimated from Bench press (barbell) when bench has history', () => {
    const history = toPbHistory([row('bench_press_bb', 120, day(-7))], keyOf);
    const ref = strengthReference(m, 'incline_bench_db', hoursOf(DAY0), history, nameOf);
    assert.equal(ref.label, 'Estimated from Bench press (barbell)');
    assert.equal(ref.tone, 'estimated');
    assert.ok(Math.abs(ref.pb! - 34.56) < 0.01);
  });

  test('F17: with no history and no estimate link it is calibrating', () => {
    const ref = strengthReference(m, 'landmine_press', hoursOf(DAY0), [], nameOf);
    assert.deepEqual([ref.pb, ref.tone, ref.label], [null, 'calibrating', 'Calibrating: your first session sets it']);
    // incline DB has an estimate link, but with nothing logged anywhere it calibrates too
    assert.equal(strengthReference(m, 'incline_bench_db', hoursOf(DAY0), [], nameOf).tone, 'calibrating');
  });

  test('logged and lapsed sources, with the window and the lapse from the thresholds', () => {
    const logged = toPbHistory([row('bench_press_bb', 120, day(-7))], keyOf);
    assert.equal(strengthReference(m, 'bench_press_bb', hoursOf(DAY0), logged, nameOf).label, 'Logged in the last 30 days');
    const old = toPbHistory([row('bench_press_bb', 120, day(-60))], keyOf);
    const lapsed = strengthReference(m, 'bench_press_bb', hoursOf(DAY0), old, nameOf);
    assert.deepEqual([lapsed.tone, lapsed.label], ['lapsed', 'Lapsed: your last 30 days of sets, less 5%']);
    assert.ok(Math.abs(lapsed.pb! - 114) < 0.01);
    const c = withOverride(C, 'pb.window_days', 28);
    assert.equal(referenceSource(c, { pb: 1, source: 'monthly', detail: 'logged' }, nameOf).label, 'Logged in the last 28 days');
  });
});

describe('bests and the history list', () => {
  const rows = [
    row('bench_press_bb', 100, day(-45)),
    row('bench_press_bb', 118, day(-10), 'logged', { workout_id: 'w1', weight_kg: 100, reps: 5 }),
    row('bench_press_bb', 121, day(-10), 'logged', { workout_id: 'w1', weight_kg: 110, reps: 3 }),
    row('bench_press_bb', 125, day(-3), 'manual', { weight_kg: 125, reps: 1 }),
    row('bench_press_bb', 140, day(2)),   // after "now": not counted
    row('incline_bench_db', 40, day(-1)),
  ];
  test('best of the PB window and of all time, both sources, nothing after now', () => {
    assert.deepEqual(bests(m, toPbHistory(rows, keyOf), 'bench_press_bb', hoursOf(DAY0)), { window: 125, allTime: 125 });
    assert.deepEqual(bests(m, toPbHistory(rows.slice(0, 1), keyOf), 'bench_press_bb', hoursOf(DAY0)), { window: null, allTime: 100 });
  });
  test('one line per workout (its best set) and per manual entry, newest first', () => {
    const items = pbHistoryItems(rows, 'id-bench_press_bb');
    assert.deepEqual(items.map((i) => [i.source, i.e1rm]), [['logged', 140], ['manual', 125], ['logged', 121], ['logged', 100]]);
    assert.deepEqual([items[2].weightKg, items[2].reps, items[2].workoutId], [110, 3, 'w1']);
  });
});
