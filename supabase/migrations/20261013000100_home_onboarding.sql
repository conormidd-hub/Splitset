-- Splitset: the Today screen's layout, first-run onboarding, and a live check of a new
-- intervals.icu connection so the wizard can say "Connected: Conor" instead of "wait for the cron".

-- ---------------------------------------------------------------- profiles

alter table public.profiles
  add column home_layout  jsonb,
  add column onboarded_at timestamptz,
  add column birth_year   smallint check (birth_year between 1900 and 2100),
  add column sex          text check (sex in ('male', 'female'));

comment on column public.profiles.home_layout is
  'The Today screen: {"v":1,"focus":"readiness","glance":["resting_hr",...]}. Null means the app''s default.';
comment on column public.profiles.onboarded_at is
  'When the first-run wizard was finished or skipped. Null, with no intervals.icu connection, sends the account to /welcome.';
comment on column public.profiles.birth_year is
  'Optional. With sex, the VO2 max page can show the fitness-level band Garmin shows.';

grant update (home_layout, onboarded_at, birth_year, sex) on public.profiles to authenticated;

-- ---------------------------------------------------------------- wellness: four more Garmin facts

-- Body Battery reaches intervals.icu only through custom wellness fields the athlete creates
-- there with the codes BodyBatteryMin and BodyBatteryMax (ticked under Garmin, Download wellness
-- data); they ride along as extra keys of the wellness record, which the sync job now reads.
-- floorsClimbed is new in the intervals.icu API; avgSleepingHR exists there for other sources.
alter table public.wellness
  add column body_battery_max smallint,
  add column body_battery_min smallint,
  add column floors           integer,
  add column avg_sleeping_hr  real;

comment on column public.wellness.body_battery_max is
  'Garmin Body Battery high for the day, from the custom intervals.icu field BodyBatteryMax.';

-- ---------------------------------------------------------------- is the key right?

-- A newcomer pastes one thing, the API key: intervals.icu treats athlete "0" as whoever owns the
-- key, so the athlete id, name, time zone, sex, date of birth and whether Garmin wellness is
-- switched on all come back from one GET. The database makes that call with pg_net, the way
-- request_sync talks to GitHub, and the app polls for the answer. pg_net only sends after the
-- transaction commits, hence the two steps. One row per check ties a request to its response.
-- Server-only: no policies, the two functions are the only readers.
create table public.connection_checks (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  requested_at   timestamptz not null default now(),
  net_request_id bigint,
  stored_key     boolean not null default false     -- checking the key already in Vault, not a pasted one
);

create index connection_checks_user_idx on public.connection_checks (user_id, requested_at desc);

alter table public.connection_checks enable row level security;
revoke all on public.connection_checks from anon, authenticated;

