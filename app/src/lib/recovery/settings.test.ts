/// <reference types="node" />

// Build phase 9's settings, as the plan lists the tests: overriding base_recovery_hours.default to
// 72 changes F20's chest R from 59.7 to 89.6 h for that user only; with base hours at 96 the
// longest window is 192 h and a 7-day-old workout still adds fatigue until it expires;
// replace_on_log gives F29's references (130, then 116.67). Every override goes through the
// Phase 1 loader (thresholdsFor), exactly as the app applies a user's rows.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { lookbackHours, pbBefore, recoveryHours, scoreWorkout } from './engine.ts';
import { muscleFallbackName } from './figure.ts';
import { MUSCLE_IDS } from './library.ts';
import { recoveryMapAt, readSpanHours } from './read.ts';
import {
  afterEdits, diffOverrides, isOverridden, settingDefs, stepValue, validateEdits, valueAt, type NumberSetting,
} from './settings.ts';
import { C, EXERCISES, fixture, historyRows, MUSCLES, near, T0 } from './testRows.ts';
import { thresholdsFor, type ThresholdOverride } from './thresholds.ts';
import type { LiftSet, Model, PbRecord } from './types.ts';
import { libraryFromRows } from './workoutLoads.ts';
import { toPbHistory } from './pbHistory.ts';

const { lib, keyOf } = libraryFromRows(EXERCISES, MUSCLES);
const ME = 'user-a';
const YOU = 'user-b';
const row = (user_id: string, key: string, value: unknown): ThresholdOverride => ({ user_id, key, value });
const defs = settingDefs(C, muscleFallbackName);
const def = (key: string) => defs.find((d) => d.key === key) as NumberSetting;

describe('the plan\'s cases', () => {
  test('base_recovery_hours.default at 72 changes F20\'s chest R from 59.7 to 89.6 h, for that user only', () => {
    const rows = [row(ME, 'base_recovery_hours.default', 72)];
    const f20 = fixture('F20');
    const h0 = T0 / 3_600_000;   // fixture hour 0, where the PB history is dated from
    const workout = { start: h0 - 1, end: h0, exercises: f20.inputs.exercises as [string, LiftSet[]][] };
    const history = toPbHistory(historyRows(f20.inputs.history as never), (id) => keyOf.get(id));
    const R = (userId: string) => scoreWorkout({ c: thresholdsFor(C, userId, rows), lib }, workout, history).R.chest;
    near(R(YOU), 59.71);
    near(R(ME), 89.57);
  });

  test('with base hours at 96 the longest window is 192 h, and a 7-day-old workout still counts until it expires', () => {
    const c96 = thresholdsFor(C, ME, [row(ME, 'base_recovery_hours.default', 96)]);
    const m: Model = { c: c96, lib };
    assert.equal(lookbackHours({ c: C, lib }), 144);
    assert.equal(lookbackHours(m), 192);
    assert.equal(readSpanHours(m), 192 + 168);
    // a very heavy quads session (L 5) a week before `now`: its window is 96 × 2 = 192 h
    const now = T0 / 3_600_000 + 1000;
    const L = 5;
    const R = recoveryHours(m, L, 'quads');
    assert.equal(R, 192);
    const loads = { muscles: [{ muscle_id: 'quads', load: L, recovery_hours: R, finished_at: new Date((now - 168) * 3_600_000).toISOString(), workout_id: 'w' }], exercises: [] };
    const map = recoveryMapAt(m, keyOf, loads, now);
    near(map.quads.F, L * (1 - 168 / 192));
    assert.ok(map.quads.level > 0);
    assert.equal(recoveryMapAt(m, keyOf, loads, now + 24).quads.F, 0);   // 192 h after it: expired
    // with the defaults the same session's window would have been 96 h, long gone
    assert.equal(recoveryHours({ c: C, lib }, L, 'quads'), 96);
  });

  test('replace_on_log through a user\'s override gives F29\'s references: 130, then 116.67', () => {
    const f29 = fixture('F29');
    const i = f29.inputs as { slug: string; manual: { e1rm: number; day: number }; sessions: { day: number; sets: LiftSet[] }[] };
    const want = f29.expect as { pb_before: number[]; pb_kind: string[] };
    const m: Model = { c: thresholdsFor(C, ME, [row(ME, 'pb.manual_policy', 'replace_on_log')]), lib };
    let hist: PbRecord[] = [{ slug: i.slug, e1rm: i.manual.e1rm, at: i.manual.day * 24, source: 'manual' }];
    i.sessions.forEach((s, n) => {
      const t = s.day * 24;
      const ref = pbBefore(m, i.slug, t, hist);
      near(ref.pb!, want.pb_before[n]);
      assert.equal(ref.detail, want.pb_kind[n]);
      hist = hist.concat(scoreWorkout(m, { start: t, end: t + 1, exercises: [[i.slug, s.sets]] }, hist).records);
    });
    // the default policy keeps the manual 130 on day 3
    assert.equal(pbBefore({ c: C, lib }, i.slug, 72, [{ slug: i.slug, e1rm: 130, at: 0, source: 'manual' },
      { slug: i.slug, e1rm: 116.67, at: 25, source: 'logged' }]).pb, 130);
  });
});

