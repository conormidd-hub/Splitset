"""Database tests for build phase 8: custom exercises saved through create_custom_exercise() and
update_custom_exercise() as the signed-in user, with every payload built by the app's own code
(the New exercise screen's toPayload, through app/scripts/recovery-cli.ts `custom-payload`; for an
edit of an older exercise, starting from the screen's draftOf).

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
import rescore_workouts as rw  # noqa: E402
import seed_f26  # noqa: E402
import seed_library as sl  # noqa: E402
from backfill_e1rm import EXERCISE_COLUMNS, engine  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
U_MAKER = UUID("00000000-0000-4000-a000-0000000000f1")
U_OTHER = UUID("00000000-0000-4000-a000-0000000000f2")
NOW = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)
TODAY = "2026-10-18"


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def library_row(conn, slug: str) -> tuple[dict, list[dict]]:
    cols = ", ".join(EXERCISE_COLUMNS)
    row = conn.execute(f"select {cols}, name, equipment from public.exercises where slug = %s", (slug,)).fetchone()
    roles = conn.execute("select muscle_id, role from public.exercise_muscles where exercise_id = %s", (row["id"],)).fetchall()
    return row, roles


def payload(conn, slug: str, draft: dict, similar: str | None = None) -> dict:
    """What the New exercise screen saves, built by the app's code."""
    req = {"command": "custom-payload", "draft": draft, "slug": slug, "today": TODAY}
    if similar:
        row, roles = library_row(conn, similar)
        req["similar"] = {"row": row, "roles": roles}
    return engine(req)


def create(conn, uid: UUID, p: dict) -> str:
    try:
        as_user(conn, uid)
        new_id = conn.execute("select public.create_custom_exercise(%s) as id", (Jsonb(p),)).fetchone()["id"]
        conn.commit()
        return str(new_id)
    except Exception:
        conn.rollback()
        raise


def update(conn, uid: UUID, exercise_id: str, p: dict) -> None:
    try:
        as_user(conn, uid)
        conn.execute("select public.update_custom_exercise(%s, %s)", (exercise_id, Jsonb(p)))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def has_pb_history(conn, exercise_id) -> bool:
    """What Edit reads before drafting an older bodyweight exercise (draftOf's `scored`): whether
    any set or known best of it stored an e1RM."""
    return conn.execute("select exists (select 1 from public.pb_history where exercise_id = %s) as found",
                        (exercise_id,)).fetchone()["found"]


def roles_of(conn, exercise_id: str) -> dict[str, str]:
    return {r["muscle_id"]: r["role"] for r in conn.execute(
        "select muscle_id, role from public.exercise_muscles where exercise_id = %s", (exercise_id,)).fetchall()}


