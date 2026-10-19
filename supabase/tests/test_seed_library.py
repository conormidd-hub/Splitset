"""Tests for supabase/seed_library.py (build phase 1).

The pure tests check the library and the loader's mapping, and run anywhere:

    cd sync && uv run pytest

The database tests seed a real Postgres with every migration applied. They run only when
SPLITSET_TEST_DB_URL points at a local database (the db-tests workflow starts one with
`supabase db start`), and never against SUPABASE_DB_URL, which is a live project.
"""

from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row

SUPABASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPABASE))
import seed_library as sl  # noqa: E402

LIB = sl.load_json(sl.LIBRARY_PATH)
CONSTANTS = sl.load_json(sl.CONSTANTS_PATH)
EXERCISE_SEED_SQL = SUPABASE / "migrations" / "20260922000650_exercise_seed.sql"


def seed_names() -> list[str]:
    """Exercise names inserted by the original library migration."""
    sql = EXERCISE_SEED_SQL.read_text(encoding="utf-8")
    return [m.replace("''", "'") for m in re.findall(r"^\s*\('((?:[^']|'')+)',", sql, flags=re.M)]


def broken(mutate) -> list[str]:
    lib = copy.deepcopy(LIB)
    mutate({e["slug"]: e for e in lib["exercises"]}, lib)
    return sl.validate(lib, CONSTANTS)


# ---------------------------------------------------------------- the library itself

def test_library_has_161_exercises_and_17_muscles():
    assert len(LIB["exercises"]) == 161
    assert len(LIB["muscles"]) == 17


def test_library_passes_validation():
    assert sl.validate(LIB, CONSTANTS) == []


def test_every_exercise_has_a_primary_and_respects_role_caps():
    caps = CONSTANTS["role_caps"]
    for e in LIB["exercises"]:
        assert len(e["primary"]) >= 1, e["slug"]
        for role in sl.ROLES:
            assert len(e[role]) <= caps[role], (e["slug"], role)


def test_no_muscle_twice_on_one_exercise():
    for e in LIB["exercises"]:
        listed = [m for role in sl.ROLES for m in e[role]]
        assert len(listed) == len(set(listed)), e["slug"]


def test_pb_estimates_exist_and_library_chains_are_at_most_three_hops():
    by_slug = {e["slug"]: e for e in LIB["exercises"]}
    for e in LIB["exercises"]:
        if e["pb_estimate"]:
            assert e["pb_estimate"]["from"] in by_slug, e["slug"]
        hops = sl.estimate_hops(e["slug"], by_slug)
        assert hops is not None and hops <= 3, (e["slug"], hops)
    # the limit leaves exactly one hop for a custom exercise based on a library one (F30)
    assert CONSTANTS["pb"]["estimate_max_hops"] - 1 == 3


def test_every_muscle_is_primary_somewhere():
    primaries = {m for e in LIB["exercises"] for m in e["primary"]}
    assert primaries == {m["id"] for m in LIB["muscles"]}


# ---------------------------------------------------------------- validate() catches each rule

def test_validate_rejects_no_primary():
    def f(ex, _):
        ex["bench_press_bb"]["primary"] = []
        del ex["bench_press_bb"]["load_split"]["chest"]
    assert any("bench_press_bb: no primary" in p for p in broken(f))


def test_validate_rejects_too_many_in_a_role():
    def f(ex, _):
        ex["deadlift"]["tertiary"].append("calves")
        ex["deadlift"]["load_split"]["calves"] = 1
    assert any("deadlift: 4 tertiary" in p for p in broken(f))


def test_validate_rejects_a_muscle_twice():
    def f(ex, _):
        ex["bench_press_bb"]["tertiary"].append("chest")
    assert any("bench_press_bb: a muscle appears more than once" in p for p in broken(f))


def test_validate_rejects_an_unknown_muscle():
    def f(ex, _):
        ex["plank"]["tertiary"].append("neck")
        ex["plank"]["load_split"]["neck"] = 1
    assert any("plank: unknown muscle 'neck'" in p for p in broken(f))


