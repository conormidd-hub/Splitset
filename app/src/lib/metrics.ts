import { isRun, type ActivityListRow } from '@/api/activities';
import type { WorkoutSummary } from '@/api/lifting';
import type { LiftPbIndex, PbPeriods, RunPb } from '@/api/pbs';
import type { Profile } from '@/api/profile';
import type { WellnessDay } from '@/api/wellness';
import type { Point } from '@/components/charts/LineChart';
import { isoDate, relativeDay, weekStartIso } from './dates';
import { ICONS, type IconName } from './icons';
import { countNewPbs } from './newPbs';
import { isNewThisMonth } from './pbs';
import { hrvStatus, readinessSeries, trainingReadiness, trainingStatus } from './readiness';
import { acwr, dayMs, rolling } from './trends';
import { formatDistance, formatDuration, formatDurationShort, KM_PER_MILE, LB_PER_KG, type Units } from './units';
import { ageFromBirthYear, raceTime, vo2Classification, vo2Trend } from './vo2';

/**
 * The catalogue behind the Today screen: every stat Garmin Connect lets you put on its home
 * (In focus, At a glance), what each one is, and whether it can reach Splitset at all. The data
 * path is Garmin → intervals.icu → the sync job, so a few Garmin numbers never arrive; they are
 * listed anyway, greyed out, with the reason. Everything here is pure: screens build a
 * MetricInputs once and ask for a `snapshot` per tile or a `detailSeries` per page.
 */

export type MetricId =
  | 'resting_hr' | 'hrv' | 'hrv_status' | 'heart_rate' | 'stress' | 'respiration' | 'spo2' | 'steps' | 'floors' | 'calories'
  | 'body_battery' | 'intensity_minutes' | 'hydration'
  | 'sleep' | 'sleep_score' | 'avg_sleeping_hr'
  | 'weight' | 'body_fat'
  | 'readiness' | 'training_status' | 'vo2max' | 'fitness' | 'fatigue' | 'form' | 'ramp_rate' | 'acute_load' | 'load_ratio'
  | 'race_predictor' | 'recovery_time' | 'fitness_age' | 'endurance_score' | 'hill_score'
  | 'weekly_distance' | 'weekly_time' | 'sessions' | 'last_activity' | 'lift_volume' | 'pbs';

export type MetricGroup = 'health' | 'sleep' | 'body' | 'training' | 'activity';
export type Tone = 'mut' | 'pos' | 'neg' | 'accent';
export type Kind = 'daily' | 'weekly' | 'status' | 'special';

export type MetricDef = {
  id: MetricId;
  label: string;
  /** For the tile, 14 characters or fewer. */
  short: string;
  group: MetricGroup;
  icon: IconName;
  unit?: string;
  /** False for the Garmin numbers that never reach intervals.icu. */
  available: boolean;
  unavailableReason?: string;
  /** Shown when the metric is available but this athlete has no data for it yet. */
  setupHint?: string;
  /** Which way is good: up (fitness), down (resting HR) or neither (weight, form). */
  direction: 'up' | 'down' | 'neutral';
  /** What it is and how Garmin measures it, for the detail page. */
  description: string;
  kind: Kind;
};

export const GROUP_LABELS: Record<MetricGroup, string> = {
  health: 'Health',
  sleep: 'Sleep',
  body: 'Body',
  training: 'Training',
  activity: 'Activity',
};

const NOT_SENT = 'Garmin keeps this inside Garmin Connect and intervals.icu never receives it.';

