-- Splitset: send planned runs to the watch through intervals.icu.
--
-- intervals.icu holds the Garmin connection, so a planned workout on its calendar shows up in
-- Garmin Connect and on the watch. The sync job writes the plan's upcoming runs there as
-- events and keeps each event's id and a hash of what it sent on the session
-- (plan_sessions.external_event_id / external_hash, reserved for this in the plan migration).
-- A session moved in the app is updated in place; one skipped or deleted is removed.

-- Opt in per athlete: writing to someone's training calendar is not a default.
alter table public.intervals_connections
  add column push_plan boolean not null default false;

comment on column public.intervals_connections.push_plan is
  'Send the plan''s runs for the next two weeks to intervals.icu (and so Garmin) at each sync.';

grant update (push_plan) on public.intervals_connections to authenticated;

alter table public.sync_runs
  add column plan_pushed integer not null default 0;

-- A deleted session takes its event id with it, so remember it for the next sync to remove.
-- Server-only (RLS on, no policies). No foreign key on user_id: these rows are also written
-- while an account is being deleted, and the sync job clears any whose connection is gone.
create table public.plan_event_deletions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  event_id   text not null,
  created_at timestamptz not null default now()
);

alter table public.plan_event_deletions enable row level security;
revoke all on public.plan_event_deletions from anon, authenticated;

create or replace function public.plan_sessions_track_event_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.external_event_id is not null then
    insert into public.plan_event_deletions (user_id, event_id) values (old.user_id, old.external_event_id);
  end if;
  return old;
end;
$$;

create trigger plan_sessions_after_delete
  after delete on public.plan_sessions
  for each row execute function public.plan_sessions_track_event_delete();
