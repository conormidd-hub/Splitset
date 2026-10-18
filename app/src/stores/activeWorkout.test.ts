/// <reference types="node" />

// The workout store's save queue against a fake server (testing/supabase.mjs): the order Finish
// sends things in, a Finish during a save or while offline, the retry, and the facts a block copies
// from the library. The store's '@/…' imports resolve through testing/aliasHook.mjs, registered
// before the store loads.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';

import { resolve } from './testing/aliasHook.mjs';
import { server } from './testing/supabase.mjs';

registerHooks({ resolve });
const { useActiveWorkout } = await import('./activeWorkout.ts');

const UID = 'u1';
const BENCH = { id: 'ex-bench', name: 'Bench press', measure: 'weight_reps', slug: 'bench_press_bb', load_mode: 'weight', bw_factor: null, is_unilateral: false, is_bodyweight: false };
/** A custom exercise before it was mapped: no slug, no load mode. */
const DIP = { id: 'ex-dip', name: 'Weighted dip', measure: 'weight_reps', slug: null, load_mode: null, bw_factor: null, is_unilateral: false, is_bodyweight: false };
const DIP_MAPPED = { ...DIP, slug: 'custom_weighted_dip', load_mode: 'bodyweight', bw_factor: 1, is_bodyweight: true };

const store = () => useActiveWorkout.getState();
/** Wait for the queue: joins a drain in flight, or drains what is left. */
const settle = () => store().flush();
const calls = (name: string) => server.log.filter((e) => e.call === name);
const savedSet = (id: string) => server.table('workout_sets').get(id);
const near = (actual: number, want: number, tol = 0.05) => assert.ok(Math.abs(actual - want) <= tol, `${actual} is not ${want}`);

/** Start a workout and tick one set of an exercise. */
function logOneSet(exercise: typeof BENCH | typeof DIP = BENCH, weightKg = 100, reps = 5) {
  store().start(UID, null, 'Push', 82);
  const setId = store().addExercise(exercise).sets[0].id;
  store().updateSet(setId, { weightKg, reps });
  store().toggleSet(setId, true);
  return { setId, workoutId: store().workout!.id };
}

beforeEach(async () => {
  useActiveWorkout.setState({ workout: null, outbox: [], lastError: null, timer: null, finishedId: null });
  await settle();
  server.reset();
});

test('Finish saves every set (e1RM included) and the workout before finish_workout, which runs once, last', async () => {
  const { setId, workoutId } = logOneSet();
  await settle();
  // as an older build saved it: no e1RM
  server.table('workout_sets').set(setId, { ...savedSet(setId), e1rm: null });

  assert.equal(await store().finish(), workoutId);
  const finishCall = server.log.findIndex((e) => e.call === 'finish_workout');
  assert.equal(calls('finish_workout').length, 1);
  assert.equal(finishCall, server.log.length - 1);
  assert.ok(server.log.findLastIndex((e) => e.table === 'workout_sets') < finishCall);
  assert.ok(server.log.findLastIndex((e) => e.table === 'workouts') < finishCall);
  assert.ok(savedSet(setId).e1rm > 100);
  assert.equal(store().workout, null);
  // finish() opens the summary itself, so nothing is handed to the Lift tab
  assert.equal(store().finishedId, null);
});

test('a Finish tapped while a save is in flight waits for it and finishes the workout', async () => {
  const { setId, workoutId } = logOneSet();
  await settle();
  server.latency = 20;
  store().updateSet(setId, { reps: 6 });
  assert.equal(store().flushing, true);

  assert.equal(await store().finish(), workoutId);
  assert.equal(calls('finish_workout').length, 1);
  assert.equal(store().workout, null);
  assert.deepEqual(store().outbox, []);
  assert.equal(savedSet(setId).reps, 6);
});

test('an offline Finish keeps the sheet open and closed to edits; Retry finishes it once, at the first finishedAt', async () => {
  const { setId, workoutId } = logOneSet();
  await settle();
  server.offline = true;

  assert.equal(await store().finish(), null);
  assert.ok(store().lastError);
  assert.equal(store().workout?.id, workoutId);
  const op = store().outbox.at(-1);
  assert.ok(op?.kind === 'finish');
  const queued = store().outbox.length;

  // edits after Finish would reach a finished workout unscored: refused
  store().updateSet(setId, { reps: 9 });
  store().rename('Changed');
  assert.equal(store().outbox.length, queued);
  assert.equal(store().workout?.name, 'Push');
  // a second Finish waits for the queued one instead of queueing another (and finished_at = null)
  assert.equal(await store().finish(), null);
  assert.equal(store().outbox.length, queued);

  server.offline = false;
  await store().flush();   // Retry now
  assert.deepEqual(store().outbox, []);
  assert.equal(store().workout, null);
  assert.equal(store().finishedId, workoutId);   // for the Lift tab to open
  assert.deepEqual(calls('finish_workout').map((e) => e.finishedAt), [op.finishedAt]);
  assert.equal(server.table('workouts').get(workoutId).finished_at, op.finishedAt);
  assert.ok(server.log.findLastIndex((e) => e.table === 'workouts') < server.log.findIndex((e) => e.call === 'finish_workout'));

  store().clearFinished();
  assert.equal(store().finishedId, null);
});

