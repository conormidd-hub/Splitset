"""Database tests for the review fix 20261019000200_side_set_counts.sql: a unilateral exercise
logged one side per set (workout_sets.side) counts the same sets and volume as logged both sides
at once, in workout_summaries and exercise_records (spec §4.4 counts each side set as half).

Like the other database tests, these run only when SPLITSET_TEST_DB_URL points at a local
database (the db-tests workflow).
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

SUPABASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPABASE))
import seed_library as sl  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_SIDES = UUID("00000000-0000-4000-a000-0000000000b7")
T0 = datetime(2026, 10, 12, 7, tzinfo=timezone.utc)


def log_workout(conn, start: datetime, exercise_id, sides: list[str | None]) -> str:
    """A finished workout of 20 kg × 10 sets, one per entry in `sides` (None: both sides at once)."""
    wid, weid = str(uuid4()), str(uuid4())
    conn.execute("insert into public.workouts (id, user_id, name, started_at, finished_at) values (%s, %s, 'Legs', %s, %s)",
                 (wid, U_SIDES, start, start + timedelta(hours=1)))
    conn.execute("insert into public.workout_exercises (id, workout_id, user_id, exercise_id, position) values (%s, %s, %s, %s, 0)",
                 (weid, wid, U_SIDES, exercise_id))
    for i, side in enumerate(sides):
        conn.execute("""insert into public.workout_sets (workout_exercise_id, workout_id, exercise_id, user_id, position,
                                                         weight_kg, reps, side, completed, completed_at)
                        values (%s, %s, %s, %s, %s, 20, 10, %s, true, %s)""",
                     (weid, wid, exercise_id, U_SIDES, i, side, start + timedelta(minutes=i)))
    return wid


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                  "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', 'sides-b7@splitset.test') "
                  "on conflict (id) do nothing", (U_SIDES,))
        c.commit()
        yield c


@pytest.fixture(scope="module")
def logged(conn):
    ex = conn.execute("select id from public.exercises where slug = 'bulgarian_split_squat'").fetchone()["id"]
    conn.execute("delete from public.workouts where user_id = %s", (U_SIDES,))   # re-runnable on the same database
    both = log_workout(conn, T0, ex, [None, None, None])
    per_side = log_workout(conn, T0 + timedelta(days=2), ex, ["left", "right"] * 3)
    odd = log_workout(conn, T0 + timedelta(days=4), ex, ["left"])
    conn.commit()
    return {"exercise_id": ex, "both": both, "per_side": per_side, "odd": odd}


def summary(conn, wid: str) -> dict:
    return conn.execute("select sets_completed, volume_kg from public.workout_summaries where id = %s", (wid,)).fetchone()


def test_db_per_side_sets_count_as_many_sets_and_volume_as_both_sides(conn, logged):
    assert summary(conn, logged["both"]) == {"sets_completed": 3, "volume_kg": pytest.approx(600)}
    assert summary(conn, logged["per_side"]) == {"sets_completed": 3, "volume_kg": pytest.approx(600)}


def test_db_an_unpaired_side_set_rounds_up_to_one_set(conn, logged):
    assert summary(conn, logged["odd"]) == {"sets_completed": 1, "volume_kg": pytest.approx(100)}


def test_db_exercise_records_pairs_side_sets(conn, logged):
    rec = conn.execute("select completed_sets, best_set_volume_kg from public.exercise_records where user_id = %s and exercise_id = %s",
                       (U_SIDES, logged["exercise_id"])).fetchone()
    assert rec["completed_sets"] == 3 + 3 + 1
    assert rec["best_set_volume_kg"] == pytest.approx(200)     # one set's weight × reps, as before
