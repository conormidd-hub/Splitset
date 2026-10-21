import assert from 'node:assert/strict';
import { test } from 'node:test';

import { awayMinutes, elapsedSeconds, formatElapsed, IDLE_MS, idleAt, shouldPause } from './elapsed.ts';

const T0 = Date.parse('2026-10-21T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

test('elapsed counts from the start, and holds while paused', () => {
  const w = { startedAt: at(0) };
  assert.equal(elapsedSeconds(w, T0 + 90_000), 90);
  assert.equal(elapsedSeconds({ ...w, pausedAt: at(60_000) }, T0 + 5 * 60_000), 60);
});

test('time spent in earlier pauses is taken out', () => {
  const w = { startedAt: at(0), pausedS: 120 };
  assert.equal(elapsedSeconds(w, T0 + 10 * 60_000), 8 * 60);
  // paused again: holds at the pause, less the earlier pauses
  assert.equal(elapsedSeconds({ ...w, pausedAt: at(10 * 60_000) }, T0 + 30 * 60_000), 8 * 60);
  // never below zero, whatever the bookkeeping says
  assert.equal(elapsedSeconds({ startedAt: at(0), pausedS: 500 }, T0 + 1000), 0);
});

test('formatElapsed is m:ss under an hour, h:mm:ss past it', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(65), '1:05');
  assert.equal(formatElapsed(3725), '1:02:05');
});

test('the clock pauses ten minutes after the last edit, or after the start with no edits', () => {
  const started = { startedAt: at(0) };
  assert.equal(idleAt(started), T0 + IDLE_MS);
  assert.equal(shouldPause(started, T0 + IDLE_MS - 1), false);
  assert.equal(shouldPause(started, T0 + IDLE_MS), true);
  const edited = { ...started, lastActiveAt: at(4 * 60_000) };
  assert.equal(shouldPause(edited, T0 + IDLE_MS), false);
  assert.equal(shouldPause(edited, T0 + 14 * 60_000), true);
  // already paused: nothing to do
  assert.equal(shouldPause({ ...edited, pausedAt: at(14 * 60_000) }, T0 + 60 * 60_000), false);
});

test('awayMinutes is whole minutes since the last edit', () => {
  const w = { startedAt: at(0), lastActiveAt: at(60_000) };
  assert.equal(awayMinutes(w, T0 + 60_000 + 14 * 60_000 + 59_000), 14);
  assert.equal(awayMinutes(w, T0), 0);
});
