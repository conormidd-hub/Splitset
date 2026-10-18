// Build phase 9: the Recovery map settings. Each setting is a per-user override (user_thresholds)
// of one leaf of data/recovery_constants.json, layered on by the Phase 1 loader; the defaults
// never change. Pure, so it is tested under Node; the screen is app/(app)/settings/recovery.tsx.
//
// The plan fixes one range, base recovery hours 12–96 h. The other ranges are guard rails for the
// controls (so a slip of the thumb can't zero a weight), not model constants.

import { MUSCLE_IDS, type MuscleId } from './library.ts';
import { isValidOverride, thresholdsFor, type ThresholdOverride, type Thresholds } from './thresholds.ts';

export type SettingGroup = 'load' | 'recovery' | 'figure' | 'pbs' | 'cardio';

export interface NumberSetting {
  kind: 'number';
  key: string;
  group: SettingGroup;
  label: string;
  /** One line, plain English. */
  help: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  integer?: boolean;
}

export interface ChoiceSetting {
  kind: 'choice';
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  choices: { value: string; label: string }[];
}

export interface ToggleSetting {
  kind: 'toggle';
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
}

export type Setting = NumberSetting | ChoiceSetting | ToggleSetting;

/** Base recovery hours per muscle (build phase 9). */
export const BASE_HOURS = { min: 12, max: 96, step: 1 } as const;

const num = (key: string, group: SettingGroup, label: string, help: string, min: number, max: number, step: number,
  extra: Partial<NumberSetting> = {}): NumberSetting => ({ kind: 'number', key, group, label, help, min, max, step, ...extra });

/** Every setting, in screen order. `nameOf` gives each muscle's display name. */
export function settingDefs(c: Thresholds, nameOf: (id: MuscleId) => string): Setting[] {
  return [
    num('role_weights.secondary', 'load', 'Secondary muscles',
      'Share of an exercise\'s load a secondary muscle takes; the primary muscle takes all of it.', 0, 1, 0.05),
    num('role_weights.tertiary', 'load', 'Tertiary muscles',
      'Share a stabilising muscle takes. Raise it if stabilisers feel more worked than the map shows.', 0, 1, 0.05),
    num('fatigue_factors.high', 'load', 'Heavy exercises',
      'Multiplier for barbell squats, deadlifts and other heavy compounds.', 0.5, 2, 0.05, { unit: '×' }),
    num('fatigue_factors.standard', 'load', 'Normal exercises',
      'Multiplier for presses, rows, pull-ups and dumbbell work.', 0.5, 2, 0.05, { unit: '×' }),
    num('fatigue_factors.low', 'load', 'Light exercises',
      'Multiplier for machines, cables, bands and light core work.', 0.5, 2, 0.05, { unit: '×' }),
    num('recovery.slope', 'recovery', 'Extra recovery per unit of load',
      'How much longer a muscle takes to recover after a harder session. 0 means load never stretches it.', 0, 1, 0.05),
    num('base_recovery_hours.default', 'recovery', 'Every other muscle',
      'Recovery time after a light-to-moderate session, for muscles without their own value below.',
      BASE_HOURS.min, BASE_HOURS.max, BASE_HOURS.step, { unit: 'h', integer: true }),
    ...MUSCLE_IDS.map((id) => num(`base_recovery_hours.${id}`, 'recovery', nameOf(id),
      `Recovery time for ${nameOf(id).toLowerCase()} after a light-to-moderate session.`,
      BASE_HOURS.min, BASE_HOURS.max, BASE_HOURS.step, { unit: 'h', integer: true })),
    ...c.levels.slice(1).map((band) => num(`levels.${band.level}.min`, 'figure', `${band.label} from`,
      `The fatigue at which a muscle turns ${band.label.toLowerCase()}. Boundaries must stay in increasing order.`,
      0.05, 10, 0.05)),
    num('fatigue.weekly_cap', 'figure', 'Weekly cap',
      `Total load in a week above which a muscle shows at least ${c.levels[c.fatigue.weekly_cap_min_level].label}, however fresh it feels.`,
      2, 20, 0.5),
    num('pb.window_days', 'pbs', 'PB window',
      'How many days back your best counts as current. Older bests are discounted as lapsed.', 7, 90, 1, { unit: 'days', integer: true }),
    { kind: 'choice', key: 'pb.manual_policy', group: 'pbs', label: 'A logged session replaces my known best',
      help: 'When a best you typed in stops being your reference.',
      choices: [{ value: 'max', label: 'Only when it\'s higher' }, { value: 'replace_on_log', label: 'At the next logged set' }] },
    { kind: 'toggle', key: 'cardio.enabled_default', group: 'cardio', label: 'Count runs, rides, swims, hikes and rows',
      help: 'Activities synced from Garmin or Strava add load like sets do: legs for runs, rides and hikes; back and arms for swims and rows.' },
  ];
}

// ---------------------------------------------------------------- values

