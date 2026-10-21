import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Router } from '../api/routing.ts';
import {
  LegCache, addWaypoint, closeLoop, insertWaypoint, isClosed, moveWaypoint, nearestLeg, nearestWaypoint, outAndBack,
  parseWaypoints, removeWaypoint, reverseCourse, routeCourse, type Waypoint,
} from './courseBuilder.ts';
import { haversineKm } from './geo.ts';
import { elevationStats } from './runAnalysis.ts';

const A: Waypoint = [51.5, -0.1];
const B: Waypoint = [51.51, -0.1];
const C: Waypoint = [51.51, -0.09];
/** A point the fake router refuses, like Valhalla does for one far from any path. */
const SEA: Waypoint = [89.5, 0];

/** Height climbs 100 m per 0.01 degree of latitude: A to B is a 100 m climb, B to C is flat. */
const heightAt = (lat: number) => 100 + (lat - 51.5) * 10000;

/** Routes a pair as three points (the ends and their midpoint), 20 % longer than the straight line. */
function fakeRouter() {
  const calls: string[] = [];
  const router: Router = {
    async route(points) {
      calls.push(points.map((p) => `${p.lat},${p.lng}`).join('>'));
      if (points.some((p) => p.lat > 89)) throw new Error('A point is too far from any road or path');
      const [a, b] = points;
      const pts: [number, number][] = [[a.lat, a.lng], [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], [b.lat, b.lng]];
      return { pts, distance_m: haversineKm(a, b) * 1000 * 1.2, duration_s: 600 };
    },
    async heights(pts) {
      return pts.map(([lat]) => heightAt(lat));
    },
  };
  return { router, calls };
}

test('legs are routed in order and joined without repeating the shared point', async () => {
  const { router, calls } = fakeRouter();
  const course = await routeCourse([A, B, C], new LegCache(router));
  assert.equal(calls.length, 2);
  assert.equal(course.legs.length, 2);
  assert.equal(course.pts.length, 5);                          // 3 + 3 - the shared B
  assert.deepEqual(course.pts[2], B);
  const straight = haversineKm({ lat: A[0], lng: A[1] }, { lat: B[0], lng: B[1] }) + haversineKm({ lat: B[0], lng: B[1] }, { lat: C[0], lng: C[1] });
  assert.ok(Math.abs(course.distance_m - straight * 1200) < 1e-6);
  assert.equal(course.duration_s, 1200);
  assert.deepEqual(course.unrouted, []);
  assert.equal(course.heightsKnown, true);
  const { gain, loss } = elevationStats(course.pts.map(([lat]) => heightAt(lat)));
  assert.equal(course.elev_gain_m, gain);
  assert.equal(course.elev_loss_m, loss);
  assert.ok(gain > 50 && loss === 0);
});

test('fewer than two points is an empty course and asks the router nothing', async () => {
  const { router, calls } = fakeRouter();
  const one = await routeCourse([A], new LegCache(router));
  assert.equal(one.pts.length, 0);
  assert.equal(one.distance_m, 0);
  assert.equal(calls.length, 0);
});

test('a moved waypoint re-routes only the legs it belongs to', async () => {
  const { router, calls } = fakeRouter();
  const cache = new LegCache(router);
  await routeCourse([A, B, C], cache);
  assert.equal(calls.length, 2);
  const moved: Waypoint = [51.512, -0.09];
  await routeCourse([A, B, moved], cache);
  assert.equal(calls.length, 3);                               // A>B came from the cache
  await routeCourse([A, B, C], cache);
  assert.equal(calls.length, 3);                               // undo costs nothing
  assert.equal(cache.size, 3);
});

test('a point off the network leaves a straight, flagged leg that blocks saving', async () => {
  const { router, calls } = fakeRouter();
  const cache = new LegCache(router);
  const course = await routeCourse([A, SEA, C], cache);
  assert.deepEqual(course.unrouted, [0, 1]);
  assert.equal(course.legs[0].error, 'A point is too far from any road or path');
  assert.deepEqual(course.legs[0].pts, [A, SEA]);
  assert.deepEqual(course.pts, [A, SEA, C]);
  assert.equal(course.heightsKnown, false);
  assert.ok(course.distance_m > 0);
  // the failure is cached like any leg, then forgotten on request
  await routeCourse([A, SEA, C], cache);
  assert.equal(calls.length, 2);
  await cache.forgetFailures();
  assert.equal(cache.size, 0);
  await routeCourse([A, SEA, C], cache);
  assert.equal(calls.length, 4);
});

