import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { useNowSeconds } from '@/lib/clock';

import { useActiveWorkout, type RestTimer } from '@/stores/activeWorkout';

let handlerSet = false;
function ensureHandler() {
  if (handlerSet || Platform.OS === 'web') return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

async function scheduleAt(endsAt: number, label: string): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    ensureHandler();
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      const req = await Notifications.requestPermissionsAsync();
      if (!req.granted) return null;
    }
    return await Notifications.scheduleNotificationAsync({
      content: { title: 'Rest over', body: label, sound: true },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(endsAt) },
    });
  } catch {
    return null;
  }
}

async function cancel(id: string | null | undefined) {
  if (!id || Platform.OS === 'web') return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // already fired or never scheduled
  }
}

/** Start (or restart) the rest countdown. The end time is absolute, so backgrounding is fine. */
export async function startRest(seconds: number, label: string) {
  const { timer, setTimer } = useActiveWorkout.getState();
  await cancel(timer?.notificationId);
  const endsAt = Date.now() + seconds * 1000;
  const next: RestTimer = { endsAt, seconds, label, notificationId: null };
  setTimer(next);
  const id = await scheduleAt(endsAt, label);
  const current = useActiveWorkout.getState().timer;
  if (current && current.endsAt === endsAt) setTimer({ ...next, notificationId: id });
}

export async function adjustRest(deltaSeconds: number) {
  const { timer } = useActiveWorkout.getState();
  if (!timer) return;
  const remaining = Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000)) + deltaSeconds;
  if (remaining <= 0) return stopRest();
  await startRest(remaining, timer.label);
}

export async function stopRest() {
  const { timer, setTimer } = useActiveWorkout.getState();
  await cancel(timer?.notificationId);
  setTimer(null);
}

/** Seconds remaining on the active rest timer, ticking once a second; null when idle. */
export function useRestRemaining(): { remaining: number; timer: RestTimer } | null {
  const timer = useActiveWorkout((s) => s.timer);
  const nowSeconds = useNowSeconds();
  if (!timer) return null;
  const remaining = Math.max(0, Math.round(timer.endsAt / 1000 - nowSeconds));
  return { remaining, timer };
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
