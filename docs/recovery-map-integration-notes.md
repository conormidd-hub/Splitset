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

---

## 17. Phase 3: decisions made

Phase 3 output · 2026-10-16. Set fields, the stored e1RM, manual PBs, and the PB section of the exercise screen.

### 17.1 Decisions from §12, now settled

| # | Settled as |
|---|---|
| D4 | **One e1RM everywhere.** `lift_pbs` (1RM) and `exercise_records` (`best_e1rm_kg`) read `workout_sets.e1rm`, and both still leave warm-ups out. The logger's "new PB 🏆", the Progress chart and the finished-workout screen read it too. `epley()` is gone. Side effects: sets logged with RPE read higher, 13–20-rep sets count, and a bodyweight lift's 1RM includes bodyweight. A single shows as "tested" only when it is its own e1RM, i.e. no reps in reserve |
| D5 | **Bodyweight snapshot per workout.** `workouts.bodyweight_kg` is filled when a workout starts, or by the workout screen as soon as the bodyweight has loaded. The engine reads it for every set. There's no `workout_sets.bodyweight_kg` |
| UI | **RPE** is a per-exercise switch in the logger, on automatically if a set already has an RPE. **The PB section** sits on the exercise detail screen, above Records |

### 17.2 Schema (`20261016000200_recovery_sets_pbs.sql`)

1. **`workout_sets`:**
   - gains `side` (left/right) and `e1rm` (double precision, > 0);
   - `rpe` is checked to 6–10 in half steps;
   - warm-ups stay `set_type = 'warmup'`, so there's no `is_warmup` column (notes §3).
2. **`profiles`:** gains `bodyweight_kg` (20–400) and `bodyweight_updated_at`, with update grants.
3. **`manual_pbs`:**
   - columns `weight_kg`, `reps`, `e1rm`, `dated_at` (a `date`), plus `created_at` and `updated_at`;
   - owner-only, with `lww_guard`;
   - a user can only add one for an exercise they can see, because the RLS check re-reads `exercises` under their own rules.
4. **`pb_history` view:**
   - every completed set of a finished workout that has an e1RM, warm-ups included, dated at `finished_at`;
   - plus every manual PB, dated at the start of `dated_at` in `profiles.timezone`, worked out in SQL (notes §7);
   - the app pages through it 1,000 rows at a time, PostgREST's cap.
5. **No maths in SQL.** The views read the stored e1RM. The migration changes no existing data.

### 17.3 Computing the e1RM: one path, through the engine

6. **`src/lib/recovery/sets.ts`:**
   - `setE1rm` chains the engine's `effectiveWeight`, `rirFromRpe` and `e1rm`, with `rir_default` when there's no RPE. That's the rule `scoreExercise` uses for the records it creates, and a test checks the two agree.
   - `exerciseDef` turns an `exercises` row into the engine's library entry.
   - `currentBodyweight` picks the newer of the profile entry and the latest weigh-in. A profile entry made on a weigh-in's day wins. With neither, it uses `bodyweight_default_kg`.
7. **Exercises outside the library** that are logged as weight × reps count as plain weight mode, keyed by id. So custom and legacy lifts keep a 1RM in the trophy cabinet (D4). Holds, carries and cardio get no e1RM.
8. **`src/lib/lifting/setRow.ts`** builds the `workout_sets` row. It's moved out of the store so Node can build the identical row.
   - The store keeps each exercise's library facts on its block: slug, load mode, bodyweight factor, one-sided, bodyweight.
   - The store holds the user's thresholds, which the workout screen sets.
   - A block saved before Phase 3 has only its measure, so it gets weight mode.
9. **When the bodyweight snapshot arrives late,** sets of bodyweight and assisted exercises are saved again, so their e1RMs follow it.
10. **`app/scripts/recovery-cli.ts`** gives Python the same code: JSON in, JSON out. The backfill and the database tests use it. No engine maths was ported to Python.

### 17.4 Logging

11. **RPE:** the cell opens a picker of 6 · 6.5 … 10, or none. The column narrows the row, and "previous" truncates to make room.
12. **Sides:** one-sided exercises get "Each side".
    - Turning it on gives open sets without a side alternating L/R, and new sets alternate too.
    - Turning it off clears the sides, so one set covers both again.
    - The L/R chip on a set toggles it.
13. **e1RM display:** a ticked set shows "e1RM …", and the finished-workout screen shows the stored value and the side.
14. **"New PB 🏆"** compares the session's best e1RM with the all-time best: the `lift_pbs` 1RM or your best manual entry, whichever is higher. Manual PBs stay out of the trophy cabinet, whose rows link to logged sets.

### 17.5 PB section (exercise detail screen)

15. **What it shows:**
    - the reference a session starting now would use, from `pbBefore`;
    - its source: Logged, Manual, Lapsed, "Estimated from <exercise>" or Calibrating. The window and lapse in the label come from the thresholds;
    - the best in the last `pb.window_days` (both sources);
    - the all-time best.

    Fixed-cost exercises say they need no reference.
16. **Which history it loads:** only the exercise and the exercises its estimate chain can reach.
17. **PB history list:** each workout's best set plus each manual entry, newest first, with logged/manual badges. A logged row opens its workout; a manual row offers to delete it.
18. **"Add a known best":**
    - weight × reps, dated today unless a past date (YYYY-MM-DD) is typed;
    - for bodyweight and assisted exercises, the weight is the added load or the assistance, and today's bodyweight counts;
    - the e1RM is computed in the app by the same `setE1rm`.

### 17.6 Backfill (`supabase/backfill_e1rm.py`)

19. **It only ever fills nulls:**
    - `workouts.bodyweight_kg` on workouts with a bodyweight or assisted set, using the current bodyweight, once;
    - `workout_sets.e1rm` wherever the engine gives one.
20. **It leaves everything else alone:** weights, reps, RPE, set types and `updated_at` are untouched. A second run changes nothing, and `--dry-run` rolls back.
21. **The demo seed calls it too,** so a rebuilt demo has e1RMs. `seed_demo.py` now needs Node.

### 17.7 Ambiguities resolved

- **"`sets`: add `rpe`, `seconds`, `is_warmup`, `bodyweight_kg`":** `rpe` and `seconds` already existed (`rpe` gained the check), `is_warmup` is `set_type`, and the bodyweight snapshot is per workout (D5).
- **`manual_pbs.weight` and `dated_at`:** the column is `weight_kg`, as elsewhere in the repo, and `dated_at` is a `date`.
- **"Backfill every historical set in a migration":** SQL can't run the engine, and porting the e1RM to SQL would rewrite the maths. So the migration only adds the column, and `backfill_e1rm.py` fills it using the engine.
- **"The real logging path" in the database tests:** the store needs React Native storage. So the tests build rows with the store's own row builder through the CLI, and insert them as the signed-in user under RLS.
- **The e1RM of a 0-rep set** is its weight, as in the engine. A set with no reps gets none.

### 17.8 Tests

- **`npm test`: 94 tests.** The new ones are `sets.test.ts`, `setRow.test.ts` and `pbHistory.test.ts`. They cover:
  - F02 storing 126.5 and 125.0;
  - RPE (F04), the 20-rep cap (F03) and the bodyweight snapshot (F31);
  - agreement with the engine's own records;
  - the saved row;
  - the reference cases F14, F17 and F18.
- **`db-tests` (CI): 21 database tests,** now with Node on the runner. They cover:
  - F02 sets saved through the app's row builder as the signed-in user;
  - `pb_history`, `lift_pbs` and `exercise_records` reading the stored e1RM;
  - F18 dated at local midnight in Melbourne;
  - F14 and F17;
  - the backfill, including that a second run changes nothing;
  - the access rules, and the RPE and side checks.
- **Failures show on the PR.** `supabase/tests/conftest.py` turns failing tests, test files that won't load, and a one-line summary into GitHub annotations, because job logs need sign-in to read. That's how the backfill's mixed int/float bug (JSON returns 105 as an integer) was found and fixed before it reached the real database.

### 17.9 On splitset-dev (2026-10-16)

- **Migration:** `20261016000200_recovery_sets_pbs` was pushed by Conor.
- **Backfill:**
  - 1,680 of the demo's 1,836 sets got an e1RM; the other 156 are holds, carries or sets with no weight;
  - no workout needed a bodyweight;
  - a second run finds nothing.
- **Regenerated types** matched the hand-written ones exactly.
- **Checked in the web preview as the demo user:**
  - the logger stores 115 × 3 as 126.5, and 134.2 at RPE 8;
  - "new PB" fires;
  - per-side sets store `left` and `right`;
  - the workout's bodyweight snapshot is 72.8 kg, from the latest weigh-in;
  - the PB section shows Logged, Manual, "Estimated from Bench press (barbell)" (86.4 kg from a 120 kg known best), Calibrating, and "needs no reference" for a plank;
  - adding and deleting a known best works.

  The test workout and known best were deleted afterwards.

---

## 18. Phase 4: decisions made

Phase 4 output · 2026-10-16. The per-workout cache, the recompute rule, live scoring, the rescore backfill and the F26 seed.

### 18.1 Settled with Conor

| | Settled as |
|---|---|
| D6 | **Finish and the cache write are one transaction.** `finish_workout()` (security invoker) sets `finished_at` and replaces the workout's cache rows. `save_workout_loads()` does the replacing on its own, for recompute |
| F26 seed | **For the demo athlete only**, the same guard as `seed_demo.py`. F26's PBs come from a "PBs (fixture F26)" workout of singles 168 h before Monday, so `pb_history` holds them exactly as the fixture does: logged, at −168 h. It was run once on splitset-dev |
| Library changes | `migrate.yml` runs `rescore_workouts.py` after `seed_library.py`, since a change to an exercise's muscles or fatigue class changes every cached workout that used it (§14). The job now sets up Node |
| Existing workouts | Dummy data. They were rescored, then replaced by the F26 week without asking, as Conor said |

### 18.2 Schema (`20261016000300_recovery_loads.sql`)

1. **`workout_muscle_loads`:**
   - one row per muscle a workout loaded (L > 0), so no row means 0;
   - columns: `load` (L), `recovery_hours` (R), `finished_at` (t_w), `source` (lift or activity);
   - a row belongs to a workout or an activity, never both, enforced by a check. This is ready for Phase 10, since activities have text ids (§3);
   - a unique index per (workout, muscle), and per (activity, muscle);
   - an index on (user, `finished_at`) for Phase 5's reads.
2. **`workout_exercise_loads`:**
   - one row per (workout, exercise): `load` (L_e, both blocks of an exercise summed, F28), `pb_source`, `pb_detail`;
   - plus **`pb_value`**, the reference e1RM the session started from. The plan doesn't list it, but Phase 5's contribution list and Phase 6's tap detail need it, and it costs nothing to store.
3. **Access:** both tables are owner-only, with select, insert and delete; there are no updates, because rows are replaced as a set.
4. **Function checks:**
   - both functions raise an error for a workout the caller can't see (RLS hides it), and `save_workout_loads` also for an unfinished one;
   - `finish_workout` only moves `updated_at` forward (`greatest(updated_at, now())`), so a device whose clock ran ahead can't make the last-write-wins guard drop the finish.

### 18.3 Scoring: one path, through the engine

5. **The PB history is `pb_history`:** stored set e1RMs (Phase 3) plus manual PBs.
   - A workout is scored with `scoreWorkout` against the records dated before it started, which is what the reference gets by appending records as it goes. So the "rebuild PB history as it goes" of §14 is the stored history itself, and a workout's rows don't depend on which other workouts are rescored with it.
   - Workouts are still processed in time order.
