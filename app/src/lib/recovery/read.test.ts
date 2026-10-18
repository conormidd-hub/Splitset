/// <reference types="node" />

// Build phase 5's read side over cache rows shaped like recovery_loads()'s: the F26 week at
// Wednesday 20:00 with its contributing exercises, past moments that never see later workouts,
// the history's sample times, and F20's session view read back from its cache.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scoreWorkout, sessionMap } from './engine.ts';
import { MUSCLE_IDS, type MuscleId } from './library.ts';
import { hoursOf, toPbHistory } from './pbHistory.ts';
import {
  isoOfHours, localDayTimes, nowWindow, readSpanHours, readWindow, recoveryHistory, recoveryMapAt, sampleTimes, sessionMapFromLoads,
  sessionView, withLiveWorkout, type LoadWindow, type RecoveryMap,
} from './read.ts';
import {
  C, EXERCISES, fixture, historyRows, iso, LIBRARY, loadWindow, MUSCLES, near, score, T0, workoutRows, type FixtureWorkout,
} from './testRows.ts';
import { thresholdsFor } from './thresholds.ts';
import type { LiftSet, Model } from './types.ts';
import { engineWorkout, libraryFromRows } from './workoutLoads.ts';

const { lib, keyOf, idOf } = libraryFromRows(EXERCISES, MUSCLES);
const M: Model = { c: C, lib };
const H0 = T0 / 3_600_000;           // fixture hour 0 in engine hours
const at = (h: number) => H0 + h;
const F26 = fixture('F26');
const F26_WORKOUTS = F26.inputs.workouts as FixtureWorkout[];
const F26_PBS = F26.inputs.history as Parameters<typeof historyRows>[0];
const F26_LOADS = loadWindow(F26_WORKOUTS, F26_PBS);
const WEDNESDAY_20 = at(68);