test('a Finish queued before a restart is sent by the next drain and handed to the Lift tab', async () => {
  const { workoutId } = logOneSet();
  await settle();
  server.offline = true;
  assert.equal(await store().finish(), null);
  // what persist keeps (lastError isn't kept), restored into a fresh store
  const { workout, outbox } = store();
  useActiveWorkout.setState({ workout: null, outbox: [], lastError: null, finishedId: null });
  useActiveWorkout.setState({ workout, outbox });
  server.offline = false;

  await store().flush();   // the Lift tab's drain once the workout is back
  assert.deepEqual(store().outbox, []);
  assert.equal(store().workout, null);
  assert.equal(store().finishedId, workoutId);
  assert.equal(calls('finish_workout').length, 1);
});

test('a finish_workout that fails is sent again with the same finishedAt', async () => {
  const { workoutId } = logOneSet();
  server.failFinish = 1;

  assert.equal(await store().finish(), null);
  const op = store().outbox[0];
  assert.ok(op?.kind === 'finish');
  assert.equal(store().outbox.length, 1);

  assert.equal(await store().finish(), workoutId);
  assert.deepEqual(calls('finish_workout').map((e) => e.finishedAt), [op.finishedAt]);
  assert.equal(store().workout, null);
});

test('Discard empties the queue; a save in flight then leaves the next workout\'s queue alone', async () => {
  logOneSet();
  server.latency = 20;
  store().rename('Pull');
  const discarded = store().discard();
  assert.equal(store().workout, null);
  assert.deepEqual(store().outbox, []);

  const next = store().start(UID, null, 'Legs', 82);
  await settle();
  await discarded;
  assert.equal(server.table('workouts').get(next.id)?.name, 'Legs');
});

test('an exercise mapped mid-workout passes its new facts to the block, and its sets are saved again with their e1RM', async () => {
  const { setId } = logOneSet(DIP, 20, 8);
  await settle();
  // weight mode: the added load alone
  near(savedSet(setId).e1rm, 25.3);

  store().refreshFacts([DIP_MAPPED]);
  await settle();
  const block = store().workout!.exercises[0];
  assert.deepEqual([block.slug, block.loadMode, block.bwFactor, block.isBodyweight], ['custom_weighted_dip', 'bodyweight', 1, true]);
  // bodyweight 82 kg + 20 kg
  near(savedSet(setId).e1rm, 129.2);

  // the same facts again: no change, nothing saved
  const writes = server.log.length;
  const updatedAt = store().workout!.updatedAt;
  store().refreshFacts([DIP_MAPPED, BENCH]);
  await settle();
  assert.equal(server.log.length, writes);
  assert.equal(store().workout!.updatedAt, updatedAt);
});

test('a block restored from a build before Phase 3 takes its facts from the library', async () => {
  const w = store().start(UID, null, 'Pull', 82);
  const blockId = 'b-old';
  const setId = 's-old';
  // the block as the old build persisted it: exercise id and measure only
  useActiveWorkout.setState({
    workout: {
      ...w,
      exercises: [{
        id: blockId, exerciseId: 'ex-assisted', name: 'Assisted pull-up', measure: 'weight_reps', position: 0,
        restSeconds: 90, supersetGroup: null, notes: null, updatedAt: w.startedAt,
        sets: [{
          id: setId, workoutExerciseId: blockId, exerciseId: 'ex-assisted', position: 0, setType: 'working', weightKg: 30, reps: 8,
          rpe: null, seconds: null, completed: true, completedAt: w.startedAt, notes: null, updatedAt: w.startedAt,
        }],
      }],
    },
  });

  store().refreshFacts([{ id: 'ex-assisted', name: 'Assisted pull-up', measure: 'weight_reps', slug: 'assisted_pull_up', load_mode: 'assisted', bw_factor: 1, is_unilateral: false, is_bodyweight: true }]);
  await settle();
  assert.equal(store().workout!.exercises[0].loadMode, 'assisted');
  // 82 kg less 30 kg of assistance, not the assistance alone
  near(savedSet(setId).e1rm, 65.9);
});
