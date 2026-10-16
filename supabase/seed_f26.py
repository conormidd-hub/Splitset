#!/usr/bin/env python3
"""Dev only: load fixture F26's push/pull/legs week into the demo athlete, dated so that now is the
Wednesday at 20:00 (fixture hour 68), to check the recovery map against docs/recovery-map-preview.png.

    cd sync && uv run python ../supabase/seed_f26.py [--now <iso>]

Reads SUPABASE_DB_URL and EXPO_PUBLIC_DEMO_EMAIL from the environment or the root .env, like
seed_demo.py, and refuses to touch any account but the demo athlete. Run it again just before
checking: "now" moves on.

It clears the demo's workouts (their sets, cache rows and plan links go with them) and manual
PBs, then writes, with t0 = now − 68 h as fixture hour 0 (the fixture's Monday 00:00):

- "PBs (fixture F26)": one finished workout from t0 − 169 h to t0 − 168 h with one single per lift
  at its PB from F26's history (bench 120 × 1, deadlift 180 × 1, ...). Its sets' e1RMs are those
  PBs, so pb_history holds F26's history exactly: logged records dated −168 h. By Wednesday its
  own small loads have expired and it is outside the week.
- Push, Pull and Legs: F26's three workouts at their fixture hours (ending 50, 26 and 2 hours
  before now), sets exactly as in the fixture.

Every set gets its e1RM and every workout its cache through the app's engine (recovery-cli), and
the script prints each muscle's level and fatigue at now next to what F26 expects. The data comes
straight from data/load_model_fixtures.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backfill_e1rm import EXERCISE_COLUMNS, engine  # noqa: E402
from rescore_workouts import rescore  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "data" / "load_model_fixtures.json"
NOW_HOUR = 68          # F26's "at": Wednesday 20:00
PB_WORKOUT = "PBs (fixture F26)"
NAMES = ["Push", "Pull", "Legs"]


def fixture(fid: str) -> dict[str, Any]:
    return next(f for f in json.loads(FIXTURES.read_text(encoding="utf-8"))["fixtures"] if f["id"] == fid)


def exercise_rows(conn: psycopg.Connection[Any], slugs: set[str]) -> dict[str, dict[str, Any]]:
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(f"select {', '.join(EXERCISE_COLUMNS)} from public.exercises where slug = any(%s)", (sorted(slugs),)).fetchall()
    missing = slugs - {r["slug"] for r in rows}
    if missing:
        raise SystemExit(f"exercise library is missing {sorted(missing)}; run seed_library.py first")
    return {r["slug"]: r for r in rows}


def insert_workout(conn: psycopg.Connection[Any], user_id: Any, name: str, started: datetime, finished: datetime | None,
                   exercises: list[tuple[str, list[dict[str, Any]]]], ex: dict[str, dict[str, Any]],
                   bodyweight: float | None) -> str:
    """One workout as the logger stores it: a block per exercise in order, every set ticked, each
    set's e1RM from the engine. Returns the workout id."""
    wid = str(uuid4())
    conn.execute("""insert into public.workouts (id, user_id, name, started_at, finished_at, bodyweight_kg)
                    values (%s, %s, %s, %s, %s, %s)""", (wid, user_id, name, started, finished, bodyweight))
    rows = []
    for i, (slug, sets) in enumerate(exercises):
        weid = str(uuid4())
        conn.execute("insert into public.workout_exercises (id, workout_id, user_id, exercise_id, position) values (%s, %s, %s, %s, %s)",
                     (weid, wid, user_id, ex[slug]["id"], i))
        for j, s in enumerate(sets):
            rows.append({"id": str(uuid4()), "workout_exercise_id": weid, "exercise_id": ex[slug]["id"], "position": j,
                         "set_type": "warmup" if s.get("warmup") else "working", "weight_kg": s.get("w"), "reps": s.get("r"),
                         "rpe": s.get("rpe"), "seconds": s.get("seconds"), "side": s.get("side"), "slug": slug})
    e1rms = {r["id"]: r["e1rm"] for r in engine({"command": "e1rm", "fallback_bodyweight": bodyweight, "sets": [
        {"id": r["id"], "exercise": ex[r["slug"]], "weight_kg": r["weight_kg"], "reps": r["reps"], "rpe": r["rpe"],
         "workout_bodyweight": bodyweight} for r in rows]})}
    for r in rows:
        conn.execute("""insert into public.workout_sets (id, workout_exercise_id, workout_id, exercise_id, user_id, position, set_type,
                                                         weight_kg, reps, rpe, seconds, side, e1rm, completed, completed_at)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true, %s)""",
                     (r["id"], r["workout_exercise_id"], wid, r["exercise_id"], user_id, r["position"], r["set_type"], r["weight_kg"],
                      r["reps"], r["rpe"], r["seconds"], r["side"], e1rms[r["id"]], finished or started))
    return wid