export const METRICS: Record<MetricId, MetricDef> = {
  resting_hr: {
    id: 'resting_hr', label: 'Resting heart rate', short: 'Resting HR', group: 'health', icon: ICONS.heart, unit: 'bpm',
    available: true, direction: 'down', kind: 'daily',
    description: 'The lowest sustained heart rate your watch saw, usually while you slept. A few beats above your usual is the earliest sign of fatigue, illness or a late night; a slow drift down over months is fitness.',
  },
  hrv: {
    id: 'hrv', label: 'HRV', short: 'HRV', group: 'health', icon: ICONS.hrv, unit: 'ms',
    available: true, direction: 'up', kind: 'daily',
    description: 'Overnight heart-rate variability (RMSSD, the beat-to-beat variation). One night means little: read the 7-day average against your own range, which is what HRV status does.',
  },
  hrv_status: {
    id: 'hrv_status', label: 'HRV status', short: 'HRV status', group: 'health', icon: ICONS.hrv,
    available: true, direction: 'neutral', kind: 'special',
    description: 'Garmin compares your 7-day overnight HRV average with a personal baseline built from the previous three weeks: Balanced inside it, Unbalanced just outside, Low well below. Garmin keeps its own band on the watch, so Splitset works it out the same way from your nightly values (or uses the band from a Garmin export).',
  },
  heart_rate: {
    id: 'heart_rate', label: 'Heart rate', short: 'Heart rate', group: 'health', icon: ICONS.heart, unit: 'bpm',
    available: false, direction: 'neutral', kind: 'daily',
    unavailableReason: 'All-day heart rate stays in Garmin Connect; only the daily resting value reaches intervals.icu.',
    description: 'Your heart rate through the day.',
  },
  stress: {
    id: 'stress', label: 'Stress (self-rated)', short: 'Stress', group: 'health', icon: ICONS.stress, unit: '/4',
    available: true, direction: 'down', kind: 'daily',
    setupHint: 'Garmin’s 0–100 stress score never leaves Garmin Connect. This is intervals.icu’s own 1–4 rating, which you fill in there.',
    description: 'Garmin’s stress score does not reach intervals.icu. What intervals.icu has is a 1 (none) to 4 (extreme) rating you give yourself on its wellness page, and that is what shows here.',
  },
  respiration: {
    id: 'respiration', label: 'Respiration', short: 'Breathing', group: 'health', icon: ICONS.lungs, unit: 'brpm',
    available: true, direction: 'neutral', kind: 'daily',
    setupHint: 'Arrives when you take a Health Snapshot on the watch; the overnight average does not sync.',
    description: 'Breaths per minute. intervals.icu receives it from Garmin Health Snapshots, not from the overnight average, so it appears on the days you take one.',
  },
  spo2: {
    id: 'spo2', label: 'Pulse Ox', short: 'Pulse Ox', group: 'health', icon: ICONS.spo2, unit: '%',
    available: true, direction: 'up', kind: 'daily',
    setupHint: 'Arrives when you take a Health Snapshot on the watch; the overnight average does not sync.',
    description: 'Blood oxygen saturation. Garmin sends intervals.icu the reading from a Health Snapshot, not the overnight average, so it shows on the days you take one. Under 90% at rest is worth a conversation with a doctor.',
  },
  steps: {
    id: 'steps', label: 'Steps', short: 'Steps', group: 'health', icon: ICONS.steps,
    available: true, direction: 'up', kind: 'daily',
    description: 'Steps for the day, as counted by the watch.',
  },
  floors: {
    id: 'floors', label: 'Floors climbed', short: 'Floors', group: 'health', icon: ICONS.steps,
    available: true, direction: 'up', kind: 'daily',
    setupHint: 'A new intervals.icu field; whether Garmin fills it is still being confirmed.',
    description: 'Floors climbed, from the watch’s barometer. intervals.icu only recently added the field.',
  },
  calories: {
    id: 'calories', label: 'Calories', short: 'Calories', group: 'health', icon: ICONS.calories, unit: 'kcal',
    available: false, direction: 'neutral', kind: 'daily',
    unavailableReason: 'Daily calories stay in Garmin Connect. Each activity’s calories do sync and show on the run page.',
    description: 'Active and resting calories for the day.',
  },
  body_battery: {
    id: 'body_battery', label: 'Body Battery', short: 'Body Battery', group: 'health', icon: ICONS.battery,
    available: true, direction: 'up', kind: 'daily',
    setupHint: 'In intervals.icu: Settings, add custom wellness fields with the codes BodyBatteryMax and BodyBatteryMin, then tick them under Garmin, Download wellness data.',
    description: 'Garmin’s 0–100 energy gauge, charged by sleep and drained by stress and training. It reaches intervals.icu only through two custom wellness fields named BodyBatteryMax and BodyBatteryMin; the day’s high is shown here.',
  },
  intensity_minutes: {
    id: 'intensity_minutes', label: 'Intensity minutes', short: 'Intensity', group: 'health', icon: ICONS.time, unit: 'min',
    available: false, direction: 'up', kind: 'weekly',
    unavailableReason: NOT_SENT,
    description: 'Garmin’s weekly count of moderate and vigorous minutes.',
  },
  hydration: {
    id: 'hydration', label: 'Hydration', short: 'Hydration', group: 'health', icon: ICONS.water, unit: 'L',
    available: false, direction: 'neutral', kind: 'daily',
    unavailableReason: 'Logged water stays in Garmin Connect.',
    description: 'Water logged in Garmin Connect.',
  },
  sleep: {
    id: 'sleep', label: 'Sleep', short: 'Sleep', group: 'sleep', icon: ICONS.sleep, unit: 'h',
    available: true, direction: 'up', kind: 'daily',
    description: 'Hours asleep last night, as the watch measured them. Garmin’s sleep stages stay in Garmin Connect; the total and the score come through.',
  },
  sleep_score: {
    id: 'sleep_score', label: 'Sleep score', short: 'Sleep score', group: 'sleep', icon: ICONS.moon, unit: '/100',
    available: true, direction: 'up', kind: 'daily',
    description: 'Garmin’s 0–100 verdict on last night: duration, stages, restlessness and stress. Excellent 90+, Good 80–89, Fair 60–79, Poor below 60.',
  },
  avg_sleeping_hr: {
    id: 'avg_sleeping_hr', label: 'Sleeping heart rate', short: 'Sleeping HR', group: 'sleep', icon: ICONS.heart, unit: 'bpm',
    available: true, direction: 'down', kind: 'daily',
    setupHint: 'intervals.icu has the field but Garmin does not fill it; other sources can.',
    description: 'Average heart rate while asleep. Garmin does not send it to intervals.icu, so it shows only when another source fills it in.',
  },
  weight: {
    id: 'weight', label: 'Weight', short: 'Weight', group: 'body', icon: ICONS.weight,
    available: true, direction: 'neutral', kind: 'daily',
    setupHint: 'Weigh-ins reach intervals.icu from a Garmin scale, or type them in there.',
    description: 'Weigh-ins, from a Garmin Index scale or typed into intervals.icu.',
  },
  body_fat: {
    id: 'body_fat', label: 'Body fat', short: 'Body fat', group: 'body', icon: ICONS.weight, unit: '%',
    available: true, direction: 'down', kind: 'daily',
    setupHint: 'Needs a scale that reports body fat into intervals.icu.',
    description: 'Body fat percentage from a connected scale.',
  },
  readiness: {
    id: 'readiness', label: 'Training readiness', short: 'Readiness', group: 'training', icon: ICONS.readiness, unit: '/100',
    available: true, direction: 'up', kind: 'special',
    description: 'How ready you are for a hard session, 1–100, in Garmin’s bands: Prime 95+, High 75–94, Moderate 50–74, Low 25–49, Poor under 25. Garmin builds it from last night’s sleep, recovery time, HRV status, acute load, sleep history and stress history. Garmin keeps its own score on the watch, so Splitset estimates it from the same six ingredients.',
  },
  training_status: {
    id: 'training_status', label: 'Training status', short: 'Status', group: 'training', icon: ICONS.status,
    available: true, direction: 'neutral', kind: 'special',
    description: 'Garmin’s verdict on whether your training is working: Productive, Maintaining, Recovery, Peaking, Unproductive, Overreaching, Strained or Detraining, read from your VO2 max trend, acute load and HRV status over several weeks. Splitset reads the same signals from intervals.icu.',
  },
  vo2max: {
    id: 'vo2max', label: 'VO2 max', short: 'VO2 max', group: 'training', icon: ICONS.vo2, unit: 'ml/kg/min',
    available: true, direction: 'up', kind: 'special',
    description: 'The most oxygen your body can use per kilo per minute: the headline fitness number. Garmin estimates it on outdoor runs with heart rate and pace, and intervals.icu passes the running estimate through on the days Garmin updates it.',
  },
  fitness: {
    id: 'fitness', label: 'Fitness', short: 'Fitness', group: 'training', icon: ICONS.fitness,
    available: true, direction: 'up', kind: 'daily',
    description: 'CTL, intervals.icu’s 42-day weighted average of daily training load: what you have banked. Garmin’s chronic load is the same idea over 28 days.',
  },
  fatigue: {
    id: 'fatigue', label: 'Fatigue', short: 'Fatigue', group: 'training', icon: ICONS.fitness,
    available: true, direction: 'down', kind: 'daily',
    description: 'ATL, the 7-day weighted average of daily training load: how heavy the last week was.',
  },
  form: {
    id: 'form', label: 'Form', short: 'Form', group: 'training', icon: ICONS.fitness,
    available: true, direction: 'neutral', kind: 'daily',
    description: 'Fitness minus fatigue (TSB). Positive is fresh, which is what you want on race day; between −10 and −30 is where training blocks live; below −30 is risky.',
  },
  ramp_rate: {
    id: 'ramp_rate', label: 'Ramp rate', short: 'Ramp rate', group: 'training', icon: ICONS.status, unit: '/wk',
    available: true, direction: 'neutral', kind: 'daily',
    description: 'How fast fitness (CTL) is climbing per week. Up to about 5 a week is sustainable; much more than 8 is how overreaching starts.',
  },
  acute_load: {
    id: 'acute_load', label: 'Acute load', short: 'Acute load', group: 'training', icon: ICONS.fitness,
    available: true, direction: 'neutral', kind: 'daily',
    description: 'Training load over the last seven days, summed from each activity’s load. Garmin’s acute load is a weighted sum of EPOC over the same window and rates it low, optimal or high against your history.',
  },
  load_ratio: {
    id: 'load_ratio', label: 'Load ratio', short: 'Load ratio', group: 'training', icon: ICONS.status,
    available: true, direction: 'neutral', kind: 'daily',
    description: 'Acute load over chronic load: the last 7 days against the last 28. Garmin’s bands: Low under 0.8, Optimal 0.8–1.4, High 1.5–1.9, Very high from 2.0.',
  },
  race_predictor: {
    id: 'race_predictor', label: 'Race predictor', short: 'Race 5 km', group: 'training', icon: ICONS.trophy,
    available: true, direction: 'down', kind: 'special',
    description: 'Finish times for 5 km, 10 km, half and marathon from your VO2 max, using Daniels’ running formula. Garmin’s predictor also weighs your training history, so treat these as a fitness guide rather than a promise.',
  },
  recovery_time: {
    id: 'recovery_time', label: 'Recovery time', short: 'Recovery', group: 'training', icon: ICONS.time, unit: 'h',
    available: false, direction: 'down', kind: 'daily',
    unavailableReason: 'Garmin writes recovery hours into the activity file in a form intervals.icu cannot rely on.',
    description: 'Hours until Garmin thinks you are ready for the next hard session.',
  },
  fitness_age: {
    id: 'fitness_age', label: 'Fitness age', short: 'Fitness age', group: 'training', icon: ICONS.sparkles,
    available: false, direction: 'down', kind: 'daily',
    unavailableReason: NOT_SENT,
    description: 'The age your VO2 max, activity, resting heart rate and body fat add up to.',
  },
  endurance_score: {
    id: 'endurance_score', label: 'Endurance score', short: 'Endurance', group: 'training', icon: ICONS.sparkles,
    available: false, direction: 'up', kind: 'daily',
    unavailableReason: NOT_SENT,
    description: 'Garmin’s rating of how long you can keep going, from VO2 max and the history of long efforts.',
  },
  hill_score: {
    id: 'hill_score', label: 'Hill score', short: 'Hill score', group: 'training', icon: ICONS.sparkles,
    available: false, direction: 'up', kind: 'daily',
    unavailableReason: NOT_SENT,
    description: 'Garmin’s rating of your hill strength and endurance.',
  },
  weekly_distance: {
    id: 'weekly_distance', label: 'Running this week', short: 'Running', group: 'activity', icon: ICONS.run,
    available: true, direction: 'up', kind: 'weekly',
    description: 'Kilometres run from Monday to today, with last week beside it.',
  },
  weekly_time: {
    id: 'weekly_time', label: 'Training time this week', short: 'Time', group: 'activity', icon: ICONS.time,
    available: true, direction: 'up', kind: 'weekly',
    description: 'Moving time across every activity from Monday to today.',
  },
  sessions: {
    id: 'sessions', label: 'Sessions this week', short: 'Sessions', group: 'activity', icon: ICONS.lift,
    available: true, direction: 'up', kind: 'weekly',
    description: 'Runs and gym sessions from Monday to today.',
  },
  last_activity: {
    id: 'last_activity', label: 'Latest activity', short: 'Latest', group: 'activity', icon: ICONS.run,
    available: true, direction: 'neutral', kind: 'special',
    description: 'The most recent activity from your watch.',
  },
  lift_volume: {
    id: 'lift_volume', label: 'Lifting volume this week', short: 'Lifting', group: 'activity', icon: ICONS.lift,
    available: true, direction: 'up', kind: 'weekly',
    description: 'Weight moved across finished workouts from Monday to today.',
  },
  pbs: {
    id: 'pbs', label: 'Personal bests', short: 'PBs', group: 'activity', icon: ICONS.trophy,
    available: true, direction: 'up', kind: 'special',
    description: 'New all-time records set this month, running and lifting.',
  },
};

