import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dropSlot, makeRoom } from './sortable.ts';

// three cards of different heights with a 16 pt gap: 0-300, 316-416, 432-832
const boxes = [{ y: 0, height: 300 }, { y: 316, height: 100 }, { y: 432, height: 400 }];

test('a dragged card lands where its middle is', () => {
  assert.equal(dropSlot(boxes, 0, 0), 0);            // not moved
  assert.equal(dropSlot(boxes, 0, 220), 1);          // middle 370, past the short card's middle (366)
  assert.equal(dropSlot(boxes, 0, 500), 2);          // middle 650, past the tall card's middle (632)
  assert.equal(dropSlot(boxes, 2, -300), 1);         // middle 332: above the tall card's place, below the first
  assert.equal(dropSlot(boxes, 2, -600), 0);
  assert.equal(dropSlot(boxes, 1, 0), 1);
  assert.equal(dropSlot(boxes, 7, 50), 7);           // unknown item stays put
});

test('the cards in between slide aside by the dragged card and its gap', () => {
  // the first card (300 + 16) heading for the end: the other two slide up
  assert.deepEqual([0, 1, 2].map((i) => makeRoom(i, 0, 2, 316)), [0, -316, -316]);
  // the last card (400 + 16) heading for the top: the other two slide down
  assert.deepEqual([0, 1, 2].map((i) => makeRoom(i, 2, 0, 416)), [416, 416, 0]);
  // hovering at its own place: nothing moves
  assert.deepEqual([0, 1, 2].map((i) => makeRoom(i, 1, 1, 116)), [0, 0, 0]);
});