describe('the settings screen\'s logic', () => {
  test('every setting is a valid override key with its default as the starting value', () => {
    assert.equal(defs.filter((d) => d.key.startsWith('base_recovery_hours.')).length, 1 + MUSCLE_IDS.length);
    for (const d of defs) {
      const v = valueAt(C, d.key);
      assert.ok(v != null, d.key);
      assert.ok(validateEdits(C, ME, [], { [d.key]: v }, defs).length === 0, d.key);
      if (d.kind === 'number') assert.ok((v as number) >= d.min && (v as number) <= d.max, `${d.key} default ${v} outside ${d.min}–${d.max}`);
    }
    assert.equal(valueAt(C, 'base_recovery_hours.chest'), 48);       // no own value: the default's
    assert.equal(valueAt(C, 'base_recovery_hours.lower_back'), 72);
    assert.ok(!defs.some((d) => d.key === 'role_weights.primary'));
  });

  test('base hours stay within 12–96 h; levels must stay in increasing order', () => {
    assert.match(validateEdits(C, ME, [], { 'base_recovery_hours.chest': 120 }, defs).join(' '), /between 12 and 96/);
    assert.match(validateEdits(C, ME, [], { 'base_recovery_hours.chest': 11 }, defs).join(' '), /between 12 and 96/);
    assert.match(validateEdits(C, ME, [], { 'levels.2.min': 2.0 }, defs).join(' '), /High must start above Moderate/);
    assert.deepEqual(validateEdits(C, ME, [], { 'levels.2.min': 1.0, 'levels.3.min': 2.0 }, defs), []);
    assert.match(validateEdits(C, ME, [], { 'pb.window_days': 30.5 }, defs).join(' '), /whole number/);
    assert.match(validateEdits(C, ME, [], { 'pb.manual_policy': 'sometimes' }, defs).join(' '), /can't be set/);
  });

  test('saving: changed values upsert, resets and default values delete', () => {
    const rows = [row(ME, 'recovery.slope', 0.5), row(ME, 'base_recovery_hours.chest', 60)];
    const edits = { 'recovery.slope': null, 'fatigue.weekly_cap': 8, 'role_weights.secondary': 0.5, 'base_recovery_hours.chest': 50 };
    const { upsert, remove } = diffOverrides(C, edits);
    assert.deepEqual(upsert, [{ key: 'role_weights.secondary', value: 0.5 }, { key: 'base_recovery_hours.chest', value: 50 }]);
    assert.deepEqual(remove.sort(), ['fatigue.weekly_cap', 'recovery.slope']);
    const after = afterEdits(C, ME, rows, edits);
    assert.deepEqual([after.recovery.slope, after.role_weights.secondary, after.base_recovery_hours.chest], [0.3, 0.5, 50]);
    assert.ok(isOverridden(rows, {}, 'recovery.slope') && !isOverridden(rows, edits, 'recovery.slope'));
    assert.equal(C.role_weights.secondary, 0.4, 'the defaults never change');
  });

  test('the − / + steps stay in range and clean', () => {
    assert.equal(stepValue(def('role_weights.secondary'), 0.4, 1), 0.45);
    assert.equal(stepValue(def('role_weights.secondary'), 1, 3), 1);
    assert.equal(stepValue(def('base_recovery_hours.chest'), 12, -1), 12);
    assert.equal(stepValue(def('fatigue.weekly_cap'), 8, -1), 7.5);
  });
});
