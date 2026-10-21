import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupItems, groupLetter, linkSuperset, turnIn, unlinkSuperset } from './superset.ts';

type B = { id: string; supersetGroup: number | null };
const b = (id: string, supersetGroup: number | null = null): B => ({ id, supersetGroup });
const keyOf = (x: B) => x.id;
const ids = (xs: readonly B[]) => xs.map((x) => `${x.id}${x.supersetGroup == null ? '' : `/${x.supersetGroup}`}`).join(' ');

test('neighbouring members of a group draw as one item; the rest stand alone', () => {
  const items = groupItems([b('a'), b('b', 1), b('c', 1), b('d'), b('e', 2)], keyOf);
  assert.deepEqual(items.map((i) => [i.key, i.blocks.map((x) => x.id)]), [
    ['a', ['a']], ['superset:1', ['b', 'c']], ['d', ['d']], ['superset:2', ['e']],
  ]);
});

test('two runs of one group that are not neighbours get distinct keys', () => {
  const items = groupItems([b('a', 1), b('x'), b('c', 1)], keyOf);
  assert.deepEqual(items.map((i) => i.key), ['superset:1', 'x', 'superset:1#1']);
});

test('groups are lettered in the order they first appear', () => {
  const list = [b('a', 7), b('b'), b('c', 3), b('d', 7)];
  assert.equal(groupLetter(list, 7), 'A');
  assert.equal(groupLetter(list, 3), 'B');
  assert.equal(groupLetter(list, 9), '');
});

test('linking makes a new pair and moves the linked exercise next to its partner', () => {
  // d links with b: both take group 1, d moves to sit after b
  assert.equal(ids(linkSuperset([b('a'), b('b'), b('c'), b('d')], 'd', 'b', keyOf)), 'a b/1 d/1 c');
  // linking with the exercise right after: already neighbours, order kept
  assert.equal(ids(linkSuperset([b('a'), b('b'), b('c')], 'a', 'b', keyOf)), 'a/1 b/1 c');
  // joining an existing group puts the newcomer after its last member
  assert.equal(ids(linkSuperset([b('a', 1), b('b', 1), b('c'), b('d')], 'd', 'a', keyOf)), 'a/1 b/1 d/1 c');
  // a new group takes the next free number
  assert.equal(ids(linkSuperset([b('a', 1), b('b', 1), b('c'), b('d')], 'c', 'd', keyOf)), 'a/1 b/1 c/2 d/2');
});

test('unlinking clears a pair; a bigger group keeps the rest', () => {
  assert.equal(ids(unlinkSuperset([b('a', 1), b('b', 1), b('c')], 'a', keyOf)), 'a b c');
  assert.equal(ids(unlinkSuperset([b('a', 1), b('b', 1), b('c', 1)], 'a', keyOf)), 'a b/1 c/1');
  assert.equal(ids(unlinkSuperset([b('a'), b('b')], 'a', keyOf)), 'a b');
});

test('the turn goes to the member with the fewest ticked sets, earliest on a tie', () => {
  const sets = (...done: boolean[]) => ({ sets: done.map((completed) => ({ completed })) });
  assert.equal(turnIn([sets(false, false), sets(false, false)]), 0);
  assert.equal(turnIn([sets(true, false), sets(false, false)]), 1);
  assert.equal(turnIn([sets(true, false), sets(true, false)]), 0);
  // a member that has finished every set is skipped
  assert.equal(turnIn([sets(true, true), sets(true, false)]), 1);
  assert.equal(turnIn([sets(true), sets(true)]), null);
});
