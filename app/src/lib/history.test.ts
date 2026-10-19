import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byMonth, cutPage, inFilter, localStamp, mergeFeed, sportOf, type FeedActivity, type FeedPage, type FeedWorkout } from './history.ts';

// workouts carry UTC timestamps; pin the clock to the UK so their local times are known
process.env.TZ = 'Europe/London';

const act = (id: string, start: string, type = 'Run'): FeedActivity => ({ id, start_time: `${start}Z`, start_time_local: start, type });
const wo = (id: string, start: string, activity_id: string | null = null): FeedWorkout => ({ id, started_at: `${start}Z`, activity_id });
const keysOf = (items: { key: string }[]) => items.map((i) => i.key);

test('activity types sort into sports, and Other is everything but runs, rides and lifts', () => {
  assert.equal(sportOf('TrailRun'), 'run');
  assert.equal(sportOf('WeightTraining'), 'lift');
  assert.equal(sportOf('Workout'), 'lift');
  assert.equal(sportOf('GravelRide'), 'ride');
  assert.equal(sportOf('Velomobile'), 'ride');
  assert.equal(sportOf('OpenWaterSwim'), 'swim');
  assert.equal(sportOf('Hike'), 'hike');
  assert.equal(sportOf('Yoga'), 'other');
  assert.equal(sportOf(null), 'other');
  assert.ok(inFilter('swim', 'other'));
  assert.ok(inFilter('walk', 'other'));
  assert.ok(!inFilter('ride', 'other'));
  assert.ok(inFilter('lift', 'lifts'));
  assert.ok(!inFilter('run', 'lifts'));
  assert.ok(inFilter('run', 'all'));
});

test('activities and workouts interleave newest first', () => {
  const feed = mergeFeed(
    [act('r1', '2026-10-18T07:00:00'), act('r2', '2026-10-15T07:00:00')],
    [wo('w1', '2026-10-17T18:00:00'), wo('w2', '2026-10-14T18:00:00')],
  );
  assert.deepEqual(keysOf(feed), ['a:r1', 'w:w1', 'a:r2', 'w:w2']);
  assert.equal(feed[1].sport, 'lift');
  assert.equal(feed[0].when, '2026-10-18T07:00:00');
});

test('a watch recording linked to an app workout shows once, as the workout', () => {
  // linked by the sync, even 90 minutes apart
  const feed = mergeFeed([act('g1', '2026-10-17T19:30:00', 'WeightTraining')], [wo('w1', '2026-10-17T18:00:00', 'g1')]);
  assert.deepEqual(keysOf(feed), ['w:w1']);
});

test('an unlinked strength recording near an app workout is the same session; further off it stays', () => {
  const workouts = [wo('w1', '2026-10-17T18:00:00')];
  assert.deepEqual(keysOf(mergeFeed([act('g1', '2026-10-17T18:40:00', 'WeightTraining')], workouts)), ['w:w1']);
  assert.deepEqual(keysOf(mergeFeed([act('g2', '2026-10-17T17:20:00', 'Workout')], workouts)), ['w:w1']);
  assert.deepEqual(keysOf(mergeFeed([act('g3', '2026-10-17T19:00:00', 'WeightTraining')], workouts)), ['a:g3', 'w:w1']);
  // a run straight after the gym is its own session
  assert.deepEqual(keysOf(mergeFeed([act('r1', '2026-10-17T18:30:00')], workouts)), ['a:r1', 'w:w1']);
});

test('a strength recording near the loaded edge waits for the next page; other sports do not', () => {
  const acts = [act('g1', '2026-10-17T19:00:00', 'WeightTraining'), act('r1', '2026-10-17T18:30:00')];
  const edge = '2026-10-17T18:00:00Z';
  assert.deepEqual(keysOf(mergeFeed(acts, [], { loadedTo: edge })), ['a:r1']);
  assert.deepEqual(keysOf(mergeFeed(acts, [], { loadedTo: null })), ['a:g1', 'a:r1']);
});

