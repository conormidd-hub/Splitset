import { useSyncExternalStore } from 'react';

/**
 * A shared once-a-second clock. Components read the current second through
 * useSyncExternalStore, which keeps render pure: Date.now() is only called inside the
 * subscription tick, never during render.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowSeconds = Math.floor(Date.now() / 1000);

function tick() {
  const next = Math.floor(Date.now() / 1000);
  if (next !== nowSeconds) {
    nowSeconds = next;
    listeners.forEach((l) => l());
  }
}

function subscribe(listener: () => void) {
  tick();
  listeners.add(listener);
  if (!timer) timer = setInterval(tick, 250);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => nowSeconds;

/** Current time in whole seconds since the epoch, re-rendering the caller every second. */
export function useNowSeconds(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
