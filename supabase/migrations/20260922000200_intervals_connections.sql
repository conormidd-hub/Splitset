-- Splitset M1: one intervals.icu connection per user.
--
-- The API key never sits in a table column. It lives in Supabase Vault (encrypted at rest,
-- not exposed through PostgREST) and the row only holds the vault secret id. The app writes
-- and clears keys through the two security-definer RPCs below; the sync job, connecting as
-- postgres over the pooler, reads them via vault.decrypted_secrets.

create extension if not exists supabase_vault;

create table public.intervals_connections (
  user_id                   uuid primary key references public.profiles (id) on delete cascade,
  athlete_id                text not null,                       -- always stored with its leading 'i'
  api_key_secret_id         uuid,                                -- vault.secrets.id; null once disconnected
  status                    text not null default 'active'
                            check (status in ('active', 'paused', 'auth_failed', 'disconnected')),
  oldest_date               date not null default '2020-01-01',  -- where the first backfill starts
  last_synced_at            timestamptz,
  last_success_at           timestamptz,
  last_error                text,
  consecutive_auth_failures int  not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.intervals_connections is
  'intervals.icu credentials per user. api_key_secret_id points at Supabase Vault; use connect_intervals()/disconnect_intervals().';

create trigger intervals_connections_set_updated_at
  before update on public.intervals_connections
  for each row execute function extensions.moddatetime (updated_at);

alter table public.intervals_connections enable row level security;

create policy ic_select_own on public.intervals_connections
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy ic_update_own on public.intervals_connections
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The app may only pause/resume and move the backfill start directly. Everything else is
-- written by the RPCs or by the sync job.
revoke all on public.intervals_connections from anon, authenticated;
grant select on public.intervals_connections to authenticated;
grant update (status, oldest_date) on public.intervals_connections to authenticated;

-- ---------------------------------------------------------------- RPCs

create or replace function public.connect_intervals(
  p_athlete_id text,
  p_api_key    text,
  p_oldest     date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_aid  text := trim(p_athlete_id);
  v_id   uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_aid is null or v_aid = '' then
    raise exception 'athlete id is required';
  end if;
  if p_api_key is null or length(trim(p_api_key)) < 8 then
    raise exception 'API key looks wrong';
  end if;
  if left(v_aid, 1) <> 'i' then
    v_aid := 'i' || v_aid;
  end if;

  select api_key_secret_id into v_id
    from public.intervals_connections
   where user_id = v_uid;

  if v_id is not null then
    perform vault.update_secret(v_id, trim(p_api_key));
  else
    v_id := vault.create_secret(trim(p_api_key), 'intervals_api_key:' || v_uid::text, 'intervals.icu API key');
  end if;

  insert into public.intervals_connections (user_id, athlete_id, api_key_secret_id, oldest_date)
  values (v_uid, v_aid, v_id, coalesce(p_oldest, '2020-01-01'))
  on conflict (user_id) do update
    set athlete_id                = excluded.athlete_id,
        api_key_secret_id         = excluded.api_key_secret_id,
        oldest_date               = coalesce(p_oldest, public.intervals_connections.oldest_date),
        status                    = 'active',
        consecutive_auth_failures = 0,
        last_error                = null;
end;
$$;

create or replace function public.disconnect_intervals()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select api_key_secret_id into v_id
    from public.intervals_connections
   where user_id = v_uid;
  if v_id is not null then
    delete from vault.secrets where id = v_id;
  end if;
  update public.intervals_connections
     set status = 'disconnected', api_key_secret_id = null
   where user_id = v_uid;
end;
$$;

revoke all on function public.connect_intervals(text, text, date) from public, anon;
revoke all on function public.disconnect_intervals() from public, anon;
grant execute on function public.connect_intervals(text, text, date) to authenticated;
grant execute on function public.disconnect_intervals() to authenticated;

-- Deleting the account cascades here; take the vault secret with it.
create or replace function public.intervals_connections_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.api_key_secret_id is not null then
    delete from vault.secrets where id = old.api_key_secret_id;
  end if;
  return old;
end;
$$;

create trigger intervals_connections_before_delete
  before delete on public.intervals_connections
  for each row execute function public.intervals_connections_drop_secret();
