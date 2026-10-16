-- Splitset recovery map, phase 4: the per-workout cache (spec §11) and the functions that write it.
--
-- workout_muscle_loads    one row per muscle a finished workout (or, from phase 10, an imported
--                         activity) loaded: L_m,w, its recovery window R_m,w and t_w. A muscle with
--                         no row was not loaded. The recovery map is a query over these rows.
-- workout_exercise_loads  one row per exercise in a finished workout: L_e, and where its PB
--                         reference came from, for the tap detail (spec §10)
-- finish_workout()        sets finished_at and replaces the workout's cache in one transaction (D6)
-- save_workout_loads()    replaces the cache of workouts already finished: the recompute rule (§14)
--
-- The numbers come from the app's engine (src/lib/recovery/workoutLoads.ts); nothing is scored in
-- SQL. Both functions are security invoker, so RLS decides whose workouts a caller can write.

-- ---------------------------------------------------------------- per muscle

create table public.workout_muscle_loads (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  workout_id     uuid references public.workouts (id) on delete cascade,
  activity_id    text references public.activities (id) on delete cascade,
  source         text not null check (source in ('lift', 'activity')),
  muscle_id      text not null references public.muscles (id),
  load           double precision not null check (load > 0),             -- L_m,w
  recovery_hours double precision not null check (recovery_hours > 0),   -- R_m,w
  finished_at    timestamptz not null,                                   -- t_w
  constraint workout_muscle_loads_one_source check (
    (source = 'lift' and workout_id is not null and activity_id is null)
    or (source = 'activity' and activity_id is not null and workout_id is null))
);
create unique index workout_muscle_loads_workout_uidx  on public.workout_muscle_loads (workout_id, muscle_id)  where workout_id is not null;
create unique index workout_muscle_loads_activity_uidx on public.workout_muscle_loads (activity_id, muscle_id) where activity_id is not null;
create index workout_muscle_loads_user_time_idx on public.workout_muscle_loads (user_id, finished_at desc);

comment on table public.workout_muscle_loads is 'Cached L_m, R_m and t_w per finished workout (or activity) and muscle. Derived: rewritten by the recompute rule.';

-- ---------------------------------------------------------------- per exercise

create table public.workout_exercise_loads (
  workout_id  uuid not null references public.workouts (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  load        double precision not null check (load >= 0),   -- L_e, both blocks of an exercise summed (F28)
  pb_source   text not null check (pb_source in ('monthly', 'lapsed', 'estimated', 'calibration', 'not needed')),
  pb_detail   text,                                          -- logged | manual, or the anchor slug when estimated
  pb_value    double precision,                              -- the reference e1RM the session started from
  primary key (workout_id, exercise_id)
);

comment on table public.workout_exercise_loads is 'Cached L_e and PB reference per finished workout and exercise. Derived: rewritten by the recompute rule.';

-- ---------------------------------------------------------------- access

do $$
declare
  t text;
begin
  foreach t in array array['workout_muscle_loads', 'workout_exercise_loads'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_own', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- rows are only ever replaced as a set, through the functions below
    execute format('grant select, insert, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- writing the cache

-- p_loads: [{ "workout_id": uuid,
--             "muscles":   [{ "muscle_id", "load", "recovery_hours" }],
--             "exercises": [{ "exercise_id", "load", "pb_source", "pb_detail", "pb_value" }] }]
-- Each listed workout must be finished; its rows are deleted and written again, with t_w taken
-- from workouts.finished_at. Returns how many workouts were written.
create or replace function public.save_workout_loads(p_loads jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  w    record;
  n    integer := 0;
begin
  for item in select value from jsonb_array_elements(p_loads) loop
    select id, user_id, finished_at into w from public.workouts where id = (item ->> 'workout_id')::uuid;
    if w.id is null then
      raise exception 'workout % not found', item ->> 'workout_id';
    end if;
    if w.finished_at is null then
      raise exception 'workout % is not finished', w.id;
    end if;

    delete from public.workout_muscle_loads where workout_id = w.id;
    delete from public.workout_exercise_loads where workout_id = w.id;

    insert into public.workout_muscle_loads (user_id, workout_id, source, muscle_id, load, recovery_hours, finished_at)
    select w.user_id, w.id, 'lift', m ->> 'muscle_id', (m ->> 'load')::double precision,
           (m ->> 'recovery_hours')::double precision, w.finished_at
      from jsonb_array_elements(coalesce(item -> 'muscles', '[]')) m;

    insert into public.workout_exercise_loads (workout_id, user_id, exercise_id, load, pb_source, pb_detail, pb_value)
    select w.id, w.user_id, (e ->> 'exercise_id')::uuid, (e ->> 'load')::double precision, e ->> 'pb_source',
           e ->> 'pb_detail', (e ->> 'pb_value')::double precision
      from jsonb_array_elements(coalesce(item -> 'exercises', '[]')) e;

    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Finish a workout and write its cache in one transaction (D6). p_loads is one element of
-- save_workout_loads' array, for this workout. updated_at only moves forward, so a device whose
-- clock ran ahead cannot make the last-write-wins guard drop the finish.
create or replace function public.finish_workout(p_workout_id uuid, p_finished_at timestamptz, p_loads jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.workouts
     set finished_at = p_finished_at, updated_at = greatest(updated_at, now())
   where id = p_workout_id;
  if not found then
    raise exception 'workout % not found', p_workout_id;
  end if;
  perform public.save_workout_loads(jsonb_build_array(p_loads || jsonb_build_object('workout_id', p_workout_id)));
end;
$$;

revoke all on function public.save_workout_loads(jsonb) from public, anon;
revoke all on function public.finish_workout(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.save_workout_loads(jsonb) to authenticated;
grant execute on function public.finish_workout(uuid, timestamptz, jsonb) to authenticated;
