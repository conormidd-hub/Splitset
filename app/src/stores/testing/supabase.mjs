// A stand-in for src/lib/supabase.ts: one in-memory database for the workout store's save queue,
// with the server's last-write-wins guard (lww_guard drops an update older than the row), a log of
// every call that reached it, a delay per call and an offline switch.

export const server = {
  /** table → id → row */
  tables: new Map(),
  /** @type {{ call: 'upsert' | 'delete' | 'finish_workout', table?: string, rows?: Record<string, unknown>[], id?: string, workoutId?: string, finishedAt?: string }[]} */
  log: [],
  /** Milliseconds each call takes. */
  latency: 0,
  offline: false,
  /** How many finish_workout calls fail before one goes through (see workoutLoads.mjs). */
  failFinish: 0,
  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  },
  reset() {
    this.tables.clear();
    this.log.length = 0;
    this.latency = 0;
    this.offline = false;
    this.failFinish = 0;
  },
};

export const delay = () => new Promise((resolve) => setTimeout(resolve, server.latency));

async function call(entry, apply) {
  await delay();
  if (server.offline) return { data: null, error: new Error('Network request failed') };
  server.log.push(entry);
  apply();
  return { data: null, error: null };
}

export const supabase = {
  from: (table) => ({
    upsert: (row) => {
      const rows = [row].flat();
      return call({ call: 'upsert', table, rows }, () => {
        for (const r of rows) {
          const old = server.table(table).get(r.id);
          if (old && r.updated_at < old.updated_at) continue;   // stale write: skipped
          server.table(table).set(r.id, { ...old, ...r });
        }
      });
    },
    delete: () => ({
      eq: (_column, id) => call({ call: 'delete', table, id }, () => { server.table(table).delete(id); }),
    }),
  }),
};
