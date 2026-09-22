/** Query keys, one place, so invalidation never guesses at strings. */
export const keys = {
  profile: (uid: string) => ['profile', uid] as const,
  connection: (uid: string) => ['connection', uid] as const,
  syncRuns: (uid: string) => ['syncRuns', uid] as const,
  activities: (uid: string, filter: string) => ['activities', uid, filter] as const,
  activity: (id: string) => ['activity', id] as const,
  recentActivities: (uid: string, days: number) => ['recentActivities', uid, days] as const,
  wellness: (uid: string, days: number) => ['wellness', uid, days] as const,
};
