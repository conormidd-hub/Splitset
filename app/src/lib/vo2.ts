import type { WellnessDay } from '@/api/wellness';
import type { Point } from '@/components/charts/LineChart';
import { dayMs } from './trends';

/**
 * VO2 max as Garmin presents it: the number itself (Garmin estimates it on outdoor runs from
 * heart rate against pace, and intervals.icu passes the daily value through), the fitness-level
 * band Garmin shows for the athlete's age and sex, and race times from the same number treated
 * as a VDOT.
 */

export type Fitness = 'Superior' | 'Excellent' | 'Good' | 'Fair' | 'Poor';
export type Tone = 'mut' | 'pos' | 'neg' | 'accent';
export type Sex = 'male' | 'female';

export const FITNESS_LEVELS: Fitness[] = ['Poor', 'Fair', 'Good', 'Excellent', 'Superior'];

/** Lower bounds, ml/kg/min. Garmin's "VO2 Max. Standard Ratings" table, data from The Cooper Institute. */
type Band = { ageFrom: number; ageTo: number; fair: number; good: number; excellent: number; superior: number };
const TABLE: Record<Sex, Band[]> = {
  male: [
    { ageFrom: 0, ageTo: 29, fair: 41.7, good: 45.4, excellent: 51.1, superior: 55.4 },
    { ageFrom: 30, ageTo: 39, fair: 40.5, good: 44.0, excellent: 48.3, superior: 54.0 },
    { ageFrom: 40, ageTo: 49, fair: 38.5, good: 42.4, excellent: 46.4, superior: 52.5 },
    { ageFrom: 50, ageTo: 59, fair: 35.6, good: 39.2, excellent: 43.4, superior: 48.9 },
    { ageFrom: 60, ageTo: 69, fair: 32.3, good: 35.5, excellent: 39.5, superior: 45.7 },
    { ageFrom: 70, ageTo: 200, fair: 29.4, good: 32.3, excellent: 36.7, superior: 42.1 },
  ],
  female: [
    { ageFrom: 0, ageTo: 29, fair: 36.1, good: 39.5, excellent: 43.9, superior: 49.6 },
    { ageFrom: 30, ageTo: 39, fair: 34.4, good: 37.8, excellent: 42.4, superior: 47.4 },
    { ageFrom: 40, ageTo: 49, fair: 33.0, good: 36.3, excellent: 39.7, superior: 45.3 },
    { ageFrom: 50, ageTo: 59, fair: 30.1, good: 33.0, excellent: 36.7, superior: 41.1 },
    { ageFrom: 60, ageTo: 69, fair: 27.5, good: 30.0, excellent: 33.0, superior: 37.8 },
    { ageFrom: 70, ageTo: 200, fair: 25.9, good: 28.1, excellent: 30.9, superior: 36.7 },
  ],
};

export const AGE_BANDS = ['20–29', '30–39', '40–49', '50–59', '60–69', '70+'] as const;

/** The whole table for one sex, for the page that shows where the athlete sits. */
export function fitnessTable(sex: Sex): { age: string; fair: number; good: number; excellent: number; superior: number }[] {
  return TABLE[sex].map((b, i) => ({ age: AGE_BANDS[i], fair: b.fair, good: b.good, excellent: b.excellent, superior: b.superior }));
}

export function ageFromBirthYear(birthYear: number | null | undefined, now: Date = new Date()): number | null {
  if (birthYear == null || !Number.isFinite(birthYear)) return null;
  const age = now.getFullYear() - birthYear;
  return age >= 5 && age <= 120 ? age : null;
}

export function fitnessLevel(vo2: number, b: Band): Fitness {
  if (vo2 >= b.superior) return 'Superior';
  if (vo2 >= b.excellent) return 'Excellent';
  if (vo2 >= b.good) return 'Good';
  if (vo2 >= b.fair) return 'Fair';
  return 'Poor';
}

export const FITNESS_TONE: Record<Fitness, Tone> = { Superior: 'accent', Excellent: 'accent', Good: 'pos', Fair: 'mut', Poor: 'neg' };

export type Classification = {
  level: Fitness | null;
  tone: Tone;
  /** 0 Poor … 4 Superior, for a five-step meter. */
  index: number | null;
  /** The band's lower bounds for the athlete's age and sex, or null when unknown. */
  thresholds: { fair: number; good: number; excellent: number; superior: number } | null;
  bandIndex: number | null;
  note: string;
};

