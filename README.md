# Running dashboard — starter kit

A private training dashboard built from your own intervals.icu data: plan, gym, runs, shoes,
maps, records and trends, installable on your phone as an app. It rebuilds itself once a day
from a GitHub Action and deploys to Cloudflare Pages.

Everything here is free. The only thing that costs anything is the optional AI coach, which
runs on a Claude subscription you may already have.

---

## What you get, and what each step costs you

Set this up in stages. **Stage 1 alone gives you a working dashboard** — do that first, then
add whatever else you want. Nothing later depends on you having done the optional parts.

| Stage | What it adds | Time | Needs |
|---|---|---|---|
| 1 | A dashboard on your own machine | 15 min | intervals.icu |
| 2 | Live on the web, rebuilding daily, installable on your phone | 30 min | GitHub, Cloudflare |
| 3 | Plan and gym edits that sync across devices | 15 min | Cloudflare KV |
| 4 | A calendar feed of your sessions | 10 min | — |
| 5 | A "Sync now" button in the app | 10 min | GitHub token |
| 6 | Daily coaching written by Claude | 10 min | Claude subscription |
| 7 | Push notifications | 15 min | — |
| 8 | Planned workouts pushed to your watch | 5 min | — |

---

## Before you start

You need **intervals.icu** with your watch connected (Garmin, Coros, Polar, Suunto and
others all feed it). It is free. Everything in this dashboard is read from there, so if your
runs are not in intervals.icu, nothing else will work.

You also need **Python 3.10 or newer** on your machine.

```bash
pip install pandas numpy requests
```

---

## Stage 1 — a dashboard on your own machine

1. **Copy this folder somewhere sensible.** It will become a git repository in stage 2.

2. **Get your intervals.icu credentials.** Go to <https://intervals.icu/settings>, scroll to
   the bottom. You want your **Athlete ID** (looks like `i123456` — keep the leading `i`) and
   your **API key**.

3. **Make your `.env`:**

   ```bash
   cp .env.example .env
   ```

   Open it and paste both values in. `.env` is gitignored and never leaves your machine.

4. **Pull your data:**

   ```bash
   python sync.py
   ```

   The first run downloads your whole history and takes a few minutes. It writes
   `activities.csv`, `wellness.csv` and a cache of per-run detail in `data/runs/`. Later runs
   only fetch what is new.

5. **Build the page:**

   ```bash
   python build.py
   ```

6. **Open `dashboard.html`** in a browser. That is the whole app — one self-contained file
   with your data baked into it.

If you only ever do this, you have a working dashboard. Re-run those two commands whenever
you want it refreshed.

> **A Garmin backfill, if you want one.** intervals.icu only has wellness data (resting HR,
> HRV, sleep) from the day you connected it. If you want the years before that, request an
> export from Garmin (Account → Data Management → Export Your Data), wait for the email, then
> run `python import_garmin.py path/to/DI_CONNECT`. It fills in gaps and never overwrites
> what intervals.icu already has.

---

## Stage 2 — on the web, rebuilding daily

This puts the dashboard on a private URL, rebuilds it every morning, and lets you install it
on your phone.

### 2a. Put it on GitHub

Create a **private** repository — call it `running-dashboard` — and push this folder to it.

> Keep it private. The built page contains your entire training history.

### 2b. Cloudflare Pages

1. Sign up at <https://dash.cloudflare.com> (free).
2. **Workers & Pages → Create → Pages → Connect to Git** is the usual route, but this project
   deploys from the GitHub Action instead. Choose **Upload assets**, name the project
   (e.g. `yourname-running-dashboard`), and upload anything as a placeholder to create it.
3. Note the project name. You will need it in a moment.
4. Get your **Account ID** from the right-hand side of the Workers & Pages overview page.
5. Make an **API token**: My Profile → API Tokens → Create Token → *Edit Cloudflare Workers*
   template. Copy it now; you cannot see it again.

### 2c. Tell the Action about all of it

In your GitHub repo, **Settings → Secrets and variables → Actions**.

Under **Secrets**, add:

