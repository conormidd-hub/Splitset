-- Splitset M8: the training plan.
--
-- One row per planned session on a date. A session is "done" when it is linked to the
-- activity (from the watch) or the app workout that fulfilled it. The sync job links
-- automatically after each pass (see sync/splitset_sync/linking.py); the app links manually
-- and marks skips. A manual link, or a manual "leave unlinked", is never overridden.
-- steps / external_event_id / external_hash are reserved for structured sessions and pushing
-- planned runs to the watch through intervals.icu later.

create table public.plan_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  date              date not null,
  position          integer not null default 0,           -- order within the day
  type              text not null check (type in ('run', 'ride', 'strength', 'walk', 'rest', 'other')),
  subtype           text,                                  -- easy | long | tempo | intervals | race | recovery | hills | strides | mobility
  title             text not null,
  target_distance_m real,
  target_seconds    integer,
  routine_id        uuid references public.routines (id) on delete set null,
  notes             text,
  status            text not null default 'planned' check (status in ('planned', 'done', 'skipped')),
  activity_id       text references public.activities (id) on delete set null,
  workout_id        uuid references public.workouts (id) on delete set null,
  linked_by         text check (linked_by in ('auto', 'manual')),
  steps             jsonb,
  external_event_id text,
  external_hash     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.plan_sessions is
  'Planned sessions. linked_by=manual with a null activity_id/workout_id means "leave unlinked"; the sync job respects that.';

create index plan_sessions_user_date_idx on public.plan_sessions (user_id, date, position);
create unique index plan_sessions_activity_uidx on public.plan_sessions (activity_id) where activity_id is not null;
create unique index plan_sessions_workout_uidx  on public.plan_sessions (workout_id)  where workout_id  is not null;

alter table public.plan_sessions enable row level security;

create policy plan_sessions_own on public.plan_sessions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.plan_sessions from anon, authenticated;
grant select, insert, update, delete on public.plan_sessions to authenticated;

create trigger plan_sessions_lww before insert or update on public.plan_sessions
  for each row execute function public.lww_guard();

-- Grafana: planned vs done per week
create view reporting.plan_weekly as
select user_id,
       date_trunc('week', date)::date as week,
       type,
       count(*) filter (where status = 'planned' and date < current_date) as missed,
       count(*) filter (where status = 'planned' and date >= current_date) as upcoming,
       count(*) filter (where status = 'done')    as done,
       count(*) filter (where status = 'skipped') as skipped,
       sum(target_distance_m) / 1000.0 as planned_km
  from public.plan_sessions
 group by 1, 2, 3;

grant select on reporting.plan_weekly to grafana_reader;