6. **`src/lib/recovery/workoutLoads.ts` (pure):**
   - **Rows to the engine:** `libraryFromRows` builds the library, now with muscles by role. `engineWorkout` turns a stored workout into its blocks in order, with ticked sets only and the workout's bodyweight on each set.
   - **Engine to cache:** `scoreFinishedWorkouts` scores, and `cacheRows` shapes the rows.
   - **Live workouts:** `scoreLiveWorkout` scores the logger's in-progress workout with t_w = now.
   - **Reading the cache:** `recoveryMapFromLoads` is the recovery map over cache rows, one term per row (§8). Phase 5 builds on it.
7. **The CLI gains `score-workouts` and `recovery-map`.** `rescore_workouts.py`, `seed_f26.py` and the database tests score through them, so Python never computes a load.

### 18.4 In the app

8. **Finish:**
   - The save queue gets a `finish` step after the workout's last upserts. It fetches what scoring needs, scores the workout with t_w = its finish time, and calls `finish_workout`.
   - Offline, the step stays queued and the sheet stays open, as before. A step persisted from an older app version replays the same way.
   - If a finished workout started after this one, the recompute rule runs from here.
9. **The recompute rule (§14), in the background (`recomputeFrom`, `useRecomputeStatus`):**
   - **Deleting a finished workout:** rescore from its start.
   - **Adding or deleting a manual PB:** rescore from the day before its date, which safely covers the start of that date in any time zone.
   - **Changing an exercise's muscles or fatigue:** today that only happens through the library, so `migrate.yml` handles it. Phase 8's custom exercises will call `recomputeFrom` themselves.
   - **Changing a threshold:** Phase 9.
   - **"Updating…":** `useRecomputeStatus` reports `running` for Phase 6's figure, and the last error if one failed.
10. **`useLiveSession()`:** the workout in progress, scored from its ticked sets against the full PB history, with its session map. Nothing is cached until Finish. Phase 7 draws it.
11. **Reading in pages:** exercises, `exercise_muscles` and `pb_history` 1,000 rows at a time, and workouts with their blocks and sets 100 at a time.

### 18.5 Scripts

12. **`supabase/rescore_workouts.py`** (`--dry-run`, `--user`, `--from`):
    - it's the one-off backfill and the recompute rule outside the app;
    - it reports how many workouts' rows actually changed, so a second run says 0;
    - `seed_demo.py` calls it too, so a rebuilt demo has its cache.
13. **`supabase/seed_f26.py`** (`--now`):
    - **Clears:** the demo's workouts (their sets, cache rows and plan links go with them) and its manual PBs.
    - **Loads:** the PBs workout, then Push, Pull and Legs at F26's hours, with t0 = now − 68 h. They end 50, 26 and 2 hours before now, so their weekday names follow the real calendar, not the fixture's.
    - **Reports:** each muscle's level and F at now against F26, and it notes any threshold overrides (F26 assumes the defaults).
    - It reads the fixture straight from `data/load_model_fixtures.json`.

### 18.6 Tests

- **`npm test`: 100 tests.** The new `workoutLoads.test.ts` covers:
  - F20's cache rows (L, R, L_e, and the pre-session reference, lateral raise 13);
  - F28 as one bench row of 0.6181;
  - time order;
  - Monday's bench edit rescoring Tuesday's curls (the reference is bench × 0.85 × 0.45 × 0.9, and biceps load drops);
  - the live score;
  - F26's levels and F read back from cache rows.
- **`db-tests` (CI): 48 tests, 9 of them new:**
  - finishing F20 through `finish_workout` as the user;
  - F28;
  - the Monday edit with the rescore;
  - a second rescore changing nothing;
  - access to the cache and the functions;
  - the workout-or-activity check;
  - unfinished workouts refused;
  - the F26 seed reproducing the fixture and replacing rather than adding on a second run.

### 18.7 On splitset-dev (2026-10-16)

- **Migration:** `20261016000300_recovery_loads` was pushed from a Terminal tab.
- **Rescore backfill:** all 101 finished demo workouts in about 5 s, giving 1,010 muscle rows and 530 exercise rows. A second run changed 0.
- **The F26 seed:** run once. All 17 muscles matched F26's levels, and hamstrings 2.56, quads 2.43 and biceps 2.07 matched its F values.
- **Regenerated types** matched the hand-written ones exactly.
- **Checked in the web preview:** finishing a one-set workout (bench 90 × 8) wrote chest 0.32 (R 28.6 h), triceps and front delts 0.128, and bench as "monthly, logged, 120", with t_w equal to `finished_at`. Deleting it removed its rows. The demo now holds just the F26 week.

### 18.8 Ambiguities resolved

- **"One row per touched muscle … zeros elsewhere":** muscles with L = 0 get no row, and a missing row reads as 0.
- **"Rebuilding PB history as it goes":** the stored e1RMs already are that history (item 5). The recompute rescores against them, in time order.
- **"Run it as a background job if it takes more than a moment":** the app always runs recompute in the background and shows its status. For one athlete it takes a few seconds; the demo's 101 workouts took about 5 s from Python.
- **"Editing a finished workout":** the app still can't. The recompute is wired to the edits that exist today (delete, manual PBs), and the database test simulates an edit.
- **Dates in the F26 seed:** "now falls on the Wednesday at 20:00" is relative: now becomes fixture hour 68. `--now` pins another instant.

---

## 19. Phase 5: decisions made

Phase 5 output · 2026-10-18. The read side: `recovery_map`, `session_map` and `recovery_history`.

### 19.1 Settled with Conor

| | Settled as |
|---|---|
| Read path | **One read-only function, `recovery_loads(p_from, p_to)`** (`20261016000400_recovery_read.sql`), rather than plain table reads, so the database tests call exactly what the app calls |
| History samples | **They end on `to`:** `to`, `to − step`, … while still after `from`, returned oldest first. Seven days at 24 h is 7 samples, and the last one is exactly `to`, usually now |

### 19.2 Schema

1. **`recovery_loads(p_from, p_to default null) → jsonb`:**
   - It returns `{muscles, exercises}` for workouts (and, from Phase 10, activities) finished in (from, to]. A null `to` means no upper bound.
   - **Muscle rows:** `workout_id`, `activity_id`, `source`, `muscle_id`, `load`, `recovery_hours`, `finished_at`.
   - **Exercise rows:** `exercise_id`, the exercise's `name`, `load` (L_e > 0 only), `pb_source`, `pb_detail`, `pb_value`, and the workout's `finished_at`.
   - **Access:** it's stable and security invoker, and filters on `auth.uid()` (through the Phase 4 index), so a caller only ever reads their own rows. `authenticated` can execute it; `anon` can't. It changes no tables or rows.
2. **No maths in SQL.** Levels, colours and times are worked out in the app by the engine.

### 19.3 The read model (`src/lib/recovery/read.ts`, pure)

3. **`recoveryMapAt(m, keyOf, loads, at)`** is `recovery_map`.
   - **Window:** it reads (at − (`lookback_hours()` + 168 h), at], which is 312 h with the defaults.
   - **Per muscle:** the Phase 2 `muscleState` fields plus `contributing`.
   - **Past moments:** rows finished after `at` are dropped, so a past moment reads as it did then. That includes ready and trainable times, which would otherwise "know" about later workouts.
