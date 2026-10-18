import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCount, volumeKg } from './sideCounts.ts';

const set = (side: string | null) => ({ side, weight_kg: 20, reps: 10 });

test('Bulgarian split squat, 3 × 10 at 20 kg: the same sets and volume logged either way', () => {
  const both = [set(null), set(null), set(null)];
  const perSide = [set('left'), set('right'), set('left'), set('right'), set('left'), set('right')];
  assert.equal(setCount(both), 3);
  assert.equal(setCount(perSide), 3);
  assert.equal(volumeKg(both), 600);
  assert.equal(volumeKg(perSide), 600);
});

test('an unpaired side set rounds up to one set and adds half its volume', () => {
  assert.equal(setCount([set('left')]), 1);
  assert.equal(setCount([set(null), set('left'), set('right'), set('left')]), 3);
  assert.equal(volumeKg([set('left')]), 100);
});

test('missing weight or reps adds no volume', () => {
  assert.equal(volumeKg([{ side: null, weight_kg: null, reps: 10 }, { side: 'left', weight_kg: 20, reps: null }]), 0);
  assert.equal(setCount([]), 0);
});
