# Splitset — Muscle Recovery Map: Build Phases for Claude Code

Version 2.1 · 2026-10-16

Twelve phases, one Claude Code session each, each ending with something you can run or see. Each phase only depends on earlier ones. For every session, paste the **context block** and then **one phase**. Claude Code reads the spec, library, constants and fixtures from the repo, so they are never pasted.

## Before Phase 0: commit these files

| File | What it is |
|---|---|
| `docs/load-model-spec.md` | the math: PB → set load → muscle load → recovery → fatigue → colour |
| `docs/exercise-library.md` | 161 exercises with three-tier muscle roles, readable |
| `docs/build-phases.md` | this plan |
| `docs/recovery-map-preview.png` | what the finished figure should look like (fixture F26; F20 push day decaying) |
| `data/exercise_library.json` / `.csv` | the library as seed data (exercises and muscles only) |
| `data/recovery_constants.json` | every tunable number, including the colour scale; the only source of constants |
| `data/load_model_fixtures.json` | 31 test cases with inputs and expected values |
| `scripts/load_model.py` | reference implementation to port |
| `scripts/verify_spec_fixtures.py` | checks the reference against the fixtures |
| `scripts/build_exercise_library.py` | regenerates the library files: edit this, not them |
| `scripts/build_body_map.py` | regenerates the SVGs |
| `assets/body-front.svg`, `assets/body-back.svg` | the figure, one `<path data-muscle>` per region |

Run `python3 scripts/verify_spec_fixtures.py` once: it should print `all pass`.

---

## Context block: paste at the top of every phase

```markdown
You are working in the Splitset repo, a self-hosted, Strong-style workout tracker.
We are adding the Muscle Recovery Map: every logged set is scored against the user's
monthly PB, spread across muscles by primary / secondary / tertiary role, turned into
a recovery window, and shown on a front/back body figure coloured on a six-step scale
from clear through yellow, orange and red to dark red.

Before writing code, read:
- docs/load-model-spec.md         the math; section numbers (§) are referenced below
- docs/exercise-library.md        exercise → muscles, fatigue class, PB-estimate link
- data/recovery_constants.json    every tunable number; the ONLY source of constants
- data/load_model_fixtures.json   expected values the tests must reproduce (±0.01)
- scripts/load_model.py           the reference implementation
- docs/build-phases.md            this plan; do ONLY the phase named below

Constraints:
- The engine is a port of scripts/load_model.py, function by function, same names in
  the repo's casing: pure functions, no I/O. Storage and UI call into it.
- All constants come from data/recovery_constants.json through one loader, with
  per-user overrides from user_thresholds layered on top. No magic numbers, and no
  constants read from the library file or the database.
- Muscle IDs are the 17 strings in spec §2, used exactly, everywhere.
- Colours and levels are derived at read time, never stored.
- Times are UTC in storage; hours in the engine; the user's time zone in the UI.
- Do not change the existing workout logging behaviour except as this phase says.
- Match the repo's existing language, framework and test runner; add no frameworks.

Do only the phase below. Finish by listing: files changed, how to run the tests,
anything in the spec that was ambiguous and how you resolved it.
```

---

## Phase 0 — Audit and integration notes (no code changes)

**Goal:** a written map from the spec's data model onto what the repo already has.

