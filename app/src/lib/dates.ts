import { differenceInCalendarDays, format, isValid, parseISO, startOfWeek, subDays } from 'date-fns';

/** Parse an ISO string (with or without offset) into a Date, or null. */
export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = parseISO(iso);
  return isValid(d) ? d : null;
}

/** "2026-09-22" for a Date in the device's local time. */
export function isoDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export function todayIso(): string {
  return isoDate(new Date());
}

export function daysAgoIso(days: number): string {
  return isoDate(subDays(new Date(), days));
}

/** Monday-based week start as an ISO date. */
export function weekStartIso(d: Date = new Date()): string {
  return isoDate(startOfWeek(d, { weekStartsOn: 1 }));
}

/** "Today", "Yesterday", "Mon 15 Sep" or "15 Sep 2025" once it is a different year. */
export function relativeDay(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '–';
  const diff = differenceInCalendarDays(new Date(), d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (d.getFullYear() === new Date().getFullYear()) return format(d, 'EEE d MMM');
  return format(d, 'd MMM yyyy');
}

export function shortTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? format(d, 'HH:mm') : '';
}

export function longDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? format(d, 'EEEE d MMMM yyyy') : '–';
}
