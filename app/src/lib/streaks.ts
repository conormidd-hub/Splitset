import { addDays, parseISO } from 'date-fns';

import { isRun } from '@/api/activities';
import { isoDate, weekStartIso } from './dates';
import { ICONS, type IconName } from './icons';
import { formatDistance, formatDurationShort, type Units } from './units';

/**
 * Streaks, Strava style, over everything the athlete does: every activity the watch recorded
 * plus every gym workout logged in the app that the watch did not also record. Weeks run
 * Monday to Sunday like the rest of the app. Pure functions; the screens feed them rows.
 */

export type SessionKind = 'run' | 'lift' | 'ride' | 'swim' | 'walk' | 'other';

export type Session = {
  id: string;
  /** Local calendar day. */
  date: string;
  /** Local wall-clock start, for ordering within a day. */
  startedAt: string;
  kind: SessionKind;
  title: string;
  detail?: string;
  href: string;
};

/** The few columns the streak needs from an activity. */
export type ActivityLite = { id: string; start_time_local: string; type: string; name: string | null; distance_m: number | null; moving_time_s: number | null };
/** The few columns the streak needs from a finished gym workout. */
export type WorkoutLite = { id: string | null; started_at: string | null; activity_id: string | null; name: string | null; duration_s: number | null; sets_completed: number | null };

export function kindOf(type: string | null | undefined): SessionKind {
  const t = (type ?? '').toLowerCase();
  if (isRun(type)) return 'run';
  if (t === 'weighttraining' || t === 'workout') return 'lift';
  if (t.includes('ride') || t.includes('cycl') || t === 'velomobile' || t === 'handcycle') return 'ride';
  if (t.includes('swim')) return 'swim';
  if (t === 'walk' || t === 'hike') return 'walk';
  return 'other';
}

export const KIND_ICON: Record<SessionKind, IconName> = {
  run: ICONS.run,
  lift: ICONS.lift,
  ride: ICONS.ride,
  swim: ICONS.swim,
  walk: ICONS.hike,
  other: ICONS.cardio,
};

export const KIND_LABEL: Record<SessionKind, string> = { run: 'Run', lift: 'Gym', ride: 'Ride', swim: 'Swim', walk: 'Walk', other: 'Workout' };