/** Where a VO2 max sits in Garmin's table. Under-20s are rated on the 20–29 column, as Garmin does. */
export function vo2Classification(vo2: number | null, age: number | null, sex: Sex | null): Classification {
  if (vo2 == null) return { level: null, tone: 'mut', index: null, thresholds: null, bandIndex: null, note: 'No VO2 max yet. Garmin estimates it on outdoor runs with heart rate.' };
  if (age == null || !sex) {
    return { level: null, tone: 'mut', index: null, thresholds: null, bandIndex: null, note: 'Add your birth year and sex in Settings to see your fitness level for your age.' };
  }
  const bandIndex = TABLE[sex].findIndex((b) => age >= b.ageFrom && age <= b.ageTo);
  const b = TABLE[sex][Math.max(0, bandIndex)];
  const level = fitnessLevel(vo2, b);
  return {
    level,
    tone: FITNESS_TONE[level],
    index: FITNESS_LEVELS.indexOf(level),
    thresholds: { fair: b.fair, good: b.good, excellent: b.excellent, superior: b.superior },
    bandIndex: Math.max(0, bandIndex),
    note: `${level} for ${sex === 'male' ? 'men' : 'women'} aged ${AGE_BANDS[Math.max(0, bandIndex)]}.`,
  };
}

// ---------------------------------------------------------------- Daniels–Gilbert

/** Oxygen cost of running at v metres per minute. */
export function oxygenCost(v: number): number {
  return -4.6 + 0.182258 * v + 0.000104 * v * v;
}

/** The share of VO2 max a runner can hold for t minutes. */
export function sustainableFraction(t: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
}

/** A race's VDOT from its distance and time (Daniels and Gilbert, Oxygen Power, 1979). */
export function vdotFromRace(distanceM: number, seconds: number): number | null {
  if (!(distanceM > 0) || !(seconds > 0)) return null;
  const t = seconds / 60;
  return oxygenCost(distanceM / t) / sustainableFraction(t);
}

export const RACE_DISTANCES = [
  { label: '5 km', distanceM: 5000, pb: '5km' },
  { label: '10 km', distanceM: 10000, pb: '10km' },
  { label: 'Half', distanceM: 21097, pb: 'half' },
  { label: 'Marathon', distanceM: 42195, pb: 'marathon' },
] as const;

/** Seconds to cover a distance at a given VDOT: the t where the equations meet, found by bisection. */
export function raceTime(vdot: number, distanceM: number): number | null {
  if (!(vdot > 20) || !(vdot < 100) || !(distanceM > 0)) return null;
  // minutes: from an impossible 12 m/s to a walk at 1 m/s
  let lo = distanceM / 720;
  let hi = distanceM / 60;
  const f = (t: number) => oxygenCost(distanceM / t) / sustainableFraction(t) - vdot;
  if (f(lo) < 0 || f(hi) > 0) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 60);
}

export function raceTimes(vdot: number): { label: string; distanceM: number; pb: string; seconds: number | null }[] {
  return RACE_DISTANCES.map((r) => ({ label: r.label, distanceM: r.distanceM, pb: r.pb, seconds: raceTime(vdot, r.distanceM) }));
}

// ---------------------------------------------------------------- trend

/** Mean of the readings between `fromDays` and `toDays` ago, counted in calendar days. */
function meanAround(rows: WellnessDay[], fromDays: number, toDays: number, today: string): number | null {
  const daysAgo = (date: string) => Math.round((dayMs(today) - dayMs(date)) / 86_400_000);
  const vals = rows.filter((r) => { const d = daysAgo(r.date); return typeof r.vo2max === 'number' && d >= fromDays && d < toDays; }).map((r) => r.vo2max as number);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** Latest value and how it moved: the latest reading against the mean of the window ending N days ago. */
export function vo2Trend(rows: WellnessDay[], today: string): { latest: number | null; date: string | null; change30: number | null; change90: number | null; change365: number | null; series: Point[] } {
  let latest: number | null = null;
  let date: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (typeof rows[i].vo2max === 'number') { latest = rows[i].vo2max as number; date = rows[i].date; break; }
  }
  const change = (days: number) => {
    const then = meanAround(rows, days, days + 14, today);
    return latest != null && then != null ? Math.round((latest - then) * 10) / 10 : null;
  };
  return {
    latest,
    date,
    change30: change(30),
    change90: change(90),
    change365: change(365),
    series: rows.map((r) => ({ x: dayMs(r.date), y: typeof r.vo2max === 'number' ? r.vo2max : null })),
  };
}
