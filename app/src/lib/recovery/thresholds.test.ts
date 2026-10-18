/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { isValidOverride, parseConstants, thresholdsFor, withOverride, type ThresholdOverride } from './thresholds.ts';

const raw = JSON.parse(readFileSync(new URL('../../../../data/recovery_constants.json', import.meta.url), 'utf8'));
const base = parseConstants(raw);
const A = 'user-a';
const B = 'user-b';

describe('parseConstants', () => {
  test('reads the constants file as typed values', () => {
    assert.equal(base.role_weights.secondary, 0.4);
    assert.equal(base.role_weights.primary, 1.0);
    assert.deepEqual(base.role_caps, { primary: 2, secondary: 2, tertiary: 3 });
    assert.equal(base.pb.manual_policy, 'max');
    assert.equal(base.base_recovery_hours.default, 48);
    assert.equal(base.base_recovery_hours.lower_back, 72);
    assert.equal(base.levels.length, 6);
    assert.equal(base.levels[3].label, 'High');
  });

  test('drops the _doc notes', () => {
    assert.equal('_doc' in base, false);
    assert.equal('_doc' in base.pb, false);
    assert.equal('_doc' in base.recovery, false);
  });

  test('freezes the defaults all the way down', () => {
    assert.ok(Object.isFrozen(base));
    assert.ok(Object.isFrozen(base.role_weights));
    assert.ok(Object.isFrozen(base.levels[2]));
    assert.throws(() => { (base.role_weights as { secondary: number }).secondary = 1; }, TypeError);
  });

  test('refuses something that is not the constants file', () => {
    assert.throws(() => parseConstants({ hello: 1 }), /not the shape/);
    assert.throws(() => parseConstants(null), /not the shape/);
  });
});

describe('thresholdsFor', () => {
  const rows: ThresholdOverride[] = [{ user_id: A, key: 'role_weights.secondary', value: 0.5 }];

  test('a user override changes the value for that user only', () => {
    assert.equal(thresholdsFor(base, A, rows).role_weights.secondary, 0.5);
    assert.equal(thresholdsFor(base, B, rows).role_weights.secondary, 0.4);
    assert.equal(base.role_weights.secondary, 0.4);
  });

  test('leaves the other values alone', () => {
    const t = thresholdsFor(base, A, rows);
    assert.equal(t.role_weights.primary, 1.0);
    assert.equal(t.role_weights.tertiary, 0.2);
    assert.deepEqual(t.levels, base.levels);
  });

  test('returns the defaults themselves when the user has no overrides', () => {
    assert.equal(thresholdsFor(base, B, rows), base);
    assert.equal(thresholdsFor(base, A, []), base);
  });

  test('applies dotted keys at any depth, and a per-muscle recovery window', () => {
    const t = thresholdsFor(base, A, [
      { user_id: A, key: 'pb.manual_policy', value: 'replace_on_log' },
      { user_id: A, key: 'base_recovery_hours.default', value: 72 },
      { user_id: A, key: 'base_recovery_hours.chest', value: 60 },
      { user_id: A, key: 'levels.3.min', value: 1.6 },
      { user_id: A, key: 'cardio.enabled_default', value: false },
    ]);
    assert.equal(t.pb.manual_policy, 'replace_on_log');
    assert.equal(t.base_recovery_hours.default, 72);
    assert.equal(t.base_recovery_hours.chest, 60);
    assert.equal(t.base_recovery_hours.lower_back, 72);
    assert.equal(t.levels[3].min, 1.6);
    assert.equal(t.cardio.enabled_default, false);
    assert.ok(Object.isFrozen(t.levels[3]));
    assert.equal(base.base_recovery_hours.chest, undefined);
  });

  test('skips invalid rows instead of failing', () => {
    const t = thresholdsFor(base, A, [
      { user_id: A, key: 'role_weights.secondary', value: 0.5 },
      { user_id: A, key: 'no_such.key', value: 1 },
      { user_id: A, key: 'role_weights.tertiary', value: '0.3' },
    ]);
    assert.equal(t.role_weights.secondary, 0.5);
    assert.equal(t.role_weights.tertiary, 0.2);
    assert.equal('no_such' in t, false);
  });
});

