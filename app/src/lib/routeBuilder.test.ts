import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Router } from '../api/routing.ts';
import { haversineKm, type LatLng } from './geo.ts';
import { generatePointToPoint } from './routeBuilder.ts';

const A: LatLng = { lat: 51.5, lng: -0.1 };
const B: LatLng = { lat: 51.5, lng: -0.05 };   // about 3.5 km east of A

/** Routes any list of points as straight legs, 10 % longer than the crow flies, with flat terrain. */
function fakeRouter() {
  const calls: number[] = [];
  const router: Router = {
    async route(points) {
      calls.push(points.length);
      let d = 0;
      const pts: [number, number][] = [[points[0].lat, points[0].lng]];
      for (let i = 1; i < points.length; i++) {
        d += haversineKm(points[i - 1], points[i]) * 1100;
        pts.push([points[i].lat, points[i].lng]);
      }
      return { pts, distance_m: d, duration_s: d / 1.4 };
    },
    async heights(pts) {
      return pts.map(() => 20);
    },
  };
  return { router, calls };
}

test('without a target only the direct route comes back', async () => {
  const { router, calls } = fakeRouter();
  const out = await generatePointToPoint(A, B, null, router);
  assert.deepEqual(out.map((c) => c.label), ['Direct']);
  assert.equal(calls.length, 1);
});

test('a total target just above the direct route earns no detour, a short one does', async () => {
  const { router } = fakeRouter();
  const direct = (await generatePointToPoint(A, B, null, router))[0].distance_m;
  const near = await generatePointToPoint(A, B, { totalM: direct * 1.1 }, router);
  assert.deepEqual(near.map((c) => c.label), ['Direct']);
  const far = await generatePointToPoint(A, B, { totalM: direct * 1.5 }, router);
  assert.ok(far.length === 3);
  assert.ok(far[0].label.startsWith('Detour'), far[0].label);                 // nearest the target first
  assert.ok(Math.abs(far[0].distance_m - direct * 1.5) / (direct * 1.5) < 0.1);
  assert.ok(far.some((c) => c.label === 'Direct'));
});

test('extra distance is added to the direct route and always tries the detours', async () => {
  const { router, calls } = fakeRouter();
  const direct = (await generatePointToPoint(A, B, null, router))[0].distance_m;
  calls.length = 0;
  const out = await generatePointToPoint(A, B, { extraM: 500 }, router);
  assert.equal(out.length, 3);
  assert.ok(calls.length >= 3, `${calls.length} routing calls`);
  const target = direct + 500;
  assert.ok(out[0].label.startsWith('Detour'), out[0].label);
  assert.ok(Math.abs(out[0].distance_m - target) / target < 0.1, `${out[0].distance_m} vs ${target}`);
  for (const c of out) {
    assert.equal(c.kind, 'point_to_point');
    assert.equal(c.elev_gain_m, 0);
  }
  // nothing extra asked for: the direct route alone
  assert.deepEqual((await generatePointToPoint(A, B, { extraM: 0 }, router)).map((c) => c.label), ['Direct']);
});

test('a detour that comes back as the direct route is dropped', async () => {
  const { router } = fakeRouter();
  // a router that ignores the middle point: both detours measure exactly the direct route
  const flat: Router = { route: (points) => router.route([points[0], points[points.length - 1]]), heights: router.heights };
  const out = await generatePointToPoint(A, B, { extraM: 800 }, flat);
  assert.deepEqual(out.map((c) => c.label), ['Direct']);
});
