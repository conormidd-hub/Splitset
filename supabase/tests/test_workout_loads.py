"""Database tests for build phase 4: the per-workout cache that finish_workout() and
save_workout_loads() write, the recompute rule, the access rules, and the F26 seed. Also the
rollout: workouts logged by the main-branch app (no e1RMs, no bodyweight snapshot, no cache),
scored by the deploy's backfill-then-rescore or by the backfill run by hand.

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
from backfill_e1rm import backfill, engine  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_F20 = UUID("00000000-0000-4000-a000-0000000000d1")
U_F28 = UUID("00000000-0000-4000-a000-0000000000d2")
U_EDIT = UUID("00000000-0000-4000-a000-0000000000d3")
U_SEED = UUID("00000000-0000-4000-a000-0000000000d4")
U_OTHER = UUID("00000000-0000-4000-a000-0000000000d5")
U_OLD = UUID("00000000-0000-4000-a000-0000000000d6")     # logged by the main-branch app, then deployed
U_HAND = UUID("00000000-0000-4000-a000-0000000000d7")    # the same, rescored first, then backfilled by hand
U_MOVED = UUID("00000000-0000-4000-a000-0000000000d8")   # a finish time moved after caching
HOUR0 = datetime(2026, 10, 5, tzinfo=timezone.utc)   # a Monday: fixture hour 0
OLD_APP_LIFTS = [("bench_press_bb", 100, 5), ("pull_up", 10, 5)]   # (slug, kg, reps); pull-up kg is added load


def at(h: float) -> datetime:
    return HOUR0 + timedelta(hours=h)


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def pbs_workout(conn, uid: UUID, pbs: dict[str, float]) -> None:
    """A finished workout of singles at each PB, a week before hour 0: the fixtures' H(PBS)."""
    ex = seed_f26.exercise_rows(conn, set(pbs))
    seed_f26.insert_workout(conn, uid, "PBs", at(-169), at(-168), [(slug, [{"w": v, "r": 1}]) for slug, v in pbs.items()], ex, None)


def workout(conn, uid: UUID, name: str, start: float, end: float | None, exercises) -> str:
    ex = seed_f26.exercise_rows(conn, {slug for slug, _ in exercises})
    return seed_f26.insert_workout(conn, uid, name, at(start), at(end) if end is not None else None, exercises, ex, None)


def finish_as_user(conn, uid: UUID, wid: str, finished: datetime) -> None:
    """What the app does at Finish: score the workout with t_w = finished, then finish_workout()."""
    [loads] = rw.score(conn, uid, workout_ids=[wid], finished_at={wid: finished})
    try:
        as_user(conn, uid)
        conn.execute("select public.finish_workout(%s, %s, %s)",
                     (wid, finished, Jsonb({"muscles": loads["muscles"], "exercises": loads["exercises"]})))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def old_app_workout(conn, uid: UUID, name: str, start: float, end: float, lifts) -> str:
    """A workout as the main-branch app logs it: sets saved without an e1RM, no bodyweight
    snapshot, and finished by a plain update of finished_at, so no cache rows either."""
    ex = seed_f26.exercise_rows(conn, {slug for slug, _, _ in lifts})
    wid = str(uuid4())
    conn.execute("insert into public.workouts (id, user_id, name, started_at) values (%s, %s, %s, %s)", (wid, uid, name, at(start)))
    for i, (slug, kg, reps) in enumerate(lifts):
        weid = str(uuid4())
        conn.execute("insert into public.workout_exercises (id, workout_id, user_id, exercise_id, position) values (%s, %s, %s, %s, %s)",
                     (weid, wid, uid, ex[slug]["id"], i))
        conn.execute("""insert into public.workout_sets (id, workout_exercise_id, workout_id, exercise_id, user_id, position,
                                                         weight_kg, reps, completed, completed_at)
                        values (%s, %s, %s, %s, %s, 0, %s, %s, true, %s)""",
                     (str(uuid4()), weid, wid, ex[slug]["id"], uid, kg, reps, at(end)))
    # updated_at = now(): the same instant the insert stamped, so the last-write-wins guard keeps it
    conn.execute("update public.workouts set finished_at = %s, updated_at = now() where id = %s", (at(end), wid))
    return wid


