import { differenceInCalendarDays, format, parseISO } from 'date-fns';

import type { Point } from '@/components/charts/LineChart';
import type { Range, Tone } from '@/lib/metrics';
import type { Palette } from '@/theme/tokens';

/** The ink for a tone: badges, meters and bars all read the same colour for the same verdict. */
export function toneColor(palette: Palette, tone: Tone): string {
  return tone === 'accent' ? palette.accent : tone === 'pos' ? palette.pos : tone === 'neg' ? palette.neg : palette.mut;
}

/** The wash behind a toned word, matching Badge. */
export function toneSoft(palette: Palette, tone: Tone): string {
  return tone === 'neg' ? palette.negSoft : tone === 'mut' ? palette.surface3 : palette.accentSoft;
}

/** "Today", "Yest.", "Mon 6": what fits the timeline's date column. */
export function shortDay(iso: string, today: string): string {
  const d = parseISO(iso);
  const diff = differenceInCalendarDays(parseISO(today), d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yest.';
  return format(d, 'EEE d');
}

/** Axis labels per range: day names for a week, d/M for a month, months for a year. */
export function xFormatFor(range: Range): (ms: number) => string {
  if (range === 'week') return (ms) => format(new Date(ms), 'EEE');
  if (range === 'year') return (ms) => format(new Date(ms), 'MMM');
  return (ms) => format(new Date(ms), 'd/M');
}

/** The tapped point's date in full; a year's points are weekly means, placed on the Monday. */
export function cursorFormatFor(range: Range): (ms: number) => string {
  if (range === 'year') return (ms) => `w/c ${format(new Date(ms), 'd MMM')}`;
  return (ms) => format(new Date(ms), 'EEE d MMM');
}

/** "the week", "the last 14 days": for a stat tile's small print. */
export function rangeNoun(range: Range): string {
  return range === 'day' ? 'the last 14 days' : range === 'week' ? 'the week' : range === 'month' ? 'the month' : 'the year';
}

/**
 * Hold each reading until the next one, so a value Garmin updates every few runs (VO2 max)
 * draws as a step rather than scattered dots. `seed` is the last reading before the window.
 */
export function carryForward(points: Point[], seed: number | null): Point[] {
  let last = seed;
  return points.map((p) => {
    if (p.y != null) last = p.y;
    return { x: p.x, y: last };
  });
}
