// The workout clock: elapsed time with pauses taken out, and when an idle workout pauses. Pure,
// so it is tested under Node; the workout screen, the active-workout bar and the store use it.

/** How long a workout sits without an edit before its clock pauses. */
export const IDLE_MS = 10 * 60_000;

export type Clocked = {
  startedAt: string;
  /** The last edit; the start when nothing has been logged yet. */
  lastActiveAt?: string | null;
  /** Set while the clock is paused: when it paused. */
  pausedAt?: string | null;
  /** Seconds spent paused before the current pause. */
  pausedS?: number | null;
};

/** Whole seconds on the clock at `nowMs`: since the start, less every pause. A paused clock holds. */
export function elapsedSeconds(w: Clocked, nowMs: number): number {
  const end = w.pausedAt ? Date.parse(w.pausedAt) : nowMs;
  const s = (end - Date.parse(w.startedAt)) / 1000 - (w.pausedS ?? 0);
  return Math.max(0, Math.round(s));
}

/** "12:05", or "1:02:09" past an hour. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The instant (epoch ms) an unpaused workout's clock pauses: IDLE_MS after its last edit. */
export function idleAt(w: Clocked): number {
  return Date.parse(w.lastActiveAt ?? w.startedAt) + IDLE_MS;
}

/** True when the clock should pause now: not paused, and idle for IDLE_MS or more. */
export function shouldPause(w: Clocked, nowMs: number): boolean {
  return !w.pausedAt && nowMs >= idleAt(w);
}

/** Whole minutes since the last edit, for "You've been away 14 min". */
export function awayMinutes(w: Clocked, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(w.lastActiveAt ?? w.startedAt)) / 60_000));
}

/** The seconds a pause that started at `pausedAt` has lasted by `nowMs`. */
export function pausedFor(pausedAt: string, nowMs: number): number {
  return Math.max(0, (nowMs - Date.parse(pausedAt)) / 1000);
}