/** Display order in the Add sheet, by group, available first within each. */
export const METRIC_ORDER: MetricId[] = [
  'resting_hr', 'hrv', 'hrv_status', 'steps', 'body_battery', 'spo2', 'respiration', 'stress', 'floors', 'heart_rate', 'calories', 'intensity_minutes', 'hydration',
  'sleep', 'sleep_score', 'avg_sleeping_hr',
  'weight', 'body_fat',
  'readiness', 'training_status', 'vo2max', 'race_predictor', 'fitness', 'fatigue', 'form', 'load_ratio', 'acute_load', 'ramp_rate', 'recovery_time', 'fitness_age', 'endurance_score', 'hill_score',
  'weekly_distance', 'sessions', 'weekly_time', 'lift_volume', 'last_activity', 'pbs',
];

export const isMetricId = (v: unknown): v is MetricId => typeof v === 'string' && v in METRICS;

// ---------------------------------------------------------------- inputs

export type MetricInputs = {
  /** Oldest first, as useWellness returns. */
  wellness: WellnessDay[];
  /** Oldest first, as useRecentActivities returns. */
  activities: ActivityListRow[];
  /** Newest first, as useWorkouts returns. */
  workouts: WorkoutSummary[];
  runPbs?: Map<string, PbPeriods<RunPb>>;
  /** Lifting bests, so the PBs tile counts them as the trophy cabinet does. */
  liftPbs?: LiftPbIndex;
  profile?: Pick<Profile, 'birth_year' | 'sex' | 'timezone'> | null;
  units: Units;
  /** isoDate of today in the device's zone. */
  today: string;
};

