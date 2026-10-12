# Splitset

One personal database for running and lifting.

Garmin → intervals.icu → a Python sync job → **Supabase (Postgres)** → Grafana for analysis,
plus an **Expo app** (iOS, Android, web) that logs lifting Strong-style and shows runs,
wellness and a training plan from the same tables.

Built for one person first, on free tiers, with accounts and row-level security from day one
so friends can later sign up in the app, paste their own intervals.icu credentials, and get a
private copy of everything on the same project.

## How it fits together

```
Garmin watch ──► intervals.icu ──► sync/ (Python, GitHub Actions cron) ──► Supabase Postgres
                                                                              │        │
                                                          Grafana Cloud ◄─────┘        └──► Expo app
                                                          (reporting views)                 (iOS / Android / web)
```

| Folder | Job |
|---|---|
| `supabase/` | Supabase CLI project: SQL migrations and seed data. The schema lives here. |
| `sync/` | `splitset-sync`, the Python job that pulls activities, wellness and per-activity detail from intervals.icu into Postgres for every connected user. |
| `app/` | The Expo app. |
| `grafana/` | Dashboard JSON and datasource notes. |
| `reference/` | A friend's running dashboard that this project was modelled on. Left exactly as received; see credits. |

## Status

Milestones, in order. `[x]` verified end to end, `[~]` code complete and awaiting a runtime check.

