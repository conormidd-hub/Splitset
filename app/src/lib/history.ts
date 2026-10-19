/**
 * Everything the athlete has done as one list, newest first: every activity the watch synced and
 * every gym workout logged in the app. A strength session recorded twice (the watch's
 * WeightTraining beside the app's own workout) shows once, as the app workout, since that is the
 * one with the sets in it. Pure functions; the Today card and the History screen feed them rows.
 */

export type Sport = 'run' | 'ride' | 'lift' | 'swim' | 'walk' | 'hike' | 'other';
export type HistoryFilter = 'all' | 'runs' | 'lifts' | 'rides' | 'other';

/** The same list as api/activities (which this file cannot import and stay runnable under node --test). */
export const RUN_TYPES = ['Run', 'VirtualRun', 'TrailRun'] as const;
/** What the watch calls a gym session; the sync links these to app workouts. */
export const STRENGTH_TYPES = ['WeightTraining', 'Workout'] as const;
/** Cycling types whose names say neither "ride" nor "cycl". */
export const ODD_RIDE_TYPES = ['Velomobile', 'Handcycle'] as const;

/** A watch strength recording starting this close to an app workout is the same session. */
export const SAME_SESSION_MS = 45 * 60_000;
/** The sync links a watch recording to an app workout started up to two hours either side. */
export const LINK_WINDOW_MS = 2 * 60 * 60_000;

export function sportOf(type: string | null | undefined): Sport {
  const t = (type ?? '').toLowerCase();
  if ((RUN_TYPES as readonly string[]).includes(type ?? '')) return 'run';
  if (t === 'weighttraining' || t === 'workout') return 'lift';
  if (t.includes('ride') || t.includes('cycl') || t === 'velomobile' || t === 'handcycle') return 'ride';
  if (t.includes('swim')) return 'swim';
  if (t === 'walk') return 'walk';
  if (t === 'hike') return 'hike';
  return 'other';
}

/** Whether a sport belongs under a History filter chip. Other is everything but runs, rides and lifts. */
export function inFilter(sport: Sport, filter: HistoryFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'runs': return sport === 'run';
    case 'lifts': return sport === 'lift';
    case 'rides': return sport === 'ride';
    case 'other': return sport !== 'run' && sport !== 'ride' && sport !== 'lift';
  }
}

/** The few columns the feed needs from an activity (start_time is absolute, start_time_local the wall clock). */
export type FeedActivity = { id: string; start_time: string; start_time_local: string; type: string };
/** The few columns the feed needs from a finished gym workout. */
export type FeedWorkout = { id: string | null; started_at: string | null; activity_id: string | null };

type Base = {
  /** Unique across both kinds, for list keys. */
  key: string;
  id: string;
  /** Epoch ms, for ordering the two kinds against each other. */
  at: number;
  /** Local wall clock, "2026-10-18T07:30:00": what the date helpers format and months group by. */
  when: string;
};

export type FeedItem<A extends FeedActivity = FeedActivity, W extends FeedWorkout = FeedWorkout> =
  | (Base & { kind: 'activity'; sport: Sport; activity: A })
  | (Base & { kind: 'workout'; sport: 'lift'; workout: W });

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A timestamp as local wall clock with no offset. Activities already carry theirs
 * (start_time_local); a workout's started_at is UTC and becomes this device's local time.
 */
export function localStamp(iso: string): string {
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(iso)) return iso.slice(0, 19);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Activities and workouts as one newest-first list. An activity is left out when an app workout
 * is linked to it, or when it is a strength recording starting within SAME_SESSION_MS of an app
 * workout. `loadedTo` is how far back both lists are complete (the next page's cursor, or null
 * once they reach the start): a strength recording within LINK_WINDOW_MS of it waits, since the
 * workout it belongs to may be on the next page.
 */
export function mergeFeed<A extends FeedActivity, W extends FeedWorkout>(
  activities: readonly A[],
  workouts: readonly W[],
  { loadedTo = null }: { loadedTo?: string | null } = {},
): FeedItem<A, W>[] {
  const out: FeedItem<A, W>[] = [];
  const linked = new Set<string>();
  const workoutTimes: number[] = [];
  const seen = new Set<string>();
  for (const w of workouts) {
    if (!w.id || !w.started_at || seen.has(`w:${w.id}`)) continue;
    seen.add(`w:${w.id}`);
    const at = Date.parse(w.started_at);
    if (Number.isNaN(at)) continue;
    if (w.activity_id) linked.add(w.activity_id);
    workoutTimes.push(at);
    out.push({ kind: 'workout', key: `w:${w.id}`, id: w.id, at, when: localStamp(w.started_at), sport: 'lift', workout: w });
  }
  const edge = loadedTo ? Date.parse(loadedTo) : NaN;
  for (const a of activities) {
    if (seen.has(`a:${a.id}`) || linked.has(a.id)) continue;
    seen.add(`a:${a.id}`);
    const at = Date.parse(a.start_time);
    if (Number.isNaN(at)) continue;
    const sport = sportOf(a.type);
    if (sport === 'lift') {
      if (workoutTimes.some((t) => Math.abs(t - at) <= SAME_SESSION_MS)) continue;
      if (!Number.isNaN(edge) && at - edge < LINK_WINDOW_MS) continue;
    }
    out.push({ kind: 'activity', key: `a:${a.id}`, id: a.id, at, when: a.start_time_local.slice(0, 19), sport, activity: a });
  }
  return out.sort((x, y) => y.at - x.at || x.key.localeCompare(y.key));
}

export type FeedPage<A, W> = {
  activities: A[];
  workouts: W[];
  /** Fetch the next page from strictly before this timestamp; null when both lists are done. */
  next: string | null;
};

/**
 * One page of the History feed, from the newest `size` activities and `size` workouts before the
 * last page's cursor (each list newest first). Whichever list ran to its limit sets how far back
 * this page can be trusted: anything older than its last row is dropped here and fetched again
 * with the next page, so interleaving the two lists never leaves a gap.
 */
export function cutPage<A extends FeedActivity, W extends FeedWorkout>(activities: A[], workouts: W[], size: number): FeedPage<A, W> {
  const edges: { at: number; raw: string }[] = [];
  const lastA = activities[activities.length - 1];
  if (activities.length >= size && lastA) edges.push({ at: Date.parse(lastA.start_time), raw: lastA.start_time });
  const lastW = workouts[workouts.length - 1];
  if (workouts.length >= size && lastW?.started_at) edges.push({ at: Date.parse(lastW.started_at), raw: lastW.started_at });
  if (!edges.length) return { activities, workouts, next: null };
  // the more recent of the two edges: above it both lists are complete
  const edge = edges.reduce((best, e) => (e.at > best.at ? e : best));
  return {
    activities: activities.filter((a) => Date.parse(a.start_time) >= edge.at),
    workouts: workouts.filter((w) => !!w.started_at && Date.parse(w.started_at) >= edge.at),
    next: edge.raw,
  };
}

/**
 * Feed items in calendar months, in the order they come: "2026-10" and that month's items. A month
 * is one section even if a clock change shuffles a row across its edge.
 */
export function byMonth<I extends { when: string }>(items: readonly I[]): { month: string; items: I[] }[] {
  const out = new Map<string, I[]>();
  for (const it of items) {
    const month = it.when.slice(0, 7);
    const list = out.get(month);
    if (list) list.push(it);
    else out.set(month, [it]);
  }
  return [...out].map(([month, list]) => ({ month, items: list }));
}
