"""Database tests for build phase 5: the read side. The F26 week is logged the way the app logs it
(each set built by the logger's own row builder and saved as the user, each workout finished
through finish_workout() with the engine's scores), then read back through recovery_loads() as
that user, with recovery_map, session_map and recovery_history worked out by the app's code.

Like the other database tests, these run only when SPLITSET_TEST_DB_URL points at a local
database (the db-tests workflow), and every number comes from the app's engine through
app/scripts/recovery-cli.ts.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

SUPABASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPABASE))
import rescore_workouts as rw  # noqa: E402
import seed_f26  # noqa: E402
import seed_library as sl  # noqa: E402
from backfill_e1rm import EXERCISE_COLUMNS, engine  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_READ = UUID("00000000-0000-4000-a000-0000000000e1")
U_OTHER = UUID("00000000-0000-4000-a000-0000000000e2")
HOUR0 = datetime(2026, 10, 5, tzinfo=timezone.utc)   # a Monday: fixture hour 0
SPAN_H = 144 + 168                                   # lookback_hours() + the weekly window, with the defaults
CONSTANTS = json.loads((SUPABASE.parent / "data" / "recovery_constants.json").read_text(encoding="utf-8"))


def at(h: float) -> datetime:
    return HOUR0 + timedelta(hours=h)


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def insert(conn, table: str, row: dict) -> None:
    cols = list(row)
    conn.execute(f"insert into public.{table} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})", [row[c] for c in cols])


def log_workout(conn, uid: UUID, name: str, start: float, end: float, exercises) -> str:
    """One workout as the app logs it: the workout and its blocks saved as the user, each set built
    by the logger's row builder (set-rows), then Finish: score it with t_w = end and call
    finish_workout(), as finishWorkoutRemote does."""
    ex = seed_f26.exercise_rows(conn, {slug for slug, _ in exercises})
    wid, now = str(uuid4()), at(end).isoformat()
    blocks = []
    for i, (slug, sets) in enumerate(exercises):
        weid = str(uuid4())
        app_sets = [{"id": str(uuid4()), "workoutExerciseId": weid, "exerciseId": str(ex[slug]["id"]), "position": j,
                     "setType": "warmup" if s.get("warmup") else "working", "weightKg": s.get("w"), "reps": s.get("r"),
                     "rpe": s.get("rpe"), "seconds": s.get("seconds"), "side": s.get("side"), "completed": True,
                     "completedAt": now, "notes": None, "updatedAt": now} for j, s in enumerate(sets)]
        rows = engine({"command": "set-rows", "workout": {"id": wid, "userId": str(uid), "bodyweightKg": None},
                       "exercise": ex[slug], "sets": app_sets, "updated_at": now})
        blocks.append(({"id": weid, "workout_id": wid, "user_id": uid, "exercise_id": ex[slug]["id"], "position": i}, rows))
    try:
        as_user(conn, uid)
        insert(conn, "workouts", {"id": wid, "user_id": uid, "name": name, "started_at": at(start)})
        for block, rows in blocks:
            insert(conn, "workout_exercises", block)
            for r in rows:
                insert(conn, "workout_sets", r)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    [loads] = rw.score(conn, uid, workout_ids=[wid], finished_at={wid: at(end)})
    try:
        as_user(conn, uid)
        conn.execute("select public.finish_workout(%s, %s, %s)",
                     (wid, at(end), Jsonb({"muscles": loads["muscles"], "exercises": loads["exercises"]})))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return wid


def recovery_loads(conn, uid: UUID, start: datetime, end: datetime | None) -> dict:
    """recovery_loads() called as the user, exactly as the app calls it."""
    try:
        as_user(conn, uid)
        return conn.execute("select public.recovery_loads(%s, %s) as r", (start, end)).fetchone()["r"]
    finally:
        conn.rollback()


def library(conn) -> dict:
    cols = ", ".join(EXERCISE_COLUMNS)
    return {"exercises": conn.execute(f"select {cols} from public.exercises").fetchall(),
            "muscles": conn.execute("select exercise_id, muscle_id, role from public.exercise_muscles").fetchall()}


def recovery_map(conn, uid: UUID, h: float) -> dict:
    """recovery_map(user, at): the window (at − lookback − 168 h, at] read as the user, then the app's code."""
    loads = recovery_loads(conn, uid, at(h - SPAN_H), at(h))
    return engine({"command": "recovery-map", **library(conn), "loads": loads, "at": at(h).isoformat()})


def level_for(x: float) -> int:
    return max(lvl["level"] for lvl in CONSTANTS["levels"] if x >= lvl["min"])


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (U_READ, U_OTHER):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"phase5-{str(uid)[-2:]}@splitset.test"))
        c.commit()
        yield c


@pytest.fixture(scope="module")
def f26_week(conn):
    """F26 logged through the app's path: its PBs as singles a week before Monday, then Push, Pull
    and Legs at the fixture's hours, each finished in turn."""
    f26 = seed_f26.fixture("F26")
    [pb_hour] = {p["at"] for p in f26["inputs"]["history"]}
    log_workout(conn, U_READ, seed_f26.PB_WORKOUT, pb_hour - 1, pb_hour,
                [(p["slug"], [{"w": p["e1rm"], "r": 1}]) for p in f26["inputs"]["history"]])
    ids = {name: log_workout(conn, U_READ, name, w["start"], w["end"], w["exercises"])
           for name, w in zip(seed_f26.NAMES, f26["inputs"]["workouts"])}
    return {"expect": f26["expect"], "ids": ids}


