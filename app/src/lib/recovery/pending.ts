// What the per-workout cache still owes, and the order its writers run in. The recompute rule
// (spec §14) and the catch-ups replace rows through save_workout_loads() and
// save_activity_loads(), which delete and then insert: two writers on the same rows at once clash
// on the unique indexes, and a writer that read the thresholds or the PB history before another
// writer's change would undo it. So every writer runs through one queue, a recompute asked for
// while another one waits widens that one, and the range a recompute owes is kept (the app
// persists it) until a run that covers it succeeds, so a failed or interrupted run is retried.
// Pure: no I/O; src/api/workoutLoads.ts supplies the runs and the storage.

/** Where a recompute starts: an instant (the started_at of the first workout to rescore), or
 *  null for every workout. */
export type From = string | null;

/** The earlier of two starts; null (every workout) wins and undefined is no recompute at all.
 *  Compared as instants: started_at ('+00:00') and toISOString() ('Z') are spelled differently. */
export function earlierFrom(a: From | undefined, b: From | undefined): From | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === null || b === null) return null;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/** Two maps of what each user is owed as one, keeping each user's earlier start. */
export function mergeOwed(a: Readonly<Record<string, From>>, b: Readonly<Record<string, From>>): Record<string, From> {
  const out: Record<string, From> = { ...a };
  for (const [uid, from] of Object.entries(b)) out[uid] = earlierFrom(out[uid], from) as From;
  return out;
}

export type Serial = <T>(job: () => Promise<T>) => Promise<T>;

/** Runs jobs one at a time in the order they were queued; a job that fails doesn't stop the next. */
export function serialQueue(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Where the app keeps what each user is owed. */
export interface OwedStore {
  get(uid: string): From | undefined;
  set(uid: string, from: From | undefined): void;
}

/**
 * The recompute rule's queue. request() records the range as owed, then runs `run` through
 * `serial`; while a run for the same user still waits its turn, a request widens that one to the
 * earlier start and shares its result instead. A run starts from everything the user is owed when
 * its turn comes, a failed run's range included. When it succeeds, only what was asked for since
 * it started is still owed; when it fails, everything stays owed. retryFrom() says where a retry
 * should start: what the user is owed, when nothing of theirs is queued or running.
 */
export function recomputeQueue(serial: Serial, owed: OwedStore, run: (uid: string, from: From) => Promise<number>) {
  const waiting = new Map<string, { from: From; done: Promise<number> }>();
  const running = new Set<string>();

  function request(uid: string, from: From): Promise<number> {
    owed.set(uid, earlierFrom(owed.get(uid), from));
    const queued = waiting.get(uid);
    if (queued) {
      queued.from = earlierFrom(queued.from, from) as From;
      return queued.done;
    }
    const job = { from, done: Promise.resolve(0) };
    job.done = serial(async () => {
      if (waiting.get(uid) === job) waiting.delete(uid);
      running.add(uid);
      try {
        const n = await run(uid, earlierFrom(job.from, owed.get(uid)) as From);
        owed.set(uid, waiting.get(uid)?.from);   // asked for while this ran: the next run covers it
        return n;
      } finally {
        running.delete(uid);
      }
    });
    waiting.set(uid, job);
    return job.done;
  }

  function retryFrom(uid: string): From | undefined {
    return waiting.has(uid) || running.has(uid) ? undefined : owed.get(uid);
  }

  return { request, retryFrom };
}

/**
 * Where the recompute rule must start so that every finished workout has its cache rows: the
 * earliest start among finished workouts with no workout_exercise_loads rows although one of
 * their exercises scores (`scores`: the engine has a definition for it, so scoring writes it a
 * row whatever its sets); undefined when none is missing. This is the workout an older app
 * finished with a plain upsert of finished_at, without finish_workout(). `unscorable` lists the
 * workouts with no rows and no exercise that scores (empty, or only legacy or unmapped
 * exercises): they never get rows, so the caller needn't look at their blocks again.
 */
export function unscoredFrom(
  workouts: readonly { id: string; started_at: string }[], scoredIds: ReadonlySet<string>,
  blocks: readonly { workout_id: string; exercise_id: string }[], scores: (exerciseId: string) => boolean,
): { from: string | undefined; unscorable: string[] } {
  const scoring = new Set(blocks.filter((b) => scores(b.exercise_id)).map((b) => b.workout_id));
  let from: string | undefined;
  const unscorable: string[] = [];
  for (const w of workouts) {
    if (scoredIds.has(w.id)) continue;
    if (scoring.has(w.id)) from = earlierFrom(from, w.started_at) as string;
    else unscorable.push(w.id);
  }
  return { from, unscorable };
}