test('workouts without an id or a start are skipped, and repeats fold', () => {
  const feed = mergeFeed(
    [act('r1', '2026-10-18T07:00:00'), act('r1', '2026-10-18T07:00:00')],
    [{ id: null, started_at: '2026-10-17T18:00:00Z', activity_id: null }, wo('w1', '2026-10-16T18:00:00'), wo('w1', '2026-10-16T18:00:00')],
  );
  assert.deepEqual(keysOf(feed), ['a:r1', 'w:w1']);
});

test('a page is trusted down to the more recent edge of whichever list ran to its limit', () => {
  const acts = [act('a1', '2026-10-18T07:00:00'), act('a2', '2026-10-10T07:00:00')];
  const wos = [wo('w1', '2026-10-15T18:00:00'), wo('w2', '2026-10-01T18:00:00')];
  // neither list full: everything, and no next page
  assert.deepEqual(cutPage(acts, wos, 3), { activities: acts, workouts: wos, next: null });
  // activities full: workouts older than the last activity wait for the next page
  const p = cutPage(acts, wos, 2);
  assert.equal(p.next, '2026-10-10T07:00:00Z');
  assert.deepEqual(p.activities.map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(p.workouts.map((w) => w.id), ['w1']);
  // both full: the later of the two edges wins
  const q = cutPage([act('a1', '2026-10-18T07:00:00')], [wo('w1', '2026-10-15T18:00:00')], 1);
  assert.equal(q.next, '2026-10-18T07:00:00Z');
  assert.deepEqual(q.workouts, []);
});

test('paging the two lists together finds every item once, in order', () => {
  // a long history with bursts of one kind, so the lists run out of step
  const acts: FeedActivity[] = [];
  const wos: FeedWorkout[] = [];
  const day = (n: number) => new Date(Date.UTC(2026, 9, 18) - n * 86_400_000).toISOString().slice(0, 19);
  for (let n = 0; n < 60; n++) {
    if (n % 7 < 4 || n > 40) acts.push(act(`a${n}`, day(n)));
    if (n % 3 === 0 || (n > 20 && n < 30)) wos.push(wo(`w${n}`, `${day(n).slice(0, 10)}T18:00:00`));
  }
  const newest = <X,>(xs: X[], at: (x: X) => string) => [...xs].sort((x, y) => at(y).localeCompare(at(x)));
  const allActs = newest(acts, (a) => a.start_time);
  const allWos = newest(wos, (w) => w.started_at ?? '');

  const pageActs: FeedActivity[] = [];
  const pageWos: FeedWorkout[] = [];
  let before: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const cursor: string | null = before;
    const a: FeedActivity[] = allActs.filter((x) => !cursor || Date.parse(x.start_time) < Date.parse(cursor)).slice(0, 5);
    const w: FeedWorkout[] = allWos.filter((x) => !cursor || Date.parse(x.started_at ?? '') < Date.parse(cursor)).slice(0, 5);
    const page: FeedPage<FeedActivity, FeedWorkout> = cutPage(a, w, 5);
    pageActs.push(...page.activities);
    pageWos.push(...page.workouts);
    before = page.next;
    if (!before) break;
  }
  assert.equal(before, null);
  assert.deepEqual(keysOf(mergeFeed(pageActs, pageWos)), keysOf(mergeFeed(acts, wos)));
});

test('timestamps become local wall clock; ones without an offset stay as they are', () => {
  assert.equal(localStamp('2026-10-18T06:30:00+00:00'), '2026-10-18T07:30:00');   // BST
  assert.equal(localStamp('2026-12-01T23:30:00Z'), '2026-12-01T23:30:00');        // GMT
  assert.equal(localStamp('2026-10-18T07:30:00'), '2026-10-18T07:30:00');
  // a workout late on the last night of September (UTC) belongs to October in the UK
  const feed = mergeFeed([], [wo('w1', '2026-09-30T23:30:00')]);
  assert.equal(feed[0].when, '2026-10-01T00:30:00');
});

test('months group the feed, one section per month', () => {
  const months = byMonth([
    { when: '2026-10-18T07:00:00' }, { when: '2026-10-02T07:00:00' }, { when: '2026-09-29T07:00:00' }, { when: '2026-10-01T00:10:00' },
  ]);
  assert.deepEqual(months.map((m) => [m.month, m.items.length]), [['2026-10', 3], ['2026-09', 1]]);
});
