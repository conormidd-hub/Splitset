import { isRun } from '@/api/activities';
import type { WellnessDay } from '@/api/wellness';
import { isoDate } from './dates';
import { dayMs, acwr } from './trends';
import type { MetricInputs, Tone } from './metrics';

/**
 * Garmin's three verdicts, worked out here from what intervals.icu passes through.
 *
 * Garmin keeps Training Readiness, Training Status and HRV Status inside Garmin Connect: none of
 * them reach intervals.icu (its `readiness` field is Oura's). So each is estimated from the
 * same ingredients Garmin names in its manuals: last night's sleep, recovery from recent load,
 * the 7-day HRV average against a personal baseline, acute load against chronic load, the last
 * three nights of sleep, and the VO2 max trend. The bands and vocabulary are Garmin's; the
 * weights are ours and are written down below, so the number is explainable.
 */

const DAY = 86_400_000;
const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs: number[]) => {
  const m = mean(xs);
  if (m == null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};
/** Straight line from (x0 → y0) to (x1 → y1), clamped to the ends. */
const lerp = (x: number, x0: number, y0: number, x1: number, y1: number) => {
  const t = clamp((x - x0) / (x1 - x0), 0, 1);
  return y0 + (y1 - y0) * t;
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Rows up to and including `date`, oldest first. */
function upTo(rows: WellnessDay[], date: string): WellnessDay[] {
  return rows.filter((r) => r.date <= date);
}

function latestOf(rows: WellnessDay[], key: keyof WellnessDay, date?: string): { value: number; date: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (date && rows[i].date > date) continue;
    const v = rows[i][key];
    if (num(v)) return { value: v, date: rows[i].date };
  }
  return null;
}

// ---------------------------------------------------------------- HRV status

export type HrvStatusWord = 'Balanced' | 'Unbalanced' | 'Low' | 'Poor' | 'No status';
export type HrvStatus = {
  status: HrvStatusWord;
  tone: Tone;
  /** 7-night average of overnight HRV, ms. */
  weekly: number | null;
  nights: number;
  baselineLow: number | null;
  baselineHigh: number | null;
  /** Where the band came from: Garmin's own (from the export backfill) or the previous three weeks here. */
  baselineSource: 'garmin' | 'computed' | 'none';
  why: string;
};

/**
 * Garmin: the 7-day average of overnight HRV against a personal baseline range. The watch's own
 * band arrives with a Garmin export backfill (hrv_baseline_low/high); otherwise it is the mean
 * ± 1 sd of the three weeks before this one, which is what Garmin's "three weeks of consistent
 * sleep data" amounts to.
 */
export function hrvStatus(inputs: MetricInputs, asOf?: string): HrvStatus {
  const rows = asOf ? upTo(inputs.wellness, asOf) : inputs.wellness;
  const today = asOf ?? inputs.today;
  const weekStart = dayMs(today) - 7 * DAY;
  const week = rows.filter((r) => dayMs(r.date) > weekStart && num(r.hrv)).map((r) => r.hrv as number);
  const weekly = mean(week);
  const none = (why: string): HrvStatus => ({ status: 'No status', tone: 'mut', weekly, nights: week.length, baselineLow: null, baselineHigh: null, baselineSource: 'none', why });
  if (weekly == null || week.length < 4) return none(week.length ? 'Fewer than four nights of HRV this week.' : 'No overnight HRV in the last week.');

  const last = rows.length ? rows[rows.length - 1] : null;
  let low: number | null = null;
  let high: number | null = null;
  let source: HrvStatus['baselineSource'] = 'none';
  let spread: number | null = null;
  if (last && num(last.hrv_baseline_low) && num(last.hrv_baseline_high)) {
    low = last.hrv_baseline_low;
    high = last.hrv_baseline_high;
    spread = (high - low) / 2;
    source = 'garmin';
  } else {
    const prior = rows.filter((r) => dayMs(r.date) <= weekStart && dayMs(r.date) > weekStart - 21 * DAY && num(r.hrv)).map((r) => r.hrv as number);
    const m = mean(prior);
    const s = sd(prior);
    if (m != null && s != null && prior.length >= 14) {
      low = m - s;
      high = m + s;
      spread = s;
      source = 'computed';
    }
  }
  if (low == null || high == null || spread == null) return none('Needs about three weeks of nightly HRV for a baseline.');

  const fmt = (v: number) => `${Math.round(v)} ms`;
  const band = `${fmt(low)}–${fmt(high)}`;
  const base = { weekly, nights: week.length, baselineLow: low, baselineHigh: high, baselineSource: source };
  if (weekly >= low && weekly <= high) return { ...base, status: 'Balanced', tone: 'pos', why: `7-day average ${fmt(weekly)} sits inside your ${band} baseline.` };
  if (weekly > high) return { ...base, status: 'Unbalanced', tone: 'mut', why: `7-day average ${fmt(weekly)} is above your ${band} baseline. Higher can follow a rest block; watch for illness or a big stress change.` };
  // below: Garmin grades how far below
  if (weekly < low * 0.65) return { ...base, status: 'Poor', tone: 'neg', why: `7-day average ${fmt(weekly)} is far below your ${band} baseline.` };
  if (weekly < low - spread) return { ...base, status: 'Low', tone: 'neg', why: `7-day average ${fmt(weekly)} is well below your ${band} baseline: fatigue, illness or stress are the usual reasons.` };
  return { ...base, status: 'Unbalanced', tone: 'mut', why: `7-day average ${fmt(weekly)} is a little below your ${band} baseline.` };
}

const HRV_FACTOR: Record<HrvStatusWord, number | null> = { Balanced: 100, Unbalanced: 65, Low: 35, Poor: 20, 'No status': null };

// ---------------------------------------------------------------- training readiness

export type ReadinessLevel = 'Poor' | 'Low' | 'Moderate' | 'High' | 'Prime';
export type FactorKey = 'sleep' | 'recovery' | 'hrv' | 'acute_load' | 'sleep_history' | 'stress_history';
export type Factor = { key: FactorKey; label: string; score: number | null; text: string; tone: Tone; weight: number };
export type Readiness = {
  score: number | null;
  level: ReadinessLevel | null;
  tone: Tone;
  /** 'intervals' when intervals.icu supplied a readiness score (Oura does; Garmin does not), else our estimate. */
  source: 'intervals' | 'estimated' | 'none';
  date: string | null;
  factors: Factor[];
  explain: string;
};

/** Garmin's bands: Prime 95–100, High 75–94, Moderate 50–74, Low 25–49, Poor 1–24. */
export function readinessLevel(score: number): ReadinessLevel {
  if (score >= 95) return 'Prime';
  if (score >= 75) return 'High';
  if (score >= 50) return 'Moderate';
  if (score >= 25) return 'Low';
  return 'Poor';
}
export const READINESS_TONE: Record<ReadinessLevel, Tone> = { Prime: 'accent', High: 'pos', Moderate: 'pos', Low: 'mut', Poor: 'neg' };

/** The blend. Garmin says sleep and recovery dominate; the rest are long-term modifiers. */
export const READINESS_WEIGHTS: Record<FactorKey, number> = { sleep: 0.3, recovery: 0.25, hrv: 0.15, acute_load: 0.15, sleep_history: 0.1, stress_history: 0.05 };
const FACTOR_LABELS: Record<FactorKey, string> = { sleep: 'Sleep', recovery: 'Recovery', hrv: 'HRV status', acute_load: 'Acute load', sleep_history: 'Sleep history', stress_history: 'Stress history' };

const toneFor = (score: number | null): Tone => (score == null ? 'mut' : score >= 75 ? 'pos' : score >= 50 ? 'mut' : 'neg');
const hours = (s: number) => `${(s / 3600).toFixed(1)} h`;

/** Sleep as a 0–100 factor: Garmin's sleep score when the watch gives one, else hours against 7.5 h. */
function sleepFactor(row: WellnessDay | null): { score: number | null; text: string } {
  if (!row) return { score: null, text: 'No sleep data' };
  const byHours = num(row.sleep_s) ? lerp(row.sleep_s / 3600, 4, 0, 7.5, 100) : null;
  const byScore = num(row.sleep_score) ? clamp(row.sleep_score) : null;
  const score = byScore != null && byHours != null ? (byScore + byHours) / 2 : byScore ?? byHours;
  const parts = [num(row.sleep_s) ? hours(row.sleep_s) : null, num(row.sleep_score) ? `score ${Math.round(row.sleep_score)}` : null].filter(Boolean);
  return { score, text: parts.length ? parts.join(' · ') : 'No sleep data' };
}

export function trainingReadiness(inputs: MetricInputs, asOf?: string): Readiness {
  const today = asOf ?? inputs.today;
  const rows = upTo(inputs.wellness, today);
  const last = rows.length ? rows[rows.length - 1] : null;
  const acts = inputs.activities.filter((a) => a.start_time_local.slice(0, 10) <= today);

  // a synced score (Oura through intervals.icu) wins over the estimate; Garmin never sends one
  const synced = latestOf(rows, 'readiness', today);
  const recentSynced = synced && dayMs(today) - dayMs(synced.date) <= 2 * DAY ? synced : null;

  // 1. sleep: last night only counts if it is recent
  const night = last && dayMs(today) - dayMs(last.date) <= 1 * DAY ? last : null;
  const sleep = sleepFactor(night);

  // 2. recovery: fatigue against fitness, and whether yesterday was a hard day
  const ctl = latestOf(rows, 'ctl', today)?.value ?? null;
  const atl = latestOf(rows, 'atl', today)?.value ?? null;
  const lastAct = acts.length ? acts[acts.length - 1] : null;
  const sinceAct = lastAct ? (dayMs(today) - dayMs(lastAct.start_time_local.slice(0, 10))) / DAY : null;
  let recovery: number | null = null;
  let recoveryText = 'No training load yet';
  if (ctl != null && atl != null && ctl > 0) {
    const ratio = atl / ctl;
    recovery = lerp(ratio, 0.9, 100, 1.3, 20);
    if (sinceAct != null && sinceAct >= 2) recovery = clamp(recovery + 15);
    recoveryText = `fatigue ${Math.round(atl)} vs fitness ${Math.round(ctl)}${sinceAct != null ? ` · ${sinceAct === 0 ? 'trained today' : sinceAct === 1 ? 'trained yesterday' : `${sinceAct} days since training`}` : ''}`;
  } else if (sinceAct != null) {
    recovery = sinceAct >= 2 ? 100 : sinceAct === 1 ? 75 : 50;
    recoveryText = sinceAct === 0 ? 'trained today' : sinceAct === 1 ? 'trained yesterday' : `${sinceAct} days since training`;
  }

  // 3. HRV status
  const hrv = hrvStatus({ ...inputs, wellness: rows }, today);
  const hrvScore = HRV_FACTOR[hrv.status];
  const hrvText = hrv.weekly != null ? `${hrv.status} · ${Math.round(hrv.weekly)} ms` : 'No status';

  // 4. acute load: the last 7 days against the last 28
  const load = acwr(acts);
  const todayMs = dayMs(today);
  const at = <T extends { x: number }>(ps: T[]) => ps.filter((p) => p.x <= todayMs).pop() ?? null;
  const acute = at(load.acute);
  const ratio = at(load.ratio);
  const r = ratio?.y ?? null;
  const acuteScore = r == null ? null : r <= 0.8 ? 90 : r <= 1.0 ? 100 : r <= 1.5 ? lerp(r, 1.0, 100, 1.5, 40) : lerp(r, 1.5, 40, 2.0, 20);
  const acuteText = r == null ? (acute ? 'Needs four weeks of training' : 'No activities yet') : `ratio ${r.toFixed(2)} · ${r < 0.8 ? 'low' : r <= 1.4 ? 'optimal' : r < 2 ? 'high' : 'very high'}`;

  // 5. sleep history: the last three nights
  const nights = rows.filter((x) => dayMs(x.date) > todayMs - 3 * DAY && num(x.sleep_s)).map((x) => x.sleep_s as number);
  const avgNight = mean(nights);
  const historyScore = avgNight == null ? null : lerp(avgNight / 3600, 4, 0, 7.5, 100);
  const historyText = avgNight == null ? 'No sleep in the last 3 nights' : `${nights.length}-night average ${hours(avgNight)}`;

  // 6. stress history: intervals.icu's own 1–4 rating when the athlete fills it in (Garmin's 0–100 stress never arrives)
  const stress = rows.filter((x) => dayMs(x.date) > todayMs - 3 * DAY && num(x.stress)).map((x) => x.stress as number);
  const avgStress = mean(stress);
  const stressScore = avgStress == null ? null : lerp(avgStress, 1, 100, 4, 20);
  const stressText = avgStress == null ? 'Not rated' : `${avgStress.toFixed(1)} of 4 over ${stress.length} day${stress.length === 1 ? '' : 's'}`;

  const factors: Factor[] = [
    { key: 'sleep', label: FACTOR_LABELS.sleep, score: sleep.score, text: sleep.text, tone: toneFor(sleep.score), weight: READINESS_WEIGHTS.sleep },
    { key: 'recovery', label: FACTOR_LABELS.recovery, score: recovery, text: recoveryText, tone: toneFor(recovery), weight: READINESS_WEIGHTS.recovery },
    { key: 'hrv', label: FACTOR_LABELS.hrv, score: hrvScore, text: hrvText, tone: hrv.status === 'No status' ? 'mut' : hrv.tone, weight: READINESS_WEIGHTS.hrv },
    { key: 'acute_load', label: FACTOR_LABELS.acute_load, score: acuteScore, text: acuteText, tone: toneFor(acuteScore), weight: READINESS_WEIGHTS.acute_load },
    { key: 'sleep_history', label: FACTOR_LABELS.sleep_history, score: historyScore, text: historyText, tone: toneFor(historyScore), weight: READINESS_WEIGHTS.sleep_history },
    { key: 'stress_history', label: FACTOR_LABELS.stress_history, score: stressScore, text: stressText, tone: toneFor(stressScore), weight: READINESS_WEIGHTS.stress_history },
  ];

  const known = factors.filter((f) => f.score != null);
  const weightSum = known.reduce((s, f) => s + f.weight, 0);
  const hasCore = known.some((f) => f.key === 'sleep' || f.key === 'recovery');
  const estimate = hasCore && weightSum > 0 ? Math.round(known.reduce((s, f) => s + (f.score as number) * f.weight, 0) / weightSum) : null;

  const score = recentSynced ? Math.round(clamp(recentSynced.value)) : estimate;
  const source: Readiness['source'] = recentSynced ? 'intervals' : estimate != null ? 'estimated' : 'none';
  const level = score != null ? readinessLevel(Math.max(1, score)) : null;
  const weakest = [...known].sort((a, b) => (a.score as number) - (b.score as number)).slice(0, 2).filter((f) => (f.score as number) < 70);
  const explain = score == null
    ? 'Needs a night of sleep data or some training load to estimate.'
    : weakest.length ? `${weakest.map((f) => f.label.toLowerCase()).join(' and ')} ${weakest.length === 1 ? 'is' : 'are'} holding it back.`
    : 'Everything points the right way.';
  return {
    score,
    level,
    tone: level ? READINESS_TONE[level] : 'mut',
    source,
    date: recentSynced?.date ?? (score != null ? today : null),
    factors,
    explain: explain.charAt(0).toUpperCase() + explain.slice(1),
  };
}

// ---------------------------------------------------------------- training status

export type TrainingStatusWord = 'Peaking' | 'Productive' | 'Maintaining' | 'Recovery' | 'Unproductive' | 'Detraining' | 'Overreaching' | 'Strained' | 'No status';
export type Trend = 'rising' | 'steady' | 'falling' | 'unknown';
export type Status = {
  status: TrainingStatusWord;
  tone: Tone;
  why: string;
  loadTrend: Trend;
  vo2Trend: Trend;
  vo2Change: number | null;
  /** Sum of training load over the last 7 days. */
  acuteLoad: number;
  loadRatio: number | null;
  ctl: number | null;
  atl: number | null;
  form: number | null;
  rampRate: number | null;
};

export const STATUS_TONE: Record<TrainingStatusWord, Tone> = {
  Peaking: 'accent', Productive: 'pos', Maintaining: 'mut', Recovery: 'mut', Unproductive: 'neg', Detraining: 'neg', Overreaching: 'neg', Strained: 'neg', 'No status': 'mut',
};

/** Garmin's own one-liners, for the "what each status means" list. */
export const STATUS_MEANING: Record<TrainingStatusWord, string> = {
  Peaking: 'Ideal race condition: a recently reduced load is letting your body recover and compensate for earlier training. It only lasts a short while.',
  Productive: 'Your current training load is moving your fitness and performance in the right direction.',
  Maintaining: 'Your load is enough to hold your fitness. To improve, add variety or volume.',
  Recovery: 'A lighter load is letting your body recover, which hard training blocks need.',
  Unproductive: 'Your load is at a good level, but your fitness is slipping: look at rest, food and stress.',
  Detraining: 'You have trained much less than usual for a week or more, and it is costing fitness.',
  Overreaching: 'Your load is very high and counterproductive. Add lighter days.',
  Strained: 'Your recovery and your training load are out of balance.',
  'No status': 'Needs a couple of weeks of activities with VO2 max estimates.',
};

/**
 * Garmin reads Training Status off the VO2 max trend, acute load and HRV status over several
 * weeks. Here: the load trend is fitness (CTL) now against four weeks ago, the VO2 trend is the
 * latest estimate against the mean from four weeks earlier, the load ratio is 7-day over 28-day
 * load, and form is fitness minus fatigue.
 */
export function trainingStatus(inputs: MetricInputs, asOf?: string): Status {
  const today = asOf ?? inputs.today;
  const todayMs = dayMs(today);
  const rows = upTo(inputs.wellness, today);
  const acts = inputs.activities.filter((a) => a.start_time_local.slice(0, 10) <= today);

  const ctlNow = latestOf(rows, 'ctl', today);
  const atlNow = latestOf(rows, 'atl', today);
  const ctl = ctlNow?.value ?? null;
  const atl = atlNow?.value ?? null;
  const form = ctl != null && atl != null ? ctl - atl : null;
  const rampRate = latestOf(rows, 'ramp_rate', today)?.value ?? null;

  // the CTL four weeks ago: the closest reading in the week around that day
  const then = rows.filter((r) => num(r.ctl) && Math.abs(dayMs(r.date) - (todayMs - 28 * DAY)) <= 4 * DAY).map((r) => r.ctl as number);
  const ctlThen = mean(then);
  let loadTrend: Trend = 'unknown';
  if (ctl != null && ctlThen != null) {
    const d = ctl - ctlThen;
    loadTrend = d >= 3 ? 'rising' : d <= -3 ? 'falling' : 'steady';
  } else if (rampRate != null) {
    loadTrend = rampRate >= 1.5 ? 'rising' : rampRate <= -1.5 ? 'falling' : 'steady';
  }

  const vo2Now = latestOf(rows, 'vo2max', today);
  const vo2Then = mean(rows.filter((r) => num(r.vo2max) && dayMs(r.date) <= todayMs - 21 * DAY && dayMs(r.date) > todayMs - 42 * DAY).map((r) => r.vo2max as number));
  const vo2Change = vo2Now && vo2Then != null ? Math.round((vo2Now.value - vo2Then) * 10) / 10 : null;
  const vo2Trend: Trend = vo2Change == null ? 'unknown' : vo2Change >= 0.5 ? 'rising' : vo2Change <= -0.5 ? 'falling' : 'steady';

  const load = acwr(acts);
  const at = <T extends { x: number }>(ps: T[]) => ps.filter((p) => p.x <= todayMs).pop() ?? null;
  const loadRatio = at(load.ratio)?.y ?? null;
  const acuteLoad = acts.filter((a) => dayMs(a.start_time_local.slice(0, 10)) > todayMs - 7 * DAY).reduce((s, a) => s + (a.load ?? 0), 0);
  const recent14 = acts.filter((a) => dayMs(a.start_time_local.slice(0, 10)) > todayMs - 14 * DAY);
  const sinceLast = acts.length ? (todayMs - dayMs(acts[acts.length - 1].start_time_local.slice(0, 10))) / DAY : null;
  const hrv = hrvStatus({ ...inputs, wellness: rows }, today);

  const base = { loadTrend, vo2Trend, vo2Change, acuteLoad: Math.round(acuteLoad), loadRatio, ctl, atl, form, rampRate };
  const done = (status: TrainingStatusWord, why: string): Status => ({ status, tone: STATUS_TONE[status], why, ...base });

  const historyDays = rows.filter((r) => num(r.ctl)).length;
  if (ctl == null || historyDays < 14 || (acts.length < 3 && recent14.length === 0)) {
    return done('No status', 'Needs about two weeks of synced training before a status can be read.');
  }
  if (sinceLast != null && sinceLast >= 8 && (loadTrend === 'falling' || (ctlThen != null && ctl < ctlThen))) {
    return done('Detraining', `No training for ${Math.round(sinceLast)} days and fitness is slipping.`);
  }
  const unbalanced = hrv.status === 'Low' || hrv.status === 'Poor' || (hrv.status === 'Unbalanced' && hrv.weekly != null && hrv.baselineLow != null && hrv.weekly < hrv.baselineLow);
  if ((loadRatio != null && loadRatio >= 1.5) || (rampRate != null && rampRate >= 8)) {
    if (unbalanced || (form != null && form < -30)) return done('Strained', 'A very high load and signs your body is not keeping up: HRV below baseline or deep fatigue.');
    return done('Overreaching', `Load is very high${loadRatio != null ? ` (ratio ${loadRatio.toFixed(2)})` : ''}. A few lighter days will let it pay off.`);
  }
  if (unbalanced && loadRatio != null && loadRatio >= 1.0) {
    return done('Strained', 'Your load is normal but HRV says recovery is lagging behind it.');
  }
  if (loadTrend === 'falling' && form != null && form > 5 && vo2Trend !== 'falling' && ctlThen != null && ctl >= ctlThen * 0.8) {
    return done('Peaking', 'A reduced load after solid training: you are fresh and your fitness is holding. It does not last long.');
  }
  if (loadTrend !== 'falling' && vo2Trend === 'rising') {
    return done('Productive', `Your training load is ${loadTrend === 'rising' ? 'rising' : 'steady'} and your VO2 max is going up (${vo2Change != null && vo2Change > 0 ? '+' : ''}${vo2Change ?? ''} over four weeks).`);
  }
  if (loadTrend !== 'falling' && vo2Trend === 'falling') {
    return done('Unproductive', `Your load is ${loadTrend === 'rising' ? 'rising' : 'at a good level'} but your VO2 max is drifting down (${vo2Change} over four weeks).`);
  }
  if (loadTrend === 'falling' && form != null && form > 10) {
    return done('Recovery', 'A lighter load is giving your body time to absorb earlier training.');
  }
  return done('Maintaining', vo2Trend === 'unknown' ? 'Your load is holding your fitness. VO2 max has no recent change to read.' : 'Your load is holding your fitness. More variety or volume would move it.');
}

// ---------------------------------------------------------------- a day-by-day readiness series

/** The estimated score for each of the last `days` days, for the readiness page's chart. */
export function readinessSeries(inputs: MetricInputs, days: number): { date: string; score: number | null }[] {
  const out: { date: string; score: number | null }[] = [];
  const todayMs = dayMs(inputs.today);
  for (let i = days - 1; i >= 0; i--) {
    // local calendar days: dayMs is local noon, so a day's step never crosses midnight on a DST change
    const date = isoDate(new Date(todayMs - i * DAY));
    out.push({ date, score: trainingReadiness(inputs, date).score });
  }
  return out;
}

/** Whether there is a run in the window, for pages that want to say "no runs this week". */
export function runsIn(inputs: MetricInputs, days: number): number {
  const cutoff = dayMs(inputs.today) - days * DAY;
  return inputs.activities.filter((a) => isRun(a.type) && dayMs(a.start_time_local.slice(0, 10)) > cutoff).length;
}