@pytest.fixture(scope="module")
def conn():
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    with psycopg.connect(url, row_factory=dict_row) as c:
        sl.seed(c, sl.load_json(sl.LIBRARY_PATH), sl.load_json(sl.CONSTANTS_PATH))
        for uid in (U_MAKER, U_OTHER):
            c.execute("insert into auth.users (instance_id, id, aud, role, email) "
                      "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                      "on conflict (id) do nothing", (uid, f"phase8-{str(uid)[-2:]}@splitset.test"))
        # a bench PB of 120 a week ago, so estimates have an anchor
        ex = seed_f26.exercise_rows(c, {"bench_press_bb"})
        seed_f26.insert_workout(c, U_MAKER, "Bench single", NOW - timedelta(days=7, hours=1), NOW - timedelta(days=7),
                                [("bench_press_bb", [{"w": 120, "r": 1}])], ex, None)
        c.commit()
        yield c


@pytest.fixture(scope="module")
def incline_smith(conn):
    """'Incline Smith press', started from incline_bench_bb, saved as the user."""
    p = payload(conn, "custom_inclinesmith1", {"name": "Incline Smith press"}, similar="incline_bench_bb")
    return create(conn, U_MAKER, p)


def test_db_create_copies_the_similar_exercise(conn, incline_smith):
    row = conn.execute("select owner_id, slug, \"group\", measure, load_mode, fatigue, pb_estimate_from, pb_estimate_ratio, load_split "
                       "from public.exercises where id = %s", (incline_smith,)).fetchone()
    assert row["owner_id"] == U_MAKER and row["slug"] == "custom_inclinesmith1"
    assert (row["group"], row["measure"], row["load_mode"], row["fatigue"]) == ("Chest", "weight_reps", "weight", "standard")
    assert (row["pb_estimate_from"], row["pb_estimate_ratio"]) == ("incline_bench_bb", 1.0)
    assert row["load_split"] == {"chest": 56, "front_delts": 22, "triceps": 22}
    assert roles_of(conn, incline_smith) == {"chest": "primary", "front_delts": "secondary", "triceps": "secondary"}


def test_db_its_pb_is_estimated_through_the_similar_exercise(conn, incline_smith):
    cols = ", ".join(EXERCISE_COLUMNS)
    exercises = conn.execute(f"select {cols}, name from public.exercises where owner_id is null or owner_id = %s", (U_MAKER,)).fetchall()
    rows = conn.execute("""select exercise_id, e1rm, at, source, weight_kg, reps, set_type, workout_id, manual_pb_id
                             from public.pb_history where user_id = %s""", (U_MAKER,)).fetchall()
    ref = engine({"command": "reference", "exercises": exercises, "rows": rows, "exercise_id": incline_smith, "at": NOW.isoformat()})
    assert ref["pb"] == pytest.approx(120 * 0.8 * 1.0 * 0.9)
    assert (ref["source"], ref["detail"]) == ("estimated", "bench_press_bb")
    assert ref["label"] == "Estimated from Bench press (barbell)"


def test_db_a_known_best_is_saved_with_it(conn):
    p = payload(conn, "custom_cablepress1", {"name": "Cable press", "choice": "cable", "equipment": "cable", "fatigue": "low",
                                             "roles": {"chest": "primary"}, "best": {"weightKg": 100, "reps": 5}})
    new_id = create(conn, U_MAKER, p)
    pb = conn.execute("select weight_kg, reps, e1rm, dated_at from public.manual_pbs where exercise_id = %s", (new_id,)).fetchone()
    assert (pb["weight_kg"], pb["reps"], str(pb["dated_at"])) == (100, 5, TODAY)
    assert pb["e1rm"] == pytest.approx(100 * (1 + 5 / 30))


def test_db_no_primary_is_refused(conn):
    p = payload(conn, "custom_noprimary1", {"name": "Mystery", "roles": {"chest": "primary"}})
    p["muscles"] = [{"muscle_id": "chest", "role": "secondary"}]
    with pytest.raises(psycopg.errors.RaiseException, match="primary"):
        create(conn, U_MAKER, p)
    assert conn.execute("select count(*) as n from public.exercises where slug = 'custom_noprimary1'").fetchone()["n"] == 0


def test_db_a_library_slug_cannot_be_claimed(conn):
    p = payload(conn, "bench_press_bb", {"name": "My bench", "roles": {"chest": "primary"}})
    with pytest.raises((psycopg.errors.CheckViolation, psycopg.errors.UniqueViolation)):
        create(conn, U_MAKER, p)


def test_db_another_user_can_neither_see_nor_edit_it(conn, incline_smith):
    try:
        as_user(conn, U_OTHER)
        assert conn.execute("select count(*) as n from public.exercises where id = %s", (incline_smith,)).fetchone()["n"] == 0
        assert conn.execute("select count(*) as n from public.exercise_muscles where exercise_id = %s", (incline_smith,)).fetchone()["n"] == 0
    finally:
        conn.rollback()
    p = payload(conn, "custom_inclinesmith1", {"name": "Hijacked", "roles": {"quads": "primary"}})
    with pytest.raises(psycopg.errors.RaiseException, match="not found"):
        update(conn, U_OTHER, incline_smith, p)
    assert roles_of(conn, incline_smith)["chest"] == "primary"


def test_db_editing_muscles_rescores_its_workouts(conn):
    p = payload(conn, "custom_hackpress1", {"name": "Hack press", "choice": "machine", "equipment": "machine", "fatigue": "low",
                                            "roles": {"chest": "primary"}})
    new_id = create(conn, U_MAKER, p)
    ex = seed_f26.exercise_rows(conn, {"custom_hackpress1"})
    wid = seed_f26.insert_workout(conn, U_MAKER, "Hack day", NOW - timedelta(hours=3), NOW - timedelta(hours=2),
                                  [("custom_hackpress1", [{"w": 60, "r": 10}, {"w": 60, "r": 10}])], ex, None)
    rw.rescore(conn, U_MAKER)
    conn.commit()
    before = {r["muscle_id"] for r in conn.execute("select muscle_id from public.workout_muscle_loads where workout_id = %s", (wid,)).fetchall()}
    assert before == {"chest"}

    edited = payload(conn, "custom_hackpress1", {"name": "Hack press", "choice": "machine", "equipment": "machine", "fatigue": "low",
                                                 "roles": {"quads": "primary", "chest": "tertiary"}})
    update(conn, U_MAKER, new_id, edited)
    assert roles_of(conn, new_id) == {"quads": "primary", "chest": "tertiary"}
    assert conn.execute("select measure from public.exercises where id = %s", (new_id,)).fetchone()["measure"] == "weight_reps"
    rw.rescore(conn, U_MAKER, NOW - timedelta(hours=3))   # the recompute rule, from that workout on
    conn.commit()
    after = {r["muscle_id"]: r["load"] for r in conn.execute(
        "select muscle_id, load from public.workout_muscle_loads where workout_id = %s", (wid,)).fetchall()}
    assert set(after) == {"quads", "chest"}
    assert after["chest"] == pytest.approx(after["quads"] * 0.2)


def test_db_editing_an_old_form_exercise_scores_it(conn):
    """An exercise the old form saved (no slug, no load mode, is_bodyweight from its equipment)
    gets a slug the first time it's edited and, having stored no e1RM (every set at 0 kg), turns
    bodyweight, so its sets score (notes 23.3 item 9). The payload is what Edit saves: the
    screen's draft of the row (draftOf), with a factor and muscles chosen."""
    legacy_id = conn.execute("""insert into public.exercises (owner_id, name, equipment, measure, is_bodyweight)
                                values (%s, 'Ring dip', 'bodyweight', 'weight_reps', true) returning id""", (U_MAKER,)).fetchone()["id"]
    cols = ", ".join(EXERCISE_COLUMNS)
    row = conn.execute(f"select {cols}, name, equipment, is_bodyweight from public.exercises where id = %s", (legacy_id,)).fetchone()
    started = NOW - timedelta(hours=6)
    wid = seed_f26.insert_workout(conn, U_MAKER, "Dip day", started, started + timedelta(hours=1),
                                  [("ring_dip", [{"w": 0, "r": 12}, {"w": 0, "r": 12}])], {"ring_dip": row}, 80)
    rw.rescore(conn, U_MAKER, started)
    conn.commit()

    def loads() -> dict[str, float]:
        return {r["muscle_id"]: r["load"] for r in conn.execute(
            "select muscle_id, load from public.workout_muscle_loads where workout_id = %s", (wid,)).fetchall()}

    assert loads() == {}   # no muscles yet, so no load
    # weight mode, as the engine reads the old row: 0 kg stores no e1RM
    assert not has_pb_history(conn, legacy_id)

    p = engine({"command": "custom-payload", "edit": {"row": row, "roles": [], "scored": has_pb_history(conn, legacy_id)},
                "slug": "custom_ringdip1", "today": TODAY, "draft": {"bwFactor": 0.65, "roles": {"triceps": "primary", "chest": "secondary"}}})
    update(conn, U_MAKER, str(legacy_id), p)
    saved = conn.execute("select slug, measure, load_mode, bw_factor, is_bodyweight from public.exercises where id = %s",
                         (legacy_id,)).fetchone()
    assert (saved["slug"], saved["measure"], saved["load_mode"], saved["is_bodyweight"]) == ("custom_ringdip1", "weight_reps", "bodyweight", True)
    assert saved["bw_factor"] == pytest.approx(0.65)
    assert roles_of(conn, str(legacy_id)) == {"triceps": "primary", "chest": "secondary"}

    rw.rescore(conn, U_MAKER, started)   # the recompute rule, from that workout on
    conn.commit()
    after = loads()
    assert set(after) == {"triceps", "chest"}
    assert after["chest"] < after["triceps"] and after["chest"] > 0


def test_db_editing_an_old_form_exercise_with_e1rms_keeps_weight_mode(conn):
    """One whose sets stored e1RMs (in weight mode, as the engine has always read the old row)
    stays in weight mode when edited, still marked bodyweight, so those e1RMs keep their meaning:
    nothing rewrites them (notes 23.3 item 9)."""
    legacy_id = conn.execute("""insert into public.exercises (owner_id, name, equipment, measure, is_bodyweight)
                                values (%s, 'Weighted ring dip', 'bodyweight', 'weight_reps', true) returning id""", (U_MAKER,)).fetchone()["id"]
    cols = ", ".join(EXERCISE_COLUMNS)
    row = conn.execute(f"select {cols}, name, equipment, is_bodyweight from public.exercises where id = %s", (legacy_id,)).fetchone()
    started = NOW - timedelta(hours=30)
    seed_f26.insert_workout(conn, U_MAKER, "Weighted dips", started, started + timedelta(hours=1),
                            [("weighted_dip", [{"w": 20, "r": 8}])], {"weighted_dip": row}, 80)
    conn.commit()
    stored = conn.execute("select e1rm from public.workout_sets where exercise_id = %s", (legacy_id,)).fetchone()["e1rm"]
    assert has_pb_history(conn, legacy_id)

    p = engine({"command": "custom-payload", "edit": {"row": row, "roles": [], "scored": has_pb_history(conn, legacy_id)},
                "slug": "custom_wringdip1", "today": TODAY, "draft": {"roles": {"triceps": "primary", "chest": "secondary"}}})
    update(conn, U_MAKER, str(legacy_id), p)
    saved = conn.execute(f"select {cols}, equipment, is_bodyweight from public.exercises where id = %s", (legacy_id,)).fetchone()
    assert (saved["load_mode"], saved["bw_factor"], saved["equipment"], saved["is_bodyweight"]) == ("weight", None, "bodyweight", True)
    # the stored e1RM is the one a set saved now would get
    again = engine({"command": "e1rm", "fallback_bodyweight": 80, "sets": [
        {"id": "s", "exercise": saved, "weight_kg": 20, "reps": 8, "rpe": None, "workout_bodyweight": 80}]})
    assert again[0]["e1rm"] == pytest.approx(stored)
