import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { LIST_COLUMNS, type ActivityListRow } from './activities';
import { liftKeys, type WorkoutSummary } from './lifting';
import { ODD_RIDE_TYPES, RUN_TYPES, STRENGTH_TYPES, cutPage, mergeFeed, type FeedItem, type FeedPage, type HistoryFilter } from '@/lib/history';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/** The columns a History row shows for a gym workout. */
const WORKOUT_COLUMNS = 'id, started_at, finished_at, activity_id, name, duration_s, exercises, sets_completed, volume_kg' as const;
export type HistoryWorkout = Pick<
  WorkoutSummary,
  'id' | 'started_at' | 'finished_at' | 'activity_id' | 'name' | 'duration_s' | 'exercises' | 'sets_completed' | 'volume_kg'
>;

export type HistoryItem = FeedItem<ActivityListRow, HistoryWorkout>;
type Page = FeedPage<ActivityListRow, HistoryWorkout>;

const PAGE = 40;

// Both queries sit under the workouts key, so saving or deleting a workout (which invalidates it)
// refreshes them too; a sync invalidates everything anyway.
const historyKey = (uid: string, filter: HistoryFilter) => [...liftKeys.workouts(uid), 'history', filter] as const;
const latestKey = (uid: string, n: number) => [...liftKeys.workouts(uid), 'latest', n] as const;

/** Up to `size` finished workouts from before `before`, newest first. */
async function fetchWorkouts(uid: string, before: string | null, size: number): Promise<HistoryWorkout[]> {
  let q = supabase
    .from('workout_summaries')
    .select(WORKOUT_COLUMNS)
    .eq('user_id', uid)
    .not('finished_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(size);
  if (before) q = q.lt('started_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/** Up to `size` activities from before `before`, newest first, narrowed on the server to a filter. */
async function fetchActivities(uid: string, filter: HistoryFilter, before: string | null, size: number): Promise<ActivityListRow[]> {
  let q = supabase
    .from('activities')
    .select(LIST_COLUMNS)
    .eq('user_id', uid)
    .order('start_time', { ascending: false })
    .limit(size);
  if (before) q = q.lt('start_time', before);
  if (filter === 'runs') q = q.in('type', RUN_TYPES);
  else if (filter === 'lifts') q = q.in('type', STRENGTH_TYPES);
  else if (filter === 'rides') q = q.or(`type.ilike.*ride*,type.ilike.*cycl*,type.in.(${ODD_RIDE_TYPES.join(',')})`);
  else if (filter === 'other') {
    q = q
      .not('type', 'in', `(${[...RUN_TYPES, ...STRENGTH_TYPES, ...ODD_RIDE_TYPES].join(',')})`)
      .not('type', 'ilike', '*ride*')
      .not('type', 'ilike', '*cycl*');
  }
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/**
 * One page of the feed: the activities and workouts before `before`, cut to the stretch both lists
 * cover (see cutPage). Workouts are only fetched where lifts can show.
 */
async function fetchPage(uid: string, filter: HistoryFilter, before: string | null, size: number): Promise<Page> {
  const [activities, workouts] = await Promise.all([
    fetchActivities(uid, filter, before, size),
    filter === 'all' || filter === 'lifts' ? fetchWorkouts(uid, before, size) : Promise.resolve([]),
  ]);
  return cutPage(activities, workouts, size);
}

/**
 * Every activity and gym workout, newest first, a page at a time for the History screen. Flatten
 * with historyItems(); a strength recording the sync paired with an app workout shows once.
 */
export function useHistory(filter: HistoryFilter) {
  const uid = useUserId();
  return useInfiniteQuery({
    queryKey: historyKey(uid, filter),
    enabled: !!uid,
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page) => last.next ?? undefined,
    queryFn: ({ pageParam }) => fetchPage(uid, filter, pageParam, PAGE),
  });
}

/** The loaded pages as one list. `more` is whether another page waits beyond them. */
export function historyItems(pages: readonly Page[] | undefined, more: boolean): HistoryItem[] {
  if (!pages?.length) return [];
  return mergeFeed(
    pages.flatMap((p) => p.activities),
    pages.flatMap((p) => p.workouts),
    { loadedTo: more ? pages[pages.length - 1].next : null },
  );
}

/** The newest `n` things done, for Today's Latest activity card. */
export function useLatestActivities(n = 3) {
  const uid = useUserId();
  return useQuery({
    queryKey: latestKey(uid, n),
    enabled: !!uid,
    queryFn: async (): Promise<HistoryItem[]> => {
      // a few spare, so a watch recording folded into its workout never leaves the card short
      const page = await fetchPage(uid, 'all', null, n + 5);
      return mergeFeed(page.activities, page.workouts, { loadedTo: page.next }).slice(0, n);
    },
  });
}
