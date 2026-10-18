#!/usr/bin/env python3
"""Fill in workout_sets.e1rm for sets saved before build phase 3, and the bodyweight snapshot their
workouts need.

    cd sync && uv run python ../supabase/backfill_e1rm.py [--dry-run] [--user <uuid>]

Reads SUPABASE_DB_URL from the environment or the root .env, like the other scripts here. The
numbers come from the app's own engine through app/scripts/recovery-cli.ts (Node 22.18 or newer),
so a backfilled set gets exactly the e1RM the logger would have stored; no maths lives here.

What it changes, in one transaction, and nothing else:

1. workouts.bodyweight_kg of finished workouts, only where it is null and the workout has a set of
   a bodyweight or assisted exercise: the user's current bodyweight (the newer of their profile
   entry and latest weigh-in, else the constants' default), snapshotted once (spec §3.2, D5).
2. workout_sets.e1rm of finished workouts' sets, only where it is null and the engine gives the
   set one (an effective weight above zero and reps). Holds, carries and other fixed-cost sets
   stay null.
3. The cache of every finished workout of each user it filled, from the earliest one it filled
   on, through rescore_workouts.rescore(): the recompute rule (spec §14), since the e1RMs feed
   pb_history and the snapshot feeds the effective weight.

A workout still open is left alone: an app from before build phase 3 saves only the columns it
knows, so a set it edits later would keep a stale e1RM. The next run fills it once it finishes.
Weights, reps, RPE, set types and updated_at are never touched, so a second run finds nothing to
do. --dry-run works everything out, prints what it would change and rolls back.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "app" / "scripts" / "recovery-cli.ts"
EXERCISE_COLUMNS = ("id", "slug", "measure", "load_mode", "bw_factor", "fatigue", "pb_estimate_from",
                    "pb_estimate_ratio", "is_unilateral")


def _json(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, (date, UUID)):
        return str(v)
    raise TypeError(f"not JSON: {type(v).__name__}")


def engine(request: dict[str, Any]) -> Any:
    """One request to app/scripts/recovery-cli.ts."""
    proc = subprocess.run(
        ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", str(CLI)],
        input=json.dumps(request, default=_json), capture_output=True, text=True, encoding="utf-8",
    )
    if proc.returncode:
        raise RuntimeError(f"recovery-cli failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


@dataclass
class UserPlan:
    name: str
    bodyweight: dict[str, Any]
    workouts: list[tuple[Any, float]] = field(default_factory=list)   # (workout id, kg)
    sets: list[tuple[Any, float]] = field(default_factory=list)       # (set id, e1rm)
    without_e1rm: int = 0                                             # sets the engine gives none
    since: Any = None                                                 # earliest start among the workouts filled


@dataclass
class Plan:
    users: dict[Any, UserPlan] = field(default_factory=dict)
    rescored: int = 0   # cached workouts rescored after the fill
    changed: int = 0    # of those, how many had different cache rows

    @property
    def workouts(self) -> int:
        return sum(len(u.workouts) for u in self.users.values())

    @property
    def sets(self) -> int:
        return sum(len(u.sets) for u in self.users.values())

    def __str__(self) -> str:
        lines = [f"workouts given a bodyweight: {self.workouts}; sets given an e1RM: {self.sets}; "
                 f"workouts rescored: {self.rescored}, {self.changed} with changed cache rows"]
        for u in self.users.values():
            bw = u.bodyweight
            lines.append(f"  {u.name}: {len(u.workouts)} workouts at {bw['kg']} kg ({bw['source']}), "
                         f"{len(u.sets)} sets, {u.without_e1rm} sets with no e1RM to give (holds, carries, no weight)")
        return "\n".join(lines)


def plan(conn: psycopg.Connection[Any], user_id: Any = None) -> Plan:
    """What the backfill would change, worked out but not written. Finished workouts only."""
    out = Plan()
    with conn.cursor(row_factory=dict_row) as cur:
        users = cur.execute(
            """select distinct p.id, p.display_name, p.bodyweight_kg, p.bodyweight_updated_at
                 from public.workout_sets s join public.profiles p on p.id = s.user_id
                 join public.workouts w on w.id = s.workout_id
                where s.e1rm is null and w.finished_at is not null and (%(u)s::uuid is null or s.user_id = %(u)s::uuid)
               union
               select distinct p.id, p.display_name, p.bodyweight_kg, p.bodyweight_updated_at
                 from public.workouts w join public.profiles p on p.id = w.user_id
                where w.bodyweight_kg is null and w.finished_at is not null and (%(u)s::uuid is null or w.user_id = %(u)s::uuid)""",
            {"u": user_id}).fetchall()
        for u in users:
            uid = u["id"]
            rows = cur.execute("select user_id, key, value from public.user_thresholds where user_id = %s", (uid,)).fetchall()
            ctx = {"user_id": uid, "thresholds_rows": rows}
            weigh_in = cur.execute(
                "select weight_kg, date from public.wellness where user_id = %s and weight_kg is not null order by date desc limit 1",
                (uid,)).fetchone()
            bw = engine({**ctx, "command": "bodyweight", "weigh_in": weigh_in,
                         "profile": {"bodyweight_kg": u["bodyweight_kg"], "bodyweight_updated_at": u["bodyweight_updated_at"]}})
            up = UserPlan(name=u["display_name"], bodyweight=bw)

            fill = {r["id"]: r["started_at"] for r in cur.execute(
                """select distinct w.id, w.started_at from public.workouts w
                     join public.workout_sets s on s.workout_id = w.id
                     join public.exercises e on e.id = s.exercise_id
                    where w.user_id = %s and w.bodyweight_kg is null and w.finished_at is not null
                      and e.load_mode in ('bodyweight', 'assisted')""",
                (uid,)).fetchall()}
            up.workouts = [(wid, bw["kg"]) for wid in sorted(fill, key=str)]

            cols = ", ".join(f"e.{c} as ex_{c}" for c in EXERCISE_COLUMNS)
            sets = cur.execute(
                f"""select s.id, s.weight_kg, s.reps, s.rpe, w.id as workout_id, w.started_at, w.bodyweight_kg as workout_bodyweight, {cols}
                      from public.workout_sets s
                      join public.workouts w on w.id = s.workout_id
                      join public.exercises e on e.id = s.exercise_id
                     where s.user_id = %s and s.e1rm is null and w.finished_at is not null
                     order by s.id""",
                (uid,)).fetchall()
            request = [{
                "id": s["id"], "weight_kg": s["weight_kg"], "reps": s["reps"], "rpe": s["rpe"],
                "workout_bodyweight": bw["kg"] if s["workout_id"] in fill else s["workout_bodyweight"],
                "exercise": {c: s[f"ex_{c}"] for c in EXERCISE_COLUMNS},
            } for s in sets]
            results = engine({**ctx, "command": "e1rm", "sets": request, "fallback_bodyweight": bw["kg"]}) if request else []
            up.sets = [(r["id"], r["e1rm"]) for r in results if r["e1rm"] is not None]
            up.without_e1rm = len(results) - len(up.sets)
            started = {str(s["id"]): s["started_at"] for s in sets}
            up.since = min([*fill.values(), *(started[str(i)] for i, _ in up.sets)], default=None)
            if up.workouts or up.sets:
                out.users[uid] = up
    return out


def apply(conn: psycopg.Connection[Any], p: Plan) -> None:
    """Write a plan. Only null values are filled, so racing writes from the app are never overwritten."""
    workouts = [w for u in p.users.values() for w in u.workouts]
    sets = [s for u in p.users.values() for s in u.sets]
    with conn.cursor() as cur:
        if workouts:
            cur.execute(
                """update public.workouts w set bodyweight_kg = v.kg
                     from unnest(%s::uuid[], %s::real[]) as v(id, kg)
                    where w.id = v.id and w.bodyweight_kg is null""",
                ([str(i) for i, _ in workouts], [float(kg) for _, kg in workouts]))
        if sets:
            cur.execute(
                """update public.workout_sets s set e1rm = v.e1rm
                     from unnest(%s::uuid[], %s::double precision[]) as v(id, e1rm)
                    where s.id = v.id and s.e1rm is null""",
                ([str(i) for i, _ in sets], [float(e) for _, e in sets]))   # JSON gives 105 as an int


def backfill(conn: psycopg.Connection[Any], user_id: Any = None) -> Plan:
    """Plan, write, then rescore each user filled from the earliest workout filled on, so the
    cache follows the new e1RMs and snapshots. The caller commits or rolls back."""
    from rescore_workouts import rescore   # here, not at the top: rescore_workouts imports this module

    p = plan(conn, user_id)
    apply(conn, p)
    for uid, up in p.users.items():
        report = rescore(conn, uid, up.since)
        p.rescored += report.workouts
        p.changed += report.changed
    return p


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="show what would change, then roll back")
    parser.add_argument("--user", help="only this user id")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "sync"))
    from splitset_sync.config import env

    url = env("SUPABASE_DB_URL")
    if not url:
        raise SystemExit("SUPABASE_DB_URL is not set (see .env.example)")
    with psycopg.connect(url, connect_timeout=20, application_name="splitset-backfill-e1rm") as conn:
        p = backfill(conn, args.user)
        if args.dry_run:
            conn.rollback()
            print(f"dry run, rolled back. Would fill {p}")
        else:
            conn.commit()
            print(f"filled {p}")


if __name__ == "__main__":
    main()
