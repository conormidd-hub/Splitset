# Splitset — Muscle Recovery Map: Integration Notes

Phase 0 output · 2026-10-16 · branch `recovery-map`

How the spec (`docs/load-model-spec.md`) and the plan (`docs/build-phases.md`) land on the repo as it is today. Later phases follow these notes. Where a phase's wording and these notes disagree, section 13 says why. Nothing in the repo was changed to write them.

---

## 1. In short

- **No app server.** The app is Expo (React Native, TypeScript) writing straight to Supabase Postgres under owner-only RLS. So the engine is TypeScript inside the app, and "storage" means SQL migrations plus supabase-js hooks.
- **Sets already carry most of what the spec needs.** `workout_sets` has RPE, seconds, warm-ups (as `set_type = 'warmup'`) and a completion time. Missing: `e1rm`, `side`, a bodyweight snapshot.
- **PBs are not stored anywhere.** Two views compute them from completed sets on every read. There is no PB-events table to keep or migrate.
- **The app has no test runner.** CI runs only `tsc` and `expo lint`. Phase 2 needs one; the recommendation is Node's built-in runner (D1).
- **There is no database for integration tests.** Development is hosted-only, there's no Docker locally, and `splitset-dev` holds real data. Decide before Phase 1 (D2).
- **Exercises:** 58 of the 76 seeded exercises map to library slugs (25 by exact name, 28 by an obvious rename, 5 needing a choice). 18 have no slug of their own and stay unscored.
- **Bodyweight:** there's no profile field. `workouts.bodyweight_kg` exists but the app never fills it. Garmin weigh-ins arrive daily in `wellness.weight_kg` via intervals.icu.
- **Time zone:** `profiles.timezone` exists, is validated, and the PB views already use it. Not a blocker.

---

## 2. The stack

| Concern | Today | Where |
|---|---|---|
| App | Expo SDK 57, React Native 0.86, React 19, TypeScript 6, expo-router. TanStack Query for reads, zustand for the live workout | `app/` |
| Routes | Under `app/app/`, not `src/app/` as `app/AGENTS.md` says. Tabs: Today, Plan, Lift, Run, Trends, Settings | `app/app/(app)/_layout.tsx` |
| Database | Supabase Postgres, RLS on every table, owner-only (`user_id = auth.uid()`) | `supabase/migrations/` |
| Migrations | Plain SQL files, applied with `supabase db push --db-url …` | locally, or `.github/workflows/migrate.yml` |
| Generated types | `app/src/types/database.ts`, regenerated after each migration with `cd sync && uv run python ../supabase/gen_types.py` | |
| Writes | supabase-js, straight to the tables. The live workout writes through an ordered outbox, persisted in AsyncStorage, so a killed app resumes. A `lww_guard` trigger settles writes from two devices | `app/src/stores/activeWorkout.ts` |
| Server code | Python sync job (intervals.icu → activities, wellness) on a GitHub Actions cron. No Edge Functions, no API server | `sync/` |
| Tests | `sync/`: pytest (`ci.yml`). `app/`: none. `app.yml` runs `npx tsc --noEmit` and `npx expo lint` on Node 22 | |
| Node | 24.19 locally, 22 in CI | |

---

## 3. Spec §11 tables → repo

### `sets` → `workout_sets` (existing)

| Spec column | Repo | Status |
|---|---|---|
| exercise | `exercise_id` (copied onto each set, so history survives edits) | exists |
| weight | `weight_kg real` (always kg; imperial is display only) | exists |
| reps | `reps` | exists |
| rpe? | `rpe real`, nullable | exists, with no check constraint. **The logger has no RPE input** (Phase 3 adds one) |
| seconds? | `seconds` | exists |
| side? | — | new (Phase 3) |
| is_warmup | `set_type`: `warmup` / `working` / `drop` / `failure`, cycled by the set-number button in the logger | exists in another shape. **Derive `is_warmup = (set_type = 'warmup')`; don't add a boolean.** Drop and failure sets are working sets |
| completed_at | `completed_at`, set when the set is ticked, plus a `completed` boolean | exists. Only `completed` sets of workouts with `finished_at` count. Filled-in but unticked sets stay in history as unfinished |
| e1rm | — | new (Phase 3) |
| bodyweight_kg | none on the set. `workouts.bodyweight_kg` exists on the workout | see §6 |

### `manual_pbs` → new

`user_id`, `exercise_id` FKs as elsewhere. Owner-only RLS and `lww_guard`, like the other client-written tables. Store the date as a `date` and turn it into an instant in SQL (see §7).

### `exercise_muscles` → new

`(exercise_id, muscle_id, role)`. Reads are allowed for global exercises and the user's own. Writes are allowed only for the user's own exercises (Phase 8): the policy joins to `exercises.owner_id`.

### `muscles` → new

17 global, read-only rows. Spec §11 lists `base_hours` here, but build-phases Phase 1 says there are no recovery hours in this table. **Follow Phase 1: base hours come from constants only.**

### `workout_muscle_loads` → new

- `workout_id → workouts.id`, on delete cascade.
- `t_w` is `workouts.finished_at`, copied into the row as `finished_at`.
- **Activity rows (Phase 10) have no workout:** activities live in `activities` (text id). Give this table a nullable `workout_id` plus a nullable `activity_id`, with a check that exactly one is set.

