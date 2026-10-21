import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { IDLE_MS } from '@/lib/lifting/elapsed';
import { ensureNotificationHandler } from '@/lib/restTimer';
import { useActiveWorkout } from '@/stores/activeWorkout';

/** A notice already set within this of the new idle moment stays: edits come every few seconds. */
const RESCHEDULE_MS = 60_000;

async function scheduleAt(at: number, name: string): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    ensureNotificationHandler();
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      const req = await Notifications.requestPermissionsAsync();
      if (!req.granted) return null;
    }
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Still lifting?',
        body: `${name} has been idle for 10 minutes, so its clock is paused. Open Splitset to continue, finish or discard it.`,
        sound: true,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at) },
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

/**
 * Keep a "Still lifting?" notification set for IDLE_MS after the last edit, so a workout left
 * open in a pocket gets a nudge even with the app in the background. Re-set only when the moment
 * moves by a minute or more.
 */
export async function armIdleNotice(lastActiveAt: string, name: string) {
  const at = Date.parse(lastActiveAt) + IDLE_MS;
  const { idleNotice, setIdleNotice } = useActiveWorkout.getState();
  if (idleNotice && Math.abs(idleNotice.at - at) < RESCHEDULE_MS) return;
  await cancel(idleNotice?.id);
  setIdleNotice({ at, id: null });
  const id = await scheduleAt(at, name);
  const current = useActiveWorkout.getState().idleNotice;
  if (current && current.at === at) setIdleNotice({ at, id });
}

/** No workout, or its clock is already paused: nothing to nudge about. */
export async function disarmIdleNotice() {
  const { idleNotice, setIdleNotice } = useActiveWorkout.getState();
  if (!idleNotice) return;
  setIdleNotice(null);
  await cancel(idleNotice.id);
}