| Secret | Value |
|---|---|
| `INTERVALS_ATHLETE_ID` | `i123456` |
| `INTERVALS_API_KEY` | your intervals.icu key |
| `CLOUDFLARE_API_TOKEN` | the token from 2b |
| `CLOUDFLARE_ACCOUNT_ID` | your account id |

Under **Variables**, add:

| Variable | Value |
|---|---|
| `CF_PAGES_PROJECT` | your Pages project name |

### 2d. Run it

**Actions → Build running dashboard → Run workflow.** It takes about a minute. When it goes
green, your dashboard is live at `https://<project>.pages.dev`.

### 2e. Lock it down

**Your training history is now on a public URL.** Fix that before you do anything else:

Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**.

- Domain: your `pages.dev` hostname
- Policy: **Allow**, with rule *Emails* → your email address

You will get a one-time code by email the first time you visit. Free for up to 50 users.

### 2f. Install it on your phone

Open the URL on your phone, sign in, then **Add to Home Screen**. It works offline after the
first load.

### 2g. When it rebuilds

The Action runs twice a day on a schedule. Open `.github/workflows/dashboard.yml` and look at
the `cron` lines — they are **UTC**, and they are deliberately not on the hour, because
GitHub's scheduler gets congested at the top of the hour and can run up to three hours late.
Set them to whenever early morning is for you.

---

## Stage 3 — plan and gym edits that sync across devices

Without this, edits you make in the app are saved on that device only.

1. Cloudflare dashboard → **Storage & Databases → KV → Create a namespace**, call it
   `running-dashboard`.
2. Copy its **namespace ID**.
3. **Workers & Pages → your project → Settings → Bindings → Add → KV namespace.**
   Variable name **`PLAN_KV`**, pointing at that namespace.
4. **Redeploy.** Cloudflare only gives new bindings to deployments made *after* you save them,
   so run the Action again — this catches people out constantly.

Your plan, gym log, shoes and notification subscriptions now live in KV and follow you between
devices.

---

## Stage 4 — your sessions in your calendar

1. **Workers & Pages → your project → Settings → Variables → Add.** Name `CAL_TOKEN`, value a
   long random string you invent. This *is* the password for the feed, so make it long.
2. Redeploy (same reason as above).
3. Add a **Bypass** policy in Zero Trust Access for the path `cal/*` on this application.
   It must be **Bypass**, not Allow — Allow still forces a login page, and calendar apps
   cannot log in.
4. In the app: **Settings → Calendar**, paste the token, copy the link.
5. Subscribe: Apple Calendar → File → New Calendar Subscription. Google Calendar → Other
   calendars → From URL.

Sessions appear as all-day events and follow your plan when you change it. Add `?alarm=7` to
the link for a 7am reminder.

---

## Stage 5 — a "Sync now" button in the app

Lets you trigger a rebuild from your phone instead of waiting for the schedule.

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate.
   Repository access: *Only select repositories* → your repo. Permissions → Repository →
   **Actions: Read and write**.
2. **Workers & Pages → your project → Settings → Variables**, add:
   - `GITHUB_TOKEN` — the token (mark it **encrypted**)
   - `GITHUB_REPO` — `yourname/running-dashboard`
3. Redeploy.

---

## Stage 6 — the AI coach

A morning brief and a debrief after each run, written by Claude from your actual data.

This runs through the **Claude Code CLI** using your existing Claude subscription, so it costs
nothing extra. Skip this stage entirely if you do not have one — everything else works without
it.

1. Install the CLI and generate a token:

   ```bash
   npm install -g @anthropic-ai/claude-code
   claude setup-token
   ```

2. Add the value as a GitHub secret called **`CLAUDE_CODE_OAUTH_TOKEN`**.

3. **Rewrite `coach_prompt.md`.** This matters more than the setup. That file *is* the coach —
   your races, paces, heart-rate zones, injuries, fuelling, shoes. The template has comments
   telling you what to put where. A generic profile produces generic advice.

   Two things in there worth reading twice: say explicitly what is **off limits** (a model will
   bring up your blood results every morning if the profile mentions them once), and be careful
   writing down **tendencies** — "he goes out too hard" will colour every brief from then on,
   so only write it if the record genuinely supports it.

4. Not in Melbourne? Set `COACH_TZ`, `HOME_LAT` and `HOME_LON` as repository variables.