test('a leg whose heights fail still counts, and the others are summed on their own', async () => {
  const { router } = fakeRouter();
  let failures = 0;
  const flaky: Router = {
    route: router.route,
    async heights(pts) {
      // the first lookup (A to B, the climb) fails; B to C is flat
      if (failures++ === 0) throw new Error('Heights: down');
      return router.heights(pts);
    },
  };
  const course = await routeCourse([A, B, C], new LegCache(flaky));
  assert.equal(course.legs[0].heights, null);
  assert.deepEqual(course.unrouted, []);
  assert.equal(course.heightsKnown, false);
  assert.equal(course.elev_gain_m, 0);
  assert.equal(course.pts.length, 5);
});

test('editing the waypoints', () => {
  assert.deepEqual(addWaypoint([], A), [A]);
  assert.deepEqual(addWaypoint([A], B), [A, B]);
  // a repeat tap within 15 m of the end adds nothing
  assert.deepEqual(addWaypoint([A, B], [51.51005, -0.1]), [A, B]);
  assert.deepEqual(insertWaypoint([A, C], 0, B), [A, B, C]);
  assert.deepEqual(insertWaypoint([A, B, C], 1, [51.52, -0.1]), [A, B, [51.52, -0.1], C]);
  assert.deepEqual(insertWaypoint([A, B, C], 9, [51.52, -0.1]), [A, B, [51.52, -0.1], C]);   // clamped to the last leg
  assert.deepEqual(insertWaypoint([A], 0, B), [A, B]);
  assert.deepEqual(moveWaypoint([A, B, C], 1, [51.52, -0.1]), [A, [51.52, -0.1], C]);
  assert.deepEqual(moveWaypoint([A, B, C], 7, [51.52, -0.1]), [A, B, C]);
  assert.deepEqual(removeWaypoint([A, B, C], 1), [A, C]);
  assert.deepEqual(reverseCourse([A, B, C]), [C, B, A]);
});

test('closing a loop, out and back, and a start that drags its finish along', () => {
  assert.equal(isClosed([A, B, C]), false);
  assert.equal(isClosed([A, B, A]), true);
  assert.equal(isClosed([A, A]), false);                       // two points are never a loop
  const loop = closeLoop([A, B, C]);
  assert.deepEqual(loop, [A, B, C, A]);
  assert.equal(isClosed(loop), true);
  assert.deepEqual(closeLoop(loop), loop);                     // already closed
  assert.deepEqual(closeLoop([A]), [A]);
  assert.deepEqual(outAndBack([A, B, C]), [A, B, C, B, A]);
  assert.deepEqual(outAndBack(loop), loop);                    // a loop goes nowhere and back
  assert.deepEqual(outAndBack([A]), [A]);
  // moving the start of a closed course moves its finish too, and the course stays closed
  const movedStart = moveWaypoint(loop, 0, [51.505, -0.1]);
  assert.deepEqual(movedStart, [[51.505, -0.1], B, C, [51.505, -0.1]]);
  assert.deepEqual(moveWaypoint(loop, 3, [51.505, -0.1]), movedStart);
  assert.deepEqual(moveWaypoint(loop, 1, [51.52, -0.1]), [A, [51.52, -0.1], C, A]);
});

test('what is under a tap', async () => {
  // a flat projector: A at the origin, B 1000 px up, C 1000 px right of B
  const project = (lat: number, lng: number) => ({ x: (lng + 0.1) * 100000, y: (51.5 - lat) * 100000 });
  assert.equal(nearestWaypoint([A, B, C], project, { x: 5, y: -3 }), 0);
  assert.equal(nearestWaypoint([A, B, C], project, { x: 995, y: -1005 }), 2);
  assert.equal(nearestWaypoint([A, B, C], project, { x: 50, y: 50 }), null);
  assert.equal(nearestWaypoint([], project, { x: 0, y: 0 }), null);
  const { router } = fakeRouter();
  const course = await routeCourse([A, B, C], new LegCache(router));
  assert.equal(nearestLeg(course, project, { x: 3, y: -500 }), 0);
  assert.equal(nearestLeg(course, project, { x: 500, y: -995 }), 1);
  assert.equal(nearestLeg(course, project, { x: 500, y: -500 }), null);
  assert.equal(nearestLeg(course, project, { x: 3, y: -500 }, 2), null);
});

test('stored waypoints are checked shape by shape', () => {
  assert.deepEqual(parseWaypoints([[51.5, -0.1], [51.51, -0.1]]), [A, B]);
  assert.deepEqual(parseWaypoints([]), []);
  assert.equal(parseWaypoints(null), null);
  assert.equal(parseWaypoints('nope'), null);
  assert.equal(parseWaypoints([[51.5]]), null);
  assert.equal(parseWaypoints([[51.5, 'x']]), null);
  assert.equal(parseWaypoints([[51.5, Infinity]]), null);
  assert.equal(parseWaypoints([{ lat: 1, lng: 2 }]), null);
});