def seed(conn: psycopg.Connection[Any], user_id: Any, now: datetime) -> list[str]:
    """Clear the user's workouts and manual PBs and load F26 so that `now` is fixture hour 68.
    Returns the mismatches against F26's expected levels and F (empty when it reproduces F26).
    The caller commits or rolls back."""
    f26 = fixture("F26")
    hour0 = now - timedelta(hours=NOW_HOUR)
    at = lambda h: hour0 + timedelta(hours=h)  # noqa: E731
    workouts = f26["inputs"]["workouts"]
    pbs = f26["inputs"]["history"]
    ex = exercise_rows(conn, {p["slug"] for p in pbs} | {slug for w in workouts for slug, _ in w["exercises"]})

    conn.execute("delete from public.workouts where user_id = %s", (user_id,))
    conn.execute("delete from public.manual_pbs where user_id = %s", (user_id,))
    with conn.cursor(row_factory=dict_row) as cur:
        profile = cur.execute("select bodyweight_kg, bodyweight_updated_at from public.profiles where id = %s", (user_id,)).fetchone()
        weigh_in = cur.execute("select weight_kg, date from public.wellness where user_id = %s and weight_kg is not null order by date desc limit 1",
                               (user_id,)).fetchone()
    bodyweight = engine({"command": "bodyweight", "profile": profile, "weigh_in": weigh_in})["kg"]

    # F26's history: logged PB records, all at the same hour
    pb_hours = {p["at"] for p in pbs}
    assert len(pb_hours) == 1 and all(p["source"] == "logged" for p in pbs), "F26's history is one logged hour"
    pb_end = pb_hours.pop()
    insert_workout(conn, user_id, PB_WORKOUT, at(pb_end - 1), at(pb_end),
                   [(p["slug"], [{"w": p["e1rm"], "r": 1}]) for p in pbs], ex, bodyweight)
    for name, w in zip(NAMES, workouts):
        insert_workout(conn, user_id, name, at(w["start"]), at(w["end"]), [(slug, sets) for slug, sets in w["exercises"]], ex, bodyweight)

    rescore(conn, user_id)

    with conn.cursor(row_factory=dict_row) as cur:
        loads = cur.execute("select muscle_id, load, recovery_hours, finished_at from public.workout_muscle_loads where user_id = %s",
                            (user_id,)).fetchall()
        library = cur.execute(f"select {', '.join(EXERCISE_COLUMNS)} from public.exercises where owner_id is null").fetchall()
        muscles = cur.execute("select exercise_id, muscle_id, role from public.exercise_muscles").fetchall()
        thresholds = cur.execute("select user_id, key, value from public.user_thresholds where user_id = %s", (user_id,)).fetchall()
    state = engine({"command": "recovery-map", "exercises": library, "muscles": muscles, "rows": loads, "at": now,
                    "user_id": user_id, "thresholds_rows": thresholds})
    mismatches, lines = [], [f"  {'muscle':<12} {'F':>6} {'level':>6} {'F26':>5}"]
    for muscle, want in f26["expect"].items():
        got = state[muscle]
        ok = got["level"] == want["level"][0] and ("F" not in want or abs(got["F"] - want["F"][0]) <= 0.01)
        if not ok:
            mismatches.append(f"{muscle}: level {got['level']} F {got['F']:.3f}, F26 wants {want}")
        lines.append(f"  {muscle:<12} {got['F']:>6.2f} {got['label']:>10} {want['level'][0]:>3}{'' if ok else '  <-- differs'}")
    print("\n".join(lines))
    if thresholds:
        print(f"  note: this user has {len(thresholds)} threshold override(s); F26 assumes the defaults")
    return mismatches


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--now", help="the instant to make Wednesday 20:00 (ISO 8601); default: now")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "sync"))
    from splitset_sync.config import env
    from seed_demo import DEMO_ID

    url, email = env("SUPABASE_DB_URL"), env("EXPO_PUBLIC_DEMO_EMAIL")
    if not url or not email:
        raise SystemExit("Set SUPABASE_DB_URL and EXPO_PUBLIC_DEMO_EMAIL in the environment or the root .env.")
    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise SystemExit("--now needs a time zone, e.g. 2026-10-21T20:00:00+11:00")
    with psycopg.connect(url, connect_timeout=20, application_name="splitset-seed-f26") as conn:
        row = conn.execute("select id from auth.users where lower(email) = lower(%s)", (email,)).fetchone()
        if not row or row[0] != DEMO_ID:
            raise SystemExit(f"{email} is not the demo athlete here; this seed only ever touches the demo account. Run seed_demo.py first.")
        mismatches = seed(conn, DEMO_ID, now)
        conn.commit()
    hour0 = now - timedelta(hours=NOW_HOUR)
    print(f"F26 loaded into the demo athlete: fixture hour 0 = {hour0.isoformat()}, now = hour {NOW_HOUR} (Wednesday 20:00)")
    print("matches F26" if not mismatches else "DIFFERS from F26:\n  " + "\n  ".join(mismatches))


if __name__ == "__main__":
    main()