---

## Stage 7 — push notifications

The morning brief and today's session, pushed to your phone.

1. Open `tools/vapid-keygen.html` in a browser and generate a key pair.
2. Put the **public** key in `push.json` as `publicKey`, and set `subject` to
   `mailto:your@email`. Commit that.
3. Add the **private** key as a GitHub secret called **`VAPID_PRIVATE_KEY`**. Never commit it.
4. In the app: **Settings → Notifications → Turn on for this device.** Once per device.

---

## Stage 8 — planned workouts on your watch

Pushes the next 14 days of runs to intervals.icu, which passes them to your watch.

Add a repository **variable** `WORKOUT_SYNC` set to anything other than `off`. Set it to `off`
to stop, and run `python sync_workouts.py --clear` to remove what it created.

It never pushes race day, and only pushes runs. Gym sessions go to your calendar instead.

---

## Make it yours

Nothing here is personal data, but plenty of it is placeholder content you should replace.

| File | What to do |
|---|---|
| `coach_prompt.md` | Rewrite completely. This is the coach. |
| `plan_seed.json` | Replace the example block with your plan. Easiest path: build the first week in the app, then copy what the app saved. |
| `shoes.json` | Delete the example pair, add yours — or just add them in the app. |
| `race_plan.json` | Your goal race: stations, fuelling, kit. Its `date` must match the race session in your plan or the card will not show. Delete the file if you do not want one. |
| `gym_programs.json` | A general strength template. **If you are carrying an injury, get a programme from a physio and put that here instead** — do not follow a template written for nobody in particular. |
| `template.html` | Your name and city (line ~890), the page `<title>`, and "Your rule" on the plan page. |
| `icons/` | Replace with your own artwork — `tools/make_icons.py` builds the whole set from one square image. |
| `videos.json` | Warm-up and cool-down videos shown on session cards. Swap in whatever you like. |

---

## How it fits together

```
intervals.icu  --sync.py-->  activities.csv, wellness.csv, data/runs/
                                        |
                              build.py + template.html
                                        |
                                 dashboard.html  --wrangler-->  Cloudflare Pages
                                        |
                          your edits --> /api/* --> Cloudflare KV
```

`template.html` holds all the markup, styling and behaviour. `build.py` injects your data
into it as JSON and writes `dashboard.html`. Everything runs in the browser; there is no
server beyond a few small Cloudflare Functions for saving your plan and serving the calendar.

| File | Job |
|---|---|
| `sync.py` | Pulls activities, wellness and per-run streams from intervals.icu |
| `build.py` | Injects that data into `template.html` |
| `coach.py` | Writes the brief and debriefs via the Claude CLI |
| `send_push.py` | Sends the day's notifications |
| `sync_workouts.py` | Pushes planned runs to intervals.icu for your watch |
| `import_garmin.py` | One-off backfill from a Garmin export |
| `functions/` | Cloudflare Pages Functions: the KV API, the calendar feed, the sync trigger |

---

## When something breaks

**"CAL_TOKEN isn't set"** or a new variable seems ignored — Cloudflare only passes variables
and bindings to deployments made *after* you save them. Redeploy.

**A change you shipped isn't showing on your phone** — Settings → Version → *Check for an
update*, then close and reopen the app. The service worker caches aggressively by design so it
works offline.

**401 from intervals.icu** — the athlete ID needs its leading `i`, or the API key was
regenerated.

**The calendar feed 404s or asks for a login** — the Access policy for `cal/*` must be
**Bypass**. Check the token matches too.

**GitHub Actions runs late** — normal. The scheduler is busy on the hour; the crons here are
deliberately off-hour and doubled up for that reason.

---

## Credits and licences

Exercise illustrations from [Workout Guide](https://github.com/bryllim/workout-guide) by Bryl
Lim, based on artwork by [Everkinetic](https://github.com/everkinetic/data), licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and shown recoloured and
animated. That licence is share-alike: if you redistribute the artwork, keep the attribution
in `exercise-art/ATTRIBUTION.md` with it.

Maps © OpenStreetMap contributors. Weather from [Open-Meteo](https://open-meteo.com).