### `user_thresholds` → new

`(user_id, key, value jsonb)`, owner-only.

### Tables and columns the plan adds elsewhere

**`exercises` (Phase 1).** It exists: `id`, `owner_id`, `name`, `muscle_group`, `equipment`, `measure`, `is_bodyweight`, `is_unilateral`, `instructions`, `archived`.

| Plan column | Repo |
|---|---|
| `slug` (unique) | new. Make it unique where not null; unmatched global rows and custom exercises have none until Phase 8 |
| `group` | new. The existing `muscle_group` uses a different 13-value vocabulary (quads, back, core, cardio, mobility, …) that search and subtitles rely on. Keep both |
| `equipment` | exists, with no check constraint. The library adds `ez bar`, `plate`, `sled`, `smith`, `trap bar` |
| `load_mode`, `bw_factor`, `fatigue`, `pb_estimate_from`, `pb_estimate_ratio`, `load_split` | new |
| `unilateral` | is `is_unilateral` |
| `log_as` | is `measure`: `reps` ↔ `weight_reps`/`reps`, `seconds` ↔ `duration`. Don't add a column (mapping in §4.6) |
| `note` | `instructions` exists and the seed never fills it. Reuse it |
| `is_custom` | is `owner_id is not null`. Don't add a column |
| `owner_user_id` | is `owner_id` |

**`user_profile` (Phase 3) → `profiles`.** Add `bodyweight_kg` and `bodyweight_updated_at`. `profiles` grants updates per column (`grant update (display_name, timezone, units)`, extended in `20261013000100_home_onboarding.sql`), so the migration must grant the new columns too.

**`workout_exercise_loads` (Phase 4) → new.** `workout_exercises` lets one exercise appear twice in a workout, but `score_workout` sums `L_e` per exercise, so one row per `(workout_id, exercise_id)` matches F28.

---

## 4. Exercises → library slugs

`exercises` holds 76 global rows (`owner_id` null) from `supabase/migrations/20260922000650_exercise_seed.sql`, plus each user's own rows. Global names are unique, ignoring case.

I matched names by hand from fuzzy-match suggestions. **Phase 1's seed loader should write this mapping out explicitly** rather than fuzzy-match at runtime.

**One slug can belong to only one row.** An existing row that is a variant of an exercise another row already claims can't share that slug, because their PBs would mix.

### 4.1 Same name (25)

| Existing | Slug |
|---|---|
| Front squat | `front_squat` |
| Goblet squat | `goblet_squat` |
| Leg press | `leg_press` |
| Bulgarian split squat | `bulgarian_split_squat` |
| Walking lunge | `walking_lunge` |
| Reverse lunge | `reverse_lunge` |
| Step-up | `step_up` |
| Leg extension | `leg_extension` |
| Trap bar deadlift | `trap_bar_deadlift` |
| Single-leg Romanian deadlift | `single_leg_rdl` |
| Nordic hamstring curl | `nordic_curl` |
| Kettlebell swing | `kettlebell_swing` |
| Push-up | `push_up` |
| Pull-up | `pull_up` |
| Chin-up | `chin_up` |
| Seated cable row | `seated_cable_row` |
| Face pull | `face_pull` |
| Arnold press | `arnold_press` |
| Plank | `plank` |
| Side plank | `side_plank` |
| Copenhagen plank | `copenhagen_plank` |
| Dead bug | `dead_bug` |
| Pallof press | `pallof_press` |
| Hanging leg raise | `hanging_leg_raise` |
| Ab wheel rollout | `ab_wheel` |

### 4.2 Obvious rename (28)

| Existing | Slug | Library name | Note |
|---|---|---|---|
| Back squat | `squat_bb` | Back squat (barbell) | |
| Hack squat | `hack_squat` | Hack squat (machine) | |
| Deadlift | `deadlift` | Deadlift (conventional) | |
| Romanian deadlift | `rdl_bb` | Romanian deadlift (barbell) | |
| Dumbbell Romanian deadlift | `rdl_db` | Romanian deadlift (dumbbell) | |
| Hip thrust | `hip_thrust_bb` | Hip thrust (barbell) | |
| Glute bridge | `glute_bridge_bw` | Glute bridge (bodyweight) | seed is bodyweight, `reps` |
| Cable kickback | `cable_kickback` | Glute kickback (cable) | |
| Standing calf raise | `calf_raise_standing` | Standing calf raise (machine) | |
| Seated calf raise | `calf_raise_seated` | Seated calf raise (machine) | |
| Bench press | `bench_press_bb` | Bench press (barbell) | |
| Incline bench press | `incline_bench_bb` | Incline bench press (barbell) | |
| Dumbbell bench press | `bench_press_db` | Bench press (dumbbell) | |
| Incline dumbbell press | `incline_bench_db` | Incline bench press (dumbbell) | |
| Chest fly | `cable_fly` | Cable fly (mid) | seed is cable |
| Lat pulldown | `lat_pulldown` | Lat pulldown (wide grip) | |
| Barbell row | `barbell_row` | Bent-over row (barbell) | |
| Dumbbell row | `db_row` | Single-arm row (dumbbell) | both unilateral |
| Overhead press | `ohp_bb` | Overhead press (barbell) | |
| Dumbbell shoulder press | `ohp_db` | Shoulder press (dumbbell) | |
| Lateral raise | `lateral_raise_db` | Lateral raise (dumbbell) | seed is dumbbell |
| Rear delt fly | `rear_delt_fly_db` | Rear delt fly (dumbbell) | seed is dumbbell |
| Barbell curl | `bb_curl` | Curl (barbell) | |
| Dumbbell curl | `db_curl` | Curl (dumbbell) | |
| Hammer curl | `hammer_curl` | Hammer curl (dumbbell) | |
| Overhead tricep extension | `overhead_tri_ext_db` | Overhead triceps extension (dumbbell) | seed is dumbbell |
| Skull crusher | `skullcrusher` | Skullcrusher (EZ bar) | seed says barbell; take the library's equipment |
| Farmer's carry | `farmers_walk` | Farmer's walk | seed `measure` is `weight_duration`; the library is `fixed`. Weight stays loggable but the engine ignores it |

