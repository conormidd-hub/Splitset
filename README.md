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
- [~] **M11** Custom dashboards: the Today screen is now a Garmin Connect style home (an In focus card and At a glance tiles over every stat Garmin Connect offers, drag to arrange, add and remove, saved per account) with a page per metric (daily timeline, week, month, year); the separate Dashboards tab and its free-form tile builder stay open
- [~] **M12** Friend onboarding: Create account on the sign-in screen, a first-run wizard from "create an intervals.icu account" to "paste your key" with a live check against intervals.icu, first sync started on the spot (verified on web against a local stack; invite-only sign-up is the Supabase "Allow new users to sign up" switch, which the app explains when it is off)
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

The `migrate` workflow does this on GitHub as soon as a new migration reaches `main`, with the
same `SUPABASE_DB_URL` secret as the sync job, so a merge never leaves the sync running ahead of
the schema. To apply by hand (or to see what's waiting, with `--dry-run`):

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
Lift, Run, Trends and Settings tabs, and above them `welcome.tsx` (the first-run wizard),
`pbs.tsx` (personal bests) and `metric/[id].tsx` (one metric's page). Shared code is in
`app/src/`: `api/` (TanStack Query hooks over supabase-js), `components/ui/` (the card kit),
`components/home/`, `components/metrics/` and `components/onboarding/` (the three new screens'
parts), `lib/` (client, session, units, dates, and `metrics.ts`, `readiness.ts`, `vo2.ts`: the
metric catalogue and the Garmin-style verdicts), `theme/` (the two palettes), `types/database.ts`
(generated by `supabase/gen_types.py`).

### Connect your watch (for friends)

Nothing to install and nothing to configure: a friend opens the app's address, picks **Create
account**, types a name and an email, and enters the six-digit code. The first thing a new account
sees is the welcome wizard, five short cards that take them from "do you use intervals.icu?" to a
connected Garmin:

1. Yes or no to an intervals.icu account (no sends them to intervals.icu's sign-up, one button).
2. Connect Garmin inside intervals.icu: Settings, Connections, tick Garmin, allow on garmin.com,
   tick **Download wellness data**, press **Download old data**. Every hop out is a button.
3. Paste the API key from the bottom of intervals.icu's settings page. That is the only thing they
   paste: intervals.icu treats athlete `0` as "whoever owns this key", so the check brings back
   their athlete id, name, time zone, sex and birth date, and whether Garmin wellness is switched
   on over there (the wizard says so if it is off). The check runs in the database with `pg_net`
   (`verify_intervals_key` and `intervals_verify_status` in the `home_onboarding` migration) so the
   key never leaves the server, and once it passes `connect_intervals` stores it in Vault.
4. The first sync starts on the spot through "Sync now" (the GitHub token setup below); without
   the token the wizard says the data arrives at the next scheduled sync.

The same steps live under Settings, Data sources, "Connect your watch", and "Run the setup again"
brings the wizard back. Garmin only hands intervals.icu a year of history; the `backfill-garmin`
command covers anything older from a Garmin export.

Two things Garmin keeps to itself: its Training Readiness, Training Status and HRV Status never
reach intervals.icu (its `readiness` field is Oura's and its `stress` is a 1 to 4 self-rating), so
the app works them out from the same ingredients Garmin names; and Body Battery arrives only if the
athlete adds two custom wellness fields in intervals.icu with the codes `BodyBatteryMax` and
`BodyBatteryMin` and ticks them under Garmin, which the sync job then reads.

On 9 October 2026 the intervals.icu developer said Garmin's terms had changed and that API access
to Garmin data may have to be blocked. If that happens the Garmin to intervals.icu to Splitset path
needs another route; nothing here assumes one yet.

### Home screen

Today is laid out the way Garmin Connect lays out its home: one **In focus** card (the metric you
want first, large, with its trend), then **At a glance** tiles, then the plan, the week and the
rest. **Edit** (or Settings, Home screen) turns on Garmin's edit mode: drag a tile by the handle in
its corner to move it, minus removes it, the dashed **Add** tile opens the catalogue of every stat
Garmin Connect can show, grouped and searchable, with the ones that never reach intervals.icu
greyed out and explained rather than hidden. **Change** on the In focus card picks that one. Every
change saves to `profiles.home_layout` (and a copy on the device), so every phone shows the same
home.

### Streaks and the calendar

Two Strava-style nudges on Today. Under the PBs pill, a green flame with the number of weeks in a
row (Monday to Sunday) with at least one workout: any activity the watch recorded plus any gym
workout logged in the app that the watch did not also record. This week counts as soon as it has
one; an empty current week does not break the streak until it ends. Under the greeting, **streak
heat**: a thin line of fire in the night green that burns by the last seven days, captioned
"3/7 streak heat". One workout lights a seventh of it, each one more lights more and burns hotter
(two a little, three or four well, five or six hot), seven and the whole line is ablaze; nothing
in seven days and it goes cold. The flames flicker on the UI thread and hold still when the
system asks for reduced motion.

The Plan tab is one calendar with three views of the same days, switched by the icons at the top
(the word shows on the one you are in), with one day in focus that carries across them:

- **Month**: seven across, a workout's icon on the day it happened and "+2" when there were more,
  a dashed outline where a session is planned, a red dot where one was missed, faded where it was
  skipped. Down the left, the streak: a red flame and its number on every week that is part of it,
  joined by a path that draws itself down the gutter when the month opens and runs into the
  streak counter where the chain ends. The flame pill on Today (and in the Plan's header) opens
  this view. Tap a day to open it.
- **Week**: the plan week by week, draggable, as before but a little tighter; weeks in the streak
  carry a small flame with their number, a week's dates open its month, a day's date opens the day.
- **Day**: one day in full: every planned session with its target, notes, watch state and the
  activity it was linked to, everything the watch recorded, gym workouts logged here, and the
  quick ways to mark one done, skip it or add one. A strip of the week above it moves day to day.

### Metric pages

Tap any tile for its page: the latest value with its verdict, then **Day** (a timeline of the last
14 days with a bar, the value and the change from the day before), **Week**, **Month** and **Year**
charts with the rolling mean dashed and the usual range (mean ± 1 sd of the 60 days before) shaded,
the range's latest, average, low, high and change, and what the metric is. Four pages have more:

- **VO2 max**: Garmin's fitness-level table (The Cooper Institute's, by age and sex, from the
  profile's birth year and sex), the 30-day, 90-day and 1-year change, and a race predictor for
  5 km to the marathon from Daniels' running formula, beside the athlete's own PBs.
- **Training readiness**: a 1 to 100 score in Garmin's bands (Prime, High, Moderate, Low, Poor)
  from the six factors Garmin names (sleep, recovery, HRV status, acute load, sleep history, stress
  history), each shown as a bar, with the weights written down in `app/src/lib/readiness.ts`.
- **Training status**: Garmin's words (Productive, Maintaining, Recovery, Peaking, Unproductive,
  Overreaching, Strained, Detraining) read from fitness now against four weeks ago, the VO2 max
  trend, the 7-day over 28-day load ratio and HRV status, with eight weeks of load and what every
  status would mean.
- **HRV status**: the 7-night average against a personal baseline (Garmin's own band when a Garmin
  export was backfilled, else the previous three weeks' mean ± 1 sd): Balanced, Unbalanced, Low or Poor.

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
   - The database is kept up to date by the `migrate` workflow (Database above). For a
     preview of a branch with new migrations, apply them by hand first.
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

### Demo athlete for preview builds

Preview deployments show a "Sign in as the demo athlete" card above the email form, so the
app can be reviewed without an inbox. The account is an ordinary Supabase user with a
password instead of an emailed code, and it only exists in the project where the seed has run:

```bash
cd sync
uv run python ../supabase/seed_demo.py     # creates or rebuilds the demo athlete and a year of data
```

The seed reads `EXPO_PUBLIC_DEMO_EMAIL` and `EXPO_PUBLIC_DEMO_PASSWORD` from the root `.env`
(any long random password). Give the same two values to Vercel for the **Preview** environment
only: the sign-in screen shows the card whenever both are present at build time, production
has neither, and `app/scripts/vercel-build.mjs` (the build command in `app/vercel.json`) strips
them from production builds as a backstop. To try it locally, copy the two lines into `app/.env`
and restart the dev server.

What the demo athlete has: a year of runs with splits, best efforts, routes and heart-rate
traces, two gym sessions a week logged set by set against four routines, daily wellness with
fitness and fatigue derived from that training, a plan covering the last three weeks and the
next two, and a half marathon six weeks ago. It lives in `splitset-dev` next to real data, which
row-level security keeps apart. Re-running the seed wipes and rebuilds the account, which is
also how to undo anything a reviewer logged. Its intervals.icu connection is `paused` so the
sync job never picks it up, and the Delete account button is hidden for it.

Until invite-only sign-up lands (M12), anyone with the address can make an empty account of
their own (row-level security keeps your data yours). Once everyone who should have an account
has one, turn off "Allow new users to sign up" in Authentication, Sign In / Providers.

## Credits

The shape of the sync job, the intervals.icu field mapping and the stream maths (best efforts,
kilometre splits, route simplification) are ported from a friend's private running dashboard,
kept unmodified in [`reference/`](reference/README.md). Thank you.

Data © the athlete who recorded it. Maps © OpenStreetMap contributors where shown.