describe('recovery_map(user, at)', () => {
  const map = recoveryMapAt(M, keyOf, F26_LOADS, WEDNESDAY_20);

  test('F26 at Wednesday 20:00: hamstrings Very high; quads, glutes, biceps and traps High; the rest as in F26', () => {
    for (const id of ['quads', 'glutes', 'biceps', 'traps'] as const) assert.equal(map[id].label, 'High', id);
    assert.equal(map.hamstrings.label, 'Very high');
    const expect = F26.expect as Record<MuscleId, { level: number[]; F?: number[] }>;
    assert.deepEqual(Object.keys(expect).sort(), [...MUSCLE_IDS].sort());
    for (const [id, want] of Object.entries(expect) as [MuscleId, { level: number[]; F?: number[] }][]) {
      assert.equal(map[id].level, want.level[0], id);
      if (want.F) near(map[id].F, want.F[0]);
    }
  });

  test('every muscle carries the read API\'s fields', () => {
    for (const id of MUSCLE_IDS) {
      assert.deepEqual(Object.keys(map[id]).sort(),
        ['F', 'W', 'advice', 'contributing', 'fill', 'fill_dark', 'label', 'level', 'ready_in_h', 'trainable_in_h'].sort(), id);
    }
    assert.equal(map.hamstrings.fill, C.levels[4].fill);
    assert.equal(map.front_delts.fill_dark, C.ready_fill_dark);   // level 0 takes the ready colour
  });

  test('contributions are role_weight × L_e, largest first, and add up to W', () => {
    for (const id of MUSCLE_IDS) {
      const list = map[id].contributing;
      for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].load >= list[i].load, `${id} out of order`);
      assert.ok(Math.abs(list.reduce((s, x) => s + x.load, 0) - map[id].W) < 1e-9, `${id}: contributions ${list.length}, W ${map[id].W}`);
      for (const x of list) {
        const def = lib.get(keyOf.get(x.exercise_id)!)!;
        assert.ok(def[x.role].includes(id), `${x.exercise} is not ${x.role} for ${id}`);
        const le = F26_LOADS.exercises.find((e) => e.exercise_id === x.exercise_id && e.workout_id === x.workout_id)!.load;
        assert.equal(x.load, C.role_weights[x.role] * le);
      }
    }
    const [top] = map.hamstrings.contributing;
    assert.deepEqual([top.exercise, top.role, top.pb_source, top.workout_date], ['Romanian deadlift (barbell)', 'primary', 'monthly', iso(66)]);
    // Monday's push day still counts towards chest's week, though its fatigue has nearly gone
    assert.ok(map.chest.contributing.some((x) => x.workout_date === iso(18)));
  });

  test('a past moment only sees the workouts finished by then, ready times included', () => {
    const monday = recoveryMapAt(M, keyOf, F26_LOADS, at(0));
    for (const id of MUSCLE_IDS) {
      assert.deepEqual([monday[id].level, monday[id].F, monday[id].ready_in_h, monday[id].contributing.length], [0, 0, 0, 0], id);
    }
    // Wednesday 17:30, before Legs finished at 18:00: the same as if Legs had never happened
    const beforeLegs = recoveryMapAt(M, keyOf, F26_LOADS, at(65.5));
    const withoutLegs = recoveryMapAt(M, keyOf, loadWindow(F26_WORKOUTS.slice(0, 2), F26_PBS), at(65.5));
    assert.deepEqual(stripIds(beforeLegs), stripIds(withoutLegs));
    assert.ok(beforeLegs.hamstrings.level < map.hamstrings.level);
  });

  test('reads (at − lookback − 168 h, at]: older rows and rows after `at` change nothing', () => {
    const span = readSpanHours(M);
    assert.equal(span, 144 + 168);
    const old = { muscle_id: 'hamstrings', load: 50, recovery_hours: 10_000, finished_at: isoOfHours(WEDNESDAY_20 - span), workout_id: 'old' };
    const later = { ...old, finished_at: isoOfHours(WEDNESDAY_20 + 0.25), workout_id: 'later' };
    const padded = { ...F26_LOADS, muscles: [...F26_LOADS.muscles, old, later] };
    assert.deepEqual(recoveryMapAt(M, keyOf, padded, WEDNESDAY_20), map);
  });

  test('a role weighted 0 lists nothing: a muscle with no weekly load says so', () => {
    const m: Model = { c: thresholdsFor(C, 'me', [{ user_id: 'me', key: 'role_weights.tertiary', value: 0 }]), lib };
    const zero = recoveryMapAt(m, keyOf, F26_LOADS, WEDNESDAY_20);
    for (const id of MUSCLE_IDS) {
      assert.ok(zero[id].contributing.every((x) => x.load > 0 && x.role !== 'tertiary'), id);
      if (zero[id].W === 0) assert.deepEqual(zero[id].contributing, [], id);
    }
    // F26's week only reaches abs as a tertiary muscle
    assert.ok(map.abs.contributing.length > 0);
    assert.deepEqual(zero.abs.contributing, []);
  });
});

describe('the map at now', () => {
  const HOUR = 3_600_000;
  const minute = T0 + 18 * HOUR + 42 * 60_000;   // Monday 18:42:00
  const c96: Model = { c: thresholdsFor(C, 'me', [{ user_id: 'me', key: 'base_recovery_hours.default', value: 96 }]), lib };

  test('a workout finished seconds ago, in the current minute, already counts', () => {
    const w = nowWindow(M, minute);
    const loads: LoadWindow = {
      muscles: [{ muscle_id: 'chest', load: 1, recovery_hours: 48, finished_at: new Date(minute + 40_000).toISOString(), workout_id: 'x' }],
      exercises: [],
    };
    assert.ok(hoursOf(loads.muscles[0].finished_at) > w.from);
    assert.ok(recoveryMapAt(M, keyOf, loads, w.at).chest.F > 0);
  });

  test('its rows reach back past the map\'s window at every minute of the hour, and start on the same hour all hour', () => {
    for (const m of [M, c96]) {
      const hour = Math.floor(minute / HOUR) * HOUR;
      const froms = new Set<number>();
      for (let k = 0; k < 60; k++) {
        const w = nowWindow(m, hour + k * 60_000);
        assert.ok(w.from <= readWindow(m, w.at).from, `minute ${k}`);
        assert.ok(w.at > (hour + k * 60_000) / HOUR);
        froms.add(w.from);
      }
      assert.equal(froms.size, 1);   // so the query key holds for the hour
      assert.equal(nowWindow(m, hour).from, hour / HOUR - readSpanHours(m) - 1);
    }
    assert.equal(readSpanHours(c96), 192 + 168);
  });
});

