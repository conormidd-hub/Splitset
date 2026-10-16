/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterExercises } from './exerciseSearch.ts';

const rows = [
  { name: 'Romanian deadlift (barbell)', slug: 'rdl_bb', group: 'Legs', muscle_group: 'hamstrings' },
  { name: 'Romanian deadlift (dumbbell)', slug: 'rdl_db', group: 'Legs', muscle_group: 'hamstrings' },
  { name: 'Bench press (barbell)', slug: 'bench_press_bb', group: 'Chest', muscle_group: 'chest' },
  { name: 'Wrist curl', slug: 'wrist_curl', group: 'Arms', muscle_group: null },
  { name: 'Foam roll', slug: null, group: null, muscle_group: 'mobility' },
  { name: 'My drag curl', slug: null, group: null, muscle_group: 'biceps' },
];
const names = (r: { name: string }[]) => r.map((x) => x.name);

test('no query and no group: everything', () => {
  assert.equal(filterExercises(rows, '', null).length, rows.length);
});

test('a group keeps only that group; unscored rows only show under All', () => {
  assert.deepEqual(names(filterExercises(rows, '', 'Legs')), ['Romanian deadlift (barbell)', 'Romanian deadlift (dumbbell)']);
  assert.deepEqual(filterExercises(rows, '', 'Core'), []);
});

test('the query matches name, slug, group and muscle group, ignoring case', () => {
  assert.deepEqual(names(filterExercises(rows, 'RDL', null)), ['Romanian deadlift (barbell)', 'Romanian deadlift (dumbbell)']);
  assert.deepEqual(names(filterExercises(rows, 'bench', null)), ['Bench press (barbell)']);
  assert.deepEqual(names(filterExercises(rows, 'arms', null)), ['Wrist curl']);
  assert.deepEqual(names(filterExercises(rows, 'mobility', null)), ['Foam roll']);
  assert.deepEqual(names(filterExercises(rows, '  curl ', null)), ['Wrist curl', 'My drag curl']);
});

test('query and group together', () => {
  assert.deepEqual(names(filterExercises(rows, 'curl', 'Arms')), ['Wrist curl']);
  assert.deepEqual(filterExercises(rows, 'bench', 'Legs'), []);
});

test('returns a new array, so callers may sort it', () => {
  assert.notEqual(filterExercises(rows, '', null), rows);
});