def test_validate_rejects_an_unknown_pb_estimate():
    def f(ex, _):
        ex["bench_press_db"]["pb_estimate"] = {"from": "nope", "ratio": 1.0}
    assert any("bench_press_db: pb_estimate from unknown" in p for p in broken(f))


def test_validate_rejects_a_four_hop_chain():
    # db_curl -> bb_curl -> barbell_row -> bench_press_bb is 3; anchor bench on squat_bb for 4
    def f(ex, _):
        ex["bench_press_bb"]["pb_estimate"] = {"from": "squat_bb", "ratio": 0.8}
    assert any("db_curl: pb_estimate chain is 4 hops" in p for p in broken(f))


def test_validate_rejects_a_loop():
    def f(ex, _):
        ex["bench_press_bb"]["pb_estimate"] = {"from": "bench_press_db", "ratio": 2.6}
    assert any("chain breaks or loops" in p for p in broken(f))


def test_validate_rejects_a_muscle_never_primary():
    def f(_, lib):
        for e in lib["exercises"]:
            if e["primary"] == ["calves"]:          # the calf raises load nothing else
                e["primary"], e["load_split"] = ["quads"], {"quads": 100}
    assert broken(f) == ["calves: not primary in any exercise"]


# ---------------------------------------------------------------- the loader's mapping

def test_legacy_names_cover_57_existing_rows_with_distinct_library_slugs():
    slugs = {e["slug"] for e in LIB["exercises"]}
    names = {n.lower() for n in seed_names()}
    assert len(seed_names()) == 76
    assert len(sl.LEGACY_NAMES) == 57
    assert len(set(sl.LEGACY_NAMES.values())) == 57
    for name, slug in sl.LEGACY_NAMES.items():
        assert name.lower() in names, name
        assert slug in slugs, slug
    assert "Single-leg calf raise" not in sl.LEGACY_NAMES


def test_new_row_values_follow_the_vocabulary_table():
    ex = {e["slug"]: e for e in LIB["exercises"]}
    assert sl.new_row_values(ex["incline_bench_db"]) == {"measure": "weight_reps", "is_bodyweight": False, "muscle_group": "chest"}
    assert sl.new_row_values(ex["sissy_squat"]) == {"measure": "weight_reps", "is_bodyweight": True, "muscle_group": "quads"}
    assert sl.new_row_values(ex["assisted_pull_up"]) == {"measure": "weight_reps", "is_bodyweight": False, "muscle_group": "back"}
    assert sl.new_row_values(ex["band_pull_apart"]) == {"measure": "reps", "is_bodyweight": False, "muscle_group": "shoulders"}
    assert sl.new_row_values(ex["wall_sit"]) == {"measure": "duration", "is_bodyweight": True, "muscle_group": "quads"}
    assert sl.new_row_values(ex["wrist_curl"])["muscle_group"] is None
    assert sl.new_row_values(ex["sled_push"])["muscle_group"] == "full_body"


def test_library_values_carry_the_estimate_and_note():
    ex = {e["slug"]: e for e in LIB["exercises"]}
    v = sl.library_values(ex["bench_press_db"])
    assert (v["pb_estimate_from"], v["pb_estimate_ratio"], v["instructions"]) == ("bench_press_bb", 0.38, "weight per hand")
    v = sl.library_values(ex["bench_press_bb"])
    assert (v["pb_estimate_from"], v["pb_estimate_ratio"], v["instructions"]) == (None, None, None)


def test_seed_refuses_an_invalid_library():
    lib = copy.deepcopy(LIB)
    lib["exercises"][0]["primary"] = []
    with pytest.raises(ValueError, match="no primary"):
        sl.seed(None, lib, CONSTANTS)  # type: ignore[arg-type]  (fails before touching the connection)


# ---------------------------------------------------------------- against a local database

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
USER_A = UUID("00000000-0000-4000-a000-0000000000a1")
USER_B = UUID("00000000-0000-4000-a000-0000000000b1")
CUSTOM_NAME = "Hammer curl"   # a user's own row sharing a library exercise's legacy name


