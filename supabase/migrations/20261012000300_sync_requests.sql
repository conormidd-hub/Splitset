-- Splitset: start the sync job from the app. "Sync now" runs a full sync for the athlete who
-- asked; a plan change sends their planned runs to intervals.icu (and so the watch) straight away.
--
-- The sync job runs on GitHub Actions, so a request is a workflow_dispatch of sync.yml with the
-- athlete's id. The call goes out from the database with pg_net, using a GitHub token kept in
-- Vault next to the intervals.icu keys: nothing in the app can read it. Set it up once, in the
-- SQL editor, with a fine-grained token that has Actions read and write on this repository:
--
--     select vault.create_secret('<github token>', 'github_dispatch_token');
--     select vault.create_secret('<owner>/<repo>', 'github_dispatch_repo');
--     select vault.create_secret('main', 'github_dispatch_ref');         -- optional, default main

create extension if not exists pg_net;

-- one row per request that went out: the throttle reads it, and it ties a request to pg_net's answer
create table public.sync_requests (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  kind           text not null check (kind in ('sync', 'push')),
  requested_at   timestamptz not null default now(),
  net_request_id bigint
);

create index sync_requests_user_kind_idx on public.sync_requests (user_id, kind, requested_at desc);

alter table public.sync_requests enable row level security;

create policy sync_requests_select_own on public.sync_requests
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.sync_requests from anon, authenticated;
grant select on public.sync_requests to authenticated;

-- Returns {"status": ...}: sent (with "request", the id to ask sync_request_status about),
-- too_soon, off (push asked for with "Planned runs on your watch" off), not_configured, or the
-- connection's status when it can't sync (paused, auth_failed, disconnected, not_connected).
create or replace function public.request_sync(p_kind text default 'sync')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_status text;
  v_push   boolean;
  v_last   timestamptz;
  v_token  text;
  v_repo   text;
  v_ref    text;
  v_net    bigint;
  v_id     bigint;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('sync', 'push') then
    raise exception 'unknown sync kind %', p_kind;
  end if;

  select status, push_plan into v_status, v_push
    from public.intervals_connections
   where user_id = v_uid;
  if v_status is null then
    return jsonb_build_object('status', 'not_connected');
  end if;
  if v_status <> 'active' then
    return jsonb_build_object('status', v_status);
  end if;
  if p_kind = 'push' and not v_push then
    return jsonb_build_object('status', 'off');
  end if;

  -- a run per athlete per few seconds for pushes (GitHub folds queued ones together anyway),
  -- a full sync every two minutes, and a ceiling for everyone together
  select max(requested_at) into v_last
    from public.sync_requests
   where user_id = v_uid and kind = p_kind;
  if v_last > now() - (case p_kind when 'push' then interval '5 seconds' else interval '2 minutes' end) then
    return jsonb_build_object('status', 'too_soon');
  end if;
  if (select count(*) from public.sync_requests where requested_at > now() - interval '1 hour') >= 200 then
    return jsonb_build_object('status', 'too_soon');
  end if;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'github_dispatch_token';
  select decrypted_secret into v_repo  from vault.decrypted_secrets where name = 'github_dispatch_repo';
  select decrypted_secret into v_ref   from vault.decrypted_secrets where name = 'github_dispatch_ref';
  if v_token is null or v_repo is null then
    return jsonb_build_object('status', 'not_configured');
  end if;

  v_net := net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/sync.yml/dispatches', v_repo),
    body    := jsonb_build_object(
                 'ref', coalesce(nullif(v_ref, ''), 'main'),
                 'inputs', jsonb_build_object('user', v_uid::text, 'mode', p_kind)),
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_token,
                 'Accept', 'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent', 'splitset',
                 'Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  );
  insert into public.sync_requests (user_id, kind, net_request_id)
  values (v_uid, p_kind, v_net)
  returning id into v_id;
  return jsonb_build_object('status', 'sent', 'request', v_id);
end;
$$;

-- What GitHub said to a request: {"state": "pending"} until pg_net has the answer, then
-- {"state": "ok"} (204) or {"state": "failed", "http_status": 401, "message": "Bad credentials"}.
create or replace function public.sync_request_status(p_request bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_net  bigint;
  v_code int;
  v_body text;
  v_err  text;
begin
  select net_request_id into v_net
    from public.sync_requests
   where id = p_request and user_id = auth.uid();
  if v_net is null then
    return jsonb_build_object('state', 'unknown');
  end if;
  select status_code, content, error_msg into v_code, v_body, v_err
    from net._http_response
   where id = v_net;
  if not found then
    return jsonb_build_object('state', 'pending');
  end if;
  if v_code between 200 and 299 then
    return jsonb_build_object('state', 'ok');
  end if;
  -- GitHub explains itself in {"message": ...}; anything else is passed on as it came
  begin
    v_body := coalesce(v_body::jsonb ->> 'message', v_body);
  exception when others then
    null;
  end;
  return jsonb_build_object(
    'state', 'failed',
    'http_status', v_code,
    'message', coalesce(left(v_err, 200), left(v_body, 200)));
end;
$$;

revoke all on function public.request_sync(text) from public, anon;
revoke all on function public.sync_request_status(bigint) from public, anon;
grant execute on function public.request_sync(text) to authenticated;
grant execute on function public.sync_request_status(bigint) to authenticated;