/** Everything that counts as a workout, oldest first. A workout linked to an activity is the same session, so it shows once, as the activity. */
export function sessionsFrom(activities: readonly ActivityLite[], workouts: readonly WorkoutLite[], units: Units): Session[] {
  const out: Session[] = activities.map((a) => ({
    id: a.id,
    date: a.start_time_local.slice(0, 10),
    startedAt: a.start_time_local,
    kind: kindOf(a.type),
    title: a.name ?? KIND_LABEL[kindOf(a.type)],
    detail: a.distance_m ? `${formatDistance(a.distance_m, units)} · ${formatDurationShort(a.moving_time_s)}` : formatDurationShort(a.moving_time_s),
    href: `/run/${a.id}`,
  }));
  for (const w of workouts) {
    if (!w.id || !w.started_at || w.activity_id) continue;
    const local = new Date(w.started_at);
    out.push({
      id: w.id,
      date: isoDate(local),
      startedAt: `${isoDate(local)}T${local.toTimeString().slice(0, 8)}`,
      kind: 'lift',
      title: w.name ?? 'Workout',
      detail: [formatDurationShort(w.duration_s), w.sets_completed ? `${w.sets_completed} sets` : null].filter(Boolean).join(' · '),
      href: `/lift/history/${w.id}`,
    });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function sessionsByDay(sessions: readonly Session[]): Map<string, Session[]> {
  const m = new Map<string, Session[]>();
  for (const s of sessions) m.set(s.date, [...(m.get(s.date) ?? []), s]);
  return m;
}

/** How many sessions in the last seven days, today included. */
export function sessionsLast7(sessions: readonly Session[], today: string): number {
  const from = isoDate(addDays(parseISO(today), -6));
  return sessions.filter((s) => s.date >= from && s.date <= today).length;
}

/** Days with at least one session in the last seven (today included): the greeting's seven dashes
 *  light one per day trained, however many sessions a day held. */
export function daysTrainedLast7(sessions: readonly Session[], today: string): number {
  const from = isoDate(addDays(parseISO(today), -6));
  return new Set(sessions.filter((s) => s.date >= from && s.date <= today).map((s) => s.date)).size;
}

export type Streak = {
  /** Consecutive weeks with at least one session, counting back from this week (or last week if this one is still empty). */
  weeks: number;
  /** This week already has a session. */
  thisWeek: boolean;
  /** The streak reached the edge of the data we hold, so it may be longer. */
  capped: boolean;
};

/**
 * Strava's rule: a week counts once it has a session; the current week does not break the
 * streak until it is over. `oldest` is the first day the rows cover, so a streak that runs
 * right up to it is reported as "at least".
 */
export function weekStreak(sessions: readonly Session[], today: string, oldest?: string): Streak {
  const weeks = new Set(sessions.map((s) => weekStartIso(parseISO(s.date))));
  const thisWeek = weekStartIso(parseISO(today));
  const has = weeks.has(thisWeek);
  let cursor = has ? thisWeek : isoDate(addDays(parseISO(thisWeek), -7));
  let n = 0;
  while (weeks.has(cursor)) {
    n++;
    cursor = isoDate(addDays(parseISO(cursor), -7));
  }
  const capped = n > 0 && !!oldest && cursor < weekStartIso(parseISO(oldest));
  return { weeks: n, thisWeek: has, capped };
}

/** The weeks of the current streak, oldest first, so a calendar can number them. */
export function streakWeeks(sessions: readonly Session[], today: string): string[] {
  const weeks = new Set(sessions.map((s) => weekStartIso(parseISO(s.date))));
  const thisWeek = weekStartIso(parseISO(today));
  let cursor = weeks.has(thisWeek) ? thisWeek : isoDate(addDays(parseISO(thisWeek), -7));
  const out: string[] = [];
  while (weeks.has(cursor)) {
    out.unshift(cursor);
    cursor = isoDate(addDays(parseISO(cursor), -7));
  }
  return out;
}

/** The icon a planned session's type gets on the month grid; a rest day gets none. */
export function planKind(type: string | null | undefined): SessionKind | null {
  switch (type) {
    case 'run': return 'run';
    case 'strength': return 'lift';
    case 'ride': return 'ride';
    case 'walk': return 'walk';
    case 'rest': return null;
    default: return 'other';
  }
}

/** 0 cold, 1 one session, 2 two, 3 three or four, 4 five or six, 5 seven or more. */
export type HeatTier = 0 | 1 | 2 | 3 | 4 | 5;

export function heatTier(count: number): HeatTier {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  if (count <= 6) return 4;
  return 5;
}

/** How much of the line burns: a seventh per session, the whole line at seven. */
export function heatExtent(count: number): number {
  return Math.min(1, Math.max(0, count) / 7);
}

export const HEAT_WORDS: Record<HeatTier, string> = {
  0: 'Gone cold. One workout lights it.',
  1: 'Lit. Keep it going.',
  2: 'Catching.',
  3: 'Burning well.',
  4: 'Burning hot.',
  5: 'Ablaze. A workout every day.',
};

export type MonthCell = { date: string; inMonth: boolean };

/** The weeks of a month, Monday first, padded with the neighbouring months' days. */
export function monthGrid(year: number, month0: number): MonthCell[][] {
  const first = new Date(year, month0, 1);
  const last = new Date(year, month0 + 1, 0);
  const weeks: MonthCell[][] = [];
  let d = parseISO(weekStartIso(first));
  while (d <= last) {
    const week: MonthCell[] = [];
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) week.push({ date: isoDate(d), inMonth: d.getMonth() === month0 });
    weeks.push(week);
  }
  return weeks;
}

/** "October 2026" style keys for the months from `from` back to `to`, newest first. */
export function monthsBetween(newest: string, oldest: string): { year: number; month0: number }[] {
  const out: { year: number; month0: number }[] = [];
  const a = parseISO(newest);
  const b = parseISO(oldest);
  for (let y = a.getFullYear(), m = a.getMonth(); y > b.getFullYear() || (y === b.getFullYear() && m >= b.getMonth()); ) {
    out.push({ year: y, month0: m });
    if (m === 0) { y--; m = 11; } else m--;
  }
  return out;
}
