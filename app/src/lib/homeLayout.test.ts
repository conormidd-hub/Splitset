import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_GLANCE, OLD_DEFAULT_GLANCE, metricTrend, parseLayout, sameLayout, trendMetric } from './homeLayout.ts';

const KNOWN = new Set([...OLD_DEFAULT_GLANCE, 'readiness', 'lift_volume']);
const isMetric = (v: unknown): v is string => typeof v === 'string' && KNOWN.has(v);
const parse = (j: unknown) => parseLayout(j, isMetric, DEFAULT_GLANCE);

test('a layout from before the second slot gets the recovery figure on the right', () => {
  assert.deepEqual(parse({ v: 1, focus: 'readiness', glance: ['hrv'] }), { v: 1, focus: 'readiness', focus2: 'recovery', glance: ['hrv'], trends: null });
});

test('the right slot keeps a metric, recovery, or an empty choice', () => {
  assert.equal(parse({ v: 1, focus: 'hrv', focus2: 'sleep', glance: [] })?.focus2, 'sleep');
  assert.equal(parse({ v: 1, focus: 'hrv', focus2: 'recovery', glance: [] })?.focus2, 'recovery');
  assert.equal(parse({ v: 1, focus: 'hrv', focus2: null, glance: [] })?.focus2, null);
  assert.equal(parse({ v: 1, focus: 'hrv', focus2: 'nope', glance: [] })?.focus2, null);
});

test('an untouched old eight-tile At a glance becomes the new four; a customised one stays', () => {
  assert.deepEqual(parse({ v: 1, focus: 'readiness', glance: OLD_DEFAULT_GLANCE })?.glance, DEFAULT_GLANCE);
  const mine = ['sleep', 'lift_volume', 'hrv', 'steps', 'vo2max'];
  assert.deepEqual(parse({ v: 1, focus: 'readiness', glance: mine })?.glance, mine);
});

test('unknown ids are dropped, repeats folded, and junk is not a layout', () => {
  assert.deepEqual(parse(JSON.stringify({ v: 1, focus: 'gone', focus2: 'recovery', glance: ['hrv', 'gone', 'hrv'] })),
    { v: 1, focus: null, focus2: 'recovery', glance: ['hrv'], trends: null });
  assert.equal(parse('{bad json'), null);
  assert.equal(parse({ v: 2, glance: [] }), null);
});

test('two layouts differ when either focus slot or the tiles differ', () => {
  const a = { v: 1 as const, focus: 'hrv', focus2: 'recovery', glance: ['sleep'] };
  assert.ok(sameLayout(a, { ...a }));
  assert.ok(!sameLayout(a, { ...a, focus2: 'sleep' }));
  assert.ok(!sameLayout(a, { ...a, glance: ['sleep', 'hrv'] }));
});

test('trends keep built-in charts and charted metrics this build knows, once each, in order', () => {
  const out = parse({ v: 1, focus: 'hrv', glance: [], trends: ['hrv', 'm:sleep', 'm:nope', 'bogus', 'acwr', 'm:sleep', 7] });
  assert.deepEqual(out?.trends, ['hrv', 'm:sleep', 'acwr']);
  assert.equal(parse({ v: 1, focus: 'hrv', glance: [] })?.trends, null);       // never edited: the defaults
  assert.equal(metricTrend('steps'), 'm:steps');
  assert.equal(trendMetric('m:steps'), 'steps');
  assert.equal(trendMetric('acwr'), null);
});