describe('isValidOverride', () => {
  test('accepts a leaf of the same type', () => {
    assert.ok(isValidOverride(base, 'role_weights.secondary', 0.3));
    assert.ok(isValidOverride(base, 'pb.window_days', 28));
    assert.ok(isValidOverride(base, 'pb.manual_policy', 'max'));
    assert.ok(isValidOverride(base, 'levels.1.fill', '#FFEE99'));
  });

  test('accepts a recovery window for any of the 17 muscles, and nothing else new', () => {
    assert.ok(isValidOverride(base, 'base_recovery_hours.hamstrings', 60));
    assert.equal(isValidOverride(base, 'base_recovery_hours.neck', 60), false);
    assert.equal(isValidOverride(base, 'role_weights.quaternary', 0.1), false);
  });

  test('rejects wrong types, non-finite numbers and unknown choices', () => {
    assert.equal(isValidOverride(base, 'role_weights.secondary', '0.4'), false);
    assert.equal(isValidOverride(base, 'role_weights.secondary', null), false);
    assert.equal(isValidOverride(base, 'role_weights.secondary', Number.NaN), false);
    assert.equal(isValidOverride(base, 'pb.manual_policy', 'sometimes'), false);
    assert.equal(isValidOverride(base, 'cardio.enabled_default', 1), false);
  });

  test('rejects whole sections, bad paths and prototype keys', () => {
    assert.equal(isValidOverride(base, 'role_weights', { primary: 1 }), false);
    assert.equal(isValidOverride(base, 'levels.9.min', 1), false);
    assert.equal(isValidOverride(base, 'levels.x.min', 1), false);
    assert.equal(isValidOverride(base, 'pb..window_days', 1), false);
    assert.equal(isValidOverride(base, '__proto__.polluted', 1), false);
    assert.equal(isValidOverride(base, 'role_weights.constructor', 1), false);
  });

  test('takes only canonical level indices', () => {
    assert.ok(isValidOverride(base, 'levels.1.min', 0.3));
    assert.equal(isValidOverride(base, 'levels.01.min', 0.3), false);
    assert.equal(isValidOverride(base, 'levels.1e0.min', 0.3), false);
    assert.equal(isValidOverride(base, 'levels.-1.min', 0.3), false);
  });

  test('keeps the level pointers inside levels, and a band\'s own number and key fixed', () => {
    assert.ok(isValidOverride(base, 'trainable_max_level', 4));
    assert.equal(isValidOverride(base, 'trainable_max_level', 5), false);   // sessionMap reads levels[6]
    assert.equal(isValidOverride(base, 'trainable_max_level', 1.5), false);
    assert.equal(isValidOverride(base, 'trainable_max_level', -1), false);
    assert.ok(isValidOverride(base, 'fatigue.weekly_cap_min_level', 5));
    assert.ok(isValidOverride(base, 'fatigue.weekly_cap_min_level', 0));
    assert.equal(isValidOverride(base, 'fatigue.weekly_cap_min_level', 6), false);
    assert.equal(isValidOverride(base, 'fatigue.weekly_cap_min_level', 2.5), false);
    assert.equal(isValidOverride(base, 'levels.2.level', 3), false);
    assert.equal(isValidOverride(base, 'levels.2.level', 2), false);
    assert.equal(isValidOverride(base, 'levels.1.key', 'x'), false);
  });

  test('keeps windows and divisors above zero and the intensity cap below 1', () => {
    assert.equal(isValidOverride(base, 'e1rm.epley_divisor', 0), false);
    assert.equal(isValidOverride(base, 'recovery.max_multiplier', -1), false);
    assert.equal(isValidOverride(base, 'recovery.min_multiplier', 0), false);
    assert.equal(isValidOverride(base, 'fatigue.weekly_window_hours', 0), false);
    assert.equal(isValidOverride(base, 'base_recovery_hours.default', 0), false);
    assert.equal(isValidOverride(base, 'base_recovery_hours.chest', -12), false);
    assert.equal(isValidOverride(base, 'intensity_cap', 1), false);
    assert.equal(isValidOverride(base, 'intensity_cap', 0), false);
    assert.ok(isValidOverride(base, 'intensity_cap', 0.9));
    assert.ok(isValidOverride(base, 'fatigue.weekly_window_hours', 120));
  });

  test('takes only muscles in the activity muscle lists', () => {
    assert.ok(isValidOverride(base, 'cardio.activity_muscles.run.primary.0', 'glutes'));
    assert.equal(isValidOverride(base, 'cardio.activity_muscles.run.primary.0', 'neck'), false);
  });

  test('thresholdsFor skips the rows the engine could not run on, without throwing', () => {
    const t = thresholdsFor(base, A, [
      { user_id: A, key: 'levels.01.min', value: 0.3 },
      { user_id: A, key: 'trainable_max_level', value: 5 },
      { user_id: A, key: 'fatigue.weekly_cap_min_level', value: 6 },
      { user_id: A, key: 'levels.1.level', value: 9 },
      { user_id: A, key: 'e1rm.epley_divisor', value: 0 },
    ]);
    assert.equal(t, base);
  });
});

describe('withOverride', () => {
  test('returns a frozen copy and leaves the original alone', () => {
    const t = withOverride(base, 'recovery.slope', 0.25);
    assert.equal(t.recovery.slope, 0.25);
    assert.equal(base.recovery.slope, 0.3);
    assert.ok(Object.isFrozen(t.recovery));
  });

  test('throws on an invalid override', () => {
    assert.throws(() => withOverride(base, 'recovery.slope', 'steep'), /invalid threshold override/);
  });
});
