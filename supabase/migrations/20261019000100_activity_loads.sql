-- Splitset recovery map, phase 10: imported activities (runs, rides, swims, hikes, rows) on the
-- body map, through the same cache as lifting.
--
-- save_activity_loads(p)   replaces each listed activity's rows in workout_muscle_loads
--                          (source = 'activity'). t_w is the activity's end: its start plus its
--                          elapsed (else moving) time. Returns how many activities were written.
-- clear_activity_loads()   removes all of the caller's activity rows (cardio turned off).
-- recovery_loads()         now also lists the activities that have rows in the window, with
--                          their name, type and end, so the tap detail can name them.
--
-- p: [{ "activity_id": text, "muscles": [{ "muscle_id", "load", "recovery_hours" }] }]
--
-- The numbers come from the app's engine (src/lib/recovery/cardio.ts); nothing is scored in SQL.
-- Security invoker: an activity the caller can't see (RLS) reads as "not found".

create or replace function public.save_activity_loads(p jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  a    record;
  n    integer := 0;
begin
  for item in select value from jsonb_array_elements(p) loop
    select id, user_id, start_time + make_interval(secs => coalesce(elapsed_time_s, moving_time_s, 0)) as finished_at
      into a from public.activities where id = item ->> 'activity_id';
    if a.id is null or a.user_id <> (select auth.uid()) then
      raise exception 'activity % not found', item ->> 'activity_id';
    end if;

    delete from public.workout_muscle_loads where activity_id = a.id;
    insert into public.workout_muscle_loads (user_id, activity_id, source, muscle_id, load, recovery_hours, finished_at)
    select a.user_id, a.id, 'activity', m ->> 'muscle_id', (m ->> 'load')::double precision,
           (m ->> 'recovery_hours')::double precision, a.finished_at
      from jsonb_array_elements(coalesce(item -> 'muscles', '[]')) m;
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.clear_activity_loads()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.workout_muscle_loads where user_id = (select auth.uid()) and source = 'activity';
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.recovery_loads(p_from timestamptz, p_to timestamptz default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'muscles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'workout_id', l.workout_id, 'activity_id', l.activity_id, 'source', l.source, 'muscle_id', l.muscle_id,
               'load', l.load, 'recovery_hours', l.recovery_hours, 'finished_at', l.finished_at)
             order by l.finished_at, l.muscle_id)
        from public.workout_muscle_loads l
       where l.user_id = (select auth.uid())
         and l.finished_at > p_from and (p_to is null or l.finished_at <= p_to)), '[]'::jsonb),
    'exercises', coalesce((
      select jsonb_agg(jsonb_build_object(
               'workout_id', x.workout_id, 'exercise_id', x.exercise_id, 'name', e.name, 'load', x.load,
               'pb_source', x.pb_source, 'pb_detail', x.pb_detail, 'pb_value', x.pb_value, 'finished_at', w.finished_at)
             order by w.finished_at, x.exercise_id)
        from public.workout_exercise_loads x
        join public.workouts w on w.id = x.workout_id
        join public.exercises e on e.id = x.exercise_id
       where x.user_id = (select auth.uid()) and x.load > 0
         and w.finished_at > p_from and (p_to is null or w.finished_at <= p_to)), '[]'::jsonb),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object('activity_id', a.id, 'name', a.name, 'type', a.type, 'finished_at', l.finished_at)
             order by l.finished_at)
        from (select distinct activity_id, finished_at from public.workout_muscle_loads
               where user_id = (select auth.uid()) and source = 'activity'
                 and finished_at > p_from and (p_to is null or finished_at <= p_to)) l
        join public.activities a on a.id = l.activity_id), '[]'::jsonb));
$$;

revoke all on function public.save_activity_loads(jsonb) from public, anon;
revoke all on function public.clear_activity_loads() from public, anon;
grant execute on function public.save_activity_loads(jsonb) to authenticated;
grant execute on function public.clear_activity_loads() to authenticated;
