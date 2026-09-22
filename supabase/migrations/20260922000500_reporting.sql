-- Splitset M4: a reporting schema for Grafana.
--
-- Views here are owned by postgres and so read across every user (Grafana filters with a
-- dashboard variable). They are NOT exposed through the Data API: `reporting` is not in
-- config.toml's api.schemas. Grafana connects as `grafana_reader`, which can read only this
-- schema. Give that role a password by hand, once, in the SQL editor:
--
--     alter role grafana_reader with login password '<long random password>';

create schema if not exists reporting;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'grafana_reader') then
    create role grafana_reader nologin;
  end if;
end
$$;

grant usage on schema reporting to grafana_reader;
alter default privileges in schema reporting grant select on tables to grafana_reader;
-- lets postgres `set role grafana_reader` to verify what Grafana will see
grant grafana_reader to postgres;

-- ---------------------------------------------------------------- who

create view reporting.users as
select id as user_id, display_name, timezone, units
  from public.profiles;

-- ---------------------------------------------------------------- activities, one row each

create view reporting.activities as
select a.id, a.user_id, p.display_name,
       a.start_time, a.start_time_local, a.start_time_local::date as local_date,
       a.type, a.name,
       a.distance_m, a.distance_m / 1000.0 as km,
       a.moving_time_s, a.elapsed_time_s,
       case when a.distance_m > 0 and a.moving_time_s > 0
            then a.moving_time_s / (a.distance_m / 1000.0) end as sec_per_km,
       a.avg_hr, a.max_hr, a.cadence, a.stride_m, a.gct_ms, a.gct_pct, a.vert_osc_cm, a.vert_ratio,
       a.avg_power_w, a.vo2max, a.elev_gain_m, a.elev_loss_m,
       a.load, a.intensity, a.trimp, a.gap_ms, a.avg_temp_c, a.calories,
       a.resting_hr, a.weight_kg, a.lthr, a.athlete_max_hr, a.device,
       a.hr_zone_times, a.hr_zones, a.pace_zone_times,
       d.has_streams, d.best_efforts, d.splits, d.polyline, d.bbox
  from public.activities a
  join public.profiles p on p.id = a.user_id
  left join public.activity_details d on d.activity_id = a.id;

-- ---------------------------------------------------------------- weekly volume by type

create view reporting.weekly_volume as
select user_id,
       date_trunc('week', start_time_local)::date as week,
       type,
       count(*)                     as sessions,
       sum(distance_m) / 1000.0     as km,
       sum(moving_time_s) / 3600.0  as hours,
       sum(load)                    as load,
       sum(elev_gain_m)             as elev_gain_m,
       max(distance_m) / 1000.0     as longest_km
  from public.activities
 group by 1, 2, 3;

-- ---------------------------------------------------------------- daily load, zero-filled, with ACWR

create view reporting.daily_load as
with span as (
  select user_id, min(start_time_local)::date as first_day
    from public.activities
   group by 1
), days as (
  select s.user_id, d::date as day
    from span s
    cross join lateral generate_series(s.first_day, current_date, interval '1 day') as d
), loads as (
  select user_id, start_time_local::date as day,
         sum(load) as load, sum(distance_m) / 1000.0 as km, count(*) as sessions
    from public.activities
   group by 1, 2
)
select d.user_id, d.day,
       coalesce(l.load, 0)     as load,
       coalesce(l.km, 0)       as km,
       coalesce(l.sessions, 0) as sessions,
       avg(coalesce(l.load, 0)) over w7  as acute_7d,
       avg(coalesce(l.load, 0)) over w28 as chronic_28d,
       -- acute:chronic ratio; undefined until the chronic side is meaningful (same floor the
       -- reference dashboard used)
       case when avg(coalesce(l.load, 0)) over w28 >= 8
            then (avg(coalesce(l.load, 0)) over w7) / (avg(coalesce(l.load, 0)) over w28) end as acwr
  from days d
  left join loads l using (user_id, day)
window w7  as (partition by d.user_id order by d.day rows between 6 preceding and current row),
       w28 as (partition by d.user_id order by d.day rows between 27 preceding and current row);

-- ---------------------------------------------------------------- wellness with rolling means

create view reporting.wellness_daily as
select w.user_id, w.date,
       w.resting_hr, w.hrv, w.hrv_sdnn, w.hrv_baseline_low, w.hrv_baseline_high,
       w.weight_kg, w.body_fat_pct, w.sleep_s, w.sleep_s / 3600.0 as sleep_h, w.sleep_score, w.sleep_quality,
       w.vo2max, w.ctl, w.atl, w.ctl - w.atl as tsb, w.ramp_rate, w.steps, w.stress, w.respiration, w.spo2, w.readiness,
       w.source,
       avg(w.resting_hr) over (partition by w.user_id order by w.date rows between 6  preceding and current row) as rhr_7d,
       avg(w.resting_hr) over (partition by w.user_id order by w.date rows between 13 preceding and current row) as rhr_14d,
       avg(w.resting_hr) over (partition by w.user_id order by w.date rows between 29 preceding and current row) as rhr_30d,
       avg(w.hrv)        over (partition by w.user_id order by w.date rows between 6  preceding and current row) as hrv_7d,
       avg(w.hrv)        over (partition by w.user_id order by w.date rows between 59 preceding and current row) as hrv_60d,
       avg(w.sleep_s)    over (partition by w.user_id order by w.date rows between 6  preceding and current row) as sleep_s_7d
  from public.wellness w;

-- ---------------------------------------------------------------- best efforts, one row per distance per activity

create view reporting.best_efforts as
select a.user_id, a.id as activity_id, a.start_time_local, a.start_time_local::date as local_date,
       a.type, a.name, a.distance_m,
       (e.key)::int   as effort_m,
       (e.value)::real as seconds,
       (e.value)::real / ((e.key)::int / 1000.0) as sec_per_km
  from public.activities a
  join public.activity_details d on d.activity_id = a.id
  cross join lateral jsonb_each_text(d.best_efforts) as e
 where d.best_efforts is not null;

-- fastest ever per distance per user
create view reporting.records as
select distinct on (user_id, effort_m)
       user_id, effort_m, seconds, sec_per_km, activity_id, local_date, name
  from reporting.best_efforts
 order by user_id, effort_m, seconds;

-- ---------------------------------------------------------------- time in heart-rate zone per month (runs)

create view reporting.hr_zone_monthly as
select a.user_id,
       date_trunc('month', a.start_time_local)::date as month,
       z.zone,
       sum(z.secs) as seconds
  from public.activities a
  cross join lateral unnest(a.hr_zone_times) with ordinality as z(secs, zone)
 where a.hr_zone_times is not null
   and a.type in ('Run', 'VirtualRun', 'TrailRun')
 group by 1, 2, 3;

grant select on all tables in schema reporting to grafana_reader;
