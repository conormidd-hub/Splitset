/** Query keys, one place, so invalidation never guesses at strings. */
export const keys = {
  profile: (uid: string) => ['profile', uid] as const,
  connection: (uid: string) => ['connection', uid] as const,
  syncRuns: (uid: string) => ['syncRuns', uid] as const,
  activities: (uid: string, filter: string) => ['activities', uid, filter] as const,
  activity: (id: string) => ['activity', id] as const,
  recentActivities: (uid: string, days: number) => ['recentActivities', uid, days] as const,
  runRoutes: (uid: string) => ['runRoutes', uid] as const,
  wellness: (uid: string, days: number) => ['wellness', uid, days] as const,
  latestWeighIn: (uid: string) => ['latestWeighIn', uid] as const,
  segments: (uid: string) => ['segments', uid] as const,
  segment: (id: string) => ['segment', id] as const,
  segmentEfforts: (segmentId: string) => ['segmentEfforts', segmentId] as const,
  runEfforts: (activityId: string) => ['runEfforts', activityId] as const,
  allEfforts: (uid: string) => ['allEfforts', uid] as const,
  track: (activityId: string) => ['track', activityId] as const,
  routes: (uid: string) => ['routes', uid] as const,
  route: (id: string) => ['route', id] as const,
  routeHeights: (id: string) => ['routeHeights', id] as const,
  /** A drawn course by its waypoints: the routed legs between them. */
  course: (waypoints: [number, number][]) => ['course', waypoints] as const,
  /** Address search results for a query near a point (rounded, so a pan does not refetch). */
  placeSearch: (q: string, near: string) => ['placeSearch', q, near] as const,
  /** Cafés inside a box, keyed by the box snapped to a grid. */
  cafes: (box: string) => ['cafes', box] as const,
  sessions: (uid: string) => ['sessions', uid] as const,
};
