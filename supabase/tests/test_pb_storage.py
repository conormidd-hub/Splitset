"""Database tests for build phase 3: the e1RM stored on saved sets, manual PBs, pb_history, the
backfill and the access rules around them.

Like the database half of test_seed_library.py, these run only when SPLITSET_TEST_DB_URL points at
a local database (the db-tests workflow starts one with every migration applied). Every number
comes from the app's own code through app/scripts/recovery-cli.ts, so they need Node 22.18+.
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

SUPABASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPABASE))
import backfill_e1rm as bf  # noqa: E402
import seed_library as sl  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
USER_P = UUID("00000000-0000-4000-a000-0000000000c1")   # logs F02, then estimates from it
USER_Q = UUID("00000000-0000-4000-a000-0000000000c2")   # manual PB only, in Melbourne
USER_R = UUID("00000000-0000-4000-a000-0000000000c3")   # sets saved before phase 3, for the backfill
NOW = datetime.now(timezone.utc)


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def insert(conn, table: str, row: dict) -> None:
    cols = list(row)
    conn.execute(f"insert into public.{table} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})",
                 [row[c] for c in cols])


def exercise(conn, slug: str) -> dict:
    cols = ", ".join(bf.EXERCISE_COLUMNS)
    return conn.execute(f"select {cols}, name from public.exercises where slug = %s", (slug,)).fetchone()


def all_exercises(conn) -> list[dict]:
    cols = ", ".join(bf.EXERCISE_COLUMNS)
    return conn.execute(f"select {cols}, name from public.exercises").fetchall()


def history_rows(conn, uid: UUID) -> list[dict]:
    return conn.execute(
        """select exercise_id, e1rm, at, source, weight_kg, reps, set_type, workout_id, manual_pb_id
             from public.pb_history where user_id = %s order by at""", (uid,)).fetchall()


def reference(conn, uid: UUID, slug: str, at: datetime) -> dict:
    """The PB screen's reference for one exercise, resolved by the app's code."""
    return bf.engine({"command": "reference", "exercises": all_exercises(conn), "rows": history_rows(conn, uid),
                      "exercise_id": exercise(conn, slug)["id"], "at": at.isoformat()})


def app_set(i: int, w: float | None, r: int | None, **kw) -> dict:
    """A set as the logger holds it (src/lib/lifting/setRow.ts SetRow)."""
    return {"id": str(uuid4()), "workoutExerciseId": "", "exerciseId": "", "position": i, "setType": "working",
            "weightKg": w, "reps": r, "rpe": None, "seconds": None, "side": None, "completed": True,
            "completedAt": NOW.isoformat(), "notes": None, "updatedAt": NOW.isoformat(), **kw}


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (USER_P, USER_Q, USER_R):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"phase3-{str(uid)[-2:]}@splitset.test"))
        c.commit()
        yield c


@pytest.fixture(scope="module")
def logged_f02(conn):
    """User P logs F02's two bench sets through the app's row builder, as themselves, and finishes."""
    bench = exercise(conn, "bench_press_bb")
    wid, weid = str(uuid4()), str(uuid4())
    sets = [app_set(0, 115, 3), app_set(1, 125, 1)]
    for s in sets:
        s.update(workoutExerciseId=weid, exerciseId=str(bench["id"]))
    rows = bf.engine({"command": "set-rows", "workout": {"id": wid, "userId": str(USER_P), "bodyweightKg": 80},
                      "exercise": bench, "sets": sets, "updated_at": NOW.isoformat()})
    try:
        as_user(conn, USER_P)
        insert(conn, "workouts", {"id": wid, "user_id": USER_P, "name": "Push", "started_at": NOW - timedelta(hours=1), "bodyweight_kg": 80})
        insert(conn, "workout_exercises", {"id": weid, "workout_id": wid, "user_id": USER_P, "exercise_id": bench["id"], "position": 0})
        for r in rows:
            insert(conn, "workout_sets", r)
        # updated_at = now(): the same instant the insert stamped, so the last-write-wins guard keeps it
        conn.execute("update public.workouts set finished_at = %s, updated_at = now() where id = %s", (NOW, wid))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"workout_id": wid, "set_ids": [s["id"] for s in sets], "bench": bench}


def test_db_logging_f02_stores_its_e1rms(conn, logged_f02):
    got = conn.execute("select id, e1rm from public.workout_sets where id = any(%s::uuid[]) order by position",
                       (logged_f02["set_ids"],)).fetchall()
    assert [round(r["e1rm"], 6) for r in got] == [126.5, 125.0]


def test_db_pb_history_and_lift_pbs_read_the_stored_e1rm(conn, logged_f02):
    rows = [r for r in history_rows(conn, USER_P) if r["exercise_id"] == logged_f02["bench"]["id"]]
    # both sets carry the workout's finish time, so their order is not fixed
    assert sorted((r["source"], round(r["e1rm"], 6)) for r in rows) == [("logged", 125.0), ("logged", 126.5)]
    finished = conn.execute("select finished_at from public.workouts where id = %s", (logged_f02["workout_id"],)).fetchone()["finished_at"]
    assert all(r["at"] == finished for r in rows)
    one_rm = conn.execute("select value from public.lift_pbs where user_id = %s and exercise_id = %s and metric = '1rm' and period = 'all'",
                          (USER_P, logged_f02["bench"]["id"])).fetchone()
    assert one_rm["value"] == pytest.approx(126.5)
    best = conn.execute("select best_e1rm_kg from public.exercise_records where user_id = %s and exercise_id = %s",
                        (USER_P, logged_f02["bench"]["id"])).fetchone()
    assert best["best_e1rm_kg"] == pytest.approx(126.5)


def test_db_f18_manual_pb_is_the_reference_the_next_day(conn):
    bench = exercise(conn, "bench_press_bb")
    e1rm = bf.engine({"command": "e1rm", "sets": [{"id": "m", "exercise": bench, "weight_kg": 130, "reps": 1, "rpe": None,
                                                    "workout_bodyweight": None}]})[0]["e1rm"]
    assert e1rm == 130
    try:
        as_user(conn, USER_Q)
        conn.execute("update public.profiles set timezone = 'Australia/Melbourne' where id = %s", (USER_Q,))
        insert(conn, "manual_pbs", {"user_id": USER_Q, "exercise_id": bench["id"], "weight_kg": 130, "reps": 1, "e1rm": e1rm,
                                    "dated_at": "2026-09-01"})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    rows = history_rows(conn, USER_Q)
    # the start of 1 September in Melbourne (UTC+10)
    assert [(r["source"], r["at"]) for r in rows] == [("manual", datetime(2026, 8, 31, 14, tzinfo=timezone.utc))]
    ref = reference(conn, USER_Q, "bench_press_bb", datetime(2026, 9, 2, tzinfo=timezone.utc))
    assert (ref["pb"], ref["source"], ref["detail"], ref["tone"]) == (130, "monthly", "manual", "manual")
    # an hour before local midnight it does not count yet
    early = reference(conn, USER_Q, "bench_press_bb", datetime(2026, 8, 31, 13, tzinfo=timezone.utc))
    assert early["tone"] == "calibrating"


def test_db_f14_never_logged_exercise_is_estimated_from_bench(conn, logged_f02):
    ref = reference(conn, USER_P, "incline_bench_db", NOW + timedelta(hours=1))
    assert ref["tone"] == "estimated"
    assert ref["label"] == "Estimated from Bench press (barbell)"
    assert ref["pb"] == pytest.approx(126.5 * 0.32 * 0.9)


def test_db_f17_no_history_and_no_estimate_link_is_calibrating(conn, logged_f02):
    ref = reference(conn, USER_P, "landmine_press", NOW + timedelta(hours=1))
    assert (ref["pb"], ref["tone"]) == (None, "calibrating")


def test_db_backfill_fills_old_sets_once(conn):
    bench, pull_up, plank = exercise(conn, "bench_press_bb"), exercise(conn, "pull_up"), exercise(conn, "plank")
    wid = uuid4()
    stamp = NOW - timedelta(days=3)
    # sets as an app from before phase 3 saved them: no e1rm, no workout bodyweight
    conn.execute("update public.profiles set bodyweight_kg = 80, bodyweight_updated_at = %s where id = %s", (NOW, USER_R))
    insert(conn, "workouts", {"id": wid, "user_id": USER_R, "name": "Old", "started_at": stamp, "finished_at": stamp, "updated_at": stamp})
    for i, (ex, w, r, secs) in enumerate([(bench, 100, 5, None), (pull_up, 10, 5, None), (plank, None, None, 60)]):
        weid = uuid4()
        insert(conn, "workout_exercises", {"id": weid, "workout_id": wid, "user_id": USER_R, "exercise_id": ex["id"], "position": i})
        insert(conn, "workout_sets", {"id": uuid4(), "workout_exercise_id": weid, "workout_id": wid, "exercise_id": ex["id"],
                                      "user_id": USER_R, "position": 0, "weight_kg": w, "reps": r, "seconds": secs,
                                      "completed": True, "completed_at": stamp, "updated_at": stamp})
    conn.commit()

    p = bf.plan(conn, USER_R)
    up = p.users[USER_R]
    assert (p.workouts, p.sets, up.without_e1rm, up.bodyweight["source"]) == (1, 2, 1, "profile")
    bf.apply(conn, p)
    conn.commit()

    got = {r["exercise_id"]: r for r in conn.execute(
        "select exercise_id, e1rm, updated_at from public.workout_sets where workout_id = %s", (wid,)).fetchall()}
    assert got[bench["id"]]["e1rm"] == pytest.approx(100 * (1 + 5 / 30))
    assert got[pull_up["id"]]["e1rm"] == pytest.approx(90 * (1 + 5 / 30))   # 80 kg body + 10 kg added
    assert got[plank["id"]]["e1rm"] is None
    assert all(r["updated_at"] == stamp for r in got.values())
    w = conn.execute("select bodyweight_kg, updated_at from public.workouts where id = %s", (wid,)).fetchone()
    assert (w["bodyweight_kg"], w["updated_at"]) == (80, stamp)
    assert bf.plan(conn, USER_R).users == {}   # a second run finds nothing


def test_db_access_rules(conn, logged_f02):
    bench = logged_f02["bench"]
    custom = uuid4()
    insert(conn, "exercises", {"id": custom, "owner_id": USER_P, "name": "P's own curl", "measure": "weight_reps"})
    conn.commit()
    try:
        as_user(conn, USER_Q)
        # history and manual PBs are private
        assert {r["user_id"] for r in conn.execute("select user_id from public.pb_history").fetchall()} <= {USER_Q}
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                insert(conn, "manual_pbs", {"user_id": USER_P, "exercise_id": bench["id"], "weight_kg": 100, "reps": 1, "e1rm": 100, "dated_at": "2026-09-01"})
        # only for exercises Q can see
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                insert(conn, "manual_pbs", {"user_id": USER_Q, "exercise_id": custom, "weight_kg": 20, "reps": 8, "e1rm": 25, "dated_at": "2026-09-01"})
        # bodyweight is the user's to change
        conn.execute("update public.profiles set bodyweight_kg = 81.5, bodyweight_updated_at = now() where id = %s", (USER_Q,))
        assert conn.execute("select bodyweight_kg from public.profiles where id = %s", (USER_Q,)).fetchone()["bodyweight_kg"] == 81.5
    finally:
        conn.rollback()


@pytest.mark.parametrize("column, value", [("rpe", 5.5), ("rpe", 7.25), ("rpe", 10.5), ("side", "up")])
def test_db_set_checks(conn, logged_f02, column, value):
    with pytest.raises(psycopg.errors.CheckViolation):
        with conn.transaction():
            conn.execute(f"update public.workout_sets set {column} = %s where id = %s", (value, logged_f02["set_ids"][0]))
    conn.rollback()
