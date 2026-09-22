-- Splitset M1: activities as synced from intervals.icu, plus derived per-activity detail.
--
-- Every activity type is kept (runs, rides, walks, strength, ...). Typed columns cover what
-- the app and reporting views read; the full payload is in `raw` so new columns can be
-- backfilled from it without another API fetch. Written only by the sync job.

create table public.activities (
  id               text primary key,                    -- intervals.icu activity id, e.g. i86283384
  user_id          uuid not null references public.profiles (id) on delete cascade,
  start_time       timestamptz not null,                -- start_date (UTC)
  start_time_local timestamp   not null,                -- start_date_local, wall clock where it happened
  timezone         text,
  type             text not null,                       -- Run, Ride, Walk, WeightTraining, ...
  name             text,
  distance_m       real,
  moving_time_s    integer,
  elapsed_time_s   integer,
  avg_hr           smallint,
  max_hr           smallint,
  cadence          real,        -- full steps per minute for runs, rpm for rides
  stride_m         real,
  gct_ms           real,        -- ground contact time (average_stance_time)
  gct_pct          real,
  vert_osc_cm      real,        -- payload is mm; stored /10
  vert_ratio       real,
  avg_power_w      real,
  vo2max           real,
  elev_gain_m      real,
  elev_loss_m      real,
  load             real,        -- icu_training_load
  intensity        real,
  trimp            real,
  gap_ms           real,        -- grade-adjusted pace, metres per second
  avg_temp_c       real,
  calories         real,
  resting_hr       smallint,    -- icu_resting_hr on the day
  weight_kg        real,        -- icu_weight on the day
  lthr             smallint,
  athlete_max_hr   smallint,
  device           text,
  gear_id          text,        -- shoe/bike hook for later
  hr_zone_times    integer[],   -- seconds per zone, icu_hr_zone_times
  hr_zones         integer[],   -- zone upper bounds in bpm, icu_hr_zones
  pace_zone_times  integer[],
  raw              jsonb not null,
  synced_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.activities is 'Activities from intervals.icu, all types. Written by the sync job only.';

create index activities_user_start_idx      on public.activities (user_id, start_time desc);
create index activities_user_type_idx       on public.activities (user_id, type);
create index activities_user_localdate_idx  on public.activities (user_id, ((start_time_local)::date));

create trigger activities_set_updated_at
  before update on public.activities
  for each row execute function extensions.moddatetime (updated_at);

alter table public.activities enable row level security;

create policy activities_select_own on public.activities
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.activities from anon, authenticated;
grant select on public.activities to authenticated;

-- ---------------------------------------------------------------- derived detail

create table public.activity_details (
  activity_id  text primary key references public.activities (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  has_streams  boolean not null,
  splits       jsonb,           -- [{"k":1,"t":301.2,"hr":142,"el":8}, ...] per whole km
  best_efforts jsonb,           -- {"1000":245.3,"5000":1310.0,...} seconds, keys are metres
  polyline     text,            -- Google encoded polyline, thinned to ~12 m spacing, max 1800 points
  bbox         real[],          -- [min_lat, min_lng, max_lat, max_lng]
  samples      jsonb,           -- {"t":[...],"d":[...],"hr":[...],"alt":[...]} every 10 s
  fetched_at   timestamptz not null default now()
);

comment on table public.activity_details is
  'Derived from intervals.icu streams by the sync job. has_streams=false rows exist so an activity without streams is not refetched.';

alter table public.activity_details enable row level security;

create policy activity_details_select_own on public.activity_details
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.activity_details from anon, authenticated;
grant select on public.activity_details to authenticated;