1. Read the repo. Identify the stack, the database and migration tool, the test runner, and how workouts, exercises, sets and PBs are stored today. The app already stores PBs when they happen; find where and how.
2. Write `docs/recovery-map-integration-notes.md`:
   - for each table in spec §11, the existing table/column it maps to, or "new";
   - how existing exercises match library slugs (by name; list any that don't match);
   - how the existing PB records relate to spec §3.3 (the reference becomes derivable from `sets.e1rm`; say whether to keep the existing records as a "PB events" log for the UI);
   - where the engine module, the body-map component and the new screens should live;
   - whether bodyweight is available (profile field, Garmin).
3. List any blocker (no warm-up flag on sets, no bodyweight, no time zone on the user).

**Done when:** the notes file exists and I have read it. Later phases follow it.

---

## Phase 1 — Muscles, library and constants

**Goal:** the database knows every muscle, every library exercise and each exercise's muscles by role, and the app has one constants loader.

1. `muscles`: `id`, `group`, `name`, `views` (17 rows from `data/exercise_library.json → muscles`). No recovery hours here; the engine reads them from constants.
2. `exercises`: add whatever the repo lacks of `slug` (unique), `group`, `equipment`, `load_mode`, `bw_factor`, `unilateral`, `log_as`, `fatigue`, `pb_estimate_from`, `pb_estimate_ratio`, `load_split` (JSON), `note`, `is_custom`, `owner_user_id`.
3. `exercise_muscles`: `exercise_id`, `muscle_id`, `role` (`primary | secondary | tertiary`), PK (exercise_id, muscle_id).
4. Seed loader: upsert by slug from the JSON; match existing exercises by name using the Phase 0 notes; never modify a row where `is_custom = true`; replace that exercise's `exercise_muscles` rows. Idempotent.
5. Constants loader: reads `data/recovery_constants.json` once, exposes typed values, applies `user_thresholds (user_id, key, value)` overrides with dotted keys (e.g. `pb.manual_policy`, `base_recovery_hours.default`). Everything downstream takes this `Thresholds` object.
6. Tests: seed twice → no diff; 161 exercises and 17 muscles; every exercise has ≥ 1 primary and respects the caps in `role_caps`; no muscle twice on one exercise; every `pb_estimate_from` exists and library chains are ≤ 3 hops; every muscle is primary somewhere; loader returns `role_weights.secondary = 0.4`, and a user override changes it for that user only.

**Done when:** tests pass and the exercise picker lists the library with group filters.

---

## Phase 2 — Port the engine and pass every fixture

**Goal:** the whole model from spec §3–§9 exists as pure, tested code before anything stores or shows it.

1. Port every function in `scripts/load_model.py` into an engine module: `rir_from_rpe`, `e1rm`, `effective_weight`, `_records`, `_own_pb`, `pb_before`, `fixed_cost`, `inol`, `side_factor`, `score_exercise`, `muscle_loads`, `score_workout`, `base_hours`, `recovery_hours`, `hours_until_below`, `lookback_hours`, `terms_for`, `fatigue`, `weekly`, `level_for`, `displayed_level`, `first_time`, `muscle_state`, `recovery_map`, `session_map`, `fmt_hours`. Inputs are plain data (library entries, sets, PB records, thresholds), never database rows or ORM objects.
2. A fixture runner in the repo's test framework that loads `data/load_model_fixtures.json` and checks every case, mirroring the five `kind`s in `scripts/verify_spec_fixtures.py` (`exercise`, `pb`, `manual_timeline`, `workout`, `timeline`). Honour `extra_exercises` (add those library entries first) and `constants_override` (apply for that case only).
3. If the repo's language makes an exact solve simpler than the 15-minute scan in `first_time`, use it; fixtures must still pass.

**Done when:** all 31 fixtures pass in the repo's own test runner.

---

## Phase 3 — Set fields, e1RM, manual PBs and the PB screen

**Goal:** every set carries what the engine needs, the user can enter a known best, and each exercise shows where its reference comes from.

1. `sets`: add `rpe` (nullable, 6–10 in 0.5 steps), `seconds` (nullable), `side` (nullable: left/right), `is_warmup` (default false), `e1rm` (nullable), `bodyweight_kg` (nullable). Logging UI: warm-up toggle, optional RPE picker, seconds input for `log_as = seconds`, side picker only when the exercise is unilateral and the user turns on per-side logging.
2. `user_profile.bodyweight_kg` + `bodyweight_updated_at` (Garmin weight if Phase 0 found it). On save, a set of a bodyweight or assisted exercise snapshots the current bodyweight into `sets.bodyweight_kg`.
3. On save, compute `sets.e1rm` with the engine (`e1rm`, `effective_weight`, `rir_from_rpe`). Backfill every historical set in a migration (snapshot today's bodyweight for old bodyweight sets, once).
4. `manual_pbs`: `id`, `user_id`, `exercise_id`, `weight`, `reps`, `e1rm`, `dated_at` (a date; its time is the start of that day in the user's time zone), `created_at`. Form on the exercise detail screen: "Add a known best": weight × reps, optional date.
5. A repository function that builds the engine's PB history for a user and exercise set: one record per set with an `e1rm` (`source = logged`, `at = workout finish`) plus one per manual PB (`source = manual`).
6. PB screen per exercise: monthly best (trailing 30 days), all-time best, the current reference and its source from `pb_before` (logged / manual / lapsed / estimated from <exercise> / calibrating), and the history list with source badges. Keep the existing "new PB" moment, now driven by `sets.e1rm` beating the all-time best.
7. Tests (integration, against the database): logging fixture F02's sets stores e1RMs 126.5 and 125.0; a manual PB of 130 on day 0 makes `pb_before` report 130 / monthly / manual on day 1 (F18); an exercise never logged reports "estimated from Bench press (barbell)" when bench has history (F14), else "calibrating" (F17).

**Done when:** logging a set shows its e1RM, a manual PB appears with a "manual" badge, and a never-logged exercise shows its estimated or calibrating source.

---

## Phase 4 — Per-workout cache and recompute

**Goal:** finishing a workout writes one row per touched muscle with its load and recovery window, and edits keep the cache right.

1. `workout_muscle_loads`: `workout_id`, `muscle_id`, `load`, `recovery_hours`, `finished_at`, `source` (`lift | activity`). `workout_exercise_loads`: `workout_id`, `exercise_id`, `load`, `pb_source`, `pb_detail`. Both written by `score_workout` in the same transaction that finishes a workout.
2. Recompute rule (spec §14): editing or deleting a finished workout, changing an exercise's mapping or fatigue class, or adding/editing/deleting a manual PB → rescore **every** finished workout from the earliest affected one onward, in time order, rebuilding PB history as it goes. Run it as a background job if it takes more than a moment; show "updating…" on the figure meanwhile.
3. A workout in progress is scored on the fly with `t_w = now`; nothing is cached until Finish.
4. Tests (integration): finishing the F20 push day writes chest 2.48 / triceps 3.584 / front delts 1.952 / side delts 1.734 / traps 0.462, zeros elsewhere, and R as in F20; the F28 workout (bench in two blocks) caches bench 0.6181; editing a set in Monday's workout changes Tuesday's cached rows when Tuesday's exercise estimates from Monday's (e.g. curls from bench).

**Done when:** the push day's cache rows match F20, and an edit to an old workout updates later ones.

---

## Phase 5 — Read API

**Goal:** one call returns the full map for any instant, past or present.

1. `recovery_map(user, at = now)` → per muscle: F, W, level, label, advice, fill, fill_dark, trainable_in_h, ready_in_h, and `contributing` [{exercise, workout date, role, role_weight × L_e, pb_source}], largest first. Reads `workout_muscle_loads` and `workout_exercise_loads` from the last `lookback_hours()` plus 168 h.
2. `session_map(workout)` → per muscle: L, level, label, fill, R, trainable_after_h, ready_after_h.
3. `recovery_history(user, from, to, step = 24 h)` → `recovery_map` sampled at each step.
4. Expose as HTTP endpoints or a local store, per Phase 0.
5. Tests (integration): log the F26 week through the real logging path; `recovery_map` at Wednesday 20:00 returns hamstrings Very high, quads/glutes/biceps/traps High, and the rest as in F26; `recovery_history` over 7 days returns 7 samples.

**Done when:** finishing a workout changes the map response without a restart.

---

## Phase 6 — Body map component

**Goal:** the figure renders the map, light and dark, and every region is tappable.

The figure is `assets/body-front.svg` and `assets/body-back.svg`. Contract (spec §10): each region is a `<path>` with `data-muscle` = a muscle ID and `data-side`; a muscle may have several paths on one or both views; regions carry a default `fill` you replace; shapes with `data-role="silhouette"` never take a level colour. Element ids are prefixed `front-` / `back-`. If you swap in another SVG later it must meet the same contract.

1. `BodyMap` component: props `map` (from Phase 5), `view` (front/back), `mode` (recovery/session), `theme`. Region fill: level `fill` / `fill_dark`, or `ready_fill` / `ready_fill_dark` at level 0. Silhouette: `silhouette_fill(_dark)`. Region stroke: `region_stroke(_dark)`. Front/back toggle; swipe on mobile.
2. Legend: six swatches with label and advice, from `levels` in constants.
3. Tap a region → bottom sheet with the spec §10 tap detail. Mark contributions whose `pb_source` is estimated or calibration.
4. List view toggle under the figure: the same muscles as rows (name, level, F, trainable in, ready in), highest first. This is the accessible equivalent and must always be reachable.
5. Tests: parse both SVGs and assert all 17 muscle IDs appear across the two views and no element id repeats across them; snapshot the F26 state front and back (compare by eye with `docs/recovery-map-preview.png`); snapshot the F20 push day at 0, 24 and 48 h (levels as in F23 for chest).

**Done when:** the F26 week renders like the preview image, in light and dark mode.

---

## Phase 7 — Screens

**Goal:** the map shows up where users train.

1. **Recovery screen** (and a compact home card): recovery view, front by default, list toggle, a "next ready" strip of muscles becoming trainable in the next 24 h.
2. **Workout summary** after Finish: session view of this workout, plus a row per touched muscle, e.g. "Chest · load 2.48 · High · trainable in 24 h · ready in 2.2 days" (push day, F20).
3. **Live workout**: a small session-view figure that fills in as sets are completed.
4. **Exercise picker and detail**: the load split bar (`load_split`) and a mini figure with primary / secondary / tertiary in three tints of one colour; the PB source line from Phase 3.
5. **Train next** card: muscles currently Ready, biggest groups first, each with three exercises where it is primary, ordered by that muscle's share of `load_split`, then library order.

**Done when:** logging a full push day shows the session map on Finish and moves the Recovery screen accordingly.

---

## Phase 8 — Custom exercises

**Goal:** a user can add an exercise the library lacks, and it scores sensibly from its first set.

Create flow, one screen, top to bottom:

1. **Name.** As they type, fuzzy-match library and their own custom exercises by name and slug; show "Did you mean …?" rows. Picking one abandons the create.
2. **Start from a similar exercise** (recommended; pre-suggested from keywords in the name: "curl", "row", "press", "raise", "fly", "squat", "lunge", "deadlift"/"RDL", "pulldown", "pull-up", "extension", "crunch", "plank"). Choosing one copies equipment, load mode, `bw_factor`, unilateral, fatigue class and all three muscle tiers, and sets `pb_estimate_from` to that exercise. Below it: "Compared with <that exercise>, you lift about: less / about the same / more" → ratio 0.6 / 1.0 / 1.3. Library chains are at most 3 hops and `pb.estimate_max_hops` is 4, so the extra hop always resolves (F30).
3. **Equipment.** Barbell, dumbbell, machine, cable, Smith, bodyweight, assisted machine, band, timed. Sets the load mode (band → `fixed`, logged as reps; timed → `fixed`, logged as seconds; bodyweight → `bodyweight`; assisted → `assisted`; everything else → `weight`) and a default fatigue class (machine / cable / band → low, else standard). Bodyweight shows a `bw_factor` slider (0.2–1.0) with presets: core 0.3, push-up-like 0.65, pull-up-like 1.0, legs 0.8.
4. **Muscles.** Tap regions on a mini body map: each tap cycles none → primary → secondary → tertiary → none (three tints of one colour). Enforce `role_caps`; require ≥ 1 primary. A text list with role chips does the same for accessibility. A live load-split bar shows where one set's load will land.
5. **"How hard is this on the body?"** Light / Normal / Heavy → fatigue `low / standard / high`. It is pre-set from the similar exercise if one was chosen, otherwise from the equipment default; whatever it shows when the user saves is what is stored. This is the only load control. The user never types a load number: load always comes from sets, reps and weight against the PB.
6. **Your best (optional).** Weight × reps → a `manual_pbs` row. If skipped: estimated through the similar exercise if one was picked, else the first session calibrates (spec §3.4).
7. Save with `is_custom = true`, `owner_user_id`, slug `custom_<uuid>`. Never touched by the seed loader. Editing its muscles or fatigue later triggers the Phase 4 recompute.

Tests: "Incline Smith press" from `incline_bench_bb` copies its tiers and resolves an estimated PB through it; a custom curl based on `db_curl` resolves through four hops to bench (F30); "pull down lat" surfaces `lat_pulldown`; a create with no primary is rejected; caps enforced; a custom exercise with a manual PB of 80 scores its first set against 80, and a later logged 95 takes over (spec §3.6).

**Done when:** a custom exercise created in under 30 seconds colours the right muscles on its first workout.

---

## Phase 9 — Settings and history

**Goal:** the user can tune the model and look back.

1. Settings screen writing to `user_thresholds`: role weights, fatigue factors, base recovery hours per muscle (12–96 h), recovery slope, weekly cap, level boundaries (must stay increasing), PB window days. Each with a one-line explanation and "reset to default". Changing any of them triggers the Phase 4 recompute for that user.
2. Manual-PB policy (`pb.manual_policy`): "A logged session replaces my manual best: only when it's higher (default, `max`) / at the next logged set (`replace_on_log`)".
3. History scrubber on the Recovery screen: a date slider over the last 28 days using `recovery_history`; the figure animates between samples.
4. Tests: overriding `base_recovery_hours.default` to 72 changes F20's chest R from 59.7 to 89.6 h for that user only; with base hours at 96 the longest window is 192 h and a 7-day-old workout still contributes until it expires; `replace_on_log` gives F29's references (130 then 116.67).

**Done when:** a threshold change updates the figure without a restart, and the scrubber shows last Monday.

---

## Phase 10 — Running and cardio (Garmin / Strava)

**Goal:** a hard run shows up on the legs with no lifting logged.

1. Map imported activity types to `cardio.activity_muscles` in constants (run, ride, swim, hike, row), same role weights as lifting.
2. Equivalent sets: minutes at or above HR zone `hard_hr_zone_min` → `equiv_sets_per_10min_hard` per 10 min; the rest → `equiv_sets_per_10min_easy`; no HR data → all minutes at the easy rate. Each equivalent set costs `fixed_set.base`, fatigue standard.
3. Write `workout_muscle_loads` rows with `source = activity`, so Phases 5–7 pick them up unchanged; the tap detail shows "Long run (Sun): load 2.25".
4. Settings toggle stored as the user override of `cardio.enabled_default`.
5. Tests: a 90-minute run with 60 minutes hard → 6 + 1.5 = 7.5 equivalent sets × 0.30 = 2.25 → quads and calves 2.25, hamstrings and glutes 0.90, adductors 0.45; at t = 0 quads High.

**Done when:** yesterday's long run colours the legs with the run in their detail sheet.

---

## Phase 11 — Validate against real history

**Goal:** confidence the thresholds suit this user before trusting the figure.

1. Import a Strong CSV export → workouts and sets (weight, reps, RPE if present), exercises matched to library slugs by name; unmatched names go to a review list that opens the Phase 8 create flow pre-filled.
2. Replay the last 90 days through the engine in time order. Report per muscle: days in each level, longest run at level ≥ 4, how often it was trained while at level ≥ 3, average weekly load W.
3. Flag tuning hints. A muscle at level ≥ 3 on more than 40% of days on a normal split means the thresholds are too tight for this user. A muscle never above level 1 while trained twice a week means they are too loose.

**Done when:** the report runs on your own export and last Monday's figure matches what you remember of that week.