@pytest.fixture(scope="module")
def db_url() -> str:
    url = os.environ.get("SPLITSET_TEST_DB_URL")
    if not url:
        pytest.skip("SPLITSET_TEST_DB_URL is not set (the db-tests workflow sets it)")
    assert urlparse(url).hostname in LOCAL_HOSTS, "SPLITSET_TEST_DB_URL must point at a local database"
    return url


def snapshot(conn) -> dict[str, Any]:
    q = lambda sql: [dict(r) for r in conn.execute(sql).fetchall()]  # noqa: E731
    return {
        "muscles": q("select * from public.muscles order by id"),
        "exercises": q("select * from public.exercises where owner_id is null order by id"),
        "exercise_muscles": q("select * from public.exercise_muscles order by exercise_id, muscle_id"),
        "custom": q("select * from public.exercises where owner_id is not null order by id"),
    }


@pytest.fixture(scope="module")
def seeded(db_url):
    with psycopg.connect(db_url, row_factory=dict_row) as conn:
        for uid, email in ((USER_A, "phase1-a@splitset.test"), (USER_B, "phase1-b@splitset.test")):
            conn.execute("insert into auth.users (instance_id, id, aud, role, email) "
                         "values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
                         "on conflict (id) do nothing", (uid, email))
        conn.execute("insert into public.exercises (owner_id, name, muscle_group, equipment) values (%s, %s, 'biceps', 'cable') "
                     "on conflict (owner_id, lower(name)) where owner_id is not null do nothing", (USER_A, CUSTOM_NAME))
        conn.commit()

        before = {r["key"]: r["id"] for r in conn.execute(
            "select coalesce(slug, lower(name)) as key, id from public.exercises where owner_id is null").fetchall()}
        legacy_ids = {slug: before.get(slug) or before[name.lower()] for name, slug in sl.LEGACY_NAMES.items()}
        custom_before = snapshot(conn)["custom"]

        first = sl.seed(conn, LIB, CONSTANTS)
        conn.commit()
        after_first = snapshot(conn)
        second = sl.seed(conn, LIB, CONSTANTS)
        conn.commit()
        after_second = snapshot(conn)
        yield {"conn": conn, "first": first, "second": second, "after_first": after_first,
               "after_second": after_second, "legacy_ids": legacy_ids, "custom_before": custom_before}


def test_db_seed_twice_changes_nothing(seeded):
    assert seeded["second"].changes == 0, str(seeded["second"])
    assert seeded["second"].unchanged == 161
    assert seeded["after_first"] == seeded["after_second"]


def test_db_has_17_muscles_and_161_library_exercises(seeded):
    conn = seeded["conn"]
    assert conn.execute("select count(*) as n from public.muscles").fetchone()["n"] == 17
    assert conn.execute("select count(*) as n from public.exercises where owner_id is null and slug is not null").fetchone()["n"] == 161
    # 76 original rows - 57 matched + 161 library = 180: no matched exercise was inserted twice
    assert conn.execute("select count(*) as n from public.exercises where owner_id is null").fetchone()["n"] == 180


def test_db_matched_rows_keep_their_ids_and_take_library_names(seeded):
    conn = seeded["conn"]
    names = {e["slug"]: e["name"] for e in LIB["exercises"]}
    rows = {r["slug"]: r for r in conn.execute(
        "select id, slug, name, measure from public.exercises where owner_id is null and slug is not null").fetchall()}
    for slug, old_id in seeded["legacy_ids"].items():
        assert rows[slug]["id"] == old_id, slug
        assert rows[slug]["name"] == names[slug], slug
    assert rows["farmers_walk"]["measure"] == "weight_duration"   # existing measure kept (notes §4.2)
    unscored = conn.execute("select slug from public.exercises where owner_id is null and lower(name) = 'single-leg calf raise'").fetchone()
    assert unscored["slug"] is None


def test_db_never_touches_custom_exercises(seeded):
    assert seeded["after_second"]["custom"] == seeded["custom_before"]
    custom = [r for r in seeded["after_second"]["custom"] if r["name"] == CUSTOM_NAME]
    assert len(custom) == 1 and custom[0]["slug"] is None


