"""Database tests for build phase 10: imported activities saved to workout_muscle_loads with
source = 'activity' through save_activity_loads() as their owner, read back by recovery_loads()
with their names for the tap detail, cleared when cardio is off, and refused for anyone else.
Every number comes from the app's engine (app/scripts/recovery-cli.ts `score-activities`).

Like the other database tests, these run only when SPLITSET_TEST_DB_URL points at a local
database (the db-tests workflow).
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
import seed_library as sl  # noqa: E402
from backfill_e1rm import EXERCISE_COLUMNS, engine  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_RUNNER = UUID("00000000-0000-4000-a000-0000000000a7")
U_OTHER = UUID("00000000-0000-4000-a000-0000000000a8")
START = datetime(2026, 10, 18, 6, tzinfo=timezone.utc)
ACTIVITY_COLUMNS = "id, type, name, start_time, moving_time_s, elapsed_time_s, hr_zone_times"


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def add_activity(conn, uid: UUID, aid: str, type_: str, name: str, start: datetime, minutes: int, zones: list[int] | None) -> None:
    """An activities row as the sync job writes it (the app can't write activities)."""
    conn.execute("""insert into public.activities (id, user_id, start_time, start_time_local, type, name, moving_time_s, elapsed_time_s,
                                                   hr_zone_times, raw)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, '{}'::jsonb) on conflict (id) do nothing""",
                 (aid, uid, start, start.replace(tzinfo=None), type_, name, minutes * 60, minutes * 60, zones))


def scored(conn, uid: UUID, ids: list[str], thresholds: list[dict] | None = None) -> list[dict]:
    acts = conn.execute(f"select {ACTIVITY_COLUMNS} from public.activities where id = any(%s) order by start_time", (ids,)).fetchall()
    req = {"command": "score-activities", "activities": acts}
    if thresholds is not None:
        req |= {"user_id": str(uid), "thresholds_rows": thresholds}
    return engine(req)


def save(conn, uid: UUID, loads: list[dict]) -> None:
    try:
        as_user(conn, uid)
        conn.execute("select public.save_activity_loads(%s)", (Jsonb(loads),))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def rows(conn, aid: str) -> dict[str, dict]:
    return {r["muscle_id"]: r for r in conn.execute(
        "select muscle_id, load, recovery_hours, finished_at, source, workout_id from public.workout_muscle_loads where activity_id = %s",
        (aid,)).fetchall()}


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (U_RUNNER, U_OTHER):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"phase10-{str(uid)[-2:]}@splitset.test"))
        # a 90-minute run with 60 minutes in zones 3+; an easy ride with no heart rate three days before,
        # its fatigue worn off by then (quads R about 37 h), so the run stands alone at t = 0; and a walk
        add_activity(c, U_RUNNER, "t10-run", "Run", "Long run", START, 90, [600, 1200, 1800, 1200, 600, 0, 0])
        add_activity(c, U_RUNNER, "t10-ride", "Ride", "Coffee ride", START - timedelta(days=3), 60, None)
        add_activity(c, U_RUNNER, "t10-walk", "Walk", "Evening walk", START - timedelta(hours=10), 45, None)
        c.commit()
        yield c


@pytest.fixture(scope="module")
def saved(conn):
    loads = scored(conn, U_RUNNER, ["t10-run", "t10-ride", "t10-walk"])
    save(conn, U_RUNNER, loads)
    return loads


def test_db_the_long_run_is_saved_as_activity_rows(conn, saved):
    assert [x["activity_id"] for x in saved] == ["t10-ride", "t10-run"]     # the walk doesn't count
    run = rows(conn, "t10-run")
    assert {m: round(r["load"], 2) for m, r in run.items()} == {"quads": 2.25, "calves": 2.25, "hamstrings": 0.9, "glutes": 0.9, "adductors": 0.45}
    assert all(r["source"] == "activity" and r["workout_id"] is None for r in run.values())
    assert all(r["finished_at"] == START + timedelta(minutes=90) for r in run.values())
    ride = rows(conn, "t10-ride")
    assert ride["quads"]["load"] == pytest.approx(6 * 0.5 * 0.30)              # 60 easy minutes, no heart rate
    assert rows(conn, "t10-walk") == {}


def test_db_the_recovery_map_names_the_run(conn, saved):
    end = START + timedelta(minutes=90)
    try:
        as_user(conn, U_RUNNER)
        loads = conn.execute("select public.recovery_loads(%s, %s) as r", (end - timedelta(hours=312), end)).fetchone()["r"]
    finally:
        conn.rollback()
    assert {a["activity_id"]: a["name"] for a in loads["activities"]} == {"t10-run": "Long run", "t10-ride": "Coffee ride"}
    cols = ", ".join(EXERCISE_COLUMNS)
    m = engine({"command": "recovery-map", "exercises": conn.execute(f"select {cols} from public.exercises").fetchall(),
                "muscles": conn.execute("select exercise_id, muscle_id, role from public.exercise_muscles").fetchall(),
                "loads": loads, "at": end.isoformat()})
    assert m["quads"]["label"] == "High"
    top = m["quads"]["contributing"][0]
    assert (top["exercise"], top["role"], round(top["load"], 2)) == ("Long run", "primary", 2.25)
    assert sum(x["load"] for x in m["quads"]["contributing"]) == pytest.approx(m["quads"]["W"])


def test_db_saving_again_replaces_rather_than_adds(conn, saved):
    save(conn, U_RUNNER, scored(conn, U_RUNNER, ["t10-run"]))
    assert len(rows(conn, "t10-run")) == 5


def test_db_another_user_cannot_save_my_activity(conn, saved):
    with pytest.raises(psycopg.errors.RaiseException, match="not found"):
        save(conn, U_OTHER, [{"activity_id": "t10-run", "muscles": []}])
    assert len(rows(conn, "t10-run")) == 5


def test_db_cardio_off_scores_nothing_and_clears(conn, saved):
    assert scored(conn, U_RUNNER, ["t10-run"], [{"user_id": str(U_RUNNER), "key": "cardio.enabled_default", "value": False}]) == []
    try:
        as_user(conn, U_OTHER)
        conn.execute("select public.clear_activity_loads()")    # only ever the caller's own rows
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    assert len(rows(conn, "t10-run")) == 5
    try:
        as_user(conn, U_RUNNER)
        n = conn.execute("select public.clear_activity_loads() as n").fetchone()["n"]
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    assert n == 5 + 4 and rows(conn, "t10-run") == {} and rows(conn, "t10-ride") == {}   # run: 5 muscles; ride: 4