def muscle_rows(conn, wid: str) -> dict[str, dict]:
    return {r["muscle_id"]: r for r in conn.execute(
        "select muscle_id, load, recovery_hours, finished_at, source from public.workout_muscle_loads where workout_id = %s", (wid,)).fetchall()}


def exercise_rows(conn, wid: str) -> dict[str, dict]:
    return {r["slug"]: r for r in conn.execute(
        """select e.slug, l.load, l.pb_source, l.pb_detail, l.pb_value from public.workout_exercise_loads l
             join public.exercises e on e.id = l.exercise_id where l.workout_id = %s""", (wid,)).fetchall()}


def fx(fid: str) -> dict:
    return seed_f26.fixture(fid)


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (U_F20, U_F28, U_EDIT, U_SEED, U_OTHER, U_OLD, U_HAND, U_MOVED):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"phase4-{str(uid)[-2:]}@splitset.test"))
        c.commit()
        yield c


@pytest.fixture(scope="module")
def push_day(conn):
    """F20: the push day, finished through finish_workout() as its user, PBs a week before."""
    f20 = fx("F20")
    pbs_workout(conn, U_F20, {h["slug"]: h["e1rm"] for h in f20["inputs"]["history"]})
    wid = workout(conn, U_F20, "Push", -1, None, f20["inputs"]["exercises"])
    conn.commit()
    finish_as_user(conn, U_F20, wid, at(0))
    return wid


def test_db_finishing_f20_caches_its_muscle_loads(conn, push_day):
    expect = fx("F20")["expect"]
    rows = muscle_rows(conn, push_day)
    assert set(rows) == set(expect["L_m"])            # zeros elsewhere: no row
    for m, want in expect["L_m"].items():
        assert rows[m]["load"] == pytest.approx(want, abs=0.01), m
    for m, want in expect["R"].items():
        assert rows[m]["recovery_hours"] == pytest.approx(want, abs=0.01), m
    assert all(r["finished_at"] == at(0) and r["source"] == "lift" for r in rows.values())
    assert conn.execute("select finished_at from public.workouts where id = %s", (push_day,)).fetchone()["finished_at"] == at(0)


def test_db_finishing_f20_caches_its_exercise_loads(conn, push_day):
    rows = exercise_rows(conn, push_day)
    for slug, want in fx("F20")["expect"]["L_e"].items():
        assert rows[slug]["load"] == pytest.approx(want, abs=0.01), slug
    lateral = rows["lateral_raise_db"]
    assert (lateral["pb_source"], lateral["pb_detail"], lateral["pb_value"]) == ("monthly", "logged", 13)


def test_db_f28_caches_bench_in_two_blocks_as_one_row(conn):
    f28 = fx("F28")
    pbs_workout(conn, U_F28, {h["slug"]: h["e1rm"] for h in f28["inputs"]["history"]})
    wid = workout(conn, U_F28, "Two blocks", -1, None, f28["inputs"]["exercises"])
    conn.commit()
    finish_as_user(conn, U_F28, wid, at(0))
    rows = exercise_rows(conn, wid)
    assert rows["bench_press_bb"]["load"] == pytest.approx(0.6181, abs=0.01)
    assert conn.execute("select count(*) as n from public.workout_exercise_loads l join public.exercises e on e.id = l.exercise_id "
                        "where l.workout_id = %s and e.slug = 'bench_press_bb'", (wid,)).fetchone()["n"] == 1


def test_db_editing_monday_rescores_tuesday(conn):
    mon = workout(conn, U_EDIT, "Monday", 17, 18, [("bench_press_bb", [{"w": 100, "r": 5}, {"w": 100, "r": 5}])])
    tue = workout(conn, U_EDIT, "Tuesday", 41, 42, [("bb_curl", [{"w": 30, "r": 10}, {"w": 30, "r": 10}])])
    first = rw.rescore(conn, U_EDIT)
    conn.commit()
    assert first.workouts == 2
    before_biceps = muscle_rows(conn, tue)["biceps"]["load"]
    curl = exercise_rows(conn, tue)["bb_curl"]
    assert (curl["pb_source"], curl["pb_detail"]) == ("estimated", "bench_press_bb")
    assert curl["pb_value"] == pytest.approx(100 * (1 + 5 / 30) * 0.85 * 0.45 * 0.9)

    # edit Monday's sets as the logger would save them: new weight, new e1RM
    bench = seed_f26.exercise_rows(conn, {"bench_press_bb"})["bench_press_bb"]
    [new] = engine({"command": "e1rm", "sets": [{"id": "x", "exercise": bench, "weight_kg": 120, "reps": 5, "rpe": None, "workout_bodyweight": None}]})
    conn.execute("update public.workout_sets set weight_kg = 120, e1rm = %s, updated_at = now() where workout_id = %s", (new["e1rm"], mon))
    second = rw.rescore(conn, U_EDIT, at(17))   # the recompute rule: from Monday on
    conn.commit()
    assert second.changed >= 1
    assert exercise_rows(conn, tue)["bb_curl"]["pb_value"] == pytest.approx(120 * (1 + 5 / 30) * 0.85 * 0.45 * 0.9)
    assert muscle_rows(conn, tue)["biceps"]["load"] < before_biceps   # a higher reference makes the same curls lighter


