import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_GLANCE, DEFAULT_RUN_TRENDS, OLD_DEFAULT_GLANCE, compareTrend, comparedMetrics, isRunTrend, liftTrend, metricTrend, parseLayout, parseLiftTrend, resetHome, sameLayout,
  trendMetric,
} from './homeLayout.ts';

const KNOWN = new Set([...OLD_DEFAULT_GLANCE, 'readiness', 'lift_volume']);
const isMetric = (v: unknown): v is string => typeof v === 'string' && KNOWN.has(v);
const parse = (j: unknown) => parseLayout(j, isMetric, DEFAULT_GLANCE);

test('a layout from before the second slot gets the recovery figure on the right', () => {
  assert.deepEqual(parse({ v: 1, focus: 'readiness', glance: ['hrv'] }), { v: 1, focus: 'readiness', focus2: 'recovery', glance: ['hrv'], trends: null, liftTrends: null, runTrends: null });
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
    { v: 1, focus: null, focus2: 'recovery', glance: ['hrv'], trends: null, liftTrends: null, runTrends: null });
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

test('comparisons keep two known, different metrics; anything else is dropped', () => {
  const id = compareTrend('hrv', 'sleep');
  assert.deepEqual(comparedMetrics(id), ['hrv', 'sleep']);
  assert.equal(comparedMetrics('c:hrv,hrv'), null);
  assert.equal(comparedMetrics('c:hrv'), null);
  assert.equal(comparedMetrics('m:hrv'), null);
  assert.deepEqual(parse({ v: 1, focus: null, glance: [], trends: [id, 'c:hrv,gone', id, 'c:hrv,hrv'] })?.trends, [id]);
});

test('Lift charts keep an exercise id and a known measure', () => {
  const ex = '0b9d2a52-4a8e-4b8e-9b9e-0c1d2e3f4a5b';
  assert.deepEqual(parseLiftTrend(liftTrend(ex, 'volume')), { exerciseId: ex, measure: 'volume' });
  assert.equal(parseLiftTrend(`x:${ex}:speed`), null);
  assert.equal(parseLiftTrend('x:not-a-uuid:e1rm'), null);
  const kept = parse({ v: 1, focus: null, glance: [], liftTrends: [liftTrend(ex, 'e1rm'), 'x:bad:e1rm', liftTrend(ex, 'e1rm')] });
  assert.deepEqual(kept?.liftTrends, [liftTrend(ex, 'e1rm')]);
  assert.equal(parse({ v: 1, focus: null, glance: [] })?.liftTrends, null);
});

test('Run charts keep the known ones; an empty list stays empty, not the defaults', () => {
  assert.deepEqual(parse({ v: 1, focus: null, glance: [], runTrends: ['run_cadence', 'nope', 'run_cadence', 'run_hr_zones'] })?.runTrends, ['run_cadence', 'run_hr_zones']);
  assert.deepEqual(parse({ v: 1, focus: null, glance: [], runTrends: [] })?.runTrends, []);
  assert.ok(DEFAULT_RUN_TRENDS.every(isRunTrend));
});

test('sameLayout notices a change to any chart list', () => {
  const a = parse({ v: 1, focus: null, glance: [], runTrends: ['run_hr'] })!;
  const b = parse({ v: 1, focus: null, glance: [], runTrends: ['run_hr', 'run_pace'] })!;
  const c = parse({ v: 1, focus: null, glance: [] })!;
  assert.equal(sameLayout(a, a), true);
  assert.equal(sameLayout(a, b), false);
  assert.equal(sameLayout(c, parse({ v: 1, focus: null, glance: [], liftTrends: [] })!), false);
});

test("resetting Today's layout keeps the Trends, Lift and Run chart lists", () => {
  const ex = '0b9d2a52-4a8e-4b8e-9b9e-0c1d2e3f4a5b';
  const defaults = { v: 1 as const, focus: 'readiness', focus2: 'recovery' as const, glance: [...DEFAULT_GLANCE] };
  const mine = parse({
    v: 1, focus: 'hrv', focus2: 'sleep', glance: ['steps'],
    trends: [compareTrend('hrv', 'sleep')], liftTrends: [liftTrend(ex, 'volume')], runTrends: [],
  })!;
  const out = resetHome(mine, defaults);
  assert.deepEqual(out, { ...defaults, trends: mine.trends, liftTrends: mine.liftTrends, runTrends: [] });
  assert.notEqual(out.glance, defaults.glance);       // a copy, so editing it later can't touch the defaults
  assert.equal(resetHome(parse({ v: 1, focus: null, glance: [] })!, defaults).liftTrends, null);
});