-- "Basic " + base64("API_KEY:" + key). encode() wraps base64 at 76 characters and pg_net refuses
-- a header with a line break in it, so the newlines come out.
create or replace function public.intervals_basic_auth(p_api_key text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'Basic ' || replace(encode(convert_to('API_KEY:' || p_api_key, 'UTF8'), 'base64'), E'\n', '')
$$;

revoke all on function public.intervals_basic_auth(text) from public, anon, authenticated;

-- Start a check of a pasted key, or of the stored one when p_api_key is null. Returns
-- {"status": "sent", "check": id} to poll on, or bad_key (too short), not_connected (nothing
-- stored to check), or too_soon (one check per athlete per 5 seconds).
create or replace function public.verify_intervals_key(p_api_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_key    text := nullif(trim(p_api_key), '');
  v_stored boolean := false;
  v_secret uuid;
  v_last   timestamptz;
  v_net    bigint;
  v_id     bigint;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if v_key is null then
    select api_key_secret_id into v_secret from public.intervals_connections where user_id = v_uid;
    if v_secret is not null then
      select decrypted_secret into v_key from vault.decrypted_secrets where id = v_secret;
    end if;
    if v_key is null then
      return jsonb_build_object('status', 'not_connected');
    end if;
    v_stored := true;
  elsif length(v_key) < 8 then
    return jsonb_build_object('status', 'bad_key');
  end if;

  select max(requested_at) into v_last from public.connection_checks where user_id = v_uid;
  if v_last > now() - interval '5 seconds' then
    return jsonb_build_object('status', 'too_soon');
  end if;
  if (select count(*) from public.connection_checks where requested_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('status', 'too_soon');
  end if;

  -- Cloudflare in front of intervals.icu wants a real user agent, as the sync job sends
  v_net := net.http_get(
    url     := 'https://intervals.icu/api/v1/athlete/0',
    headers := jsonb_build_object(
                 'Authorization', public.intervals_basic_auth(v_key),
                 'Accept', 'application/json',
                 'User-Agent', 'splitset/0.1 (+https://github.com/conormidd-hub/Splitset)'),
    timeout_milliseconds := 15000
  );
  insert into public.connection_checks (user_id, net_request_id, stored_key)
  values (v_uid, v_net, v_stored)
  returning id into v_id;
  return jsonb_build_object('status', 'sent', 'check', v_id);
end;
$$;

-- What intervals.icu said: {"state": "pending"} until pg_net has the answer, then
-- {"state": "ok", "athlete_id": "i123456", "name": "Conor", "timezone": "Australia/Melbourne",
-- "sex": "male", "date_of_birth": "1990-01-01", "garmin_health": true, "garmin_wellness": true,
-- "garmin_wellness_keys": ["restingHR", ...]}, or {"state": "failed", "http_status": 401,
-- "message": "..."}. A check of the stored key that intervals.icu turns down marks the connection
-- auth_failed so the sync job leaves it alone until the key is fixed; one that passes marks it
-- active again. The response row is deleted once read: the athlete record carries the key itself.
create or replace function public.intervals_verify_status(p_check bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_net    bigint;
  v_stored boolean;
  v_code   int;
  v_body   text;
  v_err    text;
  v_to     boolean;
  v_json   jsonb;
  v_msg    text;
  v_out    jsonb;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select net_request_id, stored_key into v_net, v_stored
    from public.connection_checks
   where id = p_check and user_id = v_uid;
  if v_net is null then
    return jsonb_build_object('state', 'unknown');
  end if;
  select status_code, content, error_msg, timed_out into v_code, v_body, v_err, v_to
    from net._http_response
   where id = v_net;
  if not found then
    return jsonb_build_object('state', 'pending');
  end if;
  delete from net._http_response where id = v_net;

  if v_err is not null or coalesce(v_to, false) then
    return jsonb_build_object('state', 'failed', 'message', 'Could not reach intervals.icu (' || coalesce(left(v_err, 120), 'timed out') || '). Try again in a moment.');
  end if;

  if v_code between 200 and 299 then
    begin
      v_json := v_body::jsonb;
    exception when others then
      v_json := '{}'::jsonb;
    end;
    if v_stored then
      update public.intervals_connections
         set status = 'active', consecutive_auth_failures = 0, last_error = null
       where user_id = v_uid and status in ('active', 'auth_failed');
    end if;
    -- the athlete record, or {athlete: {...}} from the profile shape; be lenient
    if v_json ? 'athlete' then
      v_json := v_json -> 'athlete';
    end if;
    v_out := jsonb_build_object(
      'state', 'ok',
      'athlete_id', v_json ->> 'id',
      'name', nullif(trim(coalesce(v_json ->> 'name', concat_ws(' ', v_json ->> 'firstname', v_json ->> 'lastname'))), ''),
      'timezone', v_json ->> 'timezone',
      'sex', case lower(coalesce(v_json ->> 'sex', '')) when 'm' then 'male' when 'male' then 'male' when 'f' then 'female' when 'female' then 'female' end,
      'date_of_birth', v_json ->> 'icu_date_of_birth',
      'garmin_health', (v_json ->> 'icu_garmin_health')::boolean,
      'garmin_wellness', (v_json ->> 'icu_garmin_download_wellness')::boolean,
      'garmin_wellness_keys', coalesce(v_json -> 'icu_garmin_wellness_keys', '[]'::jsonb));
    if v_out ->> 'athlete_id' is null then
      return jsonb_build_object('state', 'failed', 'http_status', v_code, 'message', 'intervals.icu answered, but not with an athlete. Try again in a moment.');
    end if;
    return v_out;
  end if;

  if v_code in (401, 403) then
    v_msg := 'intervals.icu did not accept that key. Check it was copied in full, and generate a new one on the intervals.icu settings page if in doubt.';
    if v_stored then
      update public.intervals_connections
         set status = 'auth_failed', last_error = v_msg
       where user_id = v_uid;
    end if;
    return jsonb_build_object('state', 'failed', 'http_status', v_code, 'message', v_msg);
  end if;
  return jsonb_build_object(
    'state', 'failed',
    'http_status', v_code,
    'message', 'intervals.icu answered ' || coalesce(v_code::text, 'nothing') || '. Try again in a moment.');
end;
$$;

revoke all on function public.verify_intervals_key(text) from public, anon;
revoke all on function public.intervals_verify_status(bigint) from public, anon;
grant execute on function public.verify_intervals_key(text) to authenticated;
grant execute on function public.intervals_verify_status(bigint) to authenticated;
