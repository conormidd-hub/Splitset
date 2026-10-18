/// <reference types="node" />

// The cache writers' queue and what it owes: starts compared as instants, one writer at a time,
// recomputes asked for while another waits folded into it, a failed run retried by the next, and
// finished workouts with no cache rows found.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { earlierFrom, mergeOwed, recomputeQueue, serialQueue, unscoredFrom, type From, type OwedStore } from './pending.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
/** Lets every queued job that can move on do so. */
const settle = () => new Promise((r) => setImmediate(r));

function memoryOwed(): OwedStore & { map: Map<string, From> } {
  const map = new Map<string, From>();
  return { map, get: (uid) => map.get(uid), set: (uid, from) => { if (from === undefined) map.delete(uid); else map.set(uid, from); } };
}

/** A recompute queue whose runs wait until the test lets them finish. */
function harness() {
  const owed = memoryOwed();
  const runs: { uid: string; from: From; done: ReturnType<typeof deferred<number>> }[] = [];
  const q = recomputeQueue(serialQueue(), owed, (uid, from) => {
    const done = deferred<number>();
    runs.push({ uid, from, done });
    return done.promise;
  });
  return { owed, runs, q };
}

describe('earlierFrom and mergeOwed', () => {
  test('null (every workout) wins, undefined is nothing, and starts compare as instants', () => {
    assert.equal(earlierFrom(null, '2026-10-01T00:00:00Z'), null);
    assert.equal(earlierFrom('2026-10-01T00:00:00Z', null), null);
    assert.equal(earlierFrom(undefined, '2026-10-01T00:00:00Z'), '2026-10-01T00:00:00Z');
    assert.equal(earlierFrom('2026-10-01T00:00:00Z', undefined), '2026-10-01T00:00:00Z');
    assert.equal(earlierFrom(undefined, undefined), undefined);
    // 06:00+01:00 is 05:00Z, earlier than 05:30Z, though it sorts later as a string
    assert.equal(earlierFrom('2026-10-18T05:30:00.000Z', '2026-10-18T06:00:00+01:00'), '2026-10-18T06:00:00+01:00');
    assert.equal(earlierFrom('2026-10-18T05:00:00+00:00', '2026-10-18T05:00:00.000Z'), '2026-10-18T05:00:00+00:00');   // a tie keeps the first
  });

  test('each user keeps their earlier start', () => {
    assert.deepEqual(
      mergeOwed({ a: '2026-10-05T00:00:00Z', b: null, c: '2026-10-01T00:00:00Z' }, { a: '2026-10-02T00:00:00Z', b: '2026-10-01T00:00:00Z', d: null }),
      { a: '2026-10-02T00:00:00Z', b: null, c: '2026-10-01T00:00:00Z', d: null },
    );
    assert.deepEqual(mergeOwed({}, {}), {});
  });
});

describe('serialQueue', () => {
  test('one job at a time, in order; a failed job does not stop the next', async () => {
    const serial = serialQueue();
    const log: string[] = [];
    const first = deferred<void>();
    const a = serial(async () => { log.push('a starts'); await first.promise; log.push('a ends'); throw new Error('a failed'); });
    const b = serial(async () => { log.push('b runs'); return 2; });
    await settle();
    assert.deepEqual(log, ['a starts']);
    first.resolve();
    await assert.rejects(a, /a failed/);
    assert.equal(await b, 2);
    assert.deepEqual(log, ['a starts', 'a ends', 'b runs']);
  });
});