def test_db_rescoring_again_changes_nothing(conn, push_day):
    last_id = lambda: conn.execute("select coalesce(max(id), 0) as m from public.workout_muscle_loads").fetchone()["m"]  # noqa: E731
    rw.rescore(conn)
    conn.commit()
    before = last_id()
    again = rw.rescore(conn)
    conn.commit()
    assert again.workouts > 0 and again.changed == 0
    assert last_id() == before   # nothing was deleted and written again


def test_db_a_moved_finish_is_rewritten(conn):
    """The cache's t_w follows the workout's finished_at even when the loads come out the same."""
    wid = workout(conn, U_MOVED, "Moved", 17, 18, [("bench_press_bb", [{"w": 100, "r": 5}])])
    rw.rescore(conn, U_MOVED)
    conn.execute("update public.workouts set finished_at = %s, updated_at = now() where id = %s", (at(19), wid))
    conn.commit()
    report = rw.rescore(conn, U_MOVED)
    conn.commit()
    assert report.changed == 1
    assert {r["finished_at"] for r in muscle_rows(conn, wid).values()} == {at(19)}


def test_db_workouts_the_old_app_logged_are_scored_by_the_deploy(conn):
    """Rollout: workouts the main-branch app logged reach `rescore_workouts.py --fill`, run by hand
    after the merge (catch_up: the e1RM backfill, then the rescore), with no e1RMs, no bodyweight
    snapshot and no cache rows. After it Tuesday's bench is referenced to Monday's sets, and the pull-ups are
    weighed at the profile's 80 kg rather than the 75 kg fallback."""
    conn.execute("update public.profiles set bodyweight_kg = 80, bodyweight_updated_at = now() where id = %s", (U_OLD,))
    mon = old_app_workout(conn, U_OLD, "Monday", 17, 18, OLD_APP_LIFTS)
    tue = old_app_workout(conn, U_OLD, "Tuesday", 41, 42, OLD_APP_LIFTS)
    conn.commit()
    assert muscle_rows(conn, mon) == {} and muscle_rows(conn, tue) == {}

    filled, report = rw.catch_up(conn, U_OLD)
    conn.commit()
    assert (filled.workouts, filled.sets, filled.rescored, filled.changed) == (2, 4, 2, 2)
    assert (report.workouts, report.changed) == (2, 0)   # the backfill already rescored them
    assert {r["bodyweight_kg"] for r in conn.execute("select bodyweight_kg from public.workouts where user_id = %s",
                                                     (U_OLD,)).fetchall()} == {80}
    bench, pull_up = exercise_rows(conn, tue)["bench_press_bb"], exercise_rows(conn, tue)["pull_up"]
    assert (bench["pb_source"], bench["pb_detail"]) == ("monthly", "logged")
    assert bench["pb_value"] == pytest.approx(100 * (1 + 5 / 30))
    assert bench["load"] == pytest.approx(0.35, abs=0.01)
    assert (pull_up["pb_source"], pull_up["pb_detail"]) == ("monthly", "logged")
    assert pull_up["pb_value"] == pytest.approx(90 * (1 + 5 / 30))   # 80 kg body + 10 kg added; 75 kg would give 99.17
    assert muscle_rows(conn, mon) and muscle_rows(conn, tue)

    # the next deploy finds nothing to fill and nothing to rewrite
    filled, report = rw.catch_up(conn, U_OLD)
    conn.commit()
    assert (filled.users, report.workouts, report.changed) == ({}, 2, 0)


