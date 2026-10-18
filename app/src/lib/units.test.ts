/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { displayToKg, kgToDisplay, sameWeightShown, weightRangeShown } from './units.ts';

/** profiles.bodyweight_kg is a real (float4), so a saved value comes back rounded to single precision. */
const stored = (kg: number) => Math.fround(kg);

describe('sameWeightShown: whether a weight field was changed', () => {
  test('in pounds, a 0.1 lb step is a change, though it is under 0.05 kg', () => {
    const saved = stored(displayToKg(160.4, 'imperial'));
    assert.equal(kgToDisplay(saved, 'imperial'), 160.4);
    assert.equal(sameWeightShown(displayToKg(160.5, 'imperial'), saved, 'imperial'), false);
    assert.equal(sameWeightShown(displayToKg(160.3, 'imperial'), saved, 'imperial'), false);
    assert.equal(sameWeightShown(displayToKg(160.4, 'imperial'), saved, 'imperial'), true);
  });

  test('every 0.1 lb step from 130 to 260 lb counts, and retyping the shown value never does', () => {
    for (let tenths = 1300; tenths < 2600; tenths++) {
      const saved = stored(displayToKg(tenths / 10, 'imperial'));
      assert.equal(sameWeightShown(displayToKg((tenths + 1) / 10, 'imperial'), saved, 'imperial'), false, `${tenths / 10} lb + 0.1`);
      assert.equal(sameWeightShown(displayToKg(kgToDisplay(saved, 'imperial'), 'imperial'), saved, 'imperial'), true, `${tenths / 10} lb`);
    }
  });

  test('in kilograms, any difference in what the field shows is a change', () => {
    const fromPounds = stored(displayToKg(160.4, 'imperial'));   // shows as 72.75597… after switching to metric
    assert.equal(sameWeightShown(72.8, fromPounds, 'metric'), false);
    assert.equal(sameWeightShown(fromPounds, fromPounds, 'metric'), true);
    assert.equal(sameWeightShown(72.8, 72.8, 'metric'), true);
  });

  test('null equals only null', () => {
    assert.equal(sameWeightShown(null, null, 'metric'), true);
    assert.equal(sameWeightShown(null, 72.8, 'imperial'), false);
    assert.equal(sameWeightShown(72.8, null, 'metric'), false);
  });
});

describe('weightRangeShown', () => {
  test('pounds are rounded inward, so both ends named pass the kg check', () => {
    const r = weightRangeShown(20, 400, 'imperial');
    assert.deepEqual(r, { min: 45, max: 881, unit: 'lb' });
    assert.ok(displayToKg(r.min, 'imperial') >= 20 && displayToKg(r.max, 'imperial') <= 400);
    assert.ok(displayToKg(r.min - 1, 'imperial') < 20 && displayToKg(r.max + 1, 'imperial') > 400);
  });

  test('kilograms are the limits as they are', () => {
    assert.deepEqual(weightRangeShown(20, 400, 'metric'), { min: 20, max: 400, unit: 'kg' });
  });
});
