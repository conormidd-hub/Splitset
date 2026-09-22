export type Units = 'metric' | 'imperial';

export const KM_PER_MILE = 1.609344;
export const LB_PER_KG = 2.2046226218;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Metres to "10.2 km" or "6.3 mi". */
export function formatDistance(metres: number | null | undefined, units: Units, decimals = 1): string {
  if (!isNum(metres)) return '–';
  const km = metres / 1000;
  const value = units === 'imperial' ? km / KM_PER_MILE : km;
  return `${value.toFixed(decimals)} ${units === 'imperial' ? 'mi' : 'km'}`;
}

/** Seconds per km to "4:27 /km" or per mile. */
export function formatPace(secPerKm: number | null | undefined, units: Units, withUnit = true): string {
  if (!isNum(secPerKm) || secPerKm <= 0) return '–';
  const s = units === 'imperial' ? secPerKm * KM_PER_MILE : secPerKm;
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  const core = `${m}:${sec.toString().padStart(2, '0')}`;
  return withUnit ? `${core} /${units === 'imperial' ? 'mi' : 'km'}` : core;
}

export function secPerKm(distanceM: number | null | undefined, seconds: number | null | undefined): number | null {
  if (!isNum(distanceM) || !isNum(seconds) || distanceM <= 0 || seconds <= 0) return null;
  return seconds / (distanceM / 1000);
}

/** Seconds to "1:02:33" or "42:10". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return '–';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
    : `${m}:${sec.toString().padStart(2, '0')}`;
}

/** Seconds to "1h 02m" for cards. */
export function formatDurationShort(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return '–';
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${(m % 60).toString().padStart(2, '0')}m` : `${m}m`;
}

export function formatWeight(kg: number | null | undefined, units: Units, decimals = 1): string {
  if (!isNum(kg)) return '–';
  const v = units === 'imperial' ? kg * LB_PER_KG : kg;
  return `${v.toFixed(decimals)} ${units === 'imperial' ? 'lb' : 'kg'}`;
}

export function kgToDisplay(kg: number, units: Units): number {
  return units === 'imperial' ? Math.round(kg * LB_PER_KG * 10) / 10 : kg;
}

export function displayToKg(value: number, units: Units): number {
  return units === 'imperial' ? value / LB_PER_KG : value;
}

export function formatElevation(metres: number | null | undefined, units: Units): string {
  if (!isNum(metres)) return '–';
  return units === 'imperial' ? `${Math.round(metres * 3.28084)} ft` : `${Math.round(metres)} m`;
}

export function formatHr(bpm: number | null | undefined): string {
  return isNum(bpm) ? `${Math.round(bpm)}` : '–';
}

export function formatNumber(v: number | null | undefined, decimals = 0): string {
  return isNum(v) ? v.toFixed(decimals) : '–';
}