4. **`contributing`:** `{exercise_id, exercise, workout_id, workout_date, role, load, pb_source, pb_detail}`, largest first.
   - It covers workouts finished in the weekly window before `at` (spec §10's "last 168 h"), with `load = role_weight × L_e`. That's the same window W sums over, so the contributions add up to W.
   - With the defaults the window is longer than the 144 h lookback, so every workout still adding fatigue is listed.
   - Roles come from `exercise_muscles` as they are now. After a library change, the rescore in `migrate.yml` brings the cache back in line with them.
5. **`sessionMapFromLoads(m, rows)`** is `session_map`.
   - It feeds the cached L and R to the engine's `sessionMap`. A muscle with no row gets L = 0 and the R the engine gives an unloaded muscle, so the result equals scoring the workout afresh.
   - **Renamed fields:** `trainable_after_h` and `ready_after_h` (hours after the workout), as the plan names them. `useLiveSession()` returns the same shape, so Phase 7 can draw live and finished workouts alike.
6. **`recoveryHistory(…, from, to, step = 24)`** is `recovery_history`.
   - One read covers every sample.
   - It refuses a step ≤ 0, or more than 1,000 samples.
7. **Thresholds:** a past moment is read with the user's current thresholds and the current cache. Phase 9's threshold changes trigger the recompute, so history follows them.

### 19.4 In the app (`src/api/recovery.ts`)

8. **There's no app server, so the plan's "local store" is:**
   - **repository functions:** `fetchRecoveryMap(uid, at?)`, `fetchSessionMap(uid, workoutId)` and `fetchRecoveryHistory(uid, from, to, stepHours)`;
   - **hooks:** `useRecoveryMap(at?)`, `useSessionMap(workoutId)` and `useRecoveryHistory(from, to, stepHours)`;
   - **times:** given as ISO strings or epoch ms.
9. **"Finishing a workout changes the map without a restart":**
   - The hooks' query keys sit under `['workoutLoads', uid]`.
   - Finishing a workout, the recompute rule and deleting a workout already invalidate that key, so the next render reads the new rows.
10. **The map "now":**
    - It follows a new `useNowMinute()` clock and is recomputed in memory each minute.
    - Its rows are read from an hour-aligned start with no upper bound, so they're only refetched when the hour or the cache changes.
    - A fixed `at` reads exactly its own window.
11. **`session_map`** reads the workout's `workout_muscle_loads` rows directly; one select is all it needs.

### 19.5 CLI and scripts

12. **`recovery-cli.ts` commands:**
    - `recovery-map` now takes `loads` (what `recovery_loads()` returns) and returns `contributing`. Muscle-only `rows` still work, so `seed_f26.py` is unchanged.
    - New: `session-map` and `recovery-history`.

### 19.6 Tests

- **`npm test`: 109 tests.**
  - **The new `read.test.ts`:**
    - F26 at Wednesday 20:00: hamstrings Very high; quads, glutes, biceps and traps High; the other muscles as in F26;
    - contributions: largest first, correct roles, `role_weight × L_e` each, adding up to W;
    - past moments: Monday 00:00 is all Ready; Wednesday 17:30 reads the same as if Legs had never happened;
    - the read window's bounds;
    - 7 samples over 7 days, the last equal to the map at `to`;
    - F20's session view from its cache: levels, R, and trainable and ready after, equal to the engine's.
  - **Shared helpers:** the fixture-row builders moved from `workoutLoads.test.ts` into `testRows.ts`.
- **`db-tests` (CI): 56 tests, 8 of them new (`test_recovery_read.py`).**
  - **The real logging path:** F26 is logged the way the app logs it. Each set is built by the logger's own row builder (`set-rows`) and saved as the user, and each workout is finished through `finish_workout()` with the engine's scores, in time order.
  - **Reading it back:** through `recovery_loads()` as that user. The checks cover:
    - Wednesday 20:00, with contributions adding up to W;
    - a past moment;
    - 7 history samples;
    - the Legs session view;
    - the window's bounds;
    - owner-only access, with `anon` refused.
  - **"Done when":** finishing a curl workout at 19:00 raises biceps in the next read, and deleting it restores the map exactly.
- **pytest locally:** 79 passed, 38 skipped. The skipped ones are the database tests, which only run in CI.

### 19.7 On splitset-dev (2026-10-18)

- **Migration:** `20261016000400_recovery_read` was pushed by Conor. The regenerated types matched the hand-written ones exactly.
- **The F26 seed:** re-run with now = 2026-10-18 07:28 UTC as Wednesday 20:00. It matches F26.
- **Read back as the demo user** through `recovery_loads()`, then the app's code:
  - every F, level, "trainable in" and "ready in" matches the table in `docs/recovery-map-preview.png`;
  - every contribution list adds up to W;
  - the 7-day history ends on the same map.
- **In the app:** the hooks are first drawn on Phase 6's dev screen, which is where finishing a workout is checked live.

### 19.8 Ambiguities resolved

- **"Reads … from the last `lookback_hours()` plus 168 h":** that's the read window. The tap detail's "contributing exercises from the last 168 h" is the weekly window inside it.
- **"`recovery_map` must accept an optional `at`":** a past `at` excludes every workout finished after it, so ready-in times aren't shortened or lengthened by what came later.
- **"`session_map(workout)` → `trainable_after_h`, `ready_after_h`":** these are the engine's `trainable_in_h` and `ready_in_h` for one workout, renamed because they count from the workout's finish, not from now.
- **"`recovery_history` over 7 days returns 7 samples":** this holds when the samples end on `to` (item 6).
- **"Expose as HTTP endpoints or a local store":** reads go to Supabase over HTTP (PostgREST, `recovery_loads`), and the maths runs in the app. That's the local store of notes §8.

---

## 20. Phase 6: decisions made

Phase 6 output · 2026-10-18. The body map: the figure, the legend, the tap detail, the list view and a temporary dev screen.

### 20.1 Settled with Conor

| | Settled as |
|---|---|
| SVG files | **Embedded byte for byte.** `npm run gen:body-figure` (`app/scripts/gen-body-figure.ts`) copies `assets/body-front.svg` and `body-back.svg` into `src/lib/recovery/bodySvg.ts` as strings. The app parses them at load. A test fails if the copy and the files ever differ. There's no Metro transformer and no new dependency (notes §8) |
| Layout | **Side by side from 640 px wide**, like the preview image. Narrower, one view at a time with a Front/Back toggle and a horizontal swipe |
| List view | **All 17 muscles**, highest first, with Ready ones at the bottom: the full text equivalent of the figure |

### 20.2 The figure as data (`src/lib/recovery/figure.ts`, pure)

1. **`parseSvg`** is a small parser for what the figure files use: elements, double-quoted attributes, text, comments and declarations. Anything else throws rather than drawing half a figure.
2. **`figureOf`** turns a file into its shapes in drawing order. It enforces the spec §10 contract, and throws on:
   - a transform;
   - an element other than `g`, `title`, `desc` and the five basic shapes;
   - a region whose `data-muscle` isn't one of the 17 IDs;
   - a region with no `data-side`;
   - a shape that is both a region and silhouette.

   So a replacement SVG that breaks the contract fails its tests, not silently on screen.
3. **`paintFigure(figure, map, theme, thresholds)`** applies the contract:
   - **Regions** take the map entry's `fill` or `fill_dark`, which the engine already sets to `ready_fill(_dark)` at level 0, and `region_stroke(_dark)` as their outline. With no map yet, every region is Ready.
   - **Silhouette shapes** (`data-role="silhouette"`) only ever take `silhouette_fill(_dark)`.
   - **Everything else** keeps its own attributes. Geometry is never touched.
4. **Every colour comes from the thresholds,** so from `recovery_constants.json` plus any overrides. The page background behind the figure is the app's own surface.
5. **`legendRows`, `listRows`, `referenceMarker` and `ROLE_BADGE`** are the legend, list and tap-detail pieces. They're pure, so tested.
   - **Legend ranges:** "F < 0.25", "0.25 – 0.75" … "≥ 4.0", built from `levels`; L instead of F on the session view.
   - **List order:** level first, then F (or L), so a muscle raised by the weekly guard sorts with its level.
   - **Times** are formatted by the engine's `fmtHours`.

### 20.3 Components (`src/components/recovery/`)

6. **`BodyMap`** takes `map`, `view`, `mode` and `theme` (plus `thresholds`, `width`, `onSelect` and `nameOf`) and draws the painted shapes with react-native-svg.
   - **Tapping a region** reports its muscle.
   - **Screen readers** get one summary line ("Body map, back view, fatigue now: Hamstrings Very high, …"); the list is the full equivalent.
   - **On web,** react-native-svg turns `onPress` into responder props React warns about, and overwrites `onClick` unless `onPress` is exactly `null`. So on web a region gets `onPress: null` and its own `onClick`; on phones it keeps `onPress`.
7. **`Legend`:** six swatches with label, range and advice.
8. **`MuscleSheet`:** the tap detail of spec §10. It's a bottom sheet on a phone and a centred card from 640 px, built like the "Add metric" sheet.
   - **Recovery view:** name, level and advice, F, trainable in, ready in and W. Then "This week": each contributing exercise with a P/S/T badge, its workout's finish in the profile's time zone, and `role_weight × L_e`, largest first. Estimated and calibration references carry an "estimated" or "calibrating" badge.
   - **Session view:** L, the recovery window R, trainable after and ready after.
9. **`MuscleList`:** the list view; its rows open the same sheet.
10. **`RecoveryFigure`** puts it together:
    - a Figure/List toggle, so the list is always one tap away;
    - the figure or figures, as in 20.1;
    - the legend;
    - the sheet;
    - "Updating…" while the recompute rule runs (Phase 4's `useRecomputeStatus`).

    Light or dark follows the app theme.
11. **Muscle names** come from the `muscles` table (`useMuscleNames()`, cached for the session), so traps reads "Traps & upper back". Until they load, IDs show as words.
12. **`ThemeOverride`** (in `ThemeProvider.tsx`) gives its children a fixed theme without saving anything. The dev screen uses it to show light and dark side by side with the app's own setting.

### 20.4 The dev screen (temporary): `app/(app)/lift/recovery-dev.tsx`

13. **Development builds only (`__DEV__`).** The Lift screen links to it ("Recovery map (dev preview)") only in development builds. A production or Vercel build shows neither the link nor the screen.
14. **Recovery view at any instant:**
    - **Now:** the default.
    - **"F26 Wednesday 20:00":** two hours after the last finished workout, which is how `seed_f26.py` dates Legs.
    - **±1 h and ±1 day** steppers.
    - **A typed time:** `YYYY-MM-DD HH:mm` in the device's time, or an ISO instant.
15. **Session view:** pick one of the last 10 finished workouts.
16. **Theme:** App, Light or Dark.

Phase 7 replaces this screen and its Lift link.

### 20.5 One change to Phase 5

17. **The map at "now" is computed at the end of the current minute.** Phase 5 rounded down. A workout finished at 18:42:40 was then outside a map at 18:42:00, so it was missing for up to a minute after Finish. That showed up in the in-app check (20.7).

### 20.6 Tests

- **`npm test`: 127 tests.** The new `figure.test.ts` covers:
  - all 17 muscle IDs across the two views;
  - no element id repeating, within a view or across both, and every id prefixed `front-` or `back-`;
  - every region with a muscle and a side;
  - the embedded copy identical to the files;
  - malformed figures refused;
  - silhouette never coloured, even with every muscle at Extreme;
  - Ready and unloaded regions taking the ready colour, with geometry untouched;
  - the F26 regions taking the preview image's colours;
  - F20 at 0, 24 and 48 h giving chest High, then Moderate, then Low, as F23 says;
  - the legend, the list order, and the reference markers.
- **Snapshots:** 10 SVG files in `src/lib/recovery/__snapshots__/`, which open in any browser:
  - F26 front and back, light and dark;
  - F20 at 0, 24 and 48 h, front and back.

  A missing or changed snapshot fails. `UPDATE_SNAPSHOTS=1 npm test` rewrites them, and the new files should be looked at before committing. Node 22's own snapshot API needs a flag, so the test compares the files itself.
- **Shared helper:** `loadWindow` (fixture workouts as `recovery_loads()` would return them) moved into `testRows.ts`.
- **pytest:** 79 passed, 38 skipped, unchanged; Phase 6 adds no database code.

### 20.7 Checked in the web preview (2026-10-18, demo athlete)

- **Wide, light,** at the seeded Wednesday 20:00:
  - the figure matches `docs/recovery-map-preview.png` region for region;
  - the list matches its table row for row: hamstrings 2.56 Very high, 1.0 days, 2.2 days … chest 0.40 Low, now, 4 h.
- **Dark:** silhouette `#262A31`, Ready regions `#3A3F47`, outlines `#16181C`, and the dark level fills.
- **Tap detail:** tapping hamstrings opened the sheet: F 2.56, trainable in 1.0 days, ready in 2.2 days, W 2.94, and five contributions (RDL P 1.25, lying leg curl P 0.86, deadlift S 0.32, back squat T 0.27, leg press T 0.23), dated in Australia/Melbourne.
- **Phone width:** one view with the toggle, and swiping left turned it to Back.
- **Session view:** Legs shows quads and hamstrings Very high and glutes High.
- **Phase 5's "done when", in the app:**
  - I finished a one-set bench workout (90 × 8) through the logger, then went back to the dev screen without reloading.
  - Chest went from F 0.39 to 0.71, which is the new cache row's 0.32.
  - That run is what found the rounding in 20.5.
- **Afterwards:** the F26 seed was re-run, so the demo again holds just the F26 week, with "now" at the time of the re-seed as Wednesday 20:00.

### 20.8 Ambiguities resolved

- **"Region fill: level `fill` / `fill_dark`, or `ready_fill` / `ready_fill_dark` at level 0":** Phase 5's map entries already carry that choice (the engine's `muscleState` and `sessionMap`), so the figure uses the entry's colours and only falls back to the ready colour when there's no entry.
- **"Snapshot the F26 state … compare by eye":** `node --test` has no stable snapshot API on Node 22, so the snapshots are plain SVG files written from the same painted shapes `BodyMap` draws. They're viewable as they are.
- **"Swipe on mobile":** a horizontal pan with react-native-gesture-handler, which is already installed (its root view is in `app/_layout.tsx`). Left shows the back, right the front.
- **"Mark contributions whose `pb_source` is estimated or calibration":** a small "estimated" or "calibrating" badge next to the exercise's name.
- **"Put it on a temporary dev screen":** `lift/recovery-dev.tsx`, development builds only, linked from Lift.

---

## 21. Between Phases 6 and 7: the coral figure

2026-10-18. Conor's own artwork and palette replace the generated figure. He approved editing `assets/` and `data/` for this, and checked a labelled image of every shape before the commit.

### 21.1 Settled with Conor

| | Settled as |
|---|---|
| Master shape | **The light SVG** (`assets/source/split-set-coral-light.svg`). The dark SVG was traced separately and has different shapes, so it only supplied its colours. Both originals are kept in `assets/source/` |
| Palette | **Coral**, light / dark: Low `#FFD9CC` / `#FFD9CC`, Moderate `#FFA488` / `#FFA488`, High `#F26B4F` / `#F26B4F`, Very high `#C9362B` / `#D9483B`, Extreme `#7F1D1D` / `#B23A3A`. Ready and the region outlines are unchanged |
| Body colour | **`silhouette_fill` is now the Ready grey**, `#D9DDE3` light and `#3A3F47` dark, as in both coral SVGs: the head, hands and shins look like a Ready muscle |
| Labels | Every shape's muscle was confirmed on the check image, including the calls in 21.3 |

### 21.2 From artwork to figure (`assets/source/build_figure.py`)

1. **Why a conversion step:** the artwork is a traced drawing grouped by colour, for one state of the F26 week:
   - shapes have no muscle tags;
   - front and back share one canvas, with a legend;
   - the tracer left slivers in the gaps.
2. **What the script does:**
   - **Tags every shape** by its position in the source file: a muscle and a side, or `data-role="silhouette"`.
   - **Drops** the traced base outline and the slivers.
   - **Splits the views:** front and back become their own 561 × 1290 files, each body centred in its canvas by moving its points sideways (the figure contract allows no transforms).
   - **Ids** are `front-…` and `back-…`.
   - **Outlines:** every region gets `stroke-width` 1.9 with round joins.
3. **The table maps all 125 source shapes,** and the script refuses to run if the source file's contents change (a SHA-256 of the text with LF line endings), because positions would then mean something else. Run it with `python assets/source/build_figure.py`, then `cd app && npm run gen:body-figure`.
4. **The gaps between shapes show the page behind the figure:** white in light, the app's near-black surface in dark. The artwork's own gap colours were `#EEF0F3` and `#262A31`.
5. **Sides:** `data-side` is the side of the body's midline a shape is on, from the viewer. The abs are a single shape across the midline, so they get `data-side="both"`, which the figure test now allows.

### 21.3 Judgement calls (confirmed by Conor)

- **Left lower obliques:** they're part of the abs shape in the artwork, while the right side has separate oblique pieces. So the left lower torso colours with abs. Fixing that needs that shape split in the artwork.
- **Serratus:** the right-hand piece below the armpit has no partner on the left. It's body (silhouette).
- **Outer strips of the front upper arm:** biceps.
- **Back:**
  - the shapes below the rear delts (over the shoulder blade): rear delts;
  - the flanks below the lats: obliques, so obliques now appear on both views;
  - the small shapes above the glutes (glute medius): glutes;
  - the outer hip strips: body.
- **Muscles split into several shapes,** such as three hamstring strips per leg, two or three calf heads, and four forearm pieces: each shape carries the same muscle.

### 21.4 Result

- **Front:** 42 muscle shapes and 9 body shapes. **Back:** 48 muscle shapes and 10 body shapes. All 17 muscles appear.
- **`npm test`: 127 passed.** The figure-contract tests pass on the new art unchanged, apart from allowing `both`. The 10 snapshots were rewritten, and tsc and lint are clean.
- **Checked in the web preview** at the seeded Wednesday 20:00: the figure matches Conor's light and dark designs.

### 21.5 Out of date until someone updates them (folders this work doesn't edit)

- **`scripts/build_body_map.py`** still generates the old figure. Running it would overwrite the coral files; regenerate from `assets/source/build_figure.py` instead.
- **Spec §9's colour table,** and its note that the silhouette differs from Ready, describe the old palette. `recovery_constants.json` is the source of truth.

---

## 22. Phase 7: decisions made

Phase 7 output · 2026-10-18. The map on real screens.

### 22.1 Settled with Conor

| | Settled as |
|---|---|
| Role tints | **Three tints of the app accent** (purple in light, green in dark), mixed towards the Ready grey: primary is the accent, then 45 % and 72 % of the way to the grey. They're unlike the coral tiredness colours, so an exercise's mini figure never reads as fatigue. Not a model constant: `recovery_constants.json` has none for this, and it's UI theming |
| "Biggest groups first" | **By body region:** Legs, Back, Chest, Shoulders, Arms, Core (`REGION_ORDER`), then spec §2 order within a region |
| Train next placement | **On the Recovery screen only.** The Today card stays compact |
| Picker | **Every row shows the load split bar and the PB source line;** an info button expands the row to show the mini figure. The detail screen always shows it |

### 22.2 Pure helpers (`src/lib/recovery/screens.ts`, tested)

1. **`nextReady(c, map)`:** muscles not trainable now (level above `trainable_max_level`) that become trainable within `NEXT_READY_HOURS` (24, from the plan), soonest first.
2. **`mostTired(map, n)`:** highest level, then F. It gives the Today card's line.
3. **`trainNext(map, exercises)`:** Ready muscles in region order, each with up to three exercises (`TRAIN_NEXT_EXERCISES`) where it's primary. They're ordered by that muscle's `load_split` share, then library order. Only library exercises qualify (custom and legacy ones have no slug), and a Ready muscle with none is left out.
4. **Library order:** `data/exercise_library.json` stays out of the bundle. `npm run gen:library-order` (`app/scripts/gen-library-order.ts`) copies just its exercise order and each muscle's group into `src/lib/recovery/libraryOrder.ts`, and a test fails if they ever differ. This is the same pattern as the figure.
5. **`sessionRows(session, nameOf)`:** one row per muscle the workout loaded, heaviest first, worded as the plan's example: "Chest · load 2.48 · High · trainable in 24 h · ready in 2.2 days".
   - **Times count from the workout's finish** (`trainable_after_h` and `ready_after_h`), so on an old workout they say how long recovery took, not how long is left.
   - **At zero,** the row says "trainable now".
6. **`roleFigure(roles, tints, ready)`:** an exercise's `exercise_muscles` as a figure map the Phase 6 `BodyMap` draws unchanged.
7. **`loadSplit(c, stored, roles)`:**
   - the stored `load_split`;
   - for an exercise without one (a Phase 8 custom exercise), spec §6's formula: role weight ÷ the sum, rounded by largest remainder to add to 100.

   A test checks the formula reproduces the stored split for all 161 library exercises.

### 22.3 Screens

8. **Recovery screen (`lift/recovery.tsx`):**
   - **Layout:** the Phase 6 `RecoveryFigure` (front first on a phone, side by side from 640 px, the Figure/List toggle, legend, tap sheet, "Updating…"), then "Next ready", then Train next, whose exercises open their detail screens.
   - **Reached from:** a Recovery button on the Lift screen, and the Today card.
9. **Today card (`RecoveryHomeCard`, after the Lifting card):** a small front-and-back figure, the two most tired muscles, and the next muscle to become trainable. Tapping it opens the Recovery screen.
10. **Workout summary (`history/[id]`):**
    - a "Muscles worked" card at the top, with the session figure (tappable for the Phase 6 sheet) and `sessionRows`;
    - Finish already lands on this screen;
    - unfinished workouts don't show the card.
11. **Live workout:** `LiveSessionFigure` sits above the exercises, from Phase 4's `useLiveSession()`.
    - It fills in as sets are ticked and names the muscles above Ready.
    - A sliver of load on a muscle reads as nothing yet, rather than "front delts ready".
    - Tapping a muscle shows its L and when it'll be trainable and ready after this session.
    - Logging itself is unchanged.
12. **Picker (`PickerRow`):** name and kind, the load split bar, and the PB source line:
    - "PB 120 kg · logged", "PB … · manual", "PB … · lapsed";
    - "~41 kg · estimated from Bench press (barbell)";
    - "calibrating: …".

    Fixed-cost exercises show no line. The PB lines come from one read of the whole PB history, resolved per row by the Phase 3 `strengthReference`.
13. **Exercise detail:** a "Muscles" card (mini figure, split bar and a key to the tints) above the Phase 3 PB section, which already shows the PB source line.
14. **Dev screen:** the Lift link is gone. Settings has a "Developer" card in development builds only (`__DEV__`), which opens the same preview with its time picker. Production and Vercel builds show neither the card nor the screen.

### 22.4 Hooks and components

15. **`src/api/recovery.ts` gains:**
    - `useExerciseRoles()`: `exercise_muscles` by exercise;
    - `useTrainNext(map)`;
    - `useReferenceLines(formatKg)`: the picker's PB lines.
16. **`src/components/recovery/` gains:**
    - `FigurePair`: front and back at a fixed size, with optional tap detail;
    - `ExerciseMuscles` with `LoadSplitBar` and `useRoleTints`;
    - `NextReadyStrip`, `TrainNextCard` and `SessionMuscleRows` (in `RecoveryExtras.tsx`);
    - `RecoveryHomeCard` and `LiveSessionFigure`.

    `src/components/lift/PickerRow.tsx` is the picker's row.

### 22.5 Tests

- **`npm test`: 135 tests.** The new `screens.test.ts` covers:
  - **The library copy:** the generated order and groups match the library.
  - **F26 at Wednesday 20:00:**
    - Next ready is traps, biceps, glutes, quads (hamstrings need just over 24 h);
    - most tired is hamstrings, then quads;
    - Train next lists front delts, side delts, forearms, abs, obliques, with exact exercises for side delts (cable, machine, dumbbell lateral raise) and front delts (dumbbell and cable front raise, Arnold press);
    - custom exercises are never suggested.
  - **F20's summary rows:** exact strings, including chest's "trainable in 24 h · ready in 2.2 days".
  - **Role tints and the load split,** including the formula against every library exercise.
- **pytest:** 79 passed, 38 skipped (the database tests, unchanged).

### 22.6 Checked in the web preview (2026-10-18, demo athlete)

- **Recovery screen, at the seeded Wednesday 20:00:** "Next ready" shows traps 1 h, biceps 12 h, glutes 17 h and quads 22 h, and Train next is as the test says.
- **Today card:** "Hamstrings · Very high, Quads · High, Traps & upper back trainable in 1 h".
- **Legs summary:** the rows read "Hamstrings · load 2.61 · Very high · trainable in 1.1 days · ready in 2.3 days", and so on.
- **Exercise detail (bench):** chest primary, with front delts and triceps secondary on the front and back views.
- **Picker:** split bars, PB lines, and the expanding mini figure.
- **Settings → Developer:** opens the preview.
- **"Done when":**
  - I logged a push day through the logger (bench 3 × 90 × 8, dumbbell shoulder press 2 × 22.5 × 8, lateral raise 2 × 10 × 15), and the live figure filled in as sets were ticked.
  - Finish showed the session map and rows: side delts 1.16, front delts 1.02, chest 0.96, triceps 0.64, traps 0.31.
  - The Recovery screen, opened without a reload, moved accordingly: chest went from Low (0.40) to Moderate (1.36), and front and side delts from Ready to Moderate.
- **Afterwards:** the F26 seed was re-run, so the demo again holds just the F26 week.

### 22.7 Ambiguities resolved

- **"Biggest groups first," "three tints of one colour" and where Train next lives:** settled with Conor (22.1).
- **"Muscles becoming trainable in the next 24 h":** only muscles not trainable now, so a muscle that's already trainable isn't "becoming" it.
- **"trainable in 24 h" on the workout summary:** counted from the workout's finish (22.2, item 5).
- **"PB source line" in the picker:** a one-line form of the Phase 3 source label, beside the reference it gives.

---

## 23. Phase 8: decisions made

Phase 8 output · 2026-10-18. Creating and editing custom exercises.

### 23.1 Settled with Conor

| | Settled as |
|---|---|
| Saving | **One database function per action:** `create_custom_exercise(p)` and `update_custom_exercise(id, p)` (`20261018000100_custom_exercises.sql`). The exercise, its muscles and an optional known best are written in one transaction, so there's never a half-made exercise |
| Flow | **Its own screen,** `lift/exercises/new.tsx`. The picker's Create button opens it, carrying the searched name, and so does the Exercises list's New exercise. Saved from the picker, the exercise goes straight into the workout or routine |
| Bodyweight factor | **Presets plus fine steps:** core 0.3, push-up-like 0.65, pull-up-like 1.0, legs 0.8, and −/+ 0.05, kept to 0.2–1.0. No slider package is installed, and this needs no new dependency |
| Editing | **Edit on your own exercise's detail screen** opens the same screen prefilled. Saving reruns the recompute rule (spec §14) |

### 23.2 The flow (`src/lib/recovery/customExercise.ts`, pure, tested)

1. **Name, with "Did you mean …?" (`matchExercises`):**
   - Each query word scores 1 if it's a whole word of the exercise's name or slug, or 0.8 if it's inside a longer one. Adjacent words also count joined, so "pull down" matches "pulldown".
   - Word order doesn't matter, so "pull down lat" finds `lat_pulldown`.
   - The top three at 0.6 or more are shown, ties going to the shorter name.
   - Picking one abandons the create and uses that exercise.
2. **Start from a similar exercise:**
   - **Suggestions (`similarSuggestions`):** the plan's keywords (curl, row, press, raise, fly, squat, lunge, deadlift/RDL, pulldown, pull-up, extension, crunch, plank) pick a family of library exercises, best name match first. A search box finds any other.
   - **What it copies (`fromSimilar`):** equipment, load mode, bodyweight factor, one-sided, fatigue class and all three muscle tiers, and it sets `pb_estimate_from` to the similar exercise's slug.
   - **Less / about the same / more** sets `pb_estimate_ratio` to 0.6 / 1.0 / 1.3 (`RATIOS`, the plan's numbers).
3. **Equipment (`EQUIPMENT`, `withEquipment`):** exactly the plan's table.
   - **Load mode:** band → fixed, logged as reps; timed → fixed, logged as seconds; bodyweight → bodyweight; assisted machine → assisted; everything else → weight.
   - **Default fatigue:** machine, cable and band → low; everything else → standard.
   - **Bodyweight factor:** bodyweight and assisted get one (0.65 and 1.0 to start).
   - **Fatigue on change:** a similar exercise's fatigue class stays when the equipment changes.
4. **Muscles:**
   - **The mini figure (Phase 6 `BodyMap`, Phase 7 role tints):** tapping a muscle cycles none → primary → secondary → tertiary → none (`cycleRole`), skipping any role already at its `role_caps` limit.
   - **The text list:** the same 17 muscles with P/S/T chips (`setRole`). A capped chip is disabled.
   - **Below them:** a live load split bar (spec §6) and the role counts against the caps.
5. **"How hard is this on the body?"** Light / Normal / Heavy → low / standard / high, pre-set from the similar exercise or the equipment. Whatever it shows when you save is stored.
6. **Your best (optional):** weight × reps, today. Its e1RM comes from the existing `setE1rm`, with today's bodyweight for bodyweight and assisted exercises. It's saved as a `manual_pbs` row. Fixed-cost exercises don't ask.
7. **Save (`validateDraft`, `toPayload`):**
   - **Validation:** a name, at least one primary, the caps, and a factor in range.
   - **Identity:** slug `custom_<uuid without dashes>`; `group` from the first primary muscle (`MUSCLE_GROUPS`).
   - **Logging:** the older `muscle_group` word for search, as `seed_library.py` sets it for new rows; `measure` and `is_bodyweight` per notes §4.6.
   - **Muscles:** `load_split` by spec §6.

### 23.3 Database

8. **Both functions** are security invoker, so RLS decides what you can write; another user's exercise reads as "not found". Both refuse an exercise with no primary muscle.
   - **The caps stay app-side, as Phase 1 decided,** so no constant is copied into SQL.
   - **The existing checks still apply:** custom slugs only, a load mode and fatigue class with a slug, the factor's pairing, and the estimate pair. So a user can't claim a library slug.
9. **An edit never changes `measure`,** so sets already logged keep their meaning. The screen only offers equipment that logs the same way. An older custom exercise (no slug, unscored) gets a slug the first time it's edited, so editing scores it.
10. **Edit's recompute:** after `update_custom_exercise`, the app reruns `recomputeFrom` from the first finished workout that used the exercise.

### 23.4 In the app

11. **The old simple form is gone** (`ExerciseForm.tsx`, `useCreateExercise`); notes §8 had planned that. The picker's and Exercises list's Create buttons open the new screen.
12. **`src/api/recovery.ts`** gains `useCreateCustomExercise()` and `useUpdateCustomExercise()`. They invalidate the exercises, library rows and PB history.
13. **The CLI** gains `custom-payload`, so the database tests save exactly what the screen saves.

### 23.5 Tests

- **`npm test`: 148 tests.** The new `customExercise.test.ts` covers the plan's list:
  - "Incline Smith press" from `incline_bench_bb` copies its tiers and estimates 86.4 through it (120 × 0.80 × 1.0 × 0.9);
  - a custom curl based on `db_curl` reaches bench in four hops: 18.59, F30;
  - "pull down lat" surfaces `lat_pulldown`;
  - no primary is rejected, and the caps hold, both on a tap and on a chip;
  - a manual 80 is the first set's reference, and a later logged 95 takes over (spec §3.6);
  - plus the ratios, keyword suggestions, equipment defaults, factor steps, the payload, and a saved exercise reading back into the same draft for Edit.
- **`db-tests` (CI): 63 tests, 7 of them new (`test_custom_exercises.py`).** They cover:
  - creating from a similar exercise as the user;
  - the estimated reference through it ("Estimated from Bench press (barbell)", 86.4);
  - a known best saved with it;
  - no primary refused;
  - a library slug can't be claimed;
  - another user can neither see nor edit it;
  - editing the muscles, then rescoring, moving the cached rows (quads primary, chest tertiary at 0.2 × quads).
- **pytest locally:** 79 passed, 45 skipped (the database tests).

### 23.6 On splitset-dev (2026-10-18)

- **Migration:** `20261018000100_custom_exercises` was pushed by Conor. Signed-in users can execute both functions and `anon` can't. The regenerated types matched exactly.
- **The done-when, in the web preview:**
  - **Creating it:** from the picker, "Incline Smith press" offered "Did you mean Incline bench press (Smith machine)" and suggested the press family. I started it from Incline bench press (barbell), which copied chest primary and front delts and triceps secondary, and set the equipment to Smith.
  - **The figure:** tapping the abs cycled primary → tertiary (secondary was full) → none.
  - **Saving** went straight into the workout.
  - **First workout:** two sets of 60 × 8, scored against the estimated 86.4, gave chest 0.52 (Low) and front delts and triceps 0.21 each.
  - **Edit:** setting it to Heavy saved fatigue `high`, kept `weight_reps`, and the recompute rewrote the cached load from 0.524 to 0.628 (× 1.2).
- **Fix found in the check:** saving from the picker first went back only to the picker. It now closes both screens (`router.dismiss(2)`).
- **Afterwards:** the F26 seed was re-run. The custom "Incline Smith press" stays on the demo account as an example.

### 23.7 Ambiguities resolved

- **"Fuzzy-match library and their own custom exercises":** a word-based match rather than an edit-distance one, so reordered and joined words match. The scores are described in item 1.
- **"`bw_factor` slider":** presets and steps (23.1).
- **"Editing its muscles or fatigue later triggers the Phase 4 recompute":** Edit exists now (23.1). The recompute starts from the first finished workout that used the exercise.
- **"Save with `is_custom = true`, `owner_user_id`":** that's `owner_id` (notes §3). `is_custom` is `owner_id is not null`.
- **The assisted machine's equipment word:** stored as `machine`, with load mode `assisted`. Timed is stored as `bodyweight` with load mode `fixed` and logged in seconds.

---

## 24. Phase 9: decisions made

Phase 9 output · 2026-10-18. Recovery map settings and the history slider. No migration: `user_thresholds` (Phase 1) already holds per-user overrides, and the loader already applies them.

### 24.1 Settled with Conor

| | Settled as |
|---|---|
| Saving | **A Save bar.** Edits are held on the screen; "Save changes" writes them all, then runs one rescore. "Discard" drops them |
| Role weights | **Secondary and tertiary only.** Primary stays 1.0, the unit spec §6 measures the others against |
| Animation | **A crossfade:** the new day's figure fades in over the old in 250 ms. React Native's own Animated, no new dependency |
| Wrap-up | As usual: tests, notes, commit and push |

### 24.2 The settings (`src/lib/recovery/settings.ts`, pure, tested)

1. **Every setting is one leaf of `recovery_constants.json`, overridden per user.** The defaults never change.

   | Setting | Key | Range |
   |---|---|---|
   | Role weights | `role_weights.secondary`, `.tertiary` | 0–1 |
   | Fatigue factors | `fatigue_factors.high`, `.standard`, `.low` | 0.5–2 |
   | Base recovery hours, other muscles | `base_recovery_hours.default` | 12–96 h (the plan's range) |
   | Base recovery hours, per muscle | `base_recovery_hours.<muscle>`, all 17 | 12–96 h |
   | Recovery slope | `recovery.slope` | 0–1 |
   | Level boundaries | `levels.1.min` … `levels.5.min` | 0.05–10, strictly increasing |
   | Weekly cap | `fatigue.weekly_cap` | 2–20 |
   | PB window | `pb.window_days` | 7–90 days, whole |
   | Manual-PB policy | `pb.manual_policy` | "Only when it's higher" (`max`) or "At the next logged set" (`replace_on_log`) |

   Apart from the plan's 12–96 h, the ranges are guard rails for the controls, not model constants.
2. **Each setting has a one-line explanation,** written for the screen.
3. **A muscle without its own base hours shows the default's value** (`valueAt`). Raising "Every other muscle" therefore moves every such muscle, which the screen previews before saving (`afterEdits`).
4. **`validateEdits`:** each value in range and whole where it must be, the Phase 1 `isValidOverride`, and the level boundaries strictly increasing once the edits apply.
5. **`diffOverrides`:** changed values are upserted. A reset, or a value equal to the constants' own default, deletes the row, so no copy of a default is ever stored.

### 24.3 The screen (`settings/recovery.tsx`, linked from Settings as "Recovery map")

6. **Four cards:** Muscle load, Recovery, The figure, PBs. Each row has its explanation, − / + steps (clamped, free of float noise) and "Reset to default (value)" when overridden.
7. **Save (`useSaveThresholds`):**
   - it writes the upserts and deletes, then refreshes the user's thresholds;
   - then it runs the recompute rule over every finished workout in the background (`recomputeInBackground(uid, null)`);
   - the screen shows "Rescoring your workouts…", and the Recovery figure says "Updating…".
8. **Every change rescores,** even those that only change colours (levels, weekly cap), as the plan says. For one athlete it takes seconds.

### 24.4 The history slider (Recovery screen)

9. **The history:** `useRecoveryHistory` over the last 28 days, one sample a day (`HISTORY_DAYS`, `HISTORY_STEP_HOURS`).
   - It ends on the current hour, so its samples sit at the hour you're looking. The last tick shows the live map ("Now").
   - "Next ready" and Train next always describe now.
10. **`DayScrubber`:**
    - one tick per day, each marked with its weekday's initial; Mondays are taller, so last Monday is easy to find;
    - drag or tap along the strip (gesture-handler);
    - ◀ / ▶ step a day;
    - screen readers get an adjustable control with increment and decrement;
    - the selected day reads like "Mon 12 Oct, 21:00" in your time zone.
11. **`RecoveryFigure` gains `previous`, `fadeKey` and `onFaded`.** The old day is drawn underneath while the new one fades in, then it's dropped. The coral figure's gaps are transparent, so the old layer can't stay behind it. The list and the tap sheet show the selected day, contributing exercises included.

### 24.5 Tests

- **`npm test`: 155 tests.** The new `settings.test.ts` covers the plan's cases:
  - a `base_recovery_hours.default` override of 72 makes F20's chest R 89.6 h for that user, while another user's stays 59.7;
  - with base hours at 96 the longest window is 192 h (the read span 360 h), a heavy quads session from 7 days ago (L 5, R 192 h) still shows at F 0.625, and it has expired 24 h later; under the defaults the same session's window is 96 h;
  - `pb.manual_policy = replace_on_log` through a user's override gives F29's references, 130 then 116.67, with 132 later; the default keeps the manual 130.
- **Also tested:** every setting is a valid key with its default in range; the 12–96 h bounds; increasing levels; whole days; an unknown policy refused; the save diff; and the steps.
- **`db-tests` (CI): 67 tests, 4 of them new (`test_settings.py`):**
  - a user's override plus a rescore changes their cached chest R to 89.6 while another user's stays 59.7;
  - a reset restores 59.7;
  - rows the loader can't use (no such level, wrong type) are ignored;
  - overrides are owner-only.
- **pytest locally:** 79 passed, 49 skipped (the database tests).

### 24.6 Checked in the web preview (2026-10-18, demo athlete)

- **History slider:**
  - last Monday ("Mon 12 Oct, 21:00") shows every muscle Ready, since the seeded week starts on Friday;
  - stepping to Saturday shows the push and pull fatigue;
  - the crossfade was caught mid-way.
- **Settings:**
  - "Every other muscle" raised from 48 to 72 h, with the per-muscle rows following in the preview, then saved;
  - without a reload, the Recovery list then showed quads Very high at F 2.51, ready in 3.3 days (it was High, F 2.42, ready in 2.2 days), and chest went from 0.39 to 1.09;
  - "Reset to default (48 h)" plus Save deleted the row, and the cache went back to the defaults (Legs' quads R 60.2 h).
- **Console:** clean.
- **Afterwards:** the F26 seed was re-run.

### 24.7 Ambiguities resolved

- **"Role weights":** secondary and tertiary (24.1).
- **"Base recovery hours per muscle (12–96 h)":** all 17 muscles, plus "Every other muscle" (`base_recovery_hours.default`), which the plan's own test overrides.
- **"Level boundaries (must stay increasing)":** levels 1 to 5's lower bounds, strictly increasing. Ready always starts at 0.
- **"Changing any of them triggers the Phase 4 recompute":** on Save, over every workout, since a changed threshold can move any of them.
- **"A date slider over the last 28 days":** 28 daily samples ending now, with the last one live.

## 25. Phase 10: decisions made

Phase 10 output · 2026-10-18. Runs, rides, swims, hikes and rows on the body map. One migration, `20261019000100_activity_loads.sql`, applied to splitset-dev by Conor on 2026-10-18.

### 25.1 Settled with Conor

| | Settled as |
|---|---|
| Are activities imported already? | **Yes.** The intervals.icu sync job (which brings in Garmin and Strava) writes `activities`, heart-rate zone times included (`hr_zone_times`, seconds per zone, zone 1 first). Nothing new to import |
| Who scores them | **The app**, with the same engine as lifting. The sync job stays as it is; the database never scores |
| Walks | **Don't count.** Only the five kinds in `cardio.activity_muscles` |
| Wrap-up | As usual: tests, notes, commit and push |

### 25.2 The scoring (`src/lib/recovery/cardio.ts`, pure, tested)

1. **Activity types map to the five kinds:**

   | Kind | intervals.icu types |
   |---|---|
   | run | Run, VirtualRun, TrailRun, Treadmill |
   | ride | Ride, VirtualRide, GravelRide, MountainBikeRide, EBikeRide, EMountainBikeRide |
   | swim | Swim, OpenWaterSwim |
   | hike | Hike |
   | row | Rowing, VirtualRow |

   Everything else doesn't count: Walk, Workout, WeightTraining (logged as lifting), Tennis, Golf and the rest.
2. **Equivalent sets, as the plan says:**
   - minutes in zone `hard_hr_zone_min` (3) or above count at `equiv_sets_per_10min_hard` (1.0 per 10 min);
   - the rest count at `equiv_sets_per_10min_easy` (0.5 per 10 min);
   - with no zone data (or all zeros), every minute is easy.
3. **Minutes are moving time** (elapsed time when there's none). Hard minutes are capped at the moving minutes, since a watch's zone times can add up to slightly more.
4. **Each kind scores as a library entry built from `cardio.activity_muscles`.** It uses fixed-cost sets (`fixed_set.base`), fatigue standard, and the lifting role weights, through the same `muscleLoads` and `recoveryHours` as a lift.
   - So L_e = sets × 0.30.
   - The plan's 90-minute run with 60 minutes hard gives 7.5 sets → 2.25.
5. **The activity's time is its end:** start plus elapsed time (moving time when there's none). A lift's time is when it finished, so this matches.
6. **Cardio off** (`cardio.enabled_default` false, a user override) scores nothing.

### 25.3 The database

7. **Activity rows go in `workout_muscle_loads`** with `source = 'activity'`, `activity_id` set and `workout_id` null. That table already allowed this (Phase 2), so Phases 5–7 read them unchanged.
8. **`save_activity_loads(p)`, security invoker, does the writing.** For each activity it replaces that activity's rows (delete, then insert), so saving twice never doubles a load.
   - An activity the caller can't see raises "activity … not found".
   - The end time is computed in SQL from the `activities` row, not trusted from the app.
   - An activity sent with no muscles just clears its rows.
9. **`clear_activity_loads()` removes all of the caller's activity rows.** It's used when cardio is turned off.
10. **`recovery_loads()` now also returns `activities`:** each activity with rows in the window, with its name, type and end. The tap detail uses these to name the activity.
11. **Execute is granted to `authenticated` only.** It's revoked from `public` and `anon`, as for the earlier functions.

### 25.4 The app

12. **New activities are scored by a catch-up.** It finds the user's countable activities that have no rows yet, scores them and saves them in batches of 50.
    - The Recovery screen and the Today card start it, at most once every 10 minutes per user.
    - It reports through `useRecomputeStatus` like the recompute rule.
    - The sync job runs on its own schedule, so the app can't know when a new run lands. Checking on open is the smallest thing that works without touching the sync job.
13. **The recompute rule rescores activities too** (from the same point in time). A settings change such as role weights or base hours moves runs as well as lifts. With cardio off, it clears them instead.
14. **The tap detail lists an activity like an exercise.** It shows the activity's name (its type when it has none), its role for that muscle, when it ended and its load, for example "6 × 1 km · primary · Tue 13 Oct, 07:04 · 1.22". It never gets a "calibrating" tag, since there's no PB to calibrate.
15. **The Settings toggle is a new Cardio card in Settings → Recovery map:** "Count runs, rides, swims, hikes and rows", On or Off. Choosing Off and saving stores the override `cardio.enabled_default = false`. "Reset to default (on)" deletes it. Saving runs the recompute, which clears or rescores the activities.
16. **`seed_f26.py`'s check reads only lifting rows.** F26 is a lifting week, and the demo athlete's imported runs now count too.

### 25.5 Tests

- **`npm test`: 161 tests.** The new `cardio.test.ts` covers:
  - the plan's run: 7.5 equivalent sets → 2.25, giving quads and calves 2.25, hamstrings and glutes 0.90, adductors 0.45;
  - at t = 0, quads High, with "Long run" the primary contribution of 2.25;
  - the same run with no heart rate: 90 easy minutes, 4.5 sets → 1.35;
  - the type mapping, with walks and the rest excluded;
  - cardio off scores nothing;
  - calves' recovery window, 24 × (0.5 + 0.3 × 2.25) h.
- **`db-tests` (CI): 72 tests, 5 of them new (`test_activity_loads.py`):**
  - the run saved as activity rows with the plan's numbers, and the walk left out;
  - `recovery_loads` names the run, and the map read back gives quads High with "Long run" on top;
  - saving again replaces rather than adds;
  - another user can't save my activity;
  - cardio off scores nothing, and clearing removes only the caller's rows.
- **CI fixes:** the first CI run had 2 failures, both in my test expectations:
  - the Phase 5 owner-only test now expects the `activities` key;
  - the test ride moved to three days before the run, so the run alone sets the level.

  Green on `517bcc8`.
- **pytest locally:** 79 passed, 54 skipped (the database tests).
- **Generated types:** `gen_types.py` against splitset-dev matches the hand-written `database.ts` exactly.

### 25.6 Checked in the web preview (2026-10-18, demo athlete)

- **Catch-up:** opening the Recovery screen scored all 216 of the demo athlete's runs, rides and hikes (1,067 rows). The 124 activities on Conor's own account are untouched until he opens the screen himself.
- **Tap detail:** quads now lists "6 × 1 km · Tue 13 Oct · 1.22" among the week's lifts, with weekly load 3.90.
- **The plan's "done when":** the slider on Tue 13 Oct, 22:00 shows the legs coloured, with quads Moderate and calves Low and almost no lifting that week. The quads sheet lists Long run 1.74, 6 × 1 km 1.22, Parkrun 0.57 and Morning Run 0.49.
- **Cardio Off + Save:** every activity row was cleared, the run left the quads sheet, and weekly load fell from 3.90 to 2.68 (exactly the run's 1.22).
- **"Reset to default (on)" + Save:** all 216 were scored again, with the same 1,067 rows.
- **Console:** clean.
- **Afterwards:** the F26 seed was re-run.

### 25.7 Ambiguities resolved

- **"Same role weights as lifting":** the user's own role weights, overrides included, so the Phase 9 settings apply to runs too.
- **"The tap detail shows 'Long run (Sun): load 2.25'":** the activity appears as a row in the existing sheet, in the same format as a lift (name, day and time, load), rather than in a new layout.
- **"Settings toggle stored as the user override":** an override row only while it's off, deleted when reset, the same as every other setting (Phase 9). The default in `recovery_constants.json` is unchanged.
- **Time of an activity:** its end, the same as a lift's.

## 26. After Phase 10: full review and fixes

Review and fix pass · 2026-10-19. Phase 10 is the last build phase, so the whole feature was reviewed (phases 1–10, the 25 commits on `recovery-map`) and the problems found were fixed.

- **Review:** a multi-agent review in three rounds:
  - eight reviewers, one per dimension: engine, read model and figure, cardio, database, data layer, UI, phase completeness, tests and CI;
  - then a completeness critic, which sent two more rounds of reviewers to the areas it found thin.
- **Verification:** every finding was checked by three independent verifiers (reproduction, spec and intent, user impact), and kept only on a majority. 103 findings came in; 100 were confirmed and 3 rejected.
- **UI test:** a hand test of every recovery screen in the web preview added two more, X-1 and X-2.
- **Fixes:** made in 13 batches that touch separate files, each checked by an independent reviewer, with a second pass where the reviewer found a problem.

### 26.1 Settled with Conor

Conor said to ask only about major fixes. Nine findings were major; he decided these:

| Finding | Settled as |
|---|---|
| r2-15: "Each side" logging doubles set counts and volume on Today, Lift history, Trends and the streaks | **Fixed** with a migration (26.3) and the matching app counts |
| r1-11: cache rows can be attached to another user's workout or activity, which blocks the owner's saves | **Not now.** The app is private, and the risk needs a signed-in user acting on purpose |
| r2-3: a ticked 0-rep set counts as a 1RM PB at its full weight | **Not now** |
| r2-4: for assisted exercises, Best weight, Best set and volume treat the assistance as weight lifted | **Not now** |
| r1-39, r2-17, r3-10: should CI fill missing e1RMs and rescore after merges and after changes to the engine or the default constants? | **No, by hand** (26.4). The app part of r2-17 is fixed: Finish re-saves every set with its e1RM |
| r1-36: activities deleted on intervals.icu stay in Splitset and keep counting | **Mirror the deletions** (26.2) |
| r1-4: editing a custom exercise can change its load mode or bodyweight factor under stored e1RMs | **Locked**, the minor option: in edit mode the load mode, the log type and a saved bodyweight factor can't change (§23.3 item 9 assumed this) |

Rejected by the verifiers:
- "the load-cache checks let NaN through": true in Postgres (`'NaN'::float8 > 0`), but no flow can send it, since the app's engine never produces a non-finite load and RLS keeps others out;
- "notes §21.5 items left out of date": already recorded there as a deferral, since they are in docs/ and scripts/, which this branch doesn't edit;
- "DB tests can't be re-run on the same database": they are built to run once on a fresh stack, which CI starts every run.

### 26.2 Activities deleted on intervals.icu (sync job)

1. **What the sync now does.** After its upsert, each `splitset-sync run` deletes the stored activities in the window it just fetched that intervals.icu no longer returns (`sync/splitset_sync/deletions.py`, plus `db.activity_ids_in_window` and `db.delete_activities`). Their details, efforts and recovery-map rows go with them (on delete cascade). Workouts and planned sessions linked to them are unlinked (set null).
2. **Guards, because this deletes real rows:**
   - nothing is deleted when intervals.icu returns no activities, the existing "stored data left untouched" case;
   - the window's last day is never deleted, since intervals.icu reads `newest` in the athlete's time zone and the job runs in UTC;
   - nothing is deleted when more than half of the window and more than 3 activities vanish at once. That looks like a partial response, so the sync logs a warning instead;
   - `--dry-run` reports what it would remove.
3. **Checked on Conor's account** with read-only dry runs on 2026-10-19:
   - the normal window (3 Oct to 20 Oct) would remove nothing;
   - `--full` (all 239 activities since 2020) would remove nothing too.
4. **When it starts:** the scheduled sync runs from main, so mirroring starts when this branch merges.

### 26.3 Per-side sets: migration `20261019000200_side_set_counts.sql` (Conor pushes)

5. **`workout_summaries.sets_completed` and `exercise_records.completed_sets`** count a left + right pair as one set, and an unpaired side rounds up.
6. **`workout_summaries.volume_kg`** adds half of each side set's weight × reps. So "3 × 10 at 20 kg" reads 3 sets and 600 kg whichever way it was logged, as spec §4.4 already scores it.
7. **Column names and types are unchanged** (bigint counts, real volume), so `create or replace view` keeps the grants and no reader changes.
8. **The app's own totals use the same rule** (`src/lib/lifting/sideCounts.ts`): the workout history screen's Sets and Volume tiles, and each workout's volume in an exercise's history.
9. **Tests:** `test_side_set_counts.py` (DB) and `sideCounts.test.ts`.

### 26.4 Run by hand (Conor's choice: CI doesn't fill or rescore beyond what it did before)

migrate.yml still runs the plain `rescore_workouts.py` after a migration or library change, as before. That rescore now rewrites only the workouts whose cache differs. Everything else is by hand, from `sync/`:

| When | Command |
|---|---|
| After the merge, or after logging with the main-branch app (its sets have no e1RM or bodyweight snapshot) | `uv run python ../supabase/rescore_workouts.py --fill --dry-run`, then without `--dry-run`. `--fill` runs the e1RM and bodyweight backfill (finished workouts only), then the rescore |
| After changing the defaults in `data/recovery_constants.json` or the engine code | `uv run python ../supabase/rescore_workouts.py` (lifting). Runs and rides rescore themselves: the app's catch-up compares each activity's stored rows with a fresh score and resaves any that differ |

### 26.5 What changed (minor fixes, all applied)

- **Workout logging**
  - **Finish and its outbox** (r1-0, r1-46): one shared drain. A synced finish closes the sheet whichever flush ran it. A second Finish, or edits after Finish, can no longer re-open or move a finished workout. Store tests run the real store against a fake server.
  - **Workout blocks** (r3-2): pick up a mid-workout change to an exercise.
  - **Routines** (r2-5): a routine saved from per-side sets keeps one target per pair.
  - **Reps** (r1-7): negative and non-finite reps are refused.
  - **The set row** (r1-50) fits 375 pt with RPE and Each side both on.
  - **The weight column** (r2-16) reads "assist" or "+kg" where it means that.
- **PBs**
  - **Quick loads** (r1-3) convert into what the weight field means.
  - **Repeating a set** (r1-19) is no longer a false new PB (0.1 kg precision).
  - **Assisted exercises** (r1-21): no 3RM or best weight.
  - **The live panel** (r1-22) counts the manual best.
  - **Exercise screen** (r2-13): the 1RM line shows only where it means something.
  - **All PBs copy** (r2-14) describes the current e1RM rule.
  - **"Add a known best"** waits for the bodyweight (r2-9), follows the PB policy (r1-60), and puts the date on its own line (r1-57).
  - **Today's "Personal bests" tile** (r2-18) counts lift PBs too.
- **Cache writers** (`api/workoutLoads.ts`, `lib/recovery/pending.ts`)
  - **One queue:** the recompute, the activity catch-up and a new workout catch-up go through one serial queue (r1-10).
  - **A failed recompute** leaves a persisted "owed from" marker that the next catch-up retries (r1-13). RecoveryFigure shows the error with **Try again** (a forced catch-up).
  - **Catch-up errors** have their own field and show where the figure is (r1-35).
  - **Activities:** an activity is rescored when its data, type or the thresholds change, and cleared when it stops counting (r1-8).
  - **Lift-side catch-up:** finished workouts with no cache rows get scored (r3-9). Old-client sets with no e1RM still need `--fill`.
  - **Paging** uses a total order (r1-12).
  - **Finish** reads only the PB history it needs (r1-45).
  - **Fewer re-reads per catch-up** (r1-37).
- **Recovery data hooks**
  - **Memoised maps and history** (r1-1), so the Recovery screen no longer recomputes 28 maps per render.
  - **The catch-up runs** on focus, on returning to the foreground, and after Sync now (r1-9).
  - **The previous map stays** while the hourly window refetches (r1-14).
  - **The workout in progress shows on the map** (r1-59, spec §14).
  - **Zero-weight roles** list no contributions (r1-28).
  - **The history slider** samples the same wall-clock time each local day, across DST (r1-30).
  - **The library cache** is per user, and the query cache clears when the account changes (r1-43).
  - **Saving a custom-exercise edit** never reports failure after it saved (r1-44).
  - **The picker's PB line** is cached (r1-58).
  - **Bodyweight** isn't "ready" after a failed read (r2-0).
- **Engine and units**
  - **fmtHours:** "< 1 h" instead of "0 h" (X-1).
  - **The full recompute** groups the PB history once, with the same results (r1-25).
  - **The same-day bodyweight rule** uses the user's own date (r1-24).
  - **Bodyweight settings:** a key per unit (r2-2), lb range hints (r2-6), 0.1 lb steps (r2-7), overriding a wrong weigh-in (r2-8), an accessible label (r2-11).
- **Custom-exercise editor**
  - **Edit locks** (r1-4, r1-5), and legacy rows that keep their meaning (r3-0, r3-1, r3-3, r3-4, r3-8).
  - **Starting from Farmer's walk** logs seconds (r3-5).
  - **A best on a fixed-load chip** no longer blocks Save (r1-26).
  - **Database refusals in words**, plus duplicate-name and over-100-rep checks (r1-41).
  - **Readable P/S/T chips** (r1-47).
  - **The known best** waits for the bodyweight (r2-10).
  - **Error and Try again** instead of an endless spinner (r3-7).
- **Recovery screen, figure and Today card**
  - **The List view shows muscle names** at phone width (r1-2).
  - **A failed refetch keeps the map** (r1-6).
  - **The history slider** no longer jumps on touch-down or steals vertical scrolls (r1-16), and tells VoiceOver the new day (r1-31).
  - **Chip and Segmented** expose their role and selected state (r1-17).
  - **The Today card's error state** (r1-32).
  - **Screen-reader summaries** state the right context (r1-33).
  - **"Workouts and activities" copy** (r1-56).
  - **The figure's swipe** lets mobile web scroll (r2-1).
- **Load split and picker**
  - **Biggest share first, with %** (X-2).
  - **The user's role weights** (r1-29).
  - **"Not on the recovery map"** for the 19 unmapped legacy rows instead of "calibrating" (r3-6).
  - **Fuller accessibility labels** (r1-55).
- **Muscle sheet and live figure**
  - **The live figure** is memoised (r1-15) and opens as one 44 pt row (r1-48).
  - **The sheet** keeps its content while it slides away (r1-54).
  - **Web focus and the dialog name** (r2-12).
  - **The keyboard is dismissed** when the sheet opens (r3-15).
  - **VoiceOver** (r3-16).
- **Settings → Recovery map**
  - **The Save bar stays pinned**, and leaving with unsaved edits asks first (r1-51).
  - **Reset values** (r1-27, r1-52).
  - **Stricter override validation** (r1-23).
  - **Hit targets** (r1-49).
- **Scripts and DB tests**
  - **rescore_workouts.py** writes only changed workouts (r1-40) and gained `--fill` (26.4).
  - **backfill_e1rm.py** fills finished workouts only, and rescores what it fills (r3-11, r3-12).
  - **New DB tests:** the old-app rollout (r3-13), test isolation in test_settings.py (r1-62, r1-63).
- **CI**
  - **app.yml** also runs on `data/` and the body figures (r1-18).
  - **db-tests.yml:** the path filter now includes `sync/pyproject.toml`, `uv.lock` and `.python-version` (r1-65). A new job checks that each new migration sorts after the existing ones (r1-66).
  - **Snapshots** rewrite only with `UPDATE_SNAPSHOTS=1`, never in CI, and a rewrite still fails once (r1-20).

### 26.6 Left open

- **The muscle sheet's scrim** still slides in with the card rather than fading (r1-54, polish).
- **A saved bodyweight factor can't be changed in edit mode.** Changing it would need the stored e1RMs rewritten, and a manual best has no bodyweight snapshot to redo it from. If Conor wants this, it's Part B of r1-4.
- **Not now** (26.1): r1-11, r2-3, r2-4, and CI-run fills and rescores.

### 26.7 Tests

- **`npm test`: 264 tests**, up from 161. tsc and lint are clean.
- **pytest locally:** 82 passed, 66 skipped (the database tests).
- **New DB tests** (CI only): side-set counts, the activity lifecycle (crop, retype to Walk, delete cascade), the old-app rollout, an open workout left by the backfill, and legacy custom-exercise edits.

### 26.8 Checked in the web preview (2026-10-19, demo athlete, 375 pt)

- **List view:** muscle names on every row, with the level and the times under each name.
- **Segmented controls** read as radios with a checked state.
- **Today card:** "Biceps trainable in 2 h".
- **Back squat's split:** "quads 42% · glutes 17% · adductors 17% · lower back 8% · abs 8% · hamstrings 8%".
- **Picker:** "Not on the recovery map: no muscles mapped" for B-stance Romanian deadlift.
- **Settings:** the Save bar is pinned with "1 unsaved change", and Discard clears it.
- **Workout history** renders its figure, rows and tiles.
- **Console:** clean after the last edit.

## 27. Lift tab and workout screen updates

UI pass · 2026-10-19, Conor's list after Phase 10.

- **Commits:** `e76c6a5` and the follow-up.
- **Migration:** `20261019000300_lift_ui.sql`, applied to splitset-dev by Conor on 2026-10-19.

### 27.1 Settled with Conor

| | Settled as |
|---|---|
| What counts as the template changing at Finish | **An exercise added or removed** (`templateChanged`). Reordering, a different set count and different weights or reps don't prompt; that's normal progress |
| "Update template" takes | **Today's exercises in today's order, with today's sets and loads as the targets** (`templateFromWorkout`). Each exercise keeps the note the template had for it |
| Routine groups | **Folders the user makes, and routines dragged between them** by a handle on each card |
| A note in a workout with no template | **Stays with that workout** (`workout_exercises.notes`) |
| Rest timer when a workout starts | **Off by default**; Settings → Workout changes the default |

### 27.2 Lift tab (`app/(app)/lift/index.tsx`)

1. **The recovery figure at the top,** front and back side by side, sized like the Run tab's map.
   - The two most tired muscles show under it; tapping opens the Recovery screen.
   - The header stays fixed (`Screen fixedHeader`): "Your recovery" over "Lift", then PBs and Exercises.
   - The "Recovery" text button is gone; the figure is the way in.
2. **The bubble** (`FigureBubble`).
   - **When it shows:** once the figure has scrolled out of view, a 40 pt round bubble with a mini figure appears next to PBs. It grows from zero width, so a hidden bubble leaves no gap.
   - **Tapping it:** opens a `QuickView`, a card floating under the header with the figure, the most tired muscles and Open Recovery.
   - **Closing:** a tap outside closes it, and scrolling back to the top closes it too.
3. **Routines as cards,** two to a row (`RoutineGrid`): the name, the exercise count, a ⠿ handle, and Start and View.
   - **Card width:** floored, with a pixel spare, so two cards always fit a row. The web rounds a measured 309.6 px up to 310.
4. **Groups** (`routine_groups`, `routines.group_id`).
   - **Creating one:** New group names it.
   - **Order on the screen:** the groups come first, in order, then "My routines". That holds ungrouped routines, and any whose group no longer exists.
   - **Collapsing:** tapping a group's name collapses it.
   - **Rename or delete:** from its ⋯ button. Deleting a group keeps its routines; they move to My routines (on delete set null).
5. **Dragging a routine card.**
   - **Moving:** the handle drags a card to another place, or into another group. The section under the finger is highlighted, and a collapsed or empty group takes the card at its end.
   - **Saving:** `moveRoutine` renumbers the target group from 0 and writes only the rows that changed. The list updates at once and is refetched after.
6. **View** (`RoutineQuickView`).
   - Lists each exercise with its sets in a few words (`setsSummary`, e.g. "3 × 5 @ 110 kg, 1 × 3 @ 120 kg"; warm-ups left out), plus its 📌 template note and 🔗 note.
   - Has Start, Edit (the routine editor) and Close. A tap outside closes it.

### 27.3 Workout screen (`app/(app)/lift/workout.tsx`)

7. **The session figure stays at the top;** once scrolled away, it becomes a header bubble that opens the session view, with the figure and a row per muscle.
8. **The rest timer is one setting for the whole workout** (`workout.rest`, kept with the workout in the store), not one per exercise.
   - **The header bubble** reads "⏱ Off" or "⏱ 1:30".
   - **Its panel:** On or Off, chips from 0:30 to 5:00, and ±15 s (15 s to 10 min).
   - **When it runs:** only when it's on does ticking a set start the countdown. Turning it off stops a countdown that's running.
   - **The per-exercise "rest" pill is gone,** from the workout and from the routine editor. `rest_seconds` stays in the schema, unused.
   - **A new workout starts from Settings → Workout:** `profiles.rest_timer_on` (default false) and `rest_seconds` (default 90). These save as soon as they change.
9. **Reordering exercises.** The ≡ button on each card collapses the workout to a list of names (`ReorderList`). A row is dragged up or down and dropped, then Done.
   - **Why a separate list:** a drag can't start on a card that collapses under it, because the gesture would go with the card.
   - **Saving:** `moveExercise` saves the new positions.
   - **Screen readers:** move a row with the adjustable actions.
10. **Notes** (📝 next to the PB button; `NoteEditor`).
    - **In a workout from a template,** a switch says where the note lives:
      - 📌 this template (`routine_exercises.notes`, written straight away);
      - 🔗 every workout with the exercise (`exercise_notes`).
    - **With no template,** the note stays with the workout (`workout_exercises.notes`).
    - **On the card,** each note shows under the exercise name with its icon.
    - **Switching scope** loads that scope's note, unless the user has already typed something.
    - **Starting from a template** no longer copies its note into the workout's own note.
11. **Finish.**
    - **From a template with the same exercises:** no template prompt. The only question left is the existing one about filled-in sets that aren't ticked.
    - **An exercise added or removed:** `FinishPrompt` offers Update template, Save as new template (opens the routine editor prefilled, to name it, after the summary) or Keep template as is. Each one saves the workout; "Back to workout" cancels.
    - **No template:** finishes as before.
    - **What "Update" and "Save as new" take:** the sets Finish keeps; untouched empty ones are dropped.

### 27.4 Exercise picker (`PickerRow`)

12. **Each row is just the exercise's name and ⓘ;** the green load-split bar is gone from the picker.
    - **ⓘ opens:** the kind of exercise, the mini figure with the primary, secondary and tertiary key ("Not on the recovery map" for unmapped rows), and the PB line.
    - **The exercise screen** keeps its split bar.
    - **Screen readers** still get all of it in the row's label.

### 27.5 Gestures, for whoever touches them next

- **Moved distance:** both drags work out how far the pointer moved from absolute positions saved in `onBegin`.
  - Starting a drag changes state (scrolling off, the highlight), and the re-render rebuilds the gesture.
  - A rebuilt gesture reports its translation from 0 again, so `translationY` at the end was 0.
- **The live drag's state:** module-level holders keep it, changed only through small module functions. The React Compiler lint refuses refs read during render, and mutation of state objects.
- **Page scrolling:** stops while a card or row is dragged (`Screen scrollEnabled`).

### 27.6 Tests

- **`npm test`: 269 tests.** `template.test.ts` covers:
  - the change rule (reordered, added, removed, swapped, duplicates, no template);
  - the update payload (per-side pairs, template notes kept);
  - grouping (orphaned groups go to My routines);
  - moves (within a group, into another, out of all, unknown id);
  - set summaries.
- **db-tests (CI): 87 tests, 3 new in `test_lift_ui.py`:**
  - deleting a group keeps its routines;
  - groups and notes are owner-only;
  - rest settings default to off and 90 s, and stay in range.
- **Generated types:** `gen_types.py` against splitset-dev matches the hand-written types exactly.

### 27.7 Checked in the web preview (2026-10-19, demo athlete, 375 pt)

- **Lift tab:**
  - the figure is on top, and the bubble appears next to PBs when scrolled;
  - the quick view opens, and a tap outside closes it;
  - cards sit two to a row, and View lists Lower A's sets.
- **Groups:**
  - created "Upper/Lower" and dragged Lower A, then Lower B, into it;
  - both stayed there after a reload;
  - collapsing and expanding work.
- **Workout:**
  - the rest timer starts off, and ticking a set starts no timer;
  - on at 1:30, ticking starts the countdown, and Off stops it;
  - the session bubble shows when scrolled;
  - dragging Plank to the top of the reorder list saved;
  - a 📌 note on Back squat saved to Lower A, and a 🔗 note saved for every workout; both show on the card.
- **Finish:**
  - the same exercises: no template prompt;
  - one removed: the prompt appeared, and Keep, Save as new (named "Upper B short") and Update (5 to 4 exercises) each worked.
- **Settings → Workout:** On at 2:00 made a new workout start with ⏱ 2:00.
- **Afterwards:**
  - the test workouts and "Upper B short" were deleted, and the demo's rest settings reset to off and 90 s;
  - the "Upper/Lower" group and the two Back squat notes were left as examples.

## 28. Drag to reorder, and room for the routines and runs

Follow-up to §27 · 2026-10-19, from Conor's requests. Commits `a16ba61` and the one after it.

### 28.1 Drag and drop in the workout and the routine editor (`SortableList`)

1. **Holding an exercise's ≡ handle and dragging moves the card itself.** This works in the live workout and in the routine editor.
   - **While dragging:** the other cards slide aside to show where it will land (`dropSlot`, `makeRoom` in `src/lib/sortable.ts`, tested). Near the top or bottom of the window the page scrolls under the finger.
   - **What it replaces:** the workout's separate reorder list (§27.3 item 9, removed) and the editor's ↑/↓ arrows.
   - **Screen readers:** move an item with the handle's Move up and Move down actions.
2. **It follows the Today grid's `ReorderGrid` approach.**
   - **No reordering mid-drag:** items only move by transform while a finger is down, and the new order is handed back on the drop. A browser drops its pointer capture when the captured element moves in the DOM.
   - **Where the gesture is built:** in a small `Handle` component from callback props, so the React Compiler lint allows the refs in those callbacks.
   - **The start point:** taken in `onBegin`, before the list re-renders.
3. **Checked in the web preview:**
   - in a live Lower A workout, Back squat dragged below Romanian deadlift, and the order survived a reload;
   - in Lower A's editor, the same drag swapped them. It wasn't saved, so the routine is unchanged.

### 28.2 The Lift tab's figure

4. **Smaller:** each view is now at most 96 pt wide (was 140), with tighter padding, so the routines show below it on a phone.
5. **An ✕ on the figure tucks it into the header bubble.** The choice is remembered on the device (`useLayoutPrefs.liftFigureCollapsed`, persisted like the map preferences).
   - **While it's tucked away,** the bubble always shows beside PBs.
   - **Getting it back:** its quick view has "Show at the top".
   - **Why the ✕ sits beside the figure's button, not inside it:** a button can't hold another; on the web that is invalid HTML.
6. **Checked:** ✕ hid the figure and showed the bubble, which stayed so after a reload. "Show at the top" brought the figure back.

### 28.3 The Run tab's map

7. **Smaller:** 170–240 px tall (26% of the window; was 220–320 px at 34%).
8. **It scrolls with the run list now,** as the list's header; the title row stays fixed.
   - **Scrolled past:** a 96 × 64 mini map appears top right, beside Maps, showing what the big map showed: every route, the route picked, or the run opened.
   - **Tapping it:** opens a larger interactive map in a floating card (zoom, pan, and tapping a route still picks it). A tap outside shrinks it back.
   - **The title row** keeps the mini map's height, so it doesn't jump.
9. **Attribution on the mini map:** `TileMap` has a `compact` mode for thumbnails, where the attribution is just its © mark (the full text is its accessibility label). The full text stays on the big and the larger maps.
10. **Checked:** the mini map appeared once scrolled, showing the Melbourne routes. It opened larger, and Escape or a tap outside closed it. The console was clean.

### 28.4 Tests

- **`npm test`: 271 tests,** adding `sortable.test.ts`.
- **Type check and lint:** clean.