- [x] **M0** Scaffold: toolchain, repo layout, Supabase project, `profiles` table
- [x] **M1** Running schema: connections (Vault-protected keys), activities, activity details, wellness, sync runs
- [x] **M2** Sync job runs from a laptop and backfills history
- [x] **M3** Sync job runs twice daily on GitHub Actions
- [~] **M4** Grafana dashboard on a read-only reporting schema (every panel query runs as `grafana_reader` on synced data; Grafana Cloud import pending)
- [x] **M5** Lifting schema: exercises, routines, workouts, sets, records
- [~] **M6** App shell: sign-in, Connect intervals.icu, Settings, Today (verified on web against a local stack: email-code sign-in, connect/pause/disconnect, units, delete account; needs the real project's keys)
- [~] **M7** Lifting logger: routines, active workout with rest timer, history, PRs (verified on web, including a reload mid-workout; on-device check pending)
- [~] **M8** Training plan calendar linked to real activities (auto-link verified on real data; plan UI and gym-session linking verified on web)
- [~] **M9** Runs, wellness and trends in the app (charts, route trace, exercise progress; verified on web, on-device check pending)
- [~] **M10** Garmin export backfill for wellness history before intervals.icu (verified on a synthetic export; needs a real one)
- [ ] **M11** Custom dashboards: a Dashboards tab with a tile builder over the synced data (numbers, lines, bars, lists), live preview, drag-to-arrange with animation, several dashboards with a switcher and reorder; Trends becomes the built-in template
- [ ] **M12** Friend onboarding: invite-only sign-up, a first-run wizard from "create an intervals.icu account" to "paste your key" with live validation, first sync started on the spot
- [ ] **M13** Security hardening: sync job on a cloud host (Google, AWS or Azure) reading secrets from its managed secret store, RLS tests in CI, encrypted backups, keychain session storage, SECURITY.md

## Setup

Filled in as each milestone lands.

### Prerequisites

- Python 3.12 and [uv](https://docs.astral.sh/uv/) for `sync/`
- Node.js LTS for the Supabase CLI (`npx supabase`) and the Expo app
- A Supabase account with two free projects: `splitset-dev` for development and `splitset` for real data
- An intervals.icu account with your watch connected (Settings page → Athlete ID and API key)

### Database

Migrations are applied straight to the project's connection string, so no CLI login is needed.
`SUPABASE_DB_URL` is the Session pooler URI from the dashboard's Connect dialog.

```bash
npx supabase db push --db-url "$SUPABASE_DB_URL"
```

To prove the migrations apply from nothing, reset the empty dev project and push again.
Never run that against `splitset` once it holds real data.

### Sync job

```bash
cp .env.example .env      # then fill in SUPABASE_DB_URL
cd sync
uv sync
uv run pytest
uv run splitset-sync run --dry-run
uv run splitset-sync link --days 30                 # re-run plan/workout linking only
uv run splitset-sync backfill-garmin --email you@example.com "C:/path/to/DI_CONNECT" --dry-run
```

### App

```bash
cd app
cp .env.example .env      # Supabase URL + publishable key (public client keys)
npm install
npx expo start            # press w for web, or scan the QR code with Expo Go
npx tsc --noEmit          # typecheck
npx expo lint             # lint (CI runs both on every app change)
```

Routes live in `app/app/` (Expo Router): `sign-in.tsx`, then `(app)/` with the Today, Plan,
Lift, Run, Trends and Settings tabs, and `pbs.tsx`, the personal bests page above them. Shared
code is in `app/src/`: `api/` (TanStack Query hooks over supabase-js), `components/ui/` (the
card kit), `lib/` (client, session, units, dates), `theme/` (the two palettes),
`types/database.ts` (generated by `supabase/gen_types.py`).

### Plan calendar

The Plan tab is a calendar: week after week of seven days, rest days included, with each week's
running total against what was planned. Planned sessions, what fulfilled them (✓) and unplanned
activities sit on their day. Hold a planned session and drag it to another day to move it.

With "Planned runs on your watch" on (Settings, intervals.icu), the next two weeks of planned
runs that have a distance or a time go to the intervals.icu calendar, and intervals.icu sends
them on to Garmin Connect and the watch when planned-workout upload is on in its Garmin
settings. Any change to the plan (a drag, an edit, a skip, a delete) is pushed straight away: the
card shows "⌚ sending…" until it lands, usually within half a minute, then ⌚. Every scheduled
sync pushes too, so nothing is lost if the app was offline.

"Sync now" (Today, the Plan tab, and Settings, intervals.icu) runs a full sync for you on the
spot instead of waiting for the schedule.

### Sync now and instant push: one-time setup

Both start the `sync` workflow on GitHub Actions for the athlete who asked (a full sync, or
`mode: push` for the plan alone). The database makes the call with `pg_net`, using a GitHub
token kept in Supabase Vault beside the intervals.icu keys, so the app never sees it.

1. On GitHub: Settings, Developer settings, Fine-grained tokens, Generate new token. Repository
   access: only this repository. Permissions: **Actions: Read and write**. Copy the token.
2. In the Supabase SQL editor (after `npx supabase db push`):

   ```sql
   select vault.create_secret('<the token>', 'github_dispatch_token');
   select vault.create_secret('conormidd-hub/Splitset', 'github_dispatch_repo');
   ```

   To replace the token later: `select vault.update_secret(id, '<new token>') from vault.secrets
   where name = 'github_dispatch_token';`

Without the token, "Sync now" says it isn't set up and plan changes wait for the next scheduled
sync. Requests are throttled per athlete (a push per 5 seconds, a full sync per 2 minutes) and
GitHub runs one at a time per athlete, folding a burst of edits into a single push.

### Personal bests

Nothing is entered by hand: the `run_pbs` and `lift_pbs` views recompute PBs from synced runs
and ticked sets on every read, for this calendar month, this year and all time (the month and
year follow `profiles.timezone`).

- **Running:** fastest 1 km, mile, 5 km, 10 km, 15 km, half and marathon inside any run (the
  sync job's best efforts), and the longest run.
- **Lifting:** 1RM (a single, or Epley from 2 to 12 reps) and 3RM (heaviest weight for 3 or
  more reps) for weighted lifts; most reps, longest hold or heaviest carry for the rest.
  Warm-ups don't count.
- **Where:** the 🏆 PBs button on Today and Lift, the Trophy cabinet card on Today, and a 🏆 PB
  button on every exercise in a workout. That panel folds in sets ticked so far, highlights
  1RM or 3RM by the reps being lifted, and fills the next set from 50-90% of this month's 1RM
  (falling back to this year's, then all time), rounded to 2.5 kg or 5 lb.

### Web app on Vercel (and your iPhone's home screen)

The web build is a static site: `app/vercel.json` builds it with `npx expo export -p web` and
sends every path to the app, so links and reloads land on the right screen.

1. **Supabase, once:**
   - Apply the migrations of the branch you're deploying (`npx supabase db push`, under
     Database above). They only add tables, views and functions, so the scheduled sync on
     `main` keeps working.
   - The app signs in with a 6-digit code, not a link. In Authentication, Emails, add
     `{{ .Token }}` to the **Magic Link** and **Confirm signup** templates, for example
     `<p>Your Splitset code: <strong>{{ .Token }}</strong></p>`.
2. **Vercel:** Add New, Project, import this repository, set **Root Directory** to `app` and
   leave the framework as Other (`vercel.json` sets the build). Under Environment Variables add
   `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (the values in `app/.env`),
   then Deploy. `main` becomes the production address, and every other branch and pull
   request gets its own preview address, behind your Vercel sign-in by default (Settings,
   Deployment Protection).
3. **iPhone:** open the address in Safari, Share, Add to Home Screen. It opens full screen
   like an app. Sign in once inside it: the home-screen app keeps its own sign-in, separate
   from Safari. That includes Vercel's sign-in, so put the production address on the home
   screen, or turn Deployment Protection off to keep a preview there too (your data still sits
   behind the Splitset sign-in).

Until invite-only sign-up lands (M12), anyone with the address can make an empty account of
their own (row-level security keeps your data yours). Once everyone who should have an account
has one, turn off "Allow new users to sign up" in Authentication, Sign In / Providers.

## Credits

The shape of the sync job, the intervals.icu field mapping and the stream maths (best efforts,
kilometre splits, route simplification) are ported from a friend's private running dashboard,
kept unmodified in [`reference/`](reference/README.md). Thank you.

Data © the athlete who recorded it. Maps © OpenStreetMap contributors where shown.
