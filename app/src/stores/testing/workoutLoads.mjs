// A stand-in for src/api/workoutLoads.ts: finish_workout against the fake server in supabase.mjs.
// Like the real one it needs the workout row on the server, and calling it again with the same
// finishedAt changes nothing.

import { delay, server } from './supabase.mjs';

export async function finishWorkoutRemote(_uid, workoutId, finishedAt) {
  await delay();
  if (server.offline) throw new Error('Network request failed');
  if (server.failFinish > 0) {
    server.failFinish -= 1;
    throw new Error('finish_workout failed');
  }
  const workout = server.table('workouts').get(workoutId);
  if (!workout) throw new Error('This workout has not reached the server yet');
  server.log.push({ call: 'finish_workout', workoutId, finishedAt });
  server.table('workouts').set(workoutId, { ...workout, finished_at: finishedAt });
}
