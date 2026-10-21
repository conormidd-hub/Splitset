// Supersets: exercises sharing a superset_group number alternate set for set. Pure, so it is
// tested under Node; the workout store, the routine draft and both editors use it.

export type Grouped = { supersetGroup: number | null };

export type GroupItem<B extends Grouped> = {
  /** A stable key: the group's number, or the lone block's own key. */
  key: string;
  group: number | null;
  blocks: B[];
};

/**
 * The list as the screen draws it: a run of neighbouring exercises in the same superset is one
 * item (drawn joined, dragged together); everything else is an item of its own. Members that
 * are not neighbours (a routine built elsewhere) stay separate items with the same tag.
 */
export function groupItems<B extends Grouped>(blocks: readonly B[], keyOf: (b: B) => string): GroupItem<B>[] {
  const out: GroupItem<B>[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.supersetGroup != null && last && last.group === b.supersetGroup) last.blocks.push(b);
    else out.push({ key: b.supersetGroup != null ? `superset:${b.supersetGroup}` : keyOf(b), group: b.supersetGroup, blocks: [b] });
  }
  // two runs of one group (not neighbours) must not share a key
  const seen = new Map<string, number>();
  for (const item of out) {
    const n = seen.get(item.key) ?? 0;
    seen.set(item.key, n + 1);
    if (n) item.key = `${item.key}#${n}`;
  }
  return out;
}

/** "A", "B", "C"… for a group, by the order groups first appear in the list. */
export function groupLetter<B extends Grouped>(blocks: readonly B[], group: number): string {
  const order: number[] = [];
  for (const b of blocks) if (b.supersetGroup != null && !order.includes(b.supersetGroup)) order.push(b.supersetGroup);
  const i = order.indexOf(group);
  return i < 0 ? '' : String.fromCharCode(65 + (i % 26));
}

/**
 * Link `id` into a superset with `partnerId`: the partner's group, or a new one for a pair. The
 * linked exercise moves to sit right after the group's last member, unless it is already its
 * neighbour (just before the group), so the pair reads as one block. Returns the new order.
 */
export function linkSuperset<B extends Grouped>(blocks: readonly B[], id: string, partnerId: string, keyOf: (b: B) => string): B[] {
  const me = blocks.find((b) => keyOf(b) === id);
  const partner = blocks.find((b) => keyOf(b) === partnerId);
  if (!me || !partner || me === partner) return [...blocks];
  const group = partner.supersetGroup ?? me.supersetGroup ?? nextGroup(blocks);
  const withGroup = blocks.map((b) => (b === me || b === partner ? { ...b, supersetGroup: group } : b));
  const i = withGroup.findIndex((b) => keyOf(b) === id);
  // already just before the group's first member: leave the order alone
  const next = withGroup[i + 1];
  if (next && next.supersetGroup === group && (i === 0 || withGroup[i - 1]?.supersetGroup !== group)) return withGroup;
  const rest = withGroup.filter((b) => keyOf(b) !== id);
  let after = -1;
  rest.forEach((b, j) => { if (b.supersetGroup === group) after = j; });
  rest.splice(after + 1, 0, withGroup[i]);
  return rest;
}

/** Take `id` out of its superset. A group left with one member is no superset, so it is cleared too. */
export function unlinkSuperset<B extends Grouped>(blocks: readonly B[], id: string, keyOf: (b: B) => string): B[] {
  const me = blocks.find((b) => keyOf(b) === id);
  if (!me || me.supersetGroup == null) return [...blocks];
  const group = me.supersetGroup;
  const out = blocks.map((b) => (b === me ? { ...b, supersetGroup: null } : b));
  const left = out.filter((b) => b.supersetGroup === group);
  return left.length < 2 ? out.map((b) => (b.supersetGroup === group ? { ...b, supersetGroup: null } : b)) : out;
}

function nextGroup(blocks: readonly Grouped[]): number {
  return blocks.reduce((m, b) => Math.max(m, b.supersetGroup ?? 0), 0) + 1;
}

/**
 * Whose set is next in a superset: the member with the fewest ticked sets, the earliest on a tie
 * (A then B then A…). Null once every member has ticked every set.
 */
export function turnIn<B extends { sets: readonly { completed: boolean }[] }>(members: readonly B[]): number | null {
  let turn: number | null = null;
  let fewest = Infinity;
  members.forEach((b, i) => {
    if (!b.sets.some((s) => !s.completed)) return;
    const done = b.sets.filter((s) => s.completed).length;
    if (done < fewest) { fewest = done; turn = i; }
  });
  return turn;
}
