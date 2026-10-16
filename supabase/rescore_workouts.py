#!/usr/bin/env python3
"""Rescore finished workouts and rewrite their cache (workout_muscle_loads, workout_exercise_loads).

    cd sync && uv run python ../supabase/rescore_workouts.py [--dry-run] [--user <uuid>] [--from <iso>]

Build phase 4's one-off backfill, and the recompute rule of spec §14 for anything outside the
app: after a library change to an exercise's muscles or fatigue class (migrate.yml runs it after
seed_library.py), or by hand. The app runs the same rule itself after the changes it makes.

Reads SUPABASE_DB_URL from the environment or the root .env. Every number comes from the app's
engine through app/scripts/recovery-cli.ts (`score-workouts`, Node 22.18+), the same code the app
scores with: each finished workout, in time order, against the PB history dated before it
started (pb_history: stored set e1RMs and manual PBs). Rows are written through
save_workout_loads(), which replaces each workout's cache. A second run changes nothing.
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backfill_e1rm import EXERCISE_COLUMNS, engine  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SAVE_BATCH = 50


def scoring_rows(conn: psycopg.Connection[Any], user_id: Any, since: Any = None,
                 workout_ids: list[Any] | None = None) -> dict[str, Any]:
    """Everything one user's scoring needs, as rows shaped like the app's (ScoringRows minus
    thresholds, which go as thresholds_rows). Finished workouts starting at or after `since`, or
    exactly `workout_ids` (finished or not)."""
    with conn.cursor(row_factory=dict_row) as cur:
        q = lambda sql, *args: cur.execute(sql, args).fetchall()  # noqa: E731
        visible = "(e.owner_id is null or e.owner_id = %s)"
        exercises = q(f"select {', '.join('e.' + c for c in EXERCISE_COLUMNS)} from public.exercises e where {visible}", user_id)
        muscles = q(f"""select em.exercise_id, em.muscle_id, em.role from public.exercise_muscles em
                          join public.exercises e on e.id = em.exercise_id where {visible}""", user_id)
        if workout_ids is not None:
            workouts = q("""select id, started_at, finished_at, bodyweight_kg from public.workouts
                             where user_id = %s and id = any(%s::uuid[]) order by started_at""",
                         user_id, [str(i) for i in workout_ids])
        else:
            workouts = q("""select id, started_at, finished_at, bodyweight_kg from public.workouts
                             where user_id = %s and finished_at is not null and (%s::timestamptz is null or started_at >= %s::timestamptz)
                             order by started_at""", user_id, since, since)
        ids = [str(w["id"]) for w in workouts]
        blocks = q("""select id, workout_id, exercise_id, position from public.workout_exercises
                       where workout_id = any(%s::uuid[])""", ids)
        sets = q("""select workout_exercise_id, position, set_type, weight_kg, reps, rpe, seconds, side, completed
                      from public.workout_sets where workout_id = any(%s::uuid[])""", ids)
        history = q("""select exercise_id, e1rm, at, source, weight_kg, reps, set_type, workout_id, manual_pb_id
                         from public.pb_history where user_id = %s order by at""", user_id)
        thresholds = q("select user_id, key, value from public.user_thresholds where user_id = %s", user_id)
    return {"user_id": user_id, "thresholds_rows": thresholds, "exercises": exercises, "muscles": muscles,
            "workouts": workouts, "blocks": blocks, "sets": sets, "history": history}


def score(conn: psycopg.Connection[Any], user_id: Any, since: Any = None, workout_ids: list[Any] | None = None,
          finished_at: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """The engine's cache rows for one user's workouts. `finished_at` overrides workouts' finish
    times by id, for scoring a workout as it finishes."""
    rows = scoring_rows(conn, user_id, since, workout_ids)
    for w in rows["workouts"]:
        if finished_at and str(w["id"]) in finished_at:
            w["finished_at"] = finished_at[str(w["id"])]
    return engine({"command": "score-workouts", **rows}) if rows["workouts"] else []


def _same(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two workouts' cache rows match, to the last float bit that matters."""
    def norm(loads: dict[str, Any]) -> tuple:
        ms = sorted((m["muscle_id"], m["load"], m["recovery_hours"]) for m in loads["muscles"])
        es = sorted((str(e["exercise_id"]), e["load"], e["pb_source"], e["pb_detail"], e["pb_value"]) for e in loads["exercises"])
        return ms, es
    (ma, ea), (mb, eb) = norm(a), norm(b)
    close = lambda x, y: x == y or (isinstance(x, float) and isinstance(y, float) and math.isclose(x, y, rel_tol=1e-12))  # noqa: E731
    return (len(ma) == len(mb) and len(ea) == len(eb)
            and all(all(close(x, y) for x, y in zip(r, s)) for r, s in zip(ma, mb))
            and all(all(close(x, y) for x, y in zip(r, s)) for r, s in zip(ea, eb)))


