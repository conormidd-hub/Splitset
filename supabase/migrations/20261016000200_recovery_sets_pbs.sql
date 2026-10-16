-- Splitset recovery map, phase 3: what each set needs for the engine, manual PBs, and one e1RM.
--
-- workout_sets      gains side and e1rm; rpe is checked (6 to 10 in half steps)
-- profiles          gains bodyweight_kg and bodyweight_updated_at
-- manual_pbs        a user's known bests (weight × reps on a date), next to their logged sets
-- pb_history        every logged set with an e1RM plus every manual PB: the engine's PB history
-- lift_pbs, exercise_records
--                   their 1RM now reads the stored e1rm, so every screen shows one number (D4)
--
-- e1rm is written by the app when a set is saved (src/lib/recovery/sets.ts, through the Phase 2
-- engine) and never computed here; supabase/backfill_e1rm.py fills it in for sets saved before.
-- The bodyweight snapshot for bodyweight and assisted sets is workouts.bodyweight_kg (D5), and a
-- warm-up is still set_type = 'warmup'. This migration changes no existing data.

-- ---------------------------------------------------------------- sets

alter table public.workout_sets
  add column side text check (side in ('left', 'right')),
  add column e1rm double precision check (e1rm > 0),
  add constraint workout_sets_rpe_steps check (rpe between 6 and 10 and rpe * 2 = round(rpe * 2));

comment on column public.workout_sets.e1rm is 'Estimated 1RM at save time: effective weight, reps plus reps in reserve from RPE (spec §3.1). Warm-ups included.';
comment on column public.workout_sets.side is 'left | right when a unilateral exercise is logged one side per set; each such set counts half (spec §4.4).';

-- ---------------------------------------------------------------- bodyweight

alter table public.profiles
  add column bodyweight_kg real check (bodyweight_kg between 20 and 400),
  add column bodyweight_updated_at timestamptz;

grant update (bodyweight_kg, bodyweight_updated_at) on public.profiles to authenticated;

-- ---------------------------------------------------------------- manual PBs

create table public.manual_pbs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  weight_kg   real not null check (weight_kg >= 0),     -- added load for bodyweight exercises
  reps        integer not null check (reps between 1 and 100),
  e1rm        double precision not null check (e1rm > 0),
  dated_at    date not null,                             -- counts from the start of this day in profiles.timezone
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index manual_pbs_user_exercise_idx on public.manual_pbs (user_id, exercise_id, dated_at desc);

comment on table public.manual_pbs is 'Known bests a user enters by hand (spec §3.3, §3.6). The e1rm is computed by the app.';

alter table public.manual_pbs enable row level security;
-- owner-only, and only for an exercise the user can see (a global one or their own)
create policy manual_pbs_own on public.manual_pbs
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.exercises e where e.id = exercise_id));
revoke all on public.manual_pbs from anon, authenticated;
grant select, insert, update, delete on public.manual_pbs to authenticated;

create trigger manual_pbs_lww before insert or update on public.manual_pbs
  for each row execute function public.lww_guard();

-- ---------------------------------------------------------------- PB history

-- One record per completed set of a finished workout that has an e1RM (warm-ups included: they
-- never limit a PB), dated when the workout finished, and one per manual PB, dated at the start
-- of its day in the user's time zone. The app turns these into the engine's PB records.
create view public.pb_history
with (security_invoker = true) as
select s.user_id, s.exercise_id, s.e1rm, w.finished_at as at, 'logged'::text as source,
       s.weight_kg, s.reps, s.rpe, s.set_type, s.workout_id, s.id as set_id, null::uuid as manual_pb_id
  from public.workout_sets s
  join public.workouts w on w.id = s.workout_id and w.finished_at is not null
 where s.completed and s.e1rm is not null
union all
select m.user_id, m.exercise_id, m.e1rm, (m.dated_at::timestamp at time zone p.timezone), 'manual',
       m.weight_kg, m.reps, null::real, null::text, null::uuid, null::uuid, m.id
  from public.manual_pbs m
  join public.profiles p on p.id = m.user_id;

revoke all on public.pb_history from anon, authenticated;
grant select on public.pb_history to authenticated;

-- ---------------------------------------------------------------- one e1RM (D4)

-- As in 20261012000100_pbs.sql, except that the 1RM is the e1rm stored on each set. Warm-ups
-- are still left out here.
--   1rm     weight x reps: best e1RM. A single with no reps in reserve counts as itself
--   3rm     weight x reps: heaviest weight lifted for 3 or more reps
--   reps    bodyweight work (reps-only, or no added weight): most reps in one set
--   time    holds: longest set
--   weight  loaded carries: heaviest weight
create or replace view public.lift_pbs
with (security_invoker = true) as
with sets as (
  select s.user_id, s.exercise_id, e.measure, e.is_bodyweight, s.id as set_id, s.workout_id,
         s.weight_kg, s.reps, s.seconds, s.e1rm,
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
         '1rm' as metric, e1rm as value
    from sets
   where measure = 'weight_reps' and e1rm is not null
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

-- As in 20260922000600_lifting.sql, except best_e1rm_kg, which is now the best stored e1RM.
create or replace view public.exercise_records
with (security_invoker = true) as
select user_id,
       exercise_id,
       max(weight_kg)          as best_weight_kg,
       max(e1rm)               as best_e1rm_kg,
       max(weight_kg * reps)   as best_set_volume_kg,
       max(reps)               as best_reps,
       max(seconds)            as best_seconds,
       count(*)                as completed_sets,
       max(completed_at)       as last_completed_at
  from public.workout_sets
 where completed and set_type <> 'warmup'
 group by user_id, exercise_id;
