/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EXERCISE_GROUPS, MUSCLE_IDS, ROLES, isMuscleId } from './library.ts';

const lib = JSON.parse(readFileSync(new URL('../../../../data/exercise_library.json', import.meta.url), 'utf8')) as {
  muscles: { id: string }[];
  exercises: { group: string; primary: string[]; secondary: string[]; tertiary: string[] }[];
};

test('the 17 muscle IDs match the library, in order', () => {
  assert.equal(MUSCLE_IDS.length, 17);
  assert.deepEqual([...MUSCLE_IDS], lib.muscles.map((m) => m.id));
});

test('every muscle an exercise names is one of the 17', () => {
  for (const e of lib.exercises) {
    for (const role of ROLES) for (const m of e[role]) assert.ok(isMuscleId(m), m);
  }
  assert.equal(isMuscleId('neck'), false);
});

test('the exercise groups match the library, in library order', () => {
  assert.deepEqual([...EXERCISE_GROUPS], [...new Set(lib.exercises.map((e) => e.group))]);
});
