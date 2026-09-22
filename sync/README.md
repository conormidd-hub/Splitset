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
```

Needs `SUPABASE_DB_URL` (the Supabase session-pooler connection string) in the environment
or in a `.env` at the repo root. See `.env.example`.

## What a run does, per user

1. Window: from `oldest_date` on the first run or `--full`, otherwise from seven days before
   the newest stored activity so late edits are picked up.
2. Activities → typed rows, upserted by intervals.icu id. intervals.icu is the source of truth,
   so every synced column is overwritten. An empty response writes nothing.
3. Wellness for the same window, merged column by column so a Garmin export backfill survives.
4. Streams for activities that have no detail row yet, newest first, capped by `--max-streams`.
   Activities without streams get a `has_streams=false` row so they are never refetched.
5. A `sync_runs` row with the counts. One user's failure never stops the others.

Auth failures (401/403) count up on the connection; after three in a row it is marked
`auth_failed` and skipped until the user reconnects in the app.
