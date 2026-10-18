// Drag-to-reorder arithmetic for a vertical list of items of any height (SortableList). Pure,
// so it is tested under Node.

/**
 * Where an item dragged from `from` lands, from where its middle now is, among items whose boxes
 * are `boxes` (in list order, as laid out before the drag). Pure, for the tests.
 */
export function dropSlot(boxes: readonly { y: number; height: number }[], from: number, delta: number): number {
  const b = boxes[from];
  if (!b) return from;
  const middle = b.y + b.height / 2 + delta;
  let to = 0;
  boxes.forEach((o, i) => { if (i !== from && o.y + o.height / 2 < middle) to++; });
  return to;
}

/** How far the item at `i` moves aside while the one at `from` hovers at `to`. */
export function makeRoom(i: number, from: number, to: number, size: number): number {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -size;
  if (to < from && i >= to && i < from) return size;
  return 0;
}
