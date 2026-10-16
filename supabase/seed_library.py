#!/usr/bin/env python3
"""Load the exercise library into the database: muscles, library columns and exercise_muscles.

    cd sync && uv run python ../supabase/seed_library.py [--dry-run]

Reads SUPABASE_DB_URL from the environment or the root .env, like seed_demo.py, and connects
as the postgres role (global exercises are read-only to the app). Source of truth is
data/exercise_library.json; edit scripts/build_exercise_library.py, never the JSON.

What it does, in one transaction:

1. Checks the library (validate): at least one primary per exercise, the role caps from
   data/recovery_constants.json, no muscle twice on one exercise, every PB-estimate link
   resolves within estimate_max_hops - 1 hops (so a custom exercise's extra hop always
   resolves, spec F30), and every muscle is primary somewhere. Refuses to seed otherwise.
2. Upserts the 17 muscles.
3. Finds each library exercise's row: the global row already carrying its slug, else the
   existing global row LEGACY_NAMES maps to it (docs/recovery-map-integration-notes.md §4),
   else a new row. Matched rows take the library name and columns but keep their measure,
   is_bodyweight and muscle_group, so existing logs and PB views read as before.
4. Replaces an exercise's exercise_muscles rows when they differ from the library.

A row is only written when something differs, and updated_at moves only then, so a second
run changes nothing. Rows with an owner_id (users' own exercises) are never read or written.
--dry-run does all of it, checks the deferred constraints, prints the counts and rolls back.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_PATH = ROOT / "data" / "exercise_library.json"
CONSTANTS_PATH = ROOT / "data" / "recovery_constants.json"
ROLES = ("primary", "secondary", "tertiary")

# Existing global exercises (supabase/migrations/20260922000650_exercise_seed.sql) and the
# library slug each one becomes, per integration notes §4.1 to §4.3. One slug per row: a
# variant of an exercise another row already claims stays unscored (§4.4), as does
# Single-leg calf raise, which is logged as bodyweight and would score 0 kg in weight mode.
LEGACY_NAMES: dict[str, str] = {
    # §4.1 same name
    "Front squat": "front_squat",
    "Goblet squat": "goblet_squat",
    "Leg press": "leg_press",
    "Bulgarian split squat": "bulgarian_split_squat",
    "Walking lunge": "walking_lunge",
    "Reverse lunge": "reverse_lunge",
    "Step-up": "step_up",
    "Leg extension": "leg_extension",
    "Trap bar deadlift": "trap_bar_deadlift",
    "Single-leg Romanian deadlift": "single_leg_rdl",
    "Nordic hamstring curl": "nordic_curl",
    "Kettlebell swing": "kettlebell_swing",
    "Push-up": "push_up",
    "Pull-up": "pull_up",
    "Chin-up": "chin_up",
    "Seated cable row": "seated_cable_row",
    "Face pull": "face_pull",
    "Arnold press": "arnold_press",
    "Plank": "plank",
    "Side plank": "side_plank",
    "Copenhagen plank": "copenhagen_plank",
    "Dead bug": "dead_bug",
    "Pallof press": "pallof_press",
    "Hanging leg raise": "hanging_leg_raise",
    "Ab wheel rollout": "ab_wheel",
    # §4.2 obvious rename
    "Back squat": "squat_bb",
    "Hack squat": "hack_squat",
    "Deadlift": "deadlift",
    "Romanian deadlift": "rdl_bb",
    "Dumbbell Romanian deadlift": "rdl_db",
    "Hip thrust": "hip_thrust_bb",
    "Glute bridge": "glute_bridge_bw",
    "Cable kickback": "cable_kickback",
    "Standing calf raise": "calf_raise_standing",
    "Seated calf raise": "calf_raise_seated",
    "Bench press": "bench_press_bb",
    "Incline bench press": "incline_bench_bb",
    "Dumbbell bench press": "bench_press_db",
    "Incline dumbbell press": "incline_bench_db",
    "Chest fly": "cable_fly",
    "Lat pulldown": "lat_pulldown",
    "Barbell row": "barbell_row",
    "Dumbbell row": "db_row",
    "Overhead press": "ohp_bb",
    "Dumbbell shoulder press": "ohp_db",
    "Lateral raise": "lateral_raise_db",
    "Rear delt fly": "rear_delt_fly_db",
    "Barbell curl": "bb_curl",
    "Dumbbell curl": "db_curl",
    "Hammer curl": "hammer_curl",
    "Overhead tricep extension": "overhead_tri_ext_db",
    "Skull crusher": "skullcrusher",
    "Farmer's carry": "farmers_walk",
    # §4.3 needs a choice (the notes' picks)
    "Leg curl": "leg_curl_lying",
    "Dip": "dip_chest",
    "Chest-supported row": "machine_row",
    "Tricep pushdown": "tri_pushdown_bar",
}

# The older muscle_group vocabulary (search and subtitles use it), for new rows only, from the
# first primary muscle. Forearms and adductors have no equivalent there.
LEGACY_MUSCLE_GROUP: dict[str, str | None] = {
    "chest": "chest", "traps": "back", "lats": "back", "lower_back": "back",
    "front_delts": "shoulders", "side_delts": "shoulders", "rear_delts": "shoulders",
    "biceps": "biceps", "triceps": "triceps", "forearms": None,
    "abs": "core", "obliques": "core",
    "glutes": "glutes", "quads": "quads", "adductors": None, "hamstrings": "hamstrings", "calves": "calves",
}

# Columns the library owns on every library row, matched or new.
LIBRARY_COLUMNS = ("name", "slug", "group", "equipment", "is_unilateral", "load_mode", "bw_factor",
                   "fatigue", "pb_estimate_from", "pb_estimate_ratio", "load_split", "instructions")
# Columns set only when a row is created (integration notes §4.6).
NEW_ROW_COLUMNS = ("measure", "is_bodyweight", "muscle_group")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- checking the library

def estimate_hops(slug: str, by_slug: dict[str, dict[str, Any]]) -> int | None:
    """Links from slug to the end of its PB-estimate chain; None if the chain breaks or loops."""
    hops, seen, cur = 0, {slug}, by_slug[slug]
    while cur.get("pb_estimate"):
        nxt = cur["pb_estimate"]["from"]
        if nxt not in by_slug or nxt in seen:
            return None
        hops, cur = hops + 1, by_slug[nxt]
        seen.add(nxt)
    return hops


def validate(lib: dict[str, Any], constants: dict[str, Any]) -> list[str]:
    """Every rule the library must meet before it is seeded. Returns the problems found."""
    problems: list[str] = []
    caps = constants["role_caps"]
    max_hops = constants["pb"]["estimate_max_hops"] - 1
    muscle_ids = [m["id"] for m in lib["muscles"]]
    known = set(muscle_ids)
    if len(known) != len(muscle_ids):
        problems.append("muscle IDs repeat")

    exercises = lib["exercises"]
    by_slug = {e["slug"]: e for e in exercises}
    if len(by_slug) != len(exercises):
        problems.append("exercise slugs repeat")
    names = [e["name"].lower() for e in exercises]
    if len(set(names)) != len(names):
        problems.append("exercise names repeat (ignoring case)")

    primary_somewhere: set[str] = set()
    for e in exercises:
        s = e["slug"]
        if not e["primary"]:
            problems.append(f"{s}: no primary muscle")
        for role in ROLES:
            if len(e[role]) > caps[role]:
                problems.append(f"{s}: {len(e[role])} {role} muscles, cap is {caps[role]}")
        listed = [m for role in ROLES for m in e[role]]
        if len(set(listed)) != len(listed):
            problems.append(f"{s}: a muscle appears more than once")
        for m in sorted(set(listed) - known):
            problems.append(f"{s}: unknown muscle {m!r}")
        if set(e["load_split"]) != set(listed):
            problems.append(f"{s}: load_split names different muscles from the roles")
        primary_somewhere.update(e["primary"])
        est = e.get("pb_estimate")
        if est:
            if est["from"] not in by_slug:
                problems.append(f"{s}: pb_estimate from unknown exercise {est['from']!r}")
            else:
                hops = estimate_hops(s, by_slug)
                if hops is None:
                    problems.append(f"{s}: pb_estimate chain breaks or loops")
                elif hops > max_hops:
                    problems.append(f"{s}: pb_estimate chain is {hops} hops, limit is {max_hops}")

    for m in muscle_ids:
        if m not in primary_somewhere:
            problems.append(f"{m}: not primary in any exercise")
    return problems


# ---------------------------------------------------------------- library entry -> row

def library_values(e: dict[str, Any]) -> dict[str, Any]:
    """The columns the library owns, as they should read on the row."""
    est = e.get("pb_estimate")
    return {
        "name": e["name"],
        "slug": e["slug"],
        "group": e["group"],
        "equipment": e["equipment"],
        "is_unilateral": e["unilateral"],
        "load_mode": e["load_mode"],
        "bw_factor": e["bw_factor"],
        "fatigue": e["fatigue"],
        "pb_estimate_from": est["from"] if est else None,
        "pb_estimate_ratio": est["ratio"] if est else None,
        "load_split": e["load_split"],
        "instructions": e["note"] or None,
    }


def new_row_values(e: dict[str, Any]) -> dict[str, Any]:
    """measure, is_bodyweight and muscle_group for a row the loader creates (notes §4.6)."""
    if e["log_as"] == "seconds":
        measure = "duration"
    elif e["load_mode"] == "fixed":
        measure = "reps"
    else:
        measure = "weight_reps"   # bodyweight: weight = added load; assisted: weight = assistance
    is_bodyweight = e["load_mode"] == "bodyweight" or (e["load_mode"] == "fixed" and e["equipment"] == "bodyweight")
    muscle_group = "full_body" if e["group"] == "Full body" else LEGACY_MUSCLE_GROUP[e["primary"][0]]
    return {"measure": measure, "is_bodyweight": is_bodyweight, "muscle_group": muscle_group}


def roles_of(e: dict[str, Any]) -> dict[str, str]:
    return {m: role for role in ROLES for m in e[role]}


def _db(col: str, value: Any) -> Any:
    return Jsonb(value) if col == "load_split" and value is not None else value


def _quoted(col: str) -> str:
    return f'"{col}"' if col == "group" else col


# ---------------------------------------------------------------- seeding

@dataclass
class Report:
    muscles_written: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    muscle_sets_replaced: int = 0

    @property
    def changes(self) -> int:
        return self.muscles_written + self.inserted + self.updated + self.muscle_sets_replaced

    def __str__(self) -> str:
        return (f"muscles written {self.muscles_written}; exercises inserted {self.inserted}, "
                f"updated {self.updated}, unchanged {self.unchanged}; "
                f"muscle sets replaced {self.muscle_sets_replaced}")


def seed(conn: psycopg.Connection[Any], lib: dict[str, Any], constants: dict[str, Any]) -> Report:
    """Bring the database in line with the library. The caller commits or rolls back."""
    problems = validate(lib, constants)
    if problems:
        raise ValueError("exercise library failed validation:\n  " + "\n  ".join(problems))
    report = Report()

    with conn.cursor(row_factory=dict_row) as cur:
        # ---- muscles
        have = {r["id"]: r for r in cur.execute('select id, "group", name, views from public.muscles').fetchall()}
        for m in lib["muscles"]:
            want = {"id": m["id"], "group": m["group"], "name": m["name"], "views": m["views"]}
            if have.get(m["id"]) == want:
                continue
            cur.execute(
                'insert into public.muscles (id, "group", name, views) values (%(id)s, %(group)s, %(name)s, %(views)s) '
                'on conflict (id) do update set "group" = excluded."group", name = excluded.name, views = excluded.views',
                want)
            report.muscles_written += 1

        # ---- exercises: find each library entry's row
        cols = ", ".join(_quoted(c) for c in LIBRARY_COLUMNS)
        rows = cur.execute(f"select id, {cols} from public.exercises where owner_id is null").fetchall()
        by_slug = {r["slug"]: r for r in rows if r["slug"]}
        by_legacy = {r["name"].lower(): r for r in rows if not r["slug"]}
        legacy_for = {slug: name.lower() for name, slug in LEGACY_NAMES.items()}

        matched: list[tuple[dict[str, Any], dict[str, Any]]] = []
        fresh: list[dict[str, Any]] = []
        for e in lib["exercises"]:
            row = by_slug.get(e["slug"]) or by_legacy.get(legacy_for.get(e["slug"], ""))
            if row:
                matched.append((e, row))
            else:
                fresh.append(e)

        # renames first, so a new row's name never meets a name that is about to change
        ids: dict[str, Any] = {}
        for e, row in matched:
            want = library_values(e)
            diff = [c for c in LIBRARY_COLUMNS if row[c] != want[c]]
            ids[e["slug"]] = row["id"]
            if not diff:
                report.unchanged += 1
                continue
            sets = ", ".join(f"{_quoted(c)} = %({c})s" for c in diff)
            cur.execute(f"update public.exercises set {sets}, updated_at = now() where id = %(id)s",
                        {**{c: _db(c, want[c]) for c in diff}, "id": row["id"]})
            report.updated += 1

        for e in fresh:
            want = {**library_values(e), **new_row_values(e)}
            names = list(want)
            r = cur.execute(
                f"insert into public.exercises ({', '.join(_quoted(c) for c in names)}) "
                f"values ({', '.join(f'%({c})s' for c in names)}) returning id",
                {c: _db(c, v) for c, v in want.items()}).fetchone()
            ids[e["slug"]] = r["id"]
            report.inserted += 1

        # ---- exercise_muscles
        current: dict[Any, dict[str, str]] = {}
        for r in cur.execute(
                "select em.exercise_id, em.muscle_id, em.role from public.exercise_muscles em "
                "join public.exercises e on e.id = em.exercise_id where e.owner_id is null").fetchall():
            current.setdefault(r["exercise_id"], {})[r["muscle_id"]] = r["role"]
        for e in lib["exercises"]:
            ex_id, want = ids[e["slug"]], roles_of(e)
            if current.get(ex_id, {}) == want:
                continue
            cur.execute("delete from public.exercise_muscles where exercise_id = %s", (ex_id,))
            cur.executemany("insert into public.exercise_muscles (exercise_id, muscle_id, role) values (%s, %s, %s)",
                            [(ex_id, m, role) for m, role in want.items()])
            report.muscle_sets_replaced += 1

        # surface a broken pb_estimate_from link now, not at commit (and on a dry run at all)
        cur.execute("set constraints all immediate")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="show what would change, then roll back")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "sync"))
    from splitset_sync.config import env

    url = env("SUPABASE_DB_URL")
    if not url:
        raise SystemExit("SUPABASE_DB_URL is not set (see .env.example)")
    lib, constants = load_json(LIBRARY_PATH), load_json(CONSTANTS_PATH)
    with psycopg.connect(url, connect_timeout=20, application_name="splitset-seed-library") as conn:
        report = seed(conn, lib, constants)
        if args.dry_run:
            conn.rollback()
            print(f"dry run, rolled back: {report}")
        else:
            conn.commit()
            print(f"seeded: {report}")


if __name__ == "__main__":
    main()