describe('recomputeQueue', () => {
  test('requests made while a run waits fold into it, from the earliest start, and share its result', async () => {
    const { owed, runs, q } = harness();
    const first = q.request('u', '2026-10-10T00:00:00Z');
    const second = q.request('u', '2026-10-08T00:00:00+00:00');
    const third = q.request('u', '2026-10-09T00:00:00Z');
    assert.equal(owed.get('u'), '2026-10-08T00:00:00+00:00');   // kept from the request on, so a killed app retries it
    await settle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].from, '2026-10-08T00:00:00+00:00');
    runs[0].done.resolve(7);
    assert.deepEqual(await Promise.all([first, second, third]), [7, 7, 7]);
    assert.equal(owed.get('u'), undefined);
    assert.equal(q.retryFrom('u'), undefined);
  });

  test('a request made while a run is going runs again after it, and stays owed until then', async () => {
    const { owed, runs, q } = harness();
    const first = q.request('u', '2026-10-10T00:00:00Z');
    await settle();
    // e.g. a workout deleted after the first run read the history: it must be rescored again
    const second = q.request('u', '2026-10-12T00:00:00Z');
    const third = q.request('u', '2026-10-11T00:00:00Z');
    runs[0].done.resolve(3);
    assert.equal(await first, 3);
    assert.equal(owed.get('u'), '2026-10-11T00:00:00Z');   // only what was asked for since it started
    await settle();
    assert.equal(runs.length, 2);
    assert.equal(runs[1].from, '2026-10-11T00:00:00Z');
    runs[1].done.resolve(2);
    assert.deepEqual(await Promise.all([second, third]), [2, 2]);
    assert.equal(owed.get('u'), undefined);
  });

  test('a failed run stays owed: the next run starts from it, and retryFrom offers it when nothing is queued', async () => {
    const { owed, runs, q } = harness();
    const first = q.request('u', '2026-10-05T00:00:00Z');
    await settle();
    assert.equal(q.retryFrom('u'), undefined);   // running
    runs[0].done.reject(new Error('Network request failed'));
    await assert.rejects(first, /Network request failed/);
    assert.equal(owed.get('u'), '2026-10-05T00:00:00Z');
    assert.equal(q.retryFrom('u'), '2026-10-05T00:00:00Z');
    // a later, narrower recompute (a manual PB on the 20th) also redoes the failed range
    const second = q.request('u', '2026-10-20T00:00:00Z');
    assert.equal(q.retryFrom('u'), undefined);   // queued
    await settle();
    assert.equal(runs[1].from, '2026-10-05T00:00:00Z');
    runs[1].done.resolve(9);
    assert.equal(await second, 9);
    assert.equal(owed.get('u'), undefined);
    assert.equal(q.retryFrom('u'), undefined);
  });

  test('a run of everything (null) covers any start, and users are kept apart', async () => {
    const { owed, runs, q } = harness();
    const all = q.request('u', '2026-10-05T00:00:00Z');
    const other = q.request('v', '2026-10-01T00:00:00Z');
    void q.request('u', null);
    await settle();
    assert.deepEqual([runs[0].uid, runs[0].from], ['u', null]);
    runs[0].done.resolve(1);
    await all;
    assert.equal(owed.get('u'), undefined);
    assert.equal(owed.get('v'), '2026-10-01T00:00:00Z');
    await settle();
    assert.deepEqual([runs[1].uid, runs[1].from], ['v', '2026-10-01T00:00:00Z']);
    runs[1].done.resolve(1);
    await other;
    assert.equal(owed.map.size, 0);
  });

  test('what a previous session owed (persisted) is run by the next request', async () => {
    const { owed, runs, q } = harness();
    owed.set('u', '2026-09-01T00:00:00Z');
    assert.equal(q.retryFrom('u'), '2026-09-01T00:00:00Z');
    void q.request('u', '2026-10-15T00:00:00Z');
    await settle();
    assert.equal(runs[0].from, '2026-09-01T00:00:00Z');
  });
});

describe('unscoredFrom', () => {
  const scores = (id: string) => id !== 'x-unscored';
  test('the earliest finished workout with no cache rows whose exercises score', () => {
    const workouts = [
      { id: 'w1', started_at: '2026-10-01T07:00:00+00:00' },   // has rows
      { id: 'w2', started_at: '2026-10-03T07:00:00+00:00' },   // only an exercise the engine can't score
      { id: 'w3', started_at: '2026-10-05T07:00:00+00:00' },   // finished by an older app: no rows
      { id: 'w4', started_at: '2026-10-04T07:00:00+00:00' },   // no rows, and no blocks at all
      { id: 'w5', started_at: '2026-10-06T07:00:00+00:00' },   // no rows either
    ];
    const blocks = [
      { workout_id: 'w1', exercise_id: 'bench' }, { workout_id: 'w2', exercise_id: 'x-unscored' },
      { workout_id: 'w3', exercise_id: 'x-unscored' }, { workout_id: 'w3', exercise_id: 'squat' }, { workout_id: 'w5', exercise_id: 'row' },
    ];
    assert.deepEqual(unscoredFrom(workouts, new Set(['w1']), blocks, scores), { from: '2026-10-05T07:00:00+00:00', unscorable: ['w2', 'w4'] });
    assert.deepEqual(unscoredFrom(workouts, new Set(['w1', 'w3', 'w5']), blocks, scores), { from: undefined, unscorable: ['w2', 'w4'] });
    assert.deepEqual(unscoredFrom([], new Set(), [], scores), { from: undefined, unscorable: [] });
  });

  test('workouts left out (already found unscorable) are neither a start nor listed again', () => {
    const workouts = [{ id: 'w2', started_at: '2026-10-03T07:00:00+00:00' }, { id: 'w3', started_at: '2026-10-05T07:00:00+00:00' }];
    const blocks = [{ workout_id: 'w3', exercise_id: 'squat' }];
    assert.deepEqual(unscoredFrom(workouts.slice(1), new Set(), blocks, scores), { from: '2026-10-05T07:00:00+00:00', unscorable: [] });
  });
});