/** Workout ids differ between two scorings of the same workouts. */
function stripIds(map: RecoveryMap) {
  return Object.fromEntries(MUSCLE_IDS.map((id) => [id, { ...map[id], contributing: map[id].contributing.map(({ workout_id: _, ...x }) => x) }]));
}

describe('recovery_history(user, from, to, step)', () => {
  test('seven days at 24 h is seven samples, ending exactly at `to`', () => {
    const samples = recoveryHistory(M, keyOf, F26_LOADS, WEDNESDAY_20 - 168, WEDNESDAY_20);
    assert.equal(samples.length, 7);
    assert.deepEqual(samples.map((s) => s.at), [144, 120, 96, 72, 48, 24, 0].map((d) => iso(68 - d)));
    assert.deepEqual(samples[6].map, recoveryMapAt(M, keyOf, F26_LOADS, WEDNESDAY_20));
    assert.equal(samples[0].map.chest.level, 0);   // Wednesday a week earlier: nothing yet
  });

  test('sample times', () => {
    assert.equal(sampleTimes(0, 168, 12).length, 14);
    assert.deepEqual(sampleTimes(0, 50, 24), [2, 26, 50]);
    assert.deepEqual(sampleTimes(10, 10, 24), []);
    assert.throws(() => sampleTimes(0, 24, 0), /positive/);
    assert.throws(() => sampleTimes(0, 24 * 2000, 1), /more than/);
  });

  describe('a sample per local date, across DST changes', () => {
    const H = (s: string) => Date.parse(s) / 3_600_000;
    /** "YYYY-MM-DD HH:mm" on the zone's wall clock. */
    const wall = (h: number, timeZone: string) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date(h * 3_600_000)).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    };
    const dates = (first: string, n: number) =>
      Array.from({ length: n }, (_, k) => new Date(Date.parse(`${first}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10));

    test('Melbourne, on summer time from 4 Oct: every date from 21 Sep to 18 Oct at midnight, 4 Oct included', () => {
      const to = H('2026-10-17T13:00:00Z');   // Sun 18 Oct 00:00 AEDT
      const times = localDayTimes(to - 28 * 24, to, 'Australia/Melbourne');
      assert.equal(times.length, 28);
      assert.equal(times[27], to);
      assert.deepEqual(times.map((t) => wall(t, 'Australia/Melbourne')), dates('2026-09-21', 28).map((d) => `${d} 00:00`));
      // plain 24 h steps skip 4 Oct
      assert.ok(!sampleTimes(to - 28 * 24, to, 24).some((t) => wall(t, 'Australia/Melbourne').startsWith('2026-10-04')));
    });

    test('Dublin, back on GMT from 25 Oct: every date from 6 Oct to 2 Nov at 23:00, 25 Oct once', () => {
      const to = H('2026-11-02T23:00:00Z');   // Mon 2 Nov 23:00 GMT
      const times = localDayTimes(to - 28 * 24, to, 'Europe/Dublin');
      assert.deepEqual(times.map((t) => wall(t, 'Europe/Dublin')), dates('2026-10-06', 28).map((d) => `${d} 23:00`));
    });

    test('a time a spring-forward date skips moves past the gap, on the same date', () => {
      // Havana jumps from 00:00 to 01:00 on 8 Mar 2026
      const to = H('2026-03-20T04:30:00Z');   // Fri 20 Mar 00:30 CDT
      const shown = localDayTimes(to - 28 * 24, to, 'America/Havana').map((t) => wall(t, 'America/Havana'));
      assert.deepEqual(shown.map((s) => s.slice(0, 10)), dates('2026-02-21', 28));
      assert.equal(shown.find((s) => s.startsWith('2026-03-08')), '2026-03-08 01:30');
      assert.ok(shown.filter((s) => !s.startsWith('2026-03-08')).every((s) => s.endsWith(' 00:30')));
    });

    test('with no DST change it is plain 24 h steps; an unknown zone reads as the device\'s', () => {
      const to = WEDNESDAY_20;
      assert.deepEqual(localDayTimes(to - 28 * 24, to, 'UTC'), sampleTimes(to - 28 * 24, to, 24));
      assert.deepEqual(localDayTimes(to - 28 * 24, to, 'Not/A_Zone'), localDayTimes(to - 28 * 24, to, null));
    });
  });
});

describe('the workout in progress on the recovery view', () => {
  const f20 = fixture('F20');
  const exercises = f20.inputs.exercises as FixtureWorkout['exercises'];
  const NOW = at(0);
  const nameOf = (id: string) => LIBRARY.find((e) => `id-${e.slug}` === id)!.name;
  const live = workoutRows('live', { start: -1, end: 0, exercises }, false);
  const history = toPbHistory(historyRows(f20.inputs.history as never), (id) => keyOf.get(id));
  const scored = scoreWorkout(M, engineWorkout(live.workout, live.blocks, live.sets, keyOf, NOW), history, null);
  const finished = loadWindow([{ start: -1, end: 0, exercises }], f20.inputs.history as never);   // as workout w0

  test('its ticked sets count with t_w = now: the same map as if it had just finished', () => {
    const map = recoveryMapAt(M, keyOf, withLiveWorkout({ muscles: [], exercises: [] }, 'live', scored, idOf, nameOf, NOW), NOW);
    assert.deepEqual(stripIds(map), stripIds(recoveryMapAt(M, keyOf, finished, NOW)));
    assert.ok(map.chest.level > 0);
    assert.ok(map.chest.contributing.length > 0);
    assert.ok(map.chest.contributing.every((x) => x.workout_id === 'live' && x.workout_date === isoOfHours(NOW)));
  });

  test('once Finish has cached it, it is not counted twice', () => {
    assert.equal(withLiveWorkout(finished, 'w0', scored, idOf, nameOf, NOW), finished);
  });

  test('a Finish queued offline keeps its t_w: read later, it decays as if cached at that time', () => {
    const later = NOW + 20;
    const map = recoveryMapAt(M, keyOf, withLiveWorkout({ muscles: [], exercises: [] }, 'live', scored, idOf, nameOf, NOW), later);
    assert.deepEqual(stripIds(map), stripIds(recoveryMapAt(M, keyOf, finished, later)));
    const peak = recoveryMapAt(M, keyOf, finished, NOW);
    assert.ok(map.chest.F < peak.chest.F);
    assert.ok(map.chest.trainable_in_h! < peak.chest.trainable_in_h!);
  });
});

describe('session_map(workout)', () => {
  test('F20 read back from its cache rows: levels, R, trainable and ready after, as the engine gives them', () => {
    const f = fixture('F20');
    const push = workoutRows('push', { start: -1, end: 0, exercises: f.inputs.exercises as [string, LiftSet[]][] });
    const [loads] = score([push], historyRows(f.inputs.history as never));
    const session = sessionMapFromLoads(M, loads.muscles);

    const expect = f.expect as { level: Record<MuscleId, number>; R: Record<MuscleId, number>;
      ready_in_h: Record<MuscleId, number>; trainable_in_h: Record<MuscleId, number> };
    for (const [id, want] of Object.entries(expect.level) as [MuscleId, number][]) assert.equal(session[id].level, want, id);
    for (const [id, want] of Object.entries(expect.R) as [MuscleId, number][]) near(session[id].R, want);
    for (const [id, want] of Object.entries(expect.ready_in_h) as [MuscleId, number][]) near(session[id].ready_after_h, want);
    for (const [id, want] of Object.entries(expect.trainable_in_h) as [MuscleId, number][]) near(session[id].trainable_after_h, want);
    assert.equal(session.chest.label, 'High');

    const history = toPbHistory(historyRows(f.inputs.history as never), (id) => keyOf.get(id));
    const scored = scoreWorkout(M, engineWorkout(push.workout, push.blocks, push.sets, keyOf), history, null);
    assert.deepEqual(session, sessionView(sessionMap(M, scored)));
  });

  test('a workout with no cache rows is all Ready', () => {
    const session = sessionMapFromLoads(M, []);
    for (const id of MUSCLE_IDS) assert.deepEqual([session[id].L, session[id].level, session[id].ready_after_h], [0, 0, 0], id);
  });
});
