-- Splitset recovery map, review fix: a unilateral exercise logged one side per set (workout_sets.side)
-- counts the same as logged both sides at once. Spec §4.4 already scores each side set as half a set;
-- the summary views counted every side row as a whole set and added both sides' volume, so switching
-- "Each side" on doubled the sets and volume shown on Today, Lift history, Trends and the streaks.
--
-- workout_summaries   sets_completed: a left + right pair is one set (an odd side row rounds up);
--                     volume_kg: each side row adds half its weight × reps
-- exercise_records    completed_sets: the same pairing
--
-- Column names and types are unchanged (bigint counts, real volume), so create or replace keeps the
-- grants and every reader works as before.

create or replace view public.workout_summaries
with (security_invoker = true) as
select w.id, w.user_id, w.routine_id, w.name, w.started_at, w.finished_at, w.notes, w.bodyweight_kg,
       w.activity_id, w.linked_by, w.updated_at,
       extract(epoch from (coalesce(w.finished_at, now()) - w.started_at))::integer as duration_s,
       (select count(*) from public.workout_exercises we where we.workout_id = w.id)                      as exercises,
       (select (count(*) filter (where s.side is null)
                + ceil(count(*) filter (where s.side is not null) / 2.0))::bigint
          from public.workout_sets s where s.workout_id = w.id and s.completed)                           as sets_completed,
       (select coalesce(sum(s.weight_kg * s.reps * (case when s.side is null then 1 else 0.5 end)::real), 0)
          from public.workout_sets s
         where s.workout_id = w.id and s.completed and s.set_type <> 'warmup')                            as volume_kg
  from public.workouts w;

-- As in 20261016000200_recovery_sets_pbs.sql, except completed_sets.
create or replace view public.exercise_records
with (security_invoker = true) as
select user_id,
       exercise_id,
       max(weight_kg)          as best_weight_kg,
       max(e1rm)               as best_e1rm_kg,
       max(weight_kg * reps)   as best_set_volume_kg,
       max(reps)               as best_reps,
       max(seconds)            as best_seconds,
       (count(*) filter (where side is null) + ceil(count(*) filter (where side is not null) / 2.0))::bigint
                               as completed_sets,
       max(completed_at)       as last_completed_at
  from public.workout_sets
 where completed and set_type <> 'warmup'
 group by user_id, exercise_id;
