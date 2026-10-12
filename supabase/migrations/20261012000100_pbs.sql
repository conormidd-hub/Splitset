-- Splitset: personal bests for runs and lifts, this month, this year and all time.
--
-- Both views read the owner's own rows (security_invoker, so RLS applies) and need nothing
-- stored: PBs are recomputed from activities, activity details and completed sets on every
-- read, so an edited or deleted workout can never leave a stale record behind.
--
-- "This month" and "this year" are the athlete's local calendar, from profiles.timezone.
-- Runs carry their local start time already; lifting sets carry an instant, converted here.

-- ---------------------------------------------------------------- a timezone the views can use

-- The settings screen takes free text. An unknown zone would make every PB read fail, so reset
-- any that Postgres cannot parse and refuse them from now on.
do $$
declare
  r record;
begin
  for r in select distinct timezone from public.profiles loop
    begin
      perform now() at time zone r.timezone;
    exception when others then
      update public.profiles set timezone = 'UTC' where timezone = r.timezone;
    end;
  end loop;
end
$$;

alter table public.profiles
  add constraint profiles_timezone_valid
  check (('2000-01-01 00:00+00'::timestamptz at time zone timezone) is not null);

-- ---------------------------------------------------------------- running

-- One row per athlete, PB and period: the fastest 1 km, mile, 5 km, 10 km, 15 km, half and
-- marathon inside any run (best efforts from the sync job), and the longest run.
create view public.run_pbs
with (security_invoker = true) as
with runs as (
  select a.user_id, a.id as activity_id, a.name, a.start_time_local, a.distance_m, a.moving_time_s,
         now() at time zone p.timezone as local_now
    from public.activities a
    join public.profiles p on p.id = a.user_id
   where a.type in ('Run', 'TrailRun', 'VirtualRun')
),
candidates as (
  select r.user_id, r.activity_id, r.name, r.start_time_local, r.local_now,
         case (e.key)::int
           when 1000 then '1km' when 1609 then '1mile' when 5000 then '5km' when 10000 then '10km'
           when 15000 then '15km' when 21097 then 'half' when 42195 then 'marathon'
         end as pb,
         (e.key)::int    as distance_m,
         (e.value)::real as seconds,
         (e.value)::real as score                       -- lower is better
    from runs r
    join public.activity_details d on d.activity_id = r.activity_id
    cross join lateral jsonb_each_text(d.best_efforts) as e
   where (e.key)::int in (1000, 1609, 5000, 10000, 15000, 21097, 42195)
  union all
  select r.user_id, r.activity_id, r.name, r.start_time_local, r.local_now,
         'longest', round(r.distance_m)::int, r.moving_time_s::real, -r.distance_m
    from runs r
   where r.distance_m > 0
)
select distinct on (c.user_id, c.pb, p.period)
       c.user_id, c.pb, p.period, c.distance_m, c.seconds, c.activity_id, c.name as activity_name, c.start_time_local
  from candidates c
  join (values ('month'), ('year'), ('all')) as p (period)
    on p.period = 'all'
    or (p.period = 'year'  and c.start_time_local >= date_trunc('year',  c.local_now))
    or (p.period = 'month' and c.start_time_local >= date_trunc('month', c.local_now))
 order by c.user_id, c.pb, p.period, c.score, c.start_time_local;

-- ---------------------------------------------------------------- lifting

-- One row per athlete, exercise, metric and period, from completed non-warm-up sets of
-- finished workouts. Metrics by how the exercise is measured:
--   1rm     weight x reps: best one-rep max. A single counts as itself; 2-12 reps go through
--           Epley, as exercise_records does. reps says which: 1 is a tested max, more is estimated
--   3rm     weight x reps: heaviest weight lifted for 3 or more reps
--   reps    bodyweight work (reps-only, or no added weight): most reps in one set
--   time    holds: longest set
--   weight  loaded carries: heaviest weight
create view public.lift_pbs
with (security_invoker = true) as
with sets as (
  select s.user_id, s.exercise_id, e.measure, e.is_bodyweight, s.id as set_id, s.workout_id,
         s.weight_kg, s.reps, s.seconds,
         coalesce(s.completed_at, w.started_at)                       as achieved_at,
         coalesce(s.completed_at, w.started_at) at time zone p.timezone as local_at,
         now() at time zone p.timezone                                 as local_now
    from public.workout_sets s
    join public.workouts w  on w.id = s.workout_id and w.finished_at is not null
    join public.exercises e on e.id = s.exercise_id
    join public.profiles p  on p.id = s.user_id
   where s.completed and s.set_type <> 'warmup'
),
candidates as (
  select user_id, exercise_id, set_id, workout_id, weight_kg, reps, seconds, achieved_at, local_at, local_now,
         '1rm' as metric,
         case when reps = 1 then weight_kg else weight_kg * (1 + reps / 30.0) end as value
    from sets
   where measure = 'weight_reps' and weight_kg > 0 and reps between 1 and 12
  union all
  select user_id, exercise_id, set_id, workout_id, weight_kg, reps, seconds, achieved_at, local_at, local_now,
         '3rm', weight_kg
    from sets
   where measure = 'weight_reps' and weight_kg > 0 and reps >= 3
  union all
  select user_id, exercise_id, set_id, workout_id, weight_kg, reps, seconds, achieved_at, local_at, local_now,
         'reps', reps
    from sets
   where (measure = 'reps' or (measure = 'weight_reps' and is_bodyweight and coalesce(weight_kg, 0) = 0)) and reps > 0
  union all
  select user_id, exercise_id, set_id, workout_id, weight_kg, reps, seconds, achieved_at, local_at, local_now,
         'time', seconds
    from sets
   where measure = 'duration' and seconds > 0
  union all
  select user_id, exercise_id, set_id, workout_id, weight_kg, reps, seconds, achieved_at, local_at, local_now,
         'weight', weight_kg
    from sets
   where measure = 'weight_duration' and weight_kg > 0
)
select distinct on (c.user_id, c.exercise_id, c.metric, p.period)
       c.user_id, c.exercise_id, c.metric, p.period,
       round(c.value::numeric, 1)::real as value,
       c.weight_kg, c.reps, c.seconds, c.set_id, c.workout_id, c.achieved_at
  from candidates c
  join (values ('month'), ('year'), ('all')) as p (period)
    on p.period = 'all'
    or (p.period = 'year'  and c.local_at >= date_trunc('year',  c.local_now))
    or (p.period = 'month' and c.local_at >= date_trunc('month', c.local_now))
 order by c.user_id, c.exercise_id, c.metric, p.period, c.value desc, c.achieved_at;

revoke all on public.run_pbs, public.lift_pbs from anon, authenticated;
grant select on public.run_pbs, public.lift_pbs to authenticated;

-- ---------------------------------------------------------------- Grafana: running records are runs only

-- The sync job derives best efforts for any activity with a distance stream, rides included,
-- so a fast 10 km on the bike was showing up as a running record.
create or replace view reporting.best_efforts as
select a.user_id, a.id as activity_id, a.start_time_local, a.start_time_local::date as local_date,
       a.type, a.name, a.distance_m,
       (e.key)::int   as effort_m,
       (e.value)::real as seconds,
       (e.value)::real / ((e.key)::int / 1000.0) as sec_per_km
  from public.activities a
  join public.activity_details d on d.activity_id = a.id
  cross join lateral jsonb_each_text(d.best_efforts) as e
 where d.best_efforts is not null
   and a.type in ('Run', 'TrailRun', 'VirtualRun');
