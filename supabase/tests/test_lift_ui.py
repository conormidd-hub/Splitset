"""Database tests for 20261019000300_lift_ui.sql: routine groups, exercise-wide notes and the
rest-timer settings on profiles, each owner-only.

Like the other database tests, these run only when SPLITSET_TEST_DB_URL points at a local
database (the db-tests workflow).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row

SUPABASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPABASE))
import seed_library as sl  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_ME = UUID("00000000-0000-4000-a000-0000000000b8")
U_OTHER = UUID("00000000-0000-4000-a000-0000000000b9")


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (U_ME, U_OTHER):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"liftui-{str(uid)[-2:]}@splitset.test"))
        c.commit()
        yield c


def test_db_groups_hold_routines_and_deleting_one_keeps_them(conn):
    try:
        as_user(conn, U_ME)
        gid = conn.execute("insert into public.routine_groups (user_id, name, position) values (%s, 'PPL', 0) returning id", (U_ME,)).fetchone()["id"]
        rid = conn.execute("insert into public.routines (user_id, name, group_id) values (%s, 'Push', %s) returning id", (U_ME, gid)).fetchone()["id"]
        conn.execute("delete from public.routine_groups where id = %s", (gid,))
        r = conn.execute("select group_id from public.routines where id = %s", (rid,)).fetchone()
    finally:
        conn.rollback()
    assert r == {"group_id": None}          # back under "My routines"


def test_db_groups_and_notes_are_owner_only(conn):
    bench = conn.execute("select id from public.exercises where slug = 'bench_press_bb'").fetchone()["id"]
    try:
        as_user(conn, U_ME)
        conn.execute("insert into public.routine_groups (user_id, name) values (%s, 'Mine')", (U_ME,))
        conn.execute("insert into public.exercise_notes (user_id, exercise_id, note) values (%s, %s, 'Elbows tucked')", (U_ME, bench))
        conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(U_OTHER), "role": "authenticated"}),))
        seen = (conn.execute("select count(*) as n from public.routine_groups").fetchone()["n"],
                conn.execute("select count(*) as n from public.exercise_notes").fetchone()["n"])
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("insert into public.exercise_notes (user_id, exercise_id, note) values (%s, %s, 'not yours')", (U_ME, bench))
    finally:
        conn.rollback()
    assert seen == (0, 0)


def test_db_rest_settings_default_off_90_and_stay_in_range(conn):
    try:
        as_user(conn, U_ME)
        row = conn.execute("select rest_timer_on, rest_seconds from public.profiles where id = %s", (U_ME,)).fetchone()
        conn.execute("update public.profiles set rest_timer_on = true, rest_seconds = 120 where id = %s", (U_ME,))
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("update public.profiles set rest_seconds = 5 where id = %s", (U_ME,))
    finally:
        conn.rollback()
    assert row == {"rest_timer_on": False, "rest_seconds": 90}