def test_db_roles_respect_caps_and_every_exercise_has_a_primary(seeded):
    caps = CONSTANTS["role_caps"]
    rows = seeded["conn"].execute("""
        select e.slug, em.role, count(*) as n from public.exercise_muscles em
          join public.exercises e on e.id = em.exercise_id
         where e.owner_id is null group by 1, 2""").fetchall()
    counts: dict[str, dict[str, int]] = {}
    for r in rows:
        counts.setdefault(r["slug"], {})[r["role"]] = r["n"]
    assert len(counts) == 161
    for slug, by_role in counts.items():
        assert by_role.get("primary", 0) >= 1, slug
        for role, n in by_role.items():
            assert n <= caps[role], (slug, role)


def test_db_matches_the_library_roles_exactly(seeded):
    rows = seeded["conn"].execute("""
        select e.slug, em.muscle_id, em.role from public.exercise_muscles em
          join public.exercises e on e.id = em.exercise_id where e.owner_id is null""").fetchall()
    got: dict[str, dict[str, str]] = {}
    for r in rows:
        got.setdefault(r["slug"], {})[r["muscle_id"]] = r["role"]
    assert got == {e["slug"]: sl.roles_of(e) for e in LIB["exercises"]}


def test_db_pb_estimates_resolve_within_three_hops(seeded):
    rows = seeded["conn"].execute("""
        with recursive chain as (
          select slug, pb_estimate_from as nxt, 0 as hops from public.exercises where owner_id is null and slug is not null
          union all
          select c.slug, e.pb_estimate_from, c.hops + 1 from chain c join public.exercises e on e.slug = c.nxt
           where c.hops < 10
        )
        select slug, max(hops) as hops, bool_or(nxt is not null and hops >= 10) as runaway from chain group by slug""").fetchall()
    assert len(rows) == 161
    for r in rows:
        assert r["hops"] <= 3 and not r["runaway"], r
    dangling = seeded["conn"].execute("""
        select a.slug from public.exercises a left join public.exercises b on b.slug = a.pb_estimate_from
         where a.pb_estimate_from is not null and b.id is null""").fetchall()
    assert dangling == []


def test_db_every_muscle_is_primary_somewhere(seeded):
    rows = seeded["conn"].execute("""
        select m.id from public.muscles m
         where not exists (select 1 from public.exercise_muscles em where em.muscle_id = m.id and em.role = 'primary')
    """).fetchall()
    assert rows == []


def as_user(conn, uid: UUID) -> None:
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid), "role": "authenticated"}),))


def test_db_rls_library_is_readable_but_not_writable(seeded):
    conn = seeded["conn"]
    try:
        as_user(conn, USER_A)
        assert conn.execute("select count(*) as n from public.muscles").fetchone()["n"] == 17
        assert conn.execute("select count(*) as n from public.exercise_muscles").fetchone()["n"] > 0
        bench = conn.execute("select id from public.exercises where slug = 'bench_press_bb'").fetchone()["id"]
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                conn.execute("insert into public.exercise_muscles (exercise_id, muscle_id, role) values (%s, 'calves', 'tertiary')", (bench,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                conn.execute("update public.muscles set name = 'x' where id = 'chest'")
        with pytest.raises(psycopg.errors.CheckViolation, match="exercises_custom_slug"):
            with conn.transaction():
                conn.execute("insert into public.exercises (owner_id, name, slug, load_mode, fatigue) "
                             "values (%s, 'Claimed', 'new_library_slug', 'weight', 'standard')", (USER_A,))
    finally:
        conn.rollback()


def test_db_rls_user_thresholds_are_private(seeded):
    conn = seeded["conn"]
    try:
        conn.execute("insert into public.user_thresholds (user_id, key, value) values (%s, 'role_weights.secondary', '0.5'), "
                     "(%s, 'role_weights.secondary', '0.3')", (USER_A, USER_B))
        as_user(conn, USER_A)
        rows = conn.execute("select user_id, key, value from public.user_thresholds").fetchall()
        assert [(r["user_id"], r["value"]) for r in rows] == [(USER_A, 0.5)]
    finally:
        conn.rollback()
