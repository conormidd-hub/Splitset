-- Splitset M5: lifting.
--
-- exercises        the library: global rows (owner_id null, seeded) plus each user's own
-- routines         reusable templates ("Lower A"), with routine_exercises and routine_sets as targets
-- workouts         one gym session, with workout_exercises and workout_sets as what actually happened
-- exercise_records personal bests per exercise, computed from completed sets
--
-- These are client-synced tables: the app writes them directly under owner-only RLS and sets
-- updated_at itself. lww_guard drops any update older than what the row already holds, which is
-- what makes logging the same workout from two devices safe. The set is the atom (one row per
-- set, not per side), exercise_id is denormalised onto each set so history survives edits to the
-- workout, and prescribed targets live on the routine rather than the log.

create or replace function public.lww_guard()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is null then
    new.updated_at := now();
  end if;
  -- a device with a wrong clock must not be able to freeze a row for everyone else
  if new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now();
  end if;
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;   -- stale write: skip silently
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- exercises

create table public.exercises (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references public.profiles (id) on delete cascade,   -- null = global library
  name          text not null,
  muscle_group  text,      -- quads | hamstrings | glutes | calves | back | chest | shoulders | biceps | triceps | core | full_body | cardio | mobility
  equipment     text,      -- barbell | dumbbell | kettlebell | machine | cable | band | bodyweight | other
  measure       text not null default 'weight_reps'
                check (measure in ('weight_reps', 'reps', 'duration', 'weight_duration', 'distance_duration')),
  is_bodyweight boolean not null default false,
  is_unilateral boolean not null default false,
  instructions  text,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.exercises is 'Exercise library. owner_id null rows are the shared seed; users add their own.';

create unique index exercises_global_name_uidx on public.exercises (lower(name)) where owner_id is null;
create unique index exercises_owner_name_uidx  on public.exercises (owner_id, lower(name)) where owner_id is not null;

alter table public.exercises enable row level security;

create policy exercises_select on public.exercises
  for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy exercises_insert_own on public.exercises
  for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy exercises_update_own on public.exercises
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy exercises_delete_own on public.exercises
  for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.exercises from anon, authenticated;
grant select, insert, update, delete on public.exercises to authenticated;

create trigger exercises_lww before insert or update on public.exercises
  for each row execute function public.lww_guard();

-- ---------------------------------------------------------------- routines (templates)

create table public.routines (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null,
  notes      text,
  position   integer not null default 0,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index routines_user_idx on public.routines (user_id, archived, position);

create table public.routine_exercises (
  id             uuid primary key default gen_random_uuid(),
  routine_id     uuid not null references public.routines (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  exercise_id    uuid not null references public.exercises (id) on delete restrict,
  position       integer not null default 0,
  superset_group smallint,          -- exercises sharing a number alternate as a superset
  rest_seconds   integer,           -- default rest after each set of this exercise
  notes          text,
  updated_at     timestamptz not null default now()
);
create index routine_exercises_routine_idx on public.routine_exercises (routine_id, position);

create table public.routine_sets (
  id                  uuid primary key default gen_random_uuid(),
  routine_exercise_id uuid not null references public.routine_exercises (id) on delete cascade,
  user_id             uuid not null references public.profiles (id) on delete cascade,
  position            integer not null default 0,
  set_type            text not null default 'working'
                      check (set_type in ('warmup', 'working', 'drop', 'failure')),
  target_reps         integer,
  target_reps_max     integer,      -- for rep ranges, e.g. 8 to 12
  target_weight_kg    real,
  target_rpe          real,
  target_seconds      integer,
  updated_at          timestamptz not null default now()
);
create index routine_sets_exercise_idx on public.routine_sets (routine_exercise_id, position);

-- ---------------------------------------------------------------- workouts (what happened)

create table public.workouts (
  id            uuid primary key default gen_random_uuid(),   -- the app generates ids so a workout can start offline
  user_id       uuid not null references public.profiles (id) on delete cascade,
  routine_id    uuid references public.routines (id) on delete set null,
  name          text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  notes         text,
  bodyweight_kg real,
  activity_id   text references public.activities (id) on delete set null,   -- the watch's recording of the same session
  linked_by     text check (linked_by in ('auto', 'manual')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index workouts_user_started_idx on public.workouts (user_id, started_at desc);
create unique index workouts_activity_uidx on public.workouts (activity_id) where activity_id is not null;

create table public.workout_exercises (
  id             uuid primary key default gen_random_uuid(),
  workout_id     uuid not null references public.workouts (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  exercise_id    uuid not null references public.exercises (id) on delete restrict,
  position       integer not null default 0,
  superset_group smallint,
  rest_seconds   integer,
  notes          text,
  updated_at     timestamptz not null default now()
);
create index workout_exercises_workout_idx on public.workout_exercises (workout_id, position);

create table public.workout_sets (
  id                  uuid primary key default gen_random_uuid(),
  workout_exercise_id uuid not null references public.workout_exercises (id) on delete cascade,
  workout_id          uuid not null references public.workouts (id) on delete cascade,
  exercise_id         uuid not null references public.exercises (id) on delete restrict,   -- denormalised for history queries
  user_id             uuid not null references public.profiles (id) on delete cascade,
  position            integer not null default 0,
  set_type            text not null default 'working'
                      check (set_type in ('warmup', 'working', 'drop', 'failure')),
  weight_kg           real,
  reps                integer,
  rpe                 real,
  seconds             integer,
  distance_m          real,
  completed           boolean not null default false,
  completed_at        timestamptz,
  notes               text,
  updated_at          timestamptz not null default now()
);
create index workout_sets_workout_idx       on public.workout_sets (workout_id, position);
create index workout_sets_user_exercise_idx on public.workout_sets (user_id, exercise_id, completed_at desc) where completed;

-- ---------------------------------------------------------------- owner-only access, LWW trigger

do $$
declare
  t text;
begin
  foreach t in array array['routines', 'routine_exercises', 'routine_sets',
                           'workouts', 'workout_exercises', 'workout_sets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_own', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.lww_guard()',
      t || '_lww', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- derived views (RLS applies via security_invoker)

create view public.exercise_records
with (security_invoker = true) as
select user_id,
       exercise_id,
       max(weight_kg)                                                          as best_weight_kg,
       max(weight_kg * (1 + reps / 30.0)) filter (where reps between 1 and 12) as best_e1rm_kg,   -- Epley; meaningless past ~12 reps
       max(weight_kg * reps)                                                   as best_set_volume_kg,
       max(reps)                                                               as best_reps,
       max(seconds)                                                            as best_seconds,
       count(*)                                                                as completed_sets,
       max(completed_at)                                                       as last_completed_at
  from public.workout_sets
 where completed and set_type <> 'warmup'
 group by user_id, exercise_id;

create view public.workout_summaries
with (security_invoker = true) as
select w.id, w.user_id, w.routine_id, w.name, w.started_at, w.finished_at, w.notes, w.bodyweight_kg,
       w.activity_id, w.linked_by, w.updated_at,
       extract(epoch from (coalesce(w.finished_at, now()) - w.started_at))::integer as duration_s,
       (select count(*) from public.workout_exercises we where we.workout_id = w.id)                      as exercises,
       (select count(*) from public.workout_sets s where s.workout_id = w.id and s.completed)             as sets_completed,
       (select coalesce(sum(s.weight_kg * s.reps), 0) from public.workout_sets s
         where s.workout_id = w.id and s.completed and s.set_type <> 'warmup')                            as volume_kg
  from public.workouts w;

revoke all on public.exercise_records, public.workout_summaries from anon, authenticated;
grant select on public.exercise_records, public.workout_summaries to authenticated;
