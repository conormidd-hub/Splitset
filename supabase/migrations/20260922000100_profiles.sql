-- Splitset M0: profiles (one row per Supabase Auth user) and account lifecycle.
--
-- Conventions used by every later migration:
--   * every user-owned table carries user_id -> profiles(id) on delete cascade
--   * policies compare against (select auth.uid()) so the planner caches the call
--   * server-owned tables get select-only policies; the sync job connects as postgres

create extension if not exists moddatetime with schema extensions;

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  timezone     text not null default 'UTC',
  units        text not null default 'metric' check (units in ('metric', 'imperial')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. Created by the on_auth_user_created trigger, removed by cascade.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function extensions.moddatetime (updated_at);

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No insert or delete policies on purpose: rows come from the auth trigger below and
-- disappear when the auth user is deleted. Signed-in users may read their row and edit
-- only the three preference columns.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, timezone, units) on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, timezone)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'athlete'
    ),
    coalesce(nullif(new.raw_user_meta_data ->> 'timezone', ''), 'UTC')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The app cannot touch auth.users directly, so account deletion goes through this RPC.
-- Deleting the auth row cascades to profiles and from there to every user table.
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