### 4.3 Needs a choice (5)

| Existing (seed details) | Options | Recommended |
|---|---|---|
| Leg curl (machine) | `leg_curl_lying`, `leg_curl_seated`, `leg_curl_standing` | **`leg_curl_lying`**. All three are hamstrings-primary and low-fatigue, so the choice barely moves scores |
| Dip (bodyweight + added, seed group chest) | `dip_chest`, `dip_triceps` | **`dip_chest`**, from the seed's group |
| Chest-supported row (machine) | `machine_row`, `chest_supported_row_db` | **`machine_row`**, from the equipment |
| Tricep pushdown (cable) | `tri_pushdown_bar`, `tri_pushdown_rope` | **`tri_pushdown_bar`**. Same muscles either way; the rope gets its own library row |
| Single-leg calf raise (bodyweight + added, unilateral) | `calf_raise_single_db` (weight mode) | **A variant (§4.4), unless it's normally logged with a dumbbell.** In weight mode a bodyweight-only set is 0 kg, which the engine skips (§14), so it would score nothing |

### 4.4 No slug (18)

These rows stay as they are, with no `exercise_muscles`, so they contribute nothing (F22). That's right for mobility, cardio and plyometrics.

| Kind | Existing | Suggestion |
|---|---|---|
| Variant of a claimed slug | B-stance Romanian deadlift (`single_leg_rdl` and `rdl_db` are taken) · Single-leg glute bridge (`glute_bridge_bw` is taken) · Bent-knee calf raise (`calf_raise_seated` is taken, and it's machine-weighted) | Add to the library through `scripts/build_exercise_library.py` with a `pb_estimate` link to the parent, or leave unscored |
| Accessory with no library match | Banded lateral walk (≈ glutes, band) · Bird dog (≈ core, fixed) | Same choice. Low stakes |
| No muscle ID | Tibialis raise (the tibialis isn't one of the 17 muscles) | Leave unscored |
| Plyometrics | Double-leg pogo, Single-leg pogo, Box jump, Broad jump | Leave unscored. Calves, quads and glutes do fatigue, but a fixed cost per set would be a guess |
| Mobility | Leg swings, Hip flexor stretch, Hamstring stretch, Figure-4 glute stretch, Foam roll | Leave unscored |
| Cardio | Stationary bike, Rower, Treadmill | Leave unscored. Phase 10 scores cardio from imported activities, not from these rows |

### 4.5 Library exercises with no existing row

161 − 58 = **103 new global rows** for Phase 1 to insert.

### 4.6 Vocabulary

| Library | → `measure` | `is_bodyweight` |
|---|---|---|
| `weight`, log_as `reps` | `weight_reps` | false |
| `bodyweight`, `reps` | `weight_reps` (weight = added load), matching how the seed stores Pull-up and Dip. The seed's Push-up is `reps`; keep existing rows as they are | true |
| `assisted`, `reps` | `weight_reps` (weight = assistance; Phase 3 labels the field "assist") | false |
| `fixed`, `reps` | `reps` | as the seed has it |
| `fixed`, `seconds` | `duration` | as the seed has it |

The `lift_pbs` "most reps" PB already treats `weight_reps` + `is_bodyweight` + 0 kg as a reps PB, so bodyweight rows keep working there.

### 4.7 Custom exercises

Not checked (§14). The loader never touches rows with an `owner_id`. They stay unscored until Phase 8 lets the user map them or base them on a library exercise.

---

## 5. PBs today vs spec §3.3

**What exists.** Nothing is stored: PBs are recalculated from completed sets on every read.

- `exercise_records` view (`20260922000600_lifting.sql`): best weight, best e1RM (Epley, 1–12 reps only), best set volume, reps and seconds per exercise. Read by `useRecords()`.
- `lift_pbs` view (`20261012000100_pbs.sql`): month, year and all-time bests by **calendar** period in `profiles.timezone`. Metrics:
  - `1rm`: a single counts as itself; 2–12 reps go through Epley;
  - `3rm`, `reps`, `time`, `weight`.

  It uses non-warm-up completed sets of finished workouts.
- In the app:
  - `epley()` (`app/src/api/lifting.ts`) returns null above 12 reps.
  - `sessionBests` / `mergeSession` (`app/src/lib/pbs.ts`) fold the live session into the stored PBs.
  - The **"new PB 🏆"** line (`app/app/(app)/lift/workout.tsx`) appears when a ticked set beats the all-time 1RM.
  - `LivePbPanel` offers % loads from this month's 1RM.
  - The trophy cabinet lives at `app/app/pbs.tsx`.

**So there are no PB records to keep as a "PB events" log.** The PB history the engine needs (Phase 3 step 5) is a query: one record per completed set that has an `e1rm` (`at = workouts.finished_at`), plus `manual_pbs`.

| | `lift_pbs` today | Spec reference |
|---|---|---|
| Window | calendar month / year | trailing 30 days |
| Rep cap | 12 (higher reps ignored) | 20 |
| RPE | ignored | adds reps in reserve |
| Warm-ups | excluded | included in the stored `e1rm` |
| Manual entries | none | `manual_pbs` |
| Stored | no | `e1rm` on each set |

**Recommendation (D4): one e1RM everywhere.** Keep both views for the trophy cabinet and PB tables, since calendar periods are what those screens show. In Phase 3:

- point their 1RM at `workout_sets.e1rm`, keeping their own warm-up exclusion;
- replace `epley()` with the engine's `e1rm`.

Then no screen shows two different 1RMs for the same set.

Side effects: 13–20-rep sets start to count, and sets logged with RPE read higher. Label the engine's reference "last 30 days" so it isn't confused with "this month".

---

## 6. Bodyweight

| Source | What | State |
|---|---|---|
| `profiles` | — | Phase 3 adds `bodyweight_kg` and `bodyweight_updated_at` |
| `wellness.weight_kg` | Daily weight from intervals.icu wellness (`weight`), i.e. Garmin scale or Garmin Connect weigh-ins | Synced by `sync/splitset_sync/wellness.py`. How much data exists is unchecked (§14) |
| `activities.weight_kg` | intervals.icu's athlete weight on the day of an activity | Synced. It's intervals.icu's profile setting, not a weigh-in, so don't use it |
| `workouts.bodyweight_kg` | One value per workout | The column exists, but the app always writes null (`activeWorkout.ts`, `start`) |

**Recommendation (D5):**

- **Current bodyweight:** whichever is newer of `profiles.bodyweight_kg` (by `bodyweight_updated_at`) and the latest `wellness.weight_kg` (by date). Otherwise `bodyweight_default_kg` (75) from constants.
- **Snapshot:** the plan adds `bodyweight_kg` to every set. Filling the existing `workouts.bodyweight_kg` when a workout starts gives the same result as F31, since bodyweight doesn't change mid-session, and needs no new column. The repository then copies it onto each set it hands the engine, so the engine still sees a per-set value. Add the per-set column only if a per-set difference ever matters.

---

## 7. Time

- **Storage:** every timestamp is `timestamptz` (UTC). ✓
- **Time zone:** `profiles.timezone` holds an IANA name. It defaults to UTC and is set from the device at sign-up (`deviceTimezone()` in `app/app/sign-in.tsx`). It's editable in Settings and protected by a validity check constraint (`20261012000100_pbs.sql`). ✓
- **Engine:** hours = epoch milliseconds ÷ 3,600,000, applied to `finished_at` and to `now`. `now` is always passed in, never read inside the engine; the React Compiler lint forbids `Date.now()` in render (use `app/src/lib/clock.ts`).
- **Manual PB date → instant:** do this in SQL (`dated_on::timestamp at time zone p.timezone`). The app has date-fns but no time-zone library.

---

## 8. Where things go

| Piece | Location | Notes |
|---|---|---|
| Engine (Phase 2) | `app/src/lib/recovery/engine.ts` (+ `types.ts`) | Pure TypeScript written so Node can run it directly: relative imports with `.ts` extensions (no `@/` alias), and no `enum` or `namespace`. `load_model.py`'s module globals (`EX`, `C`) become explicit arguments, so fixture `extra_exercises` and `constants_override` are per-case inputs, not mutation |
| Constants loader | `app/src/lib/recovery/thresholds.ts` | Imports `data/recovery_constants.json` and layers `user_thresholds` on top. **Metro probably won't resolve files outside `app/` by default.** Phase 1 should check, and if needed add `app/metro.config.js` with `watchFolders` including `../data`, rather than copying the JSON. Vercel builds from a full checkout, so `../data` is present there |
| Fixture runner | `app/src/lib/recovery/engine.test.ts` | Reads `data/load_model_fixtures.json` with `node:fs` |
| Data access | `app/src/api/recovery.ts` | TanStack Query hooks, like `api/lifting.ts`; also the PB-history builder. Add its keys to `invalidateWorkoutData()` |
| Seed loader | `supabase/seed_library.py` | Python + psycopg as the `postgres` role, run with `cd sync && uv run python ../supabase/seed_library.py`, like `seed_demo.py`. The app can't write global exercises (RLS) |
| Migrations | `supabase/migrations/2026…_recovery_*.sql` | One per phase that changes the schema; then regenerate `database.ts` |
| Body map | `app/src/components/recovery/` (`BodyMap.tsx`, `Legend.tsx`, `MuscleSheet.tsx`, `MuscleList.tsx`) | `react-native-svg` 15 is installed, but importing a `.svg` file needs a Metro transformer, which would be a new dependency. Phase 6 should generate a TypeScript module of path data from `assets/body-*.svg`, with a test that it matches |
| Recovery screen | `app/app/(app)/lift/recovery.tsx`, plus a card on Today (`app/app/(app)/index.tsx`, next to the "Lifting" card) | Six tabs is already plenty |
| Workout summary | `app/app/(app)/lift/history/[id].tsx` | Finish already lands here (`router.replace` in `workout.tsx`) |
| Live workout figure | `app/app/(app)/lift/workout.tsx` | |
| Exercise detail (PB source, "Add a known best", load split, mini figure) | `app/app/(app)/lift/exercises/[id].tsx` | |
| Group filters | `app/app/(app)/lift/picker.tsx`, `lift/exercises/index.tsx` | Both search by name and `muscle_group` today |
| Custom-exercise create (Phase 8) | replaces `app/src/components/lift/ExerciseForm.tsx` | |
| Settings (Phase 9) | `app/app/(app)/settings/recovery.tsx`, linked from `settings/index.tsx` | |

---

## 9. How scoring hooks into logging

- **Live workout:** `useActiveWorkout` holds the session. Ticking a set sets `completed` and `completed_at`. The live session map can be computed from the store with `t_w = now`; nothing touches the database until Finish.
- **Finish:** `finish()` drops empty sets, upserts `workouts.finished_at` and flushes the outbox. If offline, it returns null and the sheet stays open, so scoring happens only once the workout has reached the server.
- **Writing the cache (Phase 4):** the plan wants it "in the same transaction that finishes a workout", but supabase-js can't open a transaction. **Recommendation (D6):** a Postgres function `finish_workout(...)` (`security invoker`, so RLS still applies) that sets `finished_at` and replaces the workout's cache rows in one call. The app computes the loads and passes them in. The fallback is queueing cache upserts behind the workout upsert in the outbox: not atomic, but the recompute rule heals it.
- **What triggers a recompute today:** finished workouts can't be edited, only deleted (`lift/history/[id].tsx`). So the triggers are:
  - deleting a workout;
  - adding, editing or deleting a manual PB;
  - changing an exercise's muscles or fatigue class;
  - changing a threshold.

  If editing finished workouts is added later, it joins the list.
- **Recompute runs in the app**, since that's where the engine lives: load sets from the earliest affected finished workout onward, rescore in time order, then write through the same kind of function. For one athlete's history this is small.
- **Activities (Phase 10):** they arrive through the Python sync job, which has no TypeScript engine. Decide in Phase 10 whether the app scores them on read or the sync job writes rows. Either way, `workout_muscle_loads` needs `activity_id` (§3).

---

## 10. Tests

- **Engine and fixtures (Phase 2), recommendation D1:** Node's built-in runner, `node --test`. Node 22.18+ and 24 run `.ts` files directly by stripping types (24.19 locally; CI's `node-version: 22` resolves to the latest 22.x). `tsconfig` already has `allowImportingTsExtensions`. Add `"test": "node --test src/lib/recovery/*.test.ts"` to `app/package.json` and an `npm test` step to `app.yml`. No new dependency. Phase 2 should first confirm that Node 22 in CI loads the engine's ES-module `.ts` files as written (`app/package.json` has no `"type"`). The alternative, Jest via `jest-expo`, is the new framework the context block rules out.
- **Database integration tests (Phases 1, 3, 4, 5), recommendation D2:** there's nowhere to run them today. Don't point tests at `splitset-dev`, which holds real data and is the sync job's target. Options:
  - **(a) Recommended: a CI job that runs the Supabase CLI's local stack.** `supabase start` needs Docker, which GitHub's Ubuntu runners have. The job applies the migrations and runs the tests there. They wouldn't run locally without Docker.
  - **(b)** A third hosted project for tests. The free plan allows two active projects.
  - **(c)** Keep the integration checks as pure tests over plain row objects, and verify SQL by hand.

  The plan's "through the real logging path" can't drive the zustand store under plain Node (AsyncStorage). Treat the repository functions in `app/src/api/recovery.ts` as the path under test.

---

## 11. Blockers

| Blocker | Blocks | Way out |
|---|---|---|
| No app test runner | Phase 2's "done when" | D1 |
| No database for integration tests | integration tests in Phases 1, 3, 4, 5 | D2 |
| Migrations are applied by Conor (Claude's auto mode refuses `supabase db push`) | runtime checks in every phase that adds a migration | Each such phase ends with "push, regenerate types, then check" |

**Not blockers:**

- **Warm-up flag:** `set_type` already has it.
- **Time zone:** `profiles.timezone`.
- **Bodyweight:** the 75 kg default holds until Phase 3, and Garmin weigh-ins are probably there.
- **RPE:** optional; Phase 3 adds the input.
- **Side:** Phase 3 adds it.

---

## 12. Decisions

| # | Decision | Recommended |
|---|---|---|
| D1 | Test runner for the app | `node --test`, no new dependency (§10) |
| D2 | Where database integration tests run | CI with the Supabase CLI local stack; never `splitset-dev` (§10) |
| D3 | Rename matched global exercises to the library's names | Yes. Ids don't change, so history is untouched, and the picker reads consistently ("Bench press (barbell)" next to "Bench press (dumbbell)") |
| D4 | One e1RM across PB views and engine | Yes, in Phase 3 (§5) |
| D5 | Bodyweight snapshot per workout (existing column) instead of per set | Yes (§6) |
| D6 | Finish and cache write in one Postgres function | Yes (§9) |
| D7 | The five choices in §4.3 and what to do with the 18 rows in §4.4 | Accept the recommended column, and leave §4.4 unscored for now |
| D8 | Recovery screen in the Lift stack, plus a Today card | Yes (§8) |

---

## 13. Where the spec or plan doesn't fit the repo as written

1. **"The app already stores PBs when they happen."** It doesn't; views compute them (§5).
2. **§11 puts `base_hours` on `muscles`.** Phase 1 and the constants file say otherwise, and they win (§3).
3. **Names:** `sets` = `workout_sets`, `user_profile` = `profiles`, `owner_user_id` = `owner_id`, `is_custom` = `owner_id is not null`, `is_warmup` = `set_type = 'warmup'`, `log_as` = `measure` (§3).
4. **"Same transaction that finishes a workout."** It becomes a Postgres function (§9).
5. **"Editing a finished workout."** The app can't do this yet; only deletes trigger a recompute today (§9).
6. **`workout_muscle_loads.workout` for activity rows.** Activities aren't workouts, so the table needs `activity_id` (§3).
7. **"Monthly PB" is a trailing 30 days.** The existing PB screens use calendar months; keep the labels apart (§5).
8. **`app/AGENTS.md` says routes live in `src/app/`.** They live in `app/app/`.

---

## 14. Not checked: live data

The read-only counts below were blocked during Phase 0 (personal data in `splitset-dev`). Worth running once in the Supabase SQL editor before Phases 1 and 3:

```sql
-- custom exercises: need a mapping in Phase 8
select name, measure, equipment, is_bodyweight from exercises where owner_id is not null order by name;

-- which exercises are actually logged: prioritises §4.3 and §4.4
select e.name, e.owner_id is not null as custom, count(*) from workout_sets s
  join exercises e on e.id = s.exercise_id where s.completed group by 1, 2 order by 3 desc;

-- Garmin weigh-ins available for bodyweight
select count(*), min(date), max(date) from wellness where weight_kg is not null;

-- how sets are logged: RPE share, reps above 12, set types, ticked sets without a time
select count(*) filter (where rpe is not null) as with_rpe,
       count(*) filter (where reps > 12 and weight_kg > 0) as over_12_reps,
       count(*) filter (where set_type = 'warmup') as warmups,
       count(*) filter (where completed_at is null) as no_time,
       count(*) as total
  from workout_sets where completed;
```

---

## 15. Phase 1: decisions made

Phase 1 output · 2026-10-16. Muscles, the library and the constants loader.

### 15.1 Decisions from §12, now settled

| # | Settled as |
|---|---|
| D1 | `node --test`. `cd app && npm test` runs `src/**/*.test.ts`, and `app.yml` runs it too. TypeScript 6 no longer loads `@types` packages on its own, so each test file starts with `/// <reference types="node" />`. `@types/node` is now an explicit dev dependency, the version Expo already brought in |
| D2 | The new `db-tests` workflow starts a throwaway local Supabase database on the runner (`supabase db start`, which applies every migration). The tests then seed it. It runs on push to any branch. The database tests skip unless `SPLITSET_TEST_DB_URL` points at a local host, and they never read `SUPABASE_DB_URL` |
| D3 | Matched global rows take the library name. `seed_demo.py` still looks exercises up by its old names, and resolves them through `LEGACY_NAMES` → slug |
| D7 | The §4.3 picks as recommended. Single-leg calf raise stays unscored. Result: 57 rows matched, 104 inserted, 19 left unscored. Global `exercises` rows: 76 + 104 = 180, of which 161 have a slug |
| Seeding | By hand once, after the Phase 1 migration is pushed. `migrate.yml` then runs `seed_library.py` after every `db push` on main, and also when only the loader or `data/exercise_library.json` changes |

### 15.2 Schema

1. **`exercises` gets eight columns:** `slug`, `"group"`, `load_mode`, `bw_factor`, `fatigue`, `load_split`, `pb_estimate_from` and `pb_estimate_ratio`. The rest of the plan's list maps onto existing columns (§3): `log_as` → `measure`, `note` → `instructions`, `unilateral` → `is_unilateral`, `is_custom` → `owner_id is not null`, `owner_user_id` → `owner_id`.
2. **The column is called `group`, as in the spec.** That's a reserved word, so SQL quotes it (`"group"`). supabase-js and PostgREST handle it unquoted.
3. **`pb_estimate_from` holds the slug, not the uuid,** because the engine works in slugs.
   - It's a foreign key to `exercises.slug`, deferrable, so the loader can write in file order.
   - It's set to null if the target is deleted. The ratio may then linger, and is ignored.
   - `slug` is a plain `unique` column; nulls don't clash.
4. **`bw_factor` and `pb_estimate_ratio` are `double precision`, not `real`,** so a ratio of 0.38 reads back as 0.38.
5. **Not enforced in SQL:**
   - role caps;
   - at least one primary;
   - library chains of 3 hops or fewer.

   The first two would hard-code numbers from `role_caps`. `validate()` in the loader enforces all three, and the Phase 8 create flow must too. The chain limit is derived as `pb.estimate_max_hops − 1`, so a custom exercise's extra hop always resolves (F30). It's not a new constant.
6. **The constraints SQL does enforce:**
   - `bw_factor` is set exactly when `load_mode` is `bodyweight` or `assisted`;
   - a row with a slug has `load_mode` and `fatigue`;
   - `load_split` is a JSON object;
   - a user's own row can only carry a slug starting with `custom_`, so nobody can claim a library slug before the seed does.
7. **`exercise_muscles`:**
   - no `updated_at` and no `lww_guard`, because an exercise's rows are always replaced as a set;
   - users can read rows for global exercises and their own, and can write rows only for their own exercises (ready for Phase 8);
   - an index on `(muscle_id, role)` serves "train next".
8. **`user_thresholds` is created now,** because the loader reads it:
   - `value jsonb`, with the key's format checked;
   - owner-only, with `lww_guard`;
   - primary key `(user_id, key)`.

### 15.3 Seed loader (`supabase/seed_library.py`)

9. **Who owns which columns on a matched row.** The library owns:
   - `name`, `slug`, `group`, `equipment`, `is_unilateral`;
   - the library columns;
   - `instructions`, taken from `note`; an empty note becomes null.

   The row keeps its own `measure`, `is_bodyweight` and `muscle_group`, so existing logs and PB views read the same (§4.6). For example, Farmer's carry stays `weight_duration`.
10. **New rows:**
    - `measure` and `is_bodyweight` follow §4.6. A `fixed` exercise counts as bodyweight when its equipment is bodyweight.
    - `muscle_group` comes from the first primary muscle, in the older vocabulary.
    - Forearms and adductors have no match there, so they get null.
    - The Full body group gets `full_body`.
11. **What runs twice changes nothing.**
    - Rows are written only when a value differs, and `updated_at` moves only then.
    - An exercise's `exercise_muscles` rows are replaced only when its set differs from the library's.
    - So a second run reports 0 changes, and the snapshots match, `updated_at` included.
    - Renames run before inserts.
12. **Matching:** by slug first, then by the explicit `LEGACY_NAMES` map (§4.1 to §4.3). There's no fuzzy match. A global row the map doesn't know about, but which has a library name, makes the insert fail on the unique-name index rather than being guessed at.
13. **`--dry-run`** does everything, checks the deferred foreign key, prints the counts and rolls back.

### 15.4 Constants loader (`app/src/lib/recovery/`)

14. **`library.ts`** holds identifiers only: `MUSCLE_IDS` (§2 order), `EXERCISE_GROUPS` and `ROLES`. Tests check them against the library JSON.
15. **`thresholds.ts`:** the `Thresholds` type mirrors the JSON.
    - `parseConstants` drops `_doc` and deep-freezes the result.
    - Dotted keys can index arrays, so `levels.3.min` works.
    - **What an override may do:**
      - replace an existing leaf with a value of the same type;
      - add `base_recovery_hours.<muscle>` for any of the 17 muscles.

      Whole sections, `__proto__`-style keys and non-finite numbers are rejected. `pb.manual_policy` must be `max` or `replace_on_log`.
    - **`thresholdsFor`** ignores other users' rows and silently skips invalid ones, so a stale key can't break the map. With nothing to apply, it returns the frozen defaults object itself.
    - **`withOverride` and `isValidOverride`** are for Phase 9's settings writer. `withOverride` throws on an invalid override.
16. **`constants.ts` is the only file that imports `data/recovery_constants.json`.** `app/metro.config.js` adds `../data` to `watchFolders`. I checked this: without it, Metro fails with "Unable to resolve module", despite SDK 56's on-demand filesystem.
    - Metro also resolves the `.ts`-extension imports Node needs.
    - A Vercel build needs files outside the root directory available, which is Vercel's default.
17. **`useThresholds()`** in `app/src/api/recovery.ts`, query key `['thresholds', uid]`. It returns the defaults while loading or on error.

### 15.5 Picker

18. **One `filterExercises` for both screens.**
    - Search matches name, slug, group and `muscle_group`, so "rdl" finds both RDLs.
    - The chips are All plus the 7 groups.
    - Rows without a group (the 19 unscored ones and custom exercises) appear only under All.
    - The subtitle shows `group` when `muscle_group` is null.

### 15.6 Ambiguities resolved

- **Phase 1 lists `log_as`, `note`, `is_custom` and `owner_user_id` as columns to add.** They already exist under other names, so I mapped them (item 1).
- **"161 exercises":** that's 161 global rows with a slug. The table also keeps 19 unscored legacy rows, so it holds 180 global rows.
- **"Library chains are ≤ 3 hops":** checked on the library, which leaves one hop for a custom exercise (item 5).
- **"Per-user overrides":** the plan names keys like `base_recovery_hours.default`, but Phase 9 also sets base hours per muscle. So `base_recovery_hours.<muscle>` is the one kind of key an override may add (item 15).

---

## 16. Phase 2: decisions made

Phase 2 output · 2026-10-16. The engine: `app/src/lib/recovery/engine.ts` and `types.ts`.

### 16.1 Result

- **Fixtures:** all 31 pass in `npm test`. The runner compares 198 values, the same 198 that `scripts/verify_spec_fixtures.py` compares, and fails any fixture that compares nothing.
- **Cross-check against the reference (one-off, not committed):**
  - 400 random timelines (1,851 workouts), scored by both `scripts/load_model.py` and the engine;
  - covering both manual-PB policies, lapsed and estimated PBs, calibration, bodyweight snapshots (including 0), RPE 0 and 11, warm-ups, per-side sets and repeated blocks;
  - 558,312 values compared, with 0 mismatches. The largest difference is 8.9 × 10⁻¹⁶.

### 16.2 Shape of the port

1. **Same functions, same order, camelCase names.** For example, `score_exercise` → `scoreExercise` and `hours_until_below` → `hoursUntilBelow`.
   - `_records` and `_own_pb` stay private, as `records` and `ownPb`.
   - `level_info`, which `muscle_state` uses but the plan's list leaves out, is `levelInfo`.
2. **The reference's globals become arguments.** `C` and `EX` become a `Model` (`{ c: Thresholds, lib: Library }`), passed as the first argument.
   - A fixture's `extra_exercises` and `constants_override` build a `Model` for that case only, through `buildLibrary` and Phase 1's `withOverride`. Nothing global changes.
   - The `Library` is a `Map` keyed by slug.
3. **Field names follow the reference and the library JSON.**
   - Exercises use `load_mode`, `bw_factor` and `pb_estimate`.
   - Sets use `w`, `r`, `rpe`, `warmup`, `seconds`, `side` and `bodyweight`.
   - Results keep the spec's symbols (`L_e`, `L_m`, `R`, `F`, `W`), plus the snake_case names Phase 5 returns (`ready_in_h`, `trainable_in_h`, `pb_source`).
   - **For Phase 3:** the repository maps `workout_sets` rows onto `LiftSet`: `weight_kg` → `w`, `reps` → `r`, `set_type = 'warmup'` → `warmup`, and the workout's bodyweight → `bodyweight`.

### 16.3 Where the port deliberately differs from the reference

4. **`scoreWorkout` doesn't touch the history it's given.** It returns the workout's PB records, dated at its end, in `records`.
   - `scoreWorkouts(m, workouts, history)` scores workouts in the order given and carries each one's records into the next, as the reference's shared list does.
   - Callers pass workouts in the order they happened.
   - Phase 4's recompute should use `scoreWorkouts`.
5. **Unknown exercises never throw from a workout.**
   - `scoreWorkout` and `muscleLoads` skip a slug that isn't in the library. Python raises a `KeyError` there.
   - `scoreExercise`, called directly with an unknown slug, throws.
   - A `pb_estimate` link to an exercise missing from the library ends the chain, which means calibration.
   - `muscleLoads` ignores muscle IDs outside the 17.
6. **Sets that can't be scored are skipped.**
   - A set with no reps is skipped like a zero-weight set; Python would raise.
   - A bodyweight or assisted exercise without a `bw_factor` gives no effective weight. Phase 1's constraint already rules that out in the database.
7. **Python's truthiness is spelt out.**
   - A missing or zero bodyweight snapshot falls back to the current bodyweight, and a missing weight counts as no added load.
   - RPE 0 still counts as an RPE (`rpe == null` is the test).
   - On ties, the first record wins, as Python's `max()` does. This decides whether a reference shows as manual or logged.
8. **`firstTime` drops the reference's unused `terms` parameter.**
9. **Two extra output fields.** `muscleState` and `sessionMap` also return `fill_dark`, and `muscleState` returns `advice`. Phase 5 lists both.
10. **`fmtHours` rounds exact halves to even,** as Python's `round()` and `format` do: 12.5 h shows as "12 h" and 54 h as "2.2 days". JavaScript's `Math.round` and `toFixed` would round them up.

### 16.4 Constants and fixed numbers

11. **Every tunable number comes from `Thresholds`.** The numbers that stay in code are named at the top of `engine.ts`, with the same values the reference hard-codes:
    - the RPE scale's 10, and the RIR clamp of 0 to 5 (the constants file states this only as text, in `e1rm.rir_from_rpe`);
    - the fixed-set RPE pivot of 8 (in `fixed_set._doc` only);
    - INOL's 100;
    - 24 hours per day;
    - the 15-minute scan step (§9).

### 16.5 Ambiguities resolved

- **Exact solve or the 15-minute scan (Phase 2, item 3):** I kept the scan. The fixtures were computed on the 15-minute grid. In F24, chest's exact ready time is 53.69 h against the fixture's 53.75 h, which is 0.057 off, more than the 0.01 tolerance.
- **The plan names `_records` and `_own_pb` with Python's leading underscore.** They're ported as private functions without it.
- **Node 22 in CI:** `tsc --erasableSyntaxOnly` finds nothing in the engine or test files, so Node can strip their types. `app.yml` runs `npm test` only on main and on pull requests, so CI hasn't run it on this branch yet.

### 16.6 Tests

- **`engine.test.ts`:** the fixture runner. One test per fixture, one checking that F01 to F31 are all present, and a closing summary line.
- **`engine.edge.test.ts`:** 14 tests, covering:
  - `fmtHours` against the reference's output;
  - RIR clamping and the fixed-set cost clamp;
  - the bodyweight snapshot fallback;
  - inclusive level boundaries and the weekly guard;
  - thresholds flowing through (`lookbackHours`; base hours 72 give chest 89.6 h);
  - the §14 skips;
  - purity: frozen inputs, and history carried from workout to workout.
- **`npm test` now runs 69 tests.**
