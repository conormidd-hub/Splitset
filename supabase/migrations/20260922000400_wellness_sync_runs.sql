-- Splitset M1: daily wellness and a log of sync runs.

create table public.wellness (
  user_id           uuid not null references public.profiles (id) on delete cascade,
  date              date not null,
  resting_hr        smallint,
  hrv               real,        -- rMSSD as reported by the device
  hrv_sdnn          real,
  hrv_baseline_low  real,        -- Garmin's personal normal band, from the export backfill
  hrv_baseline_high real,
  weight_kg         real,
  body_fat_pct      real,
  sleep_s           integer,
  sleep_score       real,
  sleep_quality     smallint,
  vo2max            real,
  ctl               real,        -- fitness (42-day)
  atl               real,        -- fatigue (7-day)
  ramp_rate         real,
  steps             integer,
  stress            real,
  respiration       real,
  spo2              real,
  readiness         real,
  source            text not null default 'intervals'
                    check (source in ('intervals', 'garmin_export', 'manual')),
  raw               jsonb,
  updated_at        timestamptz not null default now(),
  primary key (user_id, date)
);

comment on table public.wellness is
  'One row per user per day. intervals.icu wins column by column; garmin_export only fills what intervals never had.';

create trigger wellness_set_updated_at
  before update on public.wellness
  for each row execute function extensions.moddatetime (updated_at);

alter table public.wellness enable row level security;

create policy wellness_select_own on public.wellness
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.wellness from anon, authenticated;
grant select on public.wellness to authenticated;

-- ---------------------------------------------------------------- sync log

create table public.sync_runs (
  id                  bigint generated always as identity primary key,
  user_id             uuid references public.profiles (id) on delete cascade,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running'
                      check (status in ('running', 'ok', 'error', 'auth_failed')),
  triggered_by        text,           -- cron | manual | local
  github_run_id       text,
  window_oldest       date,
  window_newest       date,
  activities_fetched  integer not null default 0,
  activities_upserted integer not null default 0,
  streams_fetched     integer not null default 0,
  streams_pending     integer not null default 0,
  wellness_days       integer not null default 0,
  plan_links          integer not null default 0,
  error               text
);

comment on table public.sync_runs is 'One row per user per sync pass. The app shows the latest few on the Connect screen.';

create index sync_runs_user_started_idx on public.sync_runs (user_id, started_at desc);

alter table public.sync_runs enable row level security;

create policy sync_runs_select_own on public.sync_runs
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.sync_runs from anon, authenticated;
grant select on public.sync_runs to authenticated;