def cached(conn: psycopg.Connection[Any], workout_ids: list[str]) -> dict[str, dict[str, Any]]:
    """The cache rows stored now, shaped like the engine's."""
    out: dict[str, dict[str, Any]] = {w: {"workout_id": w, "muscles": [], "exercises": []} for w in workout_ids}
    with conn.cursor(row_factory=dict_row) as cur:
        for r in cur.execute("select workout_id, muscle_id, load, recovery_hours from public.workout_muscle_loads where workout_id = any(%s::uuid[])",
                             (workout_ids,)).fetchall():
            out[str(r["workout_id"])]["muscles"].append(r)
        for r in cur.execute("""select workout_id, exercise_id, load, pb_source, pb_detail, pb_value
                                  from public.workout_exercise_loads where workout_id = any(%s::uuid[])""", (workout_ids,)).fetchall():
            out[str(r["workout_id"])]["exercises"].append(r)
    return out


def save(conn: psycopg.Connection[Any], loads: list[dict[str, Any]]) -> None:
    for i in range(0, len(loads), SAVE_BATCH):
        conn.execute("select public.save_workout_loads(%s)", (Jsonb(loads[i:i + SAVE_BATCH]),))


@dataclass
class Report:
    users: dict[str, tuple[int, int, int]] = field(default_factory=dict)   # name: (workouts, changed, muscle rows)

    @property
    def workouts(self) -> int:
        return sum(w for w, _, _ in self.users.values())

    @property
    def changed(self) -> int:
        return sum(c for _, c, _ in self.users.values())

    def __str__(self) -> str:
        lines = [f"workouts rescored: {self.workouts}; with changed cache rows: {self.changed}"]
        for name, (w, c, m) in self.users.items():
            lines.append(f"  {name}: {w} workouts, {c} changed, {m} muscle rows")
        return "\n".join(lines)


def rescore(conn: psycopg.Connection[Any], user_id: Any = None, since: Any = None) -> Report:
    """Rescore and rewrite every matching finished workout. The caller commits or rolls back."""
    report = Report()
    with conn.cursor(row_factory=dict_row) as cur:
        users = cur.execute(
            """select distinct p.id, p.display_name from public.workouts w join public.profiles p on p.id = w.user_id
                where w.finished_at is not null and (%(u)s::uuid is null or w.user_id = %(u)s::uuid)
                  and (%(s)s::timestamptz is null or w.started_at >= %(s)s::timestamptz)""",
            {"u": user_id, "s": since}).fetchall()
    for u in users:
        loads = score(conn, u["id"], since)
        before = cached(conn, [str(w["workout_id"]) for w in loads])
        changed = sum(not _same(before[str(w["workout_id"])], w) for w in loads)
        save(conn, loads)
        report.users[u["display_name"]] = (len(loads), changed, sum(len(w["muscles"]) for w in loads))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="work it all out and write it, then roll back")
    parser.add_argument("--user", help="only this user id")
    parser.add_argument("--from", dest="since", help="only workouts starting at or after this instant (ISO 8601)")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "sync"))
    from splitset_sync.config import env

    url = env("SUPABASE_DB_URL")
    if not url:
        raise SystemExit("SUPABASE_DB_URL is not set (see .env.example)")
    with psycopg.connect(url, connect_timeout=20, application_name="splitset-rescore") as conn:
        report = rescore(conn, args.user, args.since)
        if args.dry_run:
            conn.rollback()
            print(f"dry run, rolled back. {report}")
        else:
            conn.commit()
            print(report)


if __name__ == "__main__":
    main()
