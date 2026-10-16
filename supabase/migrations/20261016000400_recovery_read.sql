-- Splitset recovery map, phase 5: the read side (spec §8–§10).
--
-- recovery_loads(from, to)  the caller's cached loads for workouts (and, from phase 10, activities)
--                           that finished in (from, to], with what the tap detail lists: each
--                           exercise's name, L_e, PB source and its workout's finish time. The
--                           recovery map, the session view and the history are worked out from
--                           these rows in the app, by the engine (src/lib/recovery/read.ts);
--                           nothing is computed here. A null `to` means no upper bound.
--
-- Security invoker and filtered on auth.uid(), so a caller only ever reads their own rows, through
-- the (user_id, finished_at) index. Read-only: no table or row changes.

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
         and w.finished_at > p_from and (p_to is null or w.finished_at <= p_to)), '[]'::jsonb));
$$;

revoke all on function public.recovery_loads(timestamptz, timestamptz) from public, anon;
grant execute on function public.recovery_loads(timestamptz, timestamptz) to authenticated;
