"""Postgres access for the sync job.

Connects as the project's `postgres` role over the Supabase session pooler, so it bypasses
row-level security and can read vault.decrypted_secrets. Every function takes an open
connection; callers own commits and rollbacks.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .normalise import ACTIVITY_COLUMNS
from .wellness import WELLNESS_COLUMNS


def connect(db_url: str) -> psycopg.Connection[Any]:
    return psycopg.connect(db_url, row_factory=dict_row, autocommit=False,
                           application_name="splitset-sync")


# ---------------------------------------------------------------- users and connections

def user_id_for_email(conn: psycopg.Connection[Any], email: str) -> UUID | None:
    row = conn.execute("select id from auth.users where lower(email) = lower(%s)", (email,)).fetchone()
    return row["id"] if row else None


def active_connections(conn: psycopg.Connection[Any], user_filter: str | None = None) -> list[dict[str, Any]]:
    """Active connections with their decrypted API keys. `user_filter` is a user id or email."""
    q = """
        select c.user_id, c.athlete_id, c.oldest_date, c.status, c.consecutive_auth_failures,
               s.decrypted_secret as api_key, u.email
          from public.intervals_connections c
          join auth.users u on u.id = c.user_id
          left join vault.decrypted_secrets s on s.id = c.api_key_secret_id
         where c.status = 'active'
    """
    params: list[Any] = []
    if user_filter:
        q += " and (c.user_id::text = %s or lower(u.email) = lower(%s))"
        params += [user_filter, user_filter]
    q += " order by c.created_at"
    return conn.execute(q, params).fetchall()


def admin_connect(conn: psycopg.Connection[Any], user_id: UUID, athlete_id: str, api_key: str,
                  oldest: date | None) -> None:
    """Same effect as the connect_intervals() RPC, run by an operator before the app exists."""
    row = conn.execute("select api_key_secret_id from public.intervals_connections where user_id = %s",
                       (user_id,)).fetchone()
    secret_id = row["api_key_secret_id"] if row else None
    if secret_id:
        conn.execute("select vault.update_secret(%s, %s)", (secret_id, api_key))
    else:
        secret_id = conn.execute(
            "select vault.create_secret(%s, %s, %s) as id",
            (api_key, f"intervals_api_key:{user_id}", "intervals.icu API key"),
        ).fetchone()["id"]
    conn.execute(
        """
        insert into public.intervals_connections (user_id, athlete_id, api_key_secret_id, oldest_date)
        values (%s, %s, %s, coalesce(%s, '2020-01-01'::date))
        on conflict (user_id) do update
          set athlete_id = excluded.athlete_id,
              api_key_secret_id = excluded.api_key_secret_id,
              oldest_date = coalesce(%s, public.intervals_connections.oldest_date),
              status = 'active', consecutive_auth_failures = 0, last_error = null
        """,
        (user_id, athlete_id, secret_id, oldest, oldest),
    )


def record_success(conn: psycopg.Connection[Any], user_id: UUID) -> None:
    conn.execute(
        """
        update public.intervals_connections
           set last_synced_at = now(), last_success_at = now(),
               last_error = null, consecutive_auth_failures = 0
         where user_id = %s
        """,
        (user_id,),
    )


def record_error(conn: psycopg.Connection[Any], user_id: UUID, message: str) -> None:
    conn.execute(
        "update public.intervals_connections set last_synced_at = now(), last_error = %s where user_id = %s",
        (message[:1000], user_id),
    )


def record_auth_failure(conn: psycopg.Connection[Any], user_id: UUID, message: str, max_failures: int) -> int:
    """Increment the failure counter; flip status to auth_failed at the limit. Returns the new count."""
    row = conn.execute(
        """
        update public.intervals_connections
           set consecutive_auth_failures = consecutive_auth_failures + 1,
               last_synced_at = now(),
               last_error = %s,
               status = case when consecutive_auth_failures + 1 >= %s then 'auth_failed' else status end
         where user_id = %s
        returning consecutive_auth_failures
        """,
        (message[:1000], max_failures, user_id),
    ).fetchone()
    return int(row["consecutive_auth_failures"]) if row else 0


# ---------------------------------------------------------------- activities

_ACT_COLS = ["id", "user_id", *ACTIVITY_COLUMNS, "raw"]

_ACT_UPSERT = sql.SQL(
    "insert into public.activities ({cols}) values ({vals}) "
    "on conflict (id) do update set {updates}, synced_at = now()"
).format(
    cols=sql.SQL(", ").join(sql.Identifier(c) for c in _ACT_COLS),
    vals=sql.SQL(", ").join(sql.SQL("%s::jsonb") if c == "raw" else sql.SQL("%s") for c in _ACT_COLS),
    updates=sql.SQL(", ").join(
        sql.SQL("{c} = excluded.{c}").format(c=sql.Identifier(c)) for c in _ACT_COLS if c != "id"
    ),
)


def latest_activity_start(conn: psycopg.Connection[Any], user_id: UUID) -> datetime | None:
    row = conn.execute("select max(start_time) as latest from public.activities where user_id = %s",
                       (user_id,)).fetchone()
    return row["latest"] if row else None


def upsert_activities(conn: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(_ACT_UPSERT, [tuple(r.get(c) for c in _ACT_COLS) for r in rows])
    return len(rows)


def activities_needing_details(conn: psycopg.Connection[Any], user_id: UUID, limit: int) -> list[str]:
    rows = conn.execute(
        """
        select a.id
          from public.activities a
          left join public.activity_details d on d.activity_id = a.id
         where a.user_id = %s and d.activity_id is null and coalesce(a.distance_m, 0) >= 500
         order by a.start_time desc
         limit %s
        """,
        (user_id, limit),
    ).fetchall()
    return [r["id"] for r in rows]


def count_pending_details(conn: psycopg.Connection[Any], user_id: UUID) -> int:
    row = conn.execute(
        """
        select count(*) as n
          from public.activities a
          left join public.activity_details d on d.activity_id = a.id
         where a.user_id = %s and d.activity_id is null and coalesce(a.distance_m, 0) >= 500
        """,
        (user_id,),
    ).fetchone()
    return int(row["n"]) if row else 0


def upsert_details(conn: psycopg.Connection[Any], user_id: UUID, rec: dict[str, Any]) -> None:
    conn.execute(
        """
        insert into public.activity_details
            (activity_id, user_id, has_streams, splits, best_efforts, polyline, bbox, samples, fetched_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, now())
        on conflict (activity_id) do update
          set has_streams = excluded.has_streams, splits = excluded.splits,
              best_efforts = excluded.best_efforts, polyline = excluded.polyline,
              bbox = excluded.bbox, samples = excluded.samples, fetched_at = now()
        """,
        (
            rec["activity_id"], user_id, bool(rec["has_streams"]),
            Jsonb(rec["splits"]) if rec.get("splits") is not None else None,
            Jsonb(rec["best_efforts"]) if rec.get("best_efforts") is not None else None,
            rec.get("polyline"),
            rec.get("bbox"),
            Jsonb(rec["samples"]) if rec.get("samples") is not None else None,
        ),
    )


# ---------------------------------------------------------------- wellness

_WELL_COLS = ["user_id", "date", *WELLNESS_COLUMNS, "source", "raw"]

_WELL_UPSERT = sql.SQL(
    "insert into public.wellness ({cols}) values ({vals}) "
    "on conflict (user_id, date) do update set {updates}, source = 'intervals', raw = excluded.raw"
).format(
    cols=sql.SQL(", ").join(sql.Identifier(c) for c in _WELL_COLS),
    vals=sql.SQL(", ").join(sql.SQL("%s::jsonb") if c == "raw" else sql.SQL("%s") for c in _WELL_COLS),
    updates=sql.SQL(", ").join(
        sql.SQL("{c} = coalesce(excluded.{c}, public.wellness.{c})").format(c=sql.Identifier(c))
        for c in WELLNESS_COLUMNS
    ),
)


def upsert_wellness(conn: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(_WELL_UPSERT, [tuple(r.get(c) for c in _WELL_COLS) for r in rows])
    return len(rows)


# ---------------------------------------------------------------- sync runs

def start_sync_run(conn: psycopg.Connection[Any], user_id: UUID, triggered_by: str,
                   github_run_id: str | None, window_oldest: str, window_newest: str) -> int:
    row = conn.execute(
        """
        insert into public.sync_runs (user_id, triggered_by, github_run_id, window_oldest, window_newest)
        values (%s, %s, %s, %s, %s)
        returning id
        """,
        (user_id, triggered_by, github_run_id, window_oldest, window_newest),
    ).fetchone()
    return int(row["id"])


def finish_sync_run(conn: psycopg.Connection[Any], run_id: int, status: str,
                    counts: dict[str, int], error: str | None = None) -> None:
    conn.execute(
        """
        update public.sync_runs
           set finished_at = now(), status = %s, error = %s,
               activities_fetched = %s, activities_upserted = %s,
               streams_fetched = %s, streams_pending = %s,
               wellness_days = %s, plan_links = %s
         where id = %s
        """,
        (
            status, error,
            counts.get("activities_fetched", 0), counts.get("activities_upserted", 0),
            counts.get("streams_fetched", 0), counts.get("streams_pending", 0),
            counts.get("wellness_days", 0), counts.get("plan_links", 0),
            run_id,
        ),
    )