function leaf(t: Thresholds, key: string): unknown {
  let cur: unknown = t;
  for (const seg of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** A setting's value in `t`. A muscle without its own base hours has the default's. */
export function valueAt(t: Thresholds, key: string): number | string | boolean {
  const v = leaf(t, key);
  if (v === undefined && key.startsWith('base_recovery_hours.')) return t.base_recovery_hours.default;
  return v as number | string | boolean;
}

/** Edits on the screen, by key: a new value, or null for "reset to default". */
export type Edits = Readonly<Record<string, number | string | boolean | null>>;

/** The thresholds the user would have after saving `edits`. */
export function afterEdits(base: Thresholds, userId: string, rows: readonly ThresholdOverride[], edits: Edits): Thresholds {
  const kept = rows.filter((r) => r.user_id === userId && !(r.key in edits));
  const added = Object.entries(edits).filter(([, v]) => v != null).map(([key, value]) => ({ user_id: userId, key, value }));
  return thresholdsFor(base, userId, [...kept, ...added]);
}

/** Whether a key has the user's own value (an override row, or an edit not yet saved). */
export function isOverridden(rows: readonly ThresholdOverride[], edits: Edits, key: string): boolean {
  return key in edits ? edits[key] != null : rows.some((r) => r.key === key);
}

/**
 * The value `key` would have with no row of its own, under the user's other rows and edits: what
 * "Reset to default" gives it. For a muscle without its own base hours in the constants, that is
 * "Every other muscle", the user's value of it included.
 */
export function resetValue(base: Thresholds, userId: string, rows: readonly ThresholdOverride[], edits: Edits, key: string): number | string | boolean {
  return valueAt(afterEdits(base, userId, rows, { ...edits, [key]: null }), key);
}

/** Whether a setting is a muscle's base hours that follows "Every other muscle" when reset. */
export function followsDefault(base: Thresholds, key: string): boolean {
  return key.startsWith('base_recovery_hours.') && key !== 'base_recovery_hours.default' && leaf(base, key) === undefined;
}

/**
 * `edits` with `key` set to `value` (null resets it). A value equal to the key's reset value is a
 * reset, a reset of a key with no row is no edit at all, and a value equal to the saved row is no
 * edit either, so a + then a − leaves nothing to save.
 */
export function withEdit(base: Thresholds, userId: string, rows: readonly ThresholdOverride[], edits: Edits,
  key: string, value: number | string | boolean | null): Edits {
  const rest = Object.fromEntries(Object.entries(edits).filter(([k]) => k !== key));
  const row = rows.find((r) => r.user_id === userId && r.key === key);
  if (value != null && value !== resetValue(base, userId, rows, edits, key)) return row && row.value === value ? rest : { ...rest, [key]: value };
  return row ? { ...rest, [key]: null } : rest;
}

/** What stops `edits` saving, in words; empty when they can be saved. */
export function validateEdits(base: Thresholds, userId: string, rows: readonly ThresholdOverride[], edits: Edits, defs: readonly Setting[]): string[] {
  const out: string[] = [];
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(edits)) {
    if (value == null) continue;
    const def = byKey.get(key);
    if (!def || !isValidOverride(base, key, value)) {
      out.push(`${def?.label ?? key} can't be set to ${String(value)}.`);
    } else if (def.kind === 'number') {
      const n = value as number;
      if (n < def.min || n > def.max) out.push(`${def.label} must be between ${def.min} and ${def.max}${def.unit ? ` ${def.unit}` : ''}.`);
      else if (def.integer && !Number.isInteger(n)) out.push(`${def.label} must be a whole number.`);
    }
  }
  const after = afterEdits(base, userId, rows, edits);
  for (let i = 2; i < after.levels.length; i++) {
    if (!(after.levels[i].min > after.levels[i - 1].min)) {
      out.push(`${after.levels[i].label} must start above ${after.levels[i - 1].label} (${after.levels[i - 1].min}).`);
    }
  }
  return out;
}

/**
 * The writes that save `edits` over the user's `rows`: rows to upsert, and keys to delete (a
 * reset, or a value equal to the key's reset value, so no copy of a default is ever stored and a
 * muscle at "Every other muscle"'s hours keeps following it).
 */
export function diffOverrides(base: Thresholds, userId: string, rows: readonly ThresholdOverride[], edits: Edits): {
  upsert: { key: string; value: number | string | boolean }[]; remove: string[];
} {
  const upsert: { key: string; value: number | string | boolean }[] = [];
  const remove: string[] = [];
  for (const [key, value] of Object.entries(edits)) {
    if (value == null || value === resetValue(base, userId, rows, edits, key)) remove.push(key);
    else upsert.push({ key, value });
  }
  return { upsert, remove };
}

/** A number moved by `steps` of the setting's step, kept in range and rid of float noise. */
export function stepValue(def: NumberSetting, value: number, steps: number): number {
  const v = Math.round((value + steps * def.step) / def.step) * def.step;
  return Math.min(def.max, Math.max(def.min, Math.round(v * 1000) / 1000));
}

// ---------------------------------------------------------------- the history slider

/** The history slider's span (build phase 9): the last 28 days, one sample a day. */
export const HISTORY_DAYS = 28;
export const HISTORY_STEP_HOURS = 24;
