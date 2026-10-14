# splitset-sync

Pulls every connected user's activities, daily wellness and per-activity detail from
intervals.icu into Splitset's Postgres. Runs twice daily on GitHub Actions and on demand
from a laptop.

```bash
uv sync                                   # install (creates .venv)
uv run pytest                             # unit tests, no network or database needed
uv run splitset-sync run --dry-run        # show what would be fetched, write nothing
uv run splitset-sync run                  # incremental sync for every active connection
uv run splitset-sync run --user conor@example.com --full --max-streams 50
uv run splitset-sync connect --email conor@example.com --athlete-id i123456 --api-key ...
uv run splitset-sync link --user conor@example.com --days 30
uv run splitset-sync push-plan --dry-run      # what would change on the intervals.icu calendar
uv run splitset-sync backfill-garmin --email conor@example.com "C:/path/to/DI_CONNECT" --dry-run
uv run splitset-sync refresh-details --user conor@example.com --missing-cadence --dry-run
```

Needs `SUPABASE_DB_URL` (the Supabase session-pooler connection string) in the environment
or in a `.env` at the repo root. See `.env.example`.

The app starts runs too ("Sync now", and `push-plan` after a plan change) by dispatching the
`sync` workflow for one athlete; see the README's Sync now setup. Runs can overlap, so each
athlete's sync and plan push hold a Postgres advisory lock: a second run waits, then reads fresh
state, and never sends the same planned run twice.

## What a run does, per user

1. Window: from `oldest_date` on the first run or `--full`, otherwise from seven days before
   the newest stored activity so late edits are picked up.
2. Activities → typed rows, upserted by intervals.icu id. intervals.icu is the source of truth,
   so every synced column is overwritten. An empty response writes nothing.
3. Wellness for the same window, merged column by column so a Garmin export backfill survives.
4. Streams for activities that have no detail row yet, newest first, capped by `--max-streams`.
   Activities without streams get a `has_streams=false` row so they are never refetched.
   The detail row holds km splits, best efforts, a thinned polyline with its bbox and `samples`
   (`t, d, hr, alt, cad` every 10 s plus `route_d`, the watch distance at each polyline point).
   Running cadence is normalised to full steps per minute once per activity: when the median of
   the non-zero samples is below 120 the watch reported per leg and the whole stream is doubled.
5. If the athlete turned on "Planned runs on your watch", the next two weeks of planned runs go
   to their intervals.icu calendar, which passes them to Garmin Connect (see `planpush.py`).
   Moved sessions are updated in place; skipped, deleted or moved-into-the-past ones are removed.
6. Plan sessions and app workouts are linked to the activities that fulfilled them (see `linking.py`).
7. A `sync_runs` row with the counts. One user's failure never stops the others.

Auth failures (401/403) count up on the connection; after three in a row it is marked
`auth_failed` and skipped until the user reconnects in the app.

## Rebuilding detail rows: `refresh-details`

`run` writes an `activity_details` row once and never touches it again, so a change to the
derivation only reaches new activities. `refresh-details` refetches the streams of activities
that already have a row with `has_streams`, rebuilds the row through the same `derive_details`
and upserts it (`fetched_at` moves to now), newest first, for every active connection or the
`--user` given. It needs the connection's API key, pauses `SYNC_STREAM_SLEEP_S` between
downloads and commits every 20 rows, so it can be stopped and restarted.

```bash
uv run splitset-sync refresh-details --dry-run                       # count what would be rebuilt
uv run splitset-sync refresh-details --missing-cadence               # backfill cad and route_d everywhere
uv run splitset-sync refresh-details --user conor@example.com --max 50
```

- `--missing-cadence` restricts the work to rows whose `samples` have no `cad` key, which is
  exactly the rows written before October 2026. Rebuilt rows always carry the key (null when the
  device recorded no cadence), so repeating the command converges on "nothing to do".
- `--max N` stops after N activities per user; the default is all of them.
- A single activity's download failure is logged and skipped (the old row stays); an auth
  failure stops that user after committing what was already rebuilt.