def test_db_recovery_map_at_wednesday_20(conn, f26_week):
    m = recovery_map(conn, U_READ, 68)
    assert m["hamstrings"]["label"] == "Very high"
    assert {k: m[k]["label"] for k in ("quads", "glutes", "biceps", "traps")} == dict.fromkeys(("quads", "glutes", "biceps", "traps"), "High")
    for muscle, want in f26_week["expect"].items():
        assert m[muscle]["level"] == want["level"][0], muscle
        if "F" in want:
            assert m[muscle]["F"] == pytest.approx(want["F"][0], abs=0.01), muscle


def test_db_contributing_lists_add_up_to_w(conn, f26_week):
    m = recovery_map(conn, U_READ, 68)
    for muscle, state in m.items():
        loads = [x["load"] for x in state["contributing"]]
        assert loads == sorted(loads, reverse=True), muscle
        assert sum(loads) == pytest.approx(state["W"], abs=1e-9), muscle
    top = m["hamstrings"]["contributing"][0]
    assert (top["exercise"], top["role"], top["pb_source"], top["workout_id"]) == (
        "Romanian deadlift (barbell)", "primary", "monthly", f26_week["ids"]["Legs"])
    assert datetime.fromisoformat(top["workout_date"]) == at(66)
    # the PBs workout, a week before Monday, is outside the week
    assert all(x["workout_date"] and datetime.fromisoformat(x["workout_date"]) > at(0) for s in m.values() for x in s["contributing"])


def test_db_a_past_moment_reads_as_it_was(conn, f26_week):
    before_legs = recovery_map(conn, U_READ, 65.5)   # Wednesday 17:30; Legs finished at 18:00
    assert before_legs["hamstrings"]["level"] < 4
    assert f26_week["ids"]["Legs"] not in {x["workout_id"] for s in before_legs.values() for x in s["contributing"]}
    monday = recovery_map(conn, U_READ, 0)
    assert all(s["level"] == 0 and s["ready_in_h"] == 0 and not s["contributing"] for s in monday.values())


def test_db_recovery_history_over_7_days_has_7_samples(conn, f26_week):
    loads = recovery_loads(conn, U_READ, at(68 - 168 - SPAN_H), at(68))
    samples = engine({"command": "recovery-history", **library(conn), "loads": loads,
                      "from": at(68 - 168).isoformat(), "to": at(68).isoformat()})
    assert len(samples) == 7
    assert [datetime.fromisoformat(s["at"].replace("Z", "+00:00")) for s in samples] == [at(68 - d) for d in (144, 120, 96, 72, 48, 24, 0)]
    assert samples[-1]["map"] == recovery_map(conn, U_READ, 68)


def test_db_session_map_of_legs(conn, f26_week):
    legs = f26_week["ids"]["Legs"]
    try:
        as_user(conn, U_READ)
        rows = conn.execute("select muscle_id, load, recovery_hours from public.workout_muscle_loads where workout_id = %s", (legs,)).fetchall()
    finally:
        conn.rollback()
    session = engine({"command": "session-map", "rows": rows})
    assert {r["muscle_id"] for r in rows} == {k for k, v in session.items() if v["L"] > 0}
    for r in rows:
        s = session[r["muscle_id"]]
        assert (s["L"], s["R"], s["level"]) == (r["load"], r["recovery_hours"], level_for(r["load"]))
        assert s["ready_after_h"] == pytest.approx(r["recovery_hours"] * max(0, 1 - 0.25 / r["load"]))
    assert session["chest"]["L"] == 0 and session["chest"]["label"] == "Ready"


def test_db_recovery_loads_window_bounds(conn, f26_week):
    legs = f26_week["ids"]["Legs"]
    after = recovery_loads(conn, U_READ, at(66), None)       # (Legs' finish, ∞): Legs is not after itself
    upto = recovery_loads(conn, U_READ, at(65), at(66))      # (…, Legs' finish]: it is in
    assert not after["muscles"] and not after["exercises"]
    assert {r["workout_id"] for r in upto["muscles"]} == {legs}
    assert {r["workout_id"] for r in upto["exercises"]} == {legs}
    assert all(r["name"] for r in upto["exercises"])


def test_db_recovery_loads_is_owner_only(conn, f26_week):
    assert recovery_loads(conn, U_OTHER, at(-1000), None) == {"muscles": [], "exercises": [], "activities": []}   # phase 10 adds activities
    try:
        conn.execute("set local role anon")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select public.recovery_loads(now() - interval '1 day')")
    finally:
        conn.rollback()


def test_db_finishing_a_workout_changes_the_map(conn, f26_week):
    """Build phase 5's "done when": the map is a read over the cache, so the next read after a
    Finish includes it; nothing has to restart or be cleared. Deleting it takes it out again."""
    before = recovery_map(conn, U_READ, 68)
    wid = log_workout(conn, U_READ, "Curls", 66.5, 67, [("bb_curl", [{"w": 30, "r": 10}, {"w": 30, "r": 10}])])
    after = recovery_map(conn, U_READ, 68)
    assert after["biceps"]["F"] > before["biceps"]["F"]
    assert wid in {x["workout_id"] for x in after["biceps"]["contributing"]}
    assert after["quads"] == before["quads"]
    try:
        as_user(conn, U_READ)
        conn.execute("delete from public.workouts where id = %s", (wid,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    assert recovery_map(conn, U_READ, 68) == before