const DAY = 86_400_000;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs: number[]) => {
  const m = mean(xs);
  if (m == null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};
const localDate = (a: ActivityListRow) => a.start_time_local.slice(0, 10);

// ---------------------------------------------------------------- formatting

const thousands = (v: number) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const signed = (v: number, decimals: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(decimals)}`;

/** How a value of this metric reads on a tile or a page: the number and the unit after it. */
export function formatMetric(id: MetricId, value: number | null, units: Units): { text: string; unit?: string } {
  if (value == null || !Number.isFinite(value)) return { text: '–', unit: METRICS[id].unit };
  switch (id) {
    case 'resting_hr': case 'avg_sleeping_hr': case 'heart_rate': return { text: `${Math.round(value)}`, unit: 'bpm' };
    case 'hrv': return { text: `${Math.round(value)}`, unit: 'ms' };
    case 'stress': return { text: `${Math.round(value)}`, unit: '/4' };
    case 'respiration': return { text: value.toFixed(1), unit: 'brpm' };
    case 'spo2': case 'body_fat': return { text: value.toFixed(id === 'spo2' ? 0 : 1), unit: '%' };
    case 'steps': case 'floors': case 'body_battery': case 'sessions': case 'pbs': case 'fitness_age': case 'endurance_score': case 'hill_score': return { text: thousands(value) };
    case 'sleep': return { text: value.toFixed(1), unit: 'h' };
    case 'sleep_score': case 'readiness': return { text: `${Math.round(value)}`, unit: '/100' };
    case 'weight': return { text: (units === 'imperial' ? value * LB_PER_KG : value).toFixed(1), unit: units === 'imperial' ? 'lb' : 'kg' };
    case 'vo2max': return { text: value.toFixed(1), unit: 'ml/kg/min' };
    case 'fitness': case 'fatigue': case 'acute_load': return { text: `${Math.round(value)}` };
    case 'form': return { text: signed(value, 0) };
    case 'ramp_rate': return { text: signed(value, 1), unit: '/wk' };
    case 'load_ratio': return { text: value.toFixed(2) };
    case 'weekly_distance': {
      const km = value / 1000;
      const v = units === 'imperial' ? km / KM_PER_MILE : km;
      return { text: v.toFixed(v >= 100 ? 0 : 1), unit: units === 'imperial' ? 'mi' : 'km' };
    }
    case 'weekly_time': case 'intensity_minutes': case 'recovery_time': return { text: formatDurationShort(value) };
    case 'lift_volume': return { text: thousands(units === 'imperial' ? value * LB_PER_KG : value), unit: units === 'imperial' ? 'lb' : 'kg' };
    case 'race_predictor': return { text: formatDuration(value) };
    case 'calories': return { text: thousands(value), unit: 'kcal' };
    case 'hydration': return { text: value.toFixed(1), unit: 'L' };
    default: return { text: `${Math.round(value)}`, unit: METRICS[id].unit };
  }
}

/** A difference in the metric's own terms: "+3", "−0.4 h", "+1,200". */
function formatDelta(id: MetricId, d: number, units: Units): string {
  switch (id) {
    case 'sleep': return `${signed(d, 1)} h`;
    case 'weight': return `${signed(units === 'imperial' ? d * LB_PER_KG : d, 1)} ${units === 'imperial' ? 'lb' : 'kg'}`;
    case 'body_fat': case 'vo2max': case 'respiration': case 'ramp_rate': return signed(d, 1);
    case 'load_ratio': return signed(d, 2);
    case 'steps': case 'lift_volume': return `${d > 0 ? '+' : d < 0 ? '−' : ''}${thousands(Math.abs(d))}`;
    case 'weekly_distance': return `${signed((units === 'imperial' ? d / KM_PER_MILE : d) / 1000, 1)} ${units === 'imperial' ? 'mi' : 'km'}`;
    case 'weekly_time': return `${d >= 0 ? '+' : '−'}${formatDurationShort(Math.abs(d))}`;
    default: return signed(d, 0);
  }
}

/** Below this a change is noise and shows in grey. */
const SMALL: Partial<Record<MetricId, number>> = {
  resting_hr: 2, hrv: 3, stress: 0.5, respiration: 1, spo2: 1, steps: 1000, floors: 3, body_battery: 5, sleep: 0.3,
  sleep_score: 5, avg_sleeping_hr: 2, weight: 0.3, body_fat: 0.5, vo2max: 0.5, fitness: 1, fatigue: 2, form: 3,
  ramp_rate: 0.5, acute_load: 20, load_ratio: 0.1, weekly_distance: 1000, weekly_time: 600, lift_volume: 500, sessions: 1,
};

function deltaTone(id: MetricId, d: number): Tone {
  const def = METRICS[id];
  if (Math.abs(d) < (SMALL[id] ?? 0) || def.direction === 'neutral') return 'mut';
  const good = def.direction === 'up' ? d > 0 : d < 0;
  return good ? 'pos' : 'neg';
}

// ---------------------------------------------------------------- snapshots

export type Level = { label: string; tone: Tone; index: number; of: number };

export type Snapshot = {
  id: MetricId;
  /** The number behind the tile, null when there is none. */
  value: number | null;
  text: string;
  unit?: string;
  sub?: string;
  subTone: Tone;
  /** The reading's date (iso), when it has one. */
  date?: string;
  level?: Level;
  /** The last 14 daily (or 8 weekly) points for a sparkline. */
  spark: Point[];
  /** Where a tap should go when not the metric page itself. */
  href?: string;
};

/** The wellness column behind each daily metric, and how to read it. */
const DAILY: Partial<Record<MetricId, { key: keyof WellnessDay; transform?: (v: number) => number }>> = {
  resting_hr: { key: 'resting_hr' },
  hrv: { key: 'hrv' },
  stress: { key: 'stress' },
  respiration: { key: 'respiration' },
  spo2: { key: 'spo2' },
  steps: { key: 'steps' },
  floors: { key: 'floors' },
  body_battery: { key: 'body_battery_max' },
  sleep: { key: 'sleep_s', transform: (s) => s / 3600 },
  sleep_score: { key: 'sleep_score' },
  avg_sleeping_hr: { key: 'avg_sleeping_hr' },
  weight: { key: 'weight_kg' },
  body_fat: { key: 'body_fat_pct' },
  vo2max: { key: 'vo2max' },
  fitness: { key: 'ctl' },
  fatigue: { key: 'atl' },
  ramp_rate: { key: 'ramp_rate' },
};

/** One value per calendar day for a daily metric, oldest first; days without a reading are null. */
export function dailyValues(id: MetricId, inputs: MetricInputs): { date: string; value: number | null }[] {
  if (id === 'form') {
    return inputs.wellness.map((r) => ({ date: r.date, value: num(r.ctl) && num(r.atl) ? r.ctl - r.atl : null }));
  }
  if (id === 'acute_load') {
    // the last seven days' load added up, day by day; days before the first activity count as zero,
    // so a new account's first week reads as the sum it is rather than a mean scaled up
    const load = acwr(inputs.activities).load;
    return load.map((p, i) => ({ date: isoDate(new Date(p.x)), value: load.slice(Math.max(0, i - 6), i + 1).reduce((s, q) => s + (q.y ?? 0), 0) }));
  }
  if (id === 'load_ratio') {
    return acwr(inputs.activities).ratio.map((p) => ({ date: isoDate(new Date(p.x)), value: p.y }));
  }
  const d = DAILY[id];
  if (!d) return [];
  return inputs.wellness.map((r) => {
    const v = r[d.key];
    return { date: r.date, value: num(v) ? (d.transform ? d.transform(v) : v) : null };
  });
}

function lastReading(values: { date: string; value: number | null }[]): { date: string; value: number } | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i].value;
    if (v != null) return { date: values[i].date, value: v };
  }
  return null;
}

/** Mean of the `n` most recent readings strictly before `date`. */
function trailingMean(values: { date: string; value: number | null }[], date: string, n: number): number | null {
  const xs: number[] = [];
  for (let i = values.length - 1; i >= 0 && xs.length < n; i--) {
    if (values[i].date >= date) continue;
    const v = values[i].value;
    if (v != null) xs.push(v);
  }
  return mean(xs);
}

function sparkOf(values: { date: string; value: number | null }[], today: string, days = 14): Point[] {
  const from = isoDate(new Date(dayMs(today) - (days - 1) * DAY));
  return values.filter((v) => v.date >= from && v.date <= today).map((v) => ({ x: dayMs(v.date), y: v.value }));
}

/** Per-week sums for the activity metrics, oldest first, one entry per week that had anything. */
function weeklyTotals(inputs: MetricInputs, pick: (a: ActivityListRow) => number | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of inputs.activities) {
    const v = pick(a);
    if (v == null) continue;
    const wk = weekStartIso(new Date(a.start_time_local));
    m.set(wk, (m.get(wk) ?? 0) + v);
  }
  return m;
}

const WEEKLY_PICK: Partial<Record<MetricId, (a: ActivityListRow) => number | null>> = {
  weekly_distance: (a) => (isRun(a.type) ? a.distance_m ?? 0 : null),
  weekly_time: (a) => a.moving_time_s ?? null,
  sessions: (a) => (isRun(a.type) || a.type === 'WeightTraining' || a.type === 'Workout' ? 1 : null),
};

function liftWeekly(inputs: MetricInputs): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of inputs.workouts) {
    if (!w.started_at) continue;
    const wk = weekStartIso(new Date(w.started_at));
    m.set(wk, (m.get(wk) ?? 0) + (w.volume_kg ?? 0));
  }
  return m;
}

function weeklySpark(totals: Map<string, number>, today: string, weeks = 8): Point[] {
  const out: Point[] = [];
  const start = dayMs(weekStartIso(new Date(dayMs(today))));
  for (let i = weeks - 1; i >= 0; i--) {
    const wk = isoDate(new Date(start - i * 7 * DAY));
    out.push({ x: dayMs(wk), y: totals.get(wk) ?? 0 });
  }
  return out;
}

function levelOf(label: string, tone: Tone, order: readonly string[]): Level {
  return { label, tone, index: Math.max(0, order.indexOf(label)), of: order.length };
}

const READINESS_ORDER = ['Poor', 'Low', 'Moderate', 'High', 'Prime'] as const;
const HRV_ORDER = ['Poor', 'Low', 'Unbalanced', 'Balanced'] as const;
const SLEEP_SCORE_ORDER = ['Poor', 'Fair', 'Good', 'Excellent'] as const;

export function sleepScoreLevel(score: number): Level {
  const label = score >= 90 ? 'Excellent' : score >= 80 ? 'Good' : score >= 60 ? 'Fair' : 'Poor';
  return levelOf(label, label === 'Poor' ? 'neg' : label === 'Fair' ? 'mut' : 'pos', SLEEP_SCORE_ORDER);
}

/** intervals.icu's reading of form (TSB). */
export function formLevel(tsb: number): Level {
  const order = ['High risk', 'Optimal', 'Grey zone', 'Fresh', 'Transition'] as const;
  const label = tsb > 25 ? 'Transition' : tsb > 5 ? 'Fresh' : tsb > -10 ? 'Grey zone' : tsb >= -30 ? 'Optimal' : 'High risk';
  return levelOf(label, label === 'High risk' ? 'neg' : label === 'Grey zone' ? 'mut' : label === 'Transition' ? 'mut' : 'pos', order);
}

/** Garmin's load-ratio bands. */
export function loadRatioLevel(r: number): Level {
  const order = ['Low', 'Optimal', 'High', 'Very high'] as const;
  const label = r < 0.8 ? 'Low' : r < 1.5 ? 'Optimal' : r < 2 ? 'High' : 'Very high';
  return levelOf(label, label === 'Optimal' ? 'pos' : label === 'Low' ? 'mut' : 'neg', order);
}

const empty = (id: MetricId, sub: string, subTone: Tone = 'mut'): Snapshot => ({ id, value: null, text: '–', unit: METRICS[id].unit, sub, subTone, spark: [] });

/** What the tile for `id` shows right now. */
export function snapshot(id: MetricId, inputs: MetricInputs): Snapshot {
  const def = METRICS[id];
  const { units, today } = inputs;
  if (!def.available) return empty(id, 'Not from intervals.icu');

  switch (id) {
    case 'readiness': {
      const r = trainingReadiness(inputs);
      if (r.score == null) return empty(id, r.explain);
      const f = formatMetric(id, r.score, units);
      return {
        id, value: r.score, text: f.text, unit: f.unit, date: r.date ?? undefined,
        sub: r.source === 'estimated' ? `${r.level} · estimated` : `${r.level}`, subTone: r.tone,
        level: levelOf(r.level ?? 'Poor', r.tone, READINESS_ORDER),
        spark: readinessSeries(inputs, 14).map((p) => ({ x: dayMs(p.date), y: p.score })),
      };
    }
    case 'training_status': {
      const s = trainingStatus(inputs);
      const bits = [
        s.loadTrend !== 'unknown' ? `load ${s.loadTrend}` : null,
        s.vo2Change != null ? `VO2 ${signed(s.vo2Change, 1)}` : null,
      ].filter(Boolean);
      return {
        id, value: null, text: s.status, sub: bits.length ? bits.join(' · ') : s.why, subTone: s.tone,
        level: { label: s.status, tone: s.tone, index: 0, of: 1 },
        spark: sparkOf(dailyValues('fitness', inputs), today),
      };
    }
    case 'hrv_status': {
      const h = hrvStatus(inputs);
      const sub = h.weekly != null
        ? `7-day ${Math.round(h.weekly)} ms${h.baselineLow != null && h.baselineHigh != null ? ` · base ${Math.round(h.baselineLow)}–${Math.round(h.baselineHigh)}` : ''}`
        : h.why;
      return {
        id, value: h.weekly, text: h.status, sub, subTone: h.tone,
        level: levelOf(h.status, h.tone, HRV_ORDER),
        spark: sparkOf(dailyValues('hrv', inputs), today),
      };
    }
    case 'vo2max': {
      const t = vo2Trend(inputs.wellness, today);
      if (t.latest == null) return empty(id, 'Needs an outdoor run with heart rate');
      const f = formatMetric(id, t.latest, units);
      const c = vo2Classification(t.latest, ageFromBirthYear(inputs.profile?.birth_year), inputs.profile?.sex === 'male' || inputs.profile?.sex === 'female' ? inputs.profile.sex : null);
      const change = t.change30 ?? t.change90;
      const sub = c.level ? `${c.level}${change != null ? ` · ${signed(change, 1)} in ${t.change30 != null ? '30' : '90'} d` : ''}` : change != null ? `${signed(change, 1)} in ${t.change30 != null ? '30' : '90'} d` : relativeDay(t.date);
      return {
        id, value: t.latest, text: f.text, unit: f.unit, date: t.date ?? undefined, sub, subTone: change == null ? 'mut' : deltaTone(id, change),
        level: c.level ? { label: c.level, tone: c.tone, index: c.index ?? 0, of: 5 } : undefined,
        spark: sparkOf(dailyValues(id, inputs), today, 90),
      };
    }
    case 'race_predictor': {
      const t = vo2Trend(inputs.wellness, today);
      if (t.latest == null) return empty(id, 'Needs a VO2 max');
      const secs = raceTime(t.latest, 5000);
      if (secs == null) return empty(id, 'Needs a VO2 max');
      return { id, value: secs, text: formatDuration(secs), unit: '5 km', sub: `from VO2 max ${t.latest.toFixed(1)}`, subTone: 'mut', date: t.date ?? undefined, spark: [] };
    }
    case 'form': {
      const values = dailyValues(id, inputs);
      const last = lastReading(values);
      if (!last) return empty(id, 'No training load yet');
      const f = formatMetric(id, last.value, units);
      const lvl = formLevel(last.value);
      return { id, value: last.value, text: f.text, unit: f.unit, date: last.date, sub: lvl.label, subTone: lvl.tone, level: lvl, spark: sparkOf(values, today) };
    }
    case 'load_ratio': {
      const values = dailyValues(id, inputs);
      const last = lastReading(values);
      if (!last) return empty(id, 'Needs four weeks of activities');
      const f = formatMetric(id, last.value, units);
      const lvl = loadRatioLevel(last.value);
      return { id, value: last.value, text: f.text, unit: f.unit, date: last.date, sub: lvl.label, subTone: lvl.tone, level: lvl, spark: sparkOf(values, today) };
    }
    case 'acute_load': {
      const values = dailyValues(id, inputs);
      const last = lastReading(values);
      if (!last) return empty(id, 'No activities yet');
      const weekAgo = values.find((v) => v.date === isoDate(new Date(dayMs(last.date) - 7 * DAY)))?.value ?? null;
      const f = formatMetric(id, last.value, units);
      const d = weekAgo == null ? null : last.value - weekAgo;
      return { id, value: last.value, text: f.text, unit: f.unit, date: last.date, sub: d == null ? '7-day load' : `${formatDelta(id, d, units)} vs last week`, subTone: d == null ? 'mut' : deltaTone(id, d), spark: sparkOf(values, today) };
    }
    case 'weekly_distance': case 'weekly_time': case 'sessions': case 'lift_volume': {
      const totals = id === 'lift_volume' ? liftWeekly(inputs) : weeklyTotals(inputs, WEEKLY_PICK[id]!);
      const thisWeek = weekStartIso(new Date(dayMs(today)));
      const lastWeek = isoDate(new Date(dayMs(thisWeek) - 7 * DAY));
      const now = totals.get(thisWeek) ?? 0;
      const prev = totals.get(lastWeek) ?? 0;
      const f = formatMetric(id, now, units);
      let sub: string;
      if (id === 'sessions') {
        const week = inputs.activities.filter((a) => localDate(a) >= thisWeek);
        const runs = week.filter((a) => isRun(a.type)).length;
        const gym = week.filter((a) => a.type === 'WeightTraining' || a.type === 'Workout').length;
        sub = `${runs} run${runs === 1 ? '' : 's'} · ${gym} gym`;
      } else {
        sub = `last week ${formatMetric(id, prev, units).text}${formatMetric(id, prev, units).unit ? ` ${formatMetric(id, prev, units).unit}` : ''}`;
      }
      return { id, value: now, text: f.text, unit: f.unit, sub, subTone: 'mut', spark: weeklySpark(totals, today), href: id === 'lift_volume' ? '/lift' : '/run' };
    }
    case 'last_activity': {
      const a = inputs.activities.length ? inputs.activities[inputs.activities.length - 1] : null;
      if (!a) return empty(id, 'Nothing synced yet');
      const main = a.distance_m ? formatDistance(a.distance_m, units) : formatDurationShort(a.moving_time_s);
      return { id, value: null, text: a.name ?? a.type, sub: `${relativeDay(a.start_time_local)} · ${main}`, subTone: 'mut', date: localDate(a), spark: [], href: `/run/${a.id}` };
    }
    case 'pbs': {
      const n = countNewPbs(inputs.runPbs, inputs.liftPbs, isNewThisMonth);
      return { id, value: n, text: `${n}`, sub: n ? `new this month` : 'none yet this month', subTone: n ? 'accent' : 'mut', spark: [], href: '/pbs' };
    }
    default: {
      const values = dailyValues(id, inputs);
      const last = lastReading(values);
      if (!last) return empty(id, def.setupHint ? 'Not set up yet' : 'No data yet');
      const f = formatMetric(id, last.value, units);
      let sub: string | undefined;
      let subTone: Tone = 'mut';
      let level: Level | undefined;
      if (id === 'sleep_score') {
        level = sleepScoreLevel(last.value);
        sub = level.label;
        subTone = level.tone;
      } else if (id === 'weight' || id === 'body_fat') {
        const monthAgo = trailingMean(values.filter((v) => dayMs(v.date) <= dayMs(last.date) - 25 * DAY), last.date, 3);
        if (monthAgo != null) { sub = `${formatDelta(id, last.value - monthAgo, units)} vs a month ago`; subTone = deltaTone(id, last.value - monthAgo); }
      } else if (id === 'fitness' || id === 'fatigue' || id === 'ramp_rate') {
        const weekAgo = values.find((v) => v.date === isoDate(new Date(dayMs(last.date) - 7 * DAY)))?.value ?? null;
        if (weekAgo != null) { sub = `${formatDelta(id, last.value - weekAgo, units)} vs last week`; subTone = deltaTone(id, last.value - weekAgo); }
      } else {
        const base = trailingMean(values, last.date, 7);
        if (base != null) { sub = `${formatDelta(id, last.value - base, units)} vs 7-day`; subTone = deltaTone(id, last.value - base); }
      }
      if (!sub) sub = relativeDay(last.date);
      return { id, value: last.value, text: f.text, unit: f.unit, date: last.date, sub, subTone, level, spark: sparkOf(values, today) };
    }
  }
}

// ---------------------------------------------------------------- detail series

export type Range = 'day' | 'week' | 'month' | 'year';
export const RANGES: { value: Range; label: string; days: number }[] = [
  { value: 'day', label: 'Day', days: 14 },
  { value: 'week', label: 'Week', days: 7 },
  { value: 'month', label: 'Month', days: 30 },
  { value: 'year', label: 'Year', days: 365 },
];

export type TimelineRow = { date: string; value: number | null; text: string; delta: number | null };

export type DetailSeries = {
  /** Daily values across the range; weekly means for a year, placed on the week's Monday. */
  points: Point[];
  /** A rolling mean, when one helps read the chart. */
  baseline?: Point[];
  baselineLabel?: string;
  /** The usual range (mean ± 1 sd of the 60 days before), or a published band. */
  band?: { from: number; to: number; label: string };
  stats: { latest: number | null; mean: number | null; min: number | null; max: number | null; change: number | null };
  /** Newest first: the Day view's timeline. */
  timeline: TimelineRow[];
  kind: 'line' | 'bars' | 'points';
  yFormat: (v: number) => string;
};

const BARS: ReadonlySet<MetricId> = new Set(['sleep', 'steps', 'floors', 'acute_load', 'weekly_distance', 'weekly_time', 'sessions', 'lift_volume', 'body_battery']);
const NO_BAND: ReadonlySet<MetricId> = new Set(['steps', 'floors', 'sessions', 'fitness', 'fatigue', 'ramp_rate', 'acute_load', 'vo2max', 'body_battery', 'weekly_distance', 'weekly_time', 'lift_volume', 'readiness']);

/** Every calendar day from `from` to `to` inclusive, oldest first. */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dayMs(from); t <= dayMs(to); t += DAY) out.push(isoDate(new Date(t)));
  return out;
}

/** Daily sums of an activity-derived number. */
function dailyActivity(inputs: MetricInputs, pick: (a: ActivityListRow) => number | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of inputs.activities) {
    const v = pick(a);
    if (v == null) continue;
    m.set(localDate(a), (m.get(localDate(a)) ?? 0) + v);
  }
  return m;
}

function dailyLift(inputs: MetricInputs): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of inputs.workouts) {
    if (!w.started_at) continue;
    const d = isoDate(new Date(w.started_at));
    m.set(d, (m.get(d) ?? 0) + (w.volume_kg ?? 0));
  }
  return m;
}

/** The value for every day of the window, ending today, for any metric that has a daily reading. */
export function dailyWindow(id: MetricId, inputs: MetricInputs, days: number): { date: string; value: number | null }[] {
  const to = inputs.today;
  const from = isoDate(new Date(dayMs(to) - (days - 1) * DAY));
  const dates = eachDay(from, to);
  let byDate: Map<string, number | null>;
  if (id === 'readiness') {
    byDate = new Map(readinessSeries(inputs, days).map((p) => [p.date, p.score]));
  } else if (id === 'weekly_distance' || id === 'weekly_time' || id === 'sessions') {
    byDate = dailyActivity(inputs, WEEKLY_PICK[id]!);
  } else if (id === 'lift_volume') {
    byDate = dailyLift(inputs);
  } else if (id === 'hrv_status') {
    byDate = new Map(dailyValues('hrv', inputs).map((v) => [v.date, v.value]));
  } else if (id === 'training_status') {
    byDate = new Map(dailyValues('fitness', inputs).map((v) => [v.date, v.value]));
  } else if (id === 'race_predictor') {
    byDate = new Map(dailyValues('vo2max', inputs).map((v) => [v.date, v.value == null ? null : raceTime(v.value, 5000)]));
  } else {
    byDate = new Map(dailyValues(id, inputs).map((v) => [v.date, v.value]));
  }
  const zeroFill = id === 'weekly_distance' || id === 'weekly_time' || id === 'sessions' || id === 'lift_volume';
  return dates.map((date) => ({ date, value: byDate.get(date) ?? (zeroFill ? 0 : null) }));
}

/** Monday-keyed weekly means (or sums for the activity metrics) over the window. */
function weeklyWindow(id: MetricId, daily: { date: string; value: number | null }[]): Point[] {
  const sum = id === 'weekly_distance' || id === 'weekly_time' || id === 'sessions' || id === 'lift_volume';
  const groups = new Map<string, number[]>();
  for (const d of daily) {
    if (d.value == null) continue;
    const wk = weekStartIso(new Date(dayMs(d.date)));
    groups.set(wk, [...(groups.get(wk) ?? []), d.value]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wk, xs]) => ({ x: dayMs(wk), y: sum ? xs.reduce((s, v) => s + v, 0) : (mean(xs) as number) }));
}

/** The page's chart data for a metric over a range. */
export function detailSeries(id: MetricId, inputs: MetricInputs, range: Range): DetailSeries {
  const def = METRICS[id];
  const { units } = inputs;
  const days = RANGES.find((r) => r.value === range)?.days ?? 7;
  const yFormat = (v: number) => formatMetric(id, v, units).text;
  const kind: DetailSeries['kind'] = BARS.has(id) ? 'bars' : 'line';
  const none: DetailSeries = { points: [], stats: { latest: null, mean: null, min: null, max: null, change: null }, timeline: [], kind, yFormat };
  if (!def.available || id === 'last_activity' || id === 'pbs') return none;

  // a warm-up tail before the range so rolling means start full
  const warm = range === 'year' ? 28 : 7;
  const daily = dailyWindow(id, inputs, days + warm);
  const inRange = daily.slice(warm);
  const points: Point[] = range === 'year' ? weeklyWindow(id, inRange) : inRange.map((d) => ({ x: dayMs(d.date), y: d.value }));

  let baseline: Point[] | undefined;
  let baselineLabel: string | undefined;
  if (kind === 'line' || id === 'sleep') {
    if (range === 'month') {
      baseline = rolling(daily.map((d) => ({ x: dayMs(d.date), y: d.value })), 7).slice(warm);
      baselineLabel = '7-day';
    } else if (range === 'year') {
      baseline = rolling(weeklyWindow(id, daily), 4).slice(-points.length);
      baselineLabel = '4-week';
    }
  }

  let band: DetailSeries['band'];
  if (id === 'load_ratio') band = { from: 0.8, to: 1.4, label: 'Optimal' };
  else if (id === 'form') band = { from: -30, to: -10, label: 'Optimal' };
  else if (id === 'hrv_status') {
    const h = hrvStatus(inputs);
    if (h.baselineLow != null && h.baselineHigh != null) band = { from: h.baselineLow, to: h.baselineHigh, label: 'Baseline' };
  } else if (!NO_BAND.has(id) && id !== 'training_status' && id !== 'race_predictor') {
    const before = dailyWindow(id, inputs, days + 60).slice(0, 60).map((d) => d.value).filter(num);
    const m = mean(before);
    const s = sd(before);
    if (m != null && s != null && before.length >= 10) band = { from: m - s, to: m + s, label: 'Usual range' };
  }

  const vals = inRange.map((d) => d.value).filter(num);
  const first = inRange.find((d) => d.value != null)?.value ?? null;
  const last = lastReading(inRange);
  const stats = {
    latest: last?.value ?? null,
    mean: mean(vals),
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
    change: first != null && last ? last.value - first : null,
  };

  const timelineDays = dailyWindow(id, inputs, 14);
  const timeline: TimelineRow[] = [];
  for (let i = timelineDays.length - 1; i >= 0; i--) {
    const d = timelineDays[i];
    let prev: number | null = null;
    for (let j = i - 1; j >= 0; j--) if (timelineDays[j].value != null) { prev = timelineDays[j].value; break; }
    const f = formatMetric(id, d.value, units);
    timeline.push({ date: d.date, value: d.value, text: d.value == null ? '–' : `${f.text}${f.unit ? ` ${f.unit}` : ''}`, delta: d.value != null && prev != null ? d.value - prev : null });
  }

  return { points, baseline, baselineLabel, band, stats, timeline, kind, yFormat };
}

/** "+3 bpm" style text for a timeline delta, in the metric's terms. */
export function describeDelta(id: MetricId, d: number, units: Units): { text: string; tone: Tone } {
  return { text: formatDelta(id, d, units), tone: deltaTone(id, d) };
}