def test_db_the_backfill_by_hand_rescores_what_it_fills(conn):
    """Merge day the other way round: the rescore ran before the e1RMs were filled, so Tuesday's
    bench was cached as calibrating. Running backfill_e1rm.py by hand brings the cache into line."""
    conn.execute("update public.profiles set bodyweight_kg = 80, bodyweight_updated_at = now() where id = %s", (U_HAND,))
    old_app_workout(conn, U_HAND, "Monday", 17, 18, OLD_APP_LIFTS)
    tue = old_app_workout(conn, U_HAND, "Tuesday", 41, 42, OLD_APP_LIFTS)
    conn.commit()
    rw.rescore(conn, U_HAND)
    conn.commit()
    assert exercise_rows(conn, tue)["bench_press_bb"]["pb_source"] == "calibration"

    filled = backfill(conn, U_HAND)
    conn.commit()
    assert filled.rescored == 2 and filled.changed >= 1
    bench, pull_up = exercise_rows(conn, tue)["bench_press_bb"], exercise_rows(conn, tue)["pull_up"]
    assert (bench["pb_source"], bench["pb_detail"]) == ("monthly", "logged")
    assert bench["pb_value"] == pytest.approx(100 * (1 + 5 / 30))
    assert pull_up["pb_value"] == pytest.approx(90 * (1 + 5 / 30))
    assert backfill(conn, U_HAND).users == {}   # a second run finds nothing


def test_db_cache_access_rules(conn, push_day):
    try:
        as_user(conn, U_OTHER)
        assert conn.execute("select count(*) as n from public.workout_muscle_loads").fetchone()["n"] == 0
        assert conn.execute("select count(*) as n from public.workout_exercise_loads").fetchone()["n"] == 0
        with pytest.raises(psycopg.errors.RaiseException, match="not found"):
            with conn.transaction():
                conn.execute("select public.save_workout_loads(%s)", (Jsonb([{"workout_id": push_day, "muscles": [], "exercises": []}]),))
        with pytest.raises(psycopg.errors.RaiseException, match="not found"):
            with conn.transaction():
                conn.execute("select public.finish_workout(%s, now(), %s)", (push_day, Jsonb({"muscles": [], "exercises": []})))
    finally:
        conn.rollback()
    assert len(muscle_rows(conn, push_day)) == 5   # untouched


def test_db_a_row_is_a_workout_or_an_activity(conn, push_day):
    with pytest.raises(psycopg.errors.CheckViolation):
        with conn.transaction():
            conn.execute("""insert into public.workout_muscle_loads (user_id, source, muscle_id, load, recovery_hours, finished_at)
                            values (%s, 'activity', 'quads', 1, 30, now())""", (U_F20,))
    with pytest.raises(psycopg.errors.CheckViolation):
        with conn.transaction():
            conn.execute("""insert into public.workout_muscle_loads (user_id, workout_id, source, muscle_id, load, recovery_hours, finished_at)
                            values (%s, %s, 'activity', 'quads', 1, 30, now())""", (U_F20, push_day))
    conn.rollback()


def test_db_unfinished_workouts_are_not_cached(conn):
    wid = workout(conn, U_OTHER, "Open", -1, None, [("bench_press_bb", [{"w": 60, "r": 5}])])
    conn.commit()
    with pytest.raises(psycopg.errors.RaiseException, match="not finished"):
        with conn.transaction():
            conn.execute("select public.save_workout_loads(%s)", (Jsonb([{"workout_id": wid, "muscles": [], "exercises": []}]),))
    conn.rollback()


def test_db_seed_f26_reproduces_the_fixture(conn):
    now = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)
    mismatches = seed_f26.seed(conn, U_SEED, now)
    conn.commit()
    assert mismatches == []
    names = [r["name"] for r in conn.execute("select name from public.workouts where user_id = %s order by finished_at", (U_SEED,)).fetchall()]
    assert names == [seed_f26.PB_WORKOUT, "Push", "Pull", "Legs"]
    legs = conn.execute("select finished_at from public.workouts where user_id = %s and name = 'Legs'", (U_SEED,)).fetchone()["finished_at"]
    assert legs == now - timedelta(hours=2)
    # seeding again replaces the week rather than adding to it
    assert seed_f26.seed(conn, U_SEED, now) == []
    conn.commit()
    assert conn.execute("select count(*) as n from public.workouts where user_id = %s", (U_SEED,)).fetchone()["n"] == 4
