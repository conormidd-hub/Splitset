import assert from 'node:assert/strict';
import { test } from 'node:test';

import { focusBounds, padBoundsVertically } from './heat.ts';

test('padBoundsVertically grows the box about its middle, keeping the width', () => {
  // 10° tall, 4° wide, centred on 55°, 10°
  const b: [number, number, number, number] = [50, 8, 60, 12];
  assert.deepEqual(padBoundsVertically(b, 2), [45, 8, 65, 12]);
  assert.deepEqual(padBoundsVertically(b, 2.5), [42.5, 8, 67.5, 12]);
});

test('a factor of one or less leaves the box alone', () => {
  const b: [number, number, number, number] = [50, 8, 60, 12];
  assert.equal(padBoundsVertically(b, 1), b);
  assert.equal(padBoundsVertically(b, 0.5), b);
  assert.equal(padBoundsVertically(b, NaN), b);
});

test('the focus box of a run can then be padded for the compact window', () => {
  const run: [number, number, number, number] = [51.50, -0.12, 51.52, -0.10];
  const focus = focusBounds(run);
  const padded = padBoundsVertically(focus, 260 / 120);
  // the run stays centred in the padded box
  assert.ok(Math.abs((padded[0] + padded[2]) / 2 - 51.51) < 1e-9);
  // and the width is the focus box's
  assert.equal(padded[1], focus[1]);
  assert.equal(padded[3], focus[3]);
  assert.ok(padded[2] - padded[0] > focus[2] - focus[0]);
});
