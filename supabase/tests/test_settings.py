"""Database tests for build phase 9: settings are per-user user_thresholds rows, written by the
user, applied by the app's loader, and a rescore (the recompute rule) brings the cache into line:
base_recovery_hours.default = 72 makes F20's chest R 89.6 h for that user only, a reset brings
back 59.7, and a row the loader can't use is ignored rather than breaking anything.

Like the other database tests, these run only when SPLITSET_TEST_DB_URL points at a local
database (the db-tests workflow), and every number comes from the app's engine.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

SUPABASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPABASE))
import rescore_workouts as rw  # noqa: E402
import seed_f26  # noqa: E402
import seed_library as sl  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_TUNED = UUID("00000000-0000-4000-a000-0000000000e9")
U_PLAIN = UUID("00000000-0000-4000-a000-0000000000ea")
HOUR0 = datetime(2026, 10, 5, tzinfo=timezone.utc)


def at(h: float) -> datetime:
    return HOUR0 + timedelta(hours=h)


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def set_override(conn, uid: UUID, key: str, value) -> None:
    """What the settings screen's Save does: upsert the row as the user."""
    try:
        as_user(conn, uid)
        conn.execute("""insert into public.user_thresholds (user_id, key, value) values (%s, %s, %s)
                        on conflict (user_id, key) do update set value = excluded.value, updated_at = now()""",
                     (uid, key, Jsonb(value)))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def reset(conn, uid: UUID, key: str) -> None:
    try:
        as_user(conn, uid)
        conn.execute("delete from public.user_thresholds where user_id = %s and key = %s", (uid, key))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def chest_r(conn, wid: str) -> float:
    return conn.execute("select recovery_hours from public.workout_muscle_loads where workout_id = %s and muscle_id = 'chest'",
                        (wid,)).fetchone()["recovery_hours"]


def rescore(conn, uid: UUID) -> None:
    rw.rescore(conn, uid)
    conn.commit()


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (U_TUNED, U_PLAIN):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"phase9-{str(uid)[-2:]}@splitset.test"))
        c.commit()
        yield c


@pytest.fixture(scope="module")
def push_days(conn):
    """F20's push day, with its PBs a week before, logged by both users."""
    f20 = seed_f26.fixture("F20")
    pbs = {h["slug"]: h["e1rm"] for h in f20["inputs"]["history"]}
    ids = {}
    for uid in (U_TUNED, U_PLAIN):
        ex = seed_f26.exercise_rows(conn, set(pbs) | {slug for slug, _ in f20["inputs"]["exercises"]})
        seed_f26.insert_workout(conn, uid, "PBs", at(-169), at(-168), [(s, [{"w": v, "r": 1}]) for s, v in pbs.items()], ex, None)
        ids[uid] = seed_f26.insert_workout(conn, uid, "Push", at(-1), at(0), f20["inputs"]["exercises"], ex, None)
        conn.commit()
        rescore(conn, uid)
    return ids


def test_db_an_override_changes_only_that_users_cache(conn, push_days):
    assert chest_r(conn, push_days[U_TUNED]) == pytest.approx(59.71, abs=0.01)
    set_override(conn, U_TUNED, "base_recovery_hours.default", 72)
    rescore(conn, U_TUNED)
    rescore(conn, U_PLAIN)
    assert chest_r(conn, push_days[U_TUNED]) == pytest.approx(89.57, abs=0.01)
    assert chest_r(conn, push_days[U_PLAIN]) == pytest.approx(59.71, abs=0.01)


def test_db_a_reset_restores_the_default(conn, push_days):
    set_override(conn, U_TUNED, "base_recovery_hours.default", 72)
    rescore(conn, U_TUNED)
    reset(conn, U_TUNED, "base_recovery_hours.default")
    rescore(conn, U_TUNED)
    assert chest_r(conn, push_days[U_TUNED]) == pytest.approx(59.71, abs=0.01)


def test_db_a_row_the_loader_cannot_use_is_ignored(conn, push_days):
    set_override(conn, U_TUNED, "levels.9.min", 3)            # no such level
    set_override(conn, U_TUNED, "role_weights.secondary", "lots")   # wrong type
    rescore(conn, U_TUNED)
    assert chest_r(conn, push_days[U_TUNED]) == pytest.approx(59.71, abs=0.01)
    reset(conn, U_TUNED, "levels.9.min")
    reset(conn, U_TUNED, "role_weights.secondary")


def test_db_settings_are_owner_only(conn, push_days):
    set_override(conn, U_TUNED, "recovery.slope", 0.5)
    try:
        as_user(conn, U_PLAIN)
        assert conn.execute("select count(*) as n from public.user_thresholds where user_id = %s", (U_TUNED,)).fetchone()["n"] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("insert into public.user_thresholds (user_id, key, value) values (%s, 'recovery.slope', '0.9')", (U_TUNED,))
    finally:
        conn.rollback()
    assert conn.execute("select value from public.user_thresholds where user_id = %s and key = 'recovery.slope'",
                        (U_TUNED,)).fetchone()["value"] == 0.5
    reset(conn, U_TUNED, "recovery.slope")
