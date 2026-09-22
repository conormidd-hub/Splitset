"""Link planned sessions and app workouts to the activities that fulfilled them.

Rules (see plan_sessions in the schema):
  * only sessions still `planned` with no link and `linked_by` not 'manual' are candidates
  * an activity links to at most one session; the partial unique index enforces it
  * same local date, compatible type, then closest distance to target, then earliest start
  * app workouts link to the watch's strength recording within two hours of their start
  * a strength session prefers the app workout on that date over the raw watch activity
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

# plan type -> activity types that satisfy it; None means any type
PLAN_TYPE_MAP: dict[str, set[str] | None] = {
    "run": {"Run", "TrailRun", "VirtualRun", "Treadmill"},
    "ride": {"Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide", "EMountainBikeRide"},
    "walk": {"Walk", "Hike"},
    "strength": {"WeightTraining", "Workout"},
    "other": None,
    "rest": set(),
}
STRENGTH_TYPES = PLAN_TYPE_MAP["strength"] or set()
WORKOUT_LINK_WINDOW = timedelta(hours=2)


@dataclass(frozen=True)
class Session:
    id: str
    date: date
    position: int
    type: str
    target_distance_m: float | None


@dataclass(frozen=True)
class Candidate:
    id: str
    local_date: date
    type: str
    distance_m: float | None
    start_time: datetime


def compatible(plan_type: str, activity_type: str) -> bool:
    allowed = PLAN_TYPE_MAP.get(plan_type)
    if allowed is None:
        return plan_type == "other"
    return activity_type in allowed


def choose(session: Session, candidates: list[Candidate]) -> Candidate | None:
    """The best unlinked activity for a session, or None."""
    pool = [c for c in candidates if c.local_date == session.date and compatible(session.type, c.type)]
    if not pool:
        return None
    target = session.target_distance_m

    def rank(c: Candidate) -> tuple[float, datetime]:
        gap = abs((c.distance_m or 0.0) - target) if target is not None else 0.0
        return (gap, c.start_time)

    return min(pool, key=rank)


def assign(sessions: list[Session], candidates: list[Candidate]) -> dict[str, str]:
    """session id -> activity id, greedily in plan order, each activity used once."""
    out: dict[str, str] = {}
    free = list(candidates)
    for s in sorted(sessions, key=lambda x: (x.date, x.position)):
        pick = choose(s, free)
        if pick:
            out[s.id] = pick.id
            free = [c for c in free if c.id != pick.id]
    return out


# ---------------------------------------------------------------- database

def _rows(conn: psycopg.Connection[Any], sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    """Dict rows regardless of the connection's default row factory."""
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()


def link_plan_sessions(conn: psycopg.Connection[Any], user_id: UUID, since: date) -> int:
    """Link sessions from `since` up to today. Returns the number of sessions updated."""
    rows = _rows(
        conn,
        """
        select id::text, date, position, type, target_distance_m
          from public.plan_sessions
         where user_id = %s and status = 'planned' and activity_id is null and workout_id is null
           and linked_by is distinct from 'manual'
           and date >= %s and date <= current_date
        """,
        (user_id, since),
    )
    sessions = [Session(r["id"], r["date"], r["position"], r["type"], r["target_distance_m"]) for r in rows]
    if not sessions:
        return 0
    linked = 0

    # strength sessions first try the app's own finished workouts on that date
    strength = [s for s in sessions if s.type == "strength"]
    if strength:
        workouts = _rows(
            conn,
            """
            select w.id::text, (w.started_at at time zone coalesce(p.timezone, 'UTC'))::date as local_date, w.started_at
              from public.workouts w
              join public.profiles p on p.id = w.user_id
             where w.user_id = %s and w.finished_at is not null
               and w.started_at >= %s::date - interval '1 day'
               and not exists (select 1 from public.plan_sessions ps where ps.workout_id = w.id)
             order by w.started_at
            """,
            (user_id, since),
        )
        wcands = [Candidate(w["id"], w["local_date"], "Workout", None, w["started_at"]) for w in workouts]
        picked = assign(strength, wcands)
        for sid, wid in picked.items():
            conn.execute(
                """
                update public.plan_sessions
                   set workout_id = %s, status = 'done', linked_by = 'auto', updated_at = now()
                 where id = %s and workout_id is null and activity_id is null
                """,
                (wid, sid),
            )
            linked += 1
        sessions = [s for s in sessions if s.id not in picked]

    if sessions:
        acts = _rows(
            conn,
            """
            select a.id, a.start_time_local::date as local_date, a.type, a.distance_m, a.start_time
              from public.activities a
             where a.user_id = %s and a.start_time_local::date >= %s
               and not exists (select 1 from public.plan_sessions ps where ps.activity_id = a.id)
             order by a.start_time
            """,
            (user_id, since),
        )
        cands = [Candidate(a["id"], a["local_date"], a["type"], a["distance_m"], a["start_time"]) for a in acts]
        for sid, aid in assign(sessions, cands).items():
            conn.execute(
                """
                update public.plan_sessions
                   set activity_id = %s, status = 'done', linked_by = 'auto', updated_at = now()
                 where id = %s and activity_id is null and workout_id is null
                """,
                (aid, sid),
            )
            linked += 1
    return linked


def link_workouts(conn: psycopg.Connection[Any], user_id: UUID, since: date) -> int:
    """Attach the watch's strength recording to app workouts started within two hours of it."""
    workouts = _rows(
        conn,
        """
        select id::text, started_at from public.workouts
         where user_id = %s and activity_id is null and finished_at is not null
           and linked_by is distinct from 'manual' and started_at >= %s::date - interval '1 day'
         order by started_at
        """,
        (user_id, since),
    )
    if not workouts:
        return 0
    acts = _rows(
        conn,
        """
        select a.id, a.start_time from public.activities a
         where a.user_id = %s and a.type = any(%s) and a.start_time >= %s::date - interval '1 day'
           and not exists (select 1 from public.workouts w where w.activity_id = a.id)
         order by a.start_time
        """,
        (user_id, sorted(STRENGTH_TYPES), since),
    )
    free = {a["id"]: a["start_time"] for a in acts}
    linked = 0
    for w in workouts:
        best: tuple[str, timedelta] | None = None
        for aid, st in free.items():
            gap = abs(st - w["started_at"])
            if gap <= WORKOUT_LINK_WINDOW and (best is None or gap < best[1]):
                best = (aid, gap)
        if best:
            conn.execute(
                "update public.workouts set activity_id = %s, linked_by = 'auto', updated_at = now() "
                "where id = %s and activity_id is null",
                (best[0], w["id"]),
            )
            free.pop(best[0])
            linked += 1
    return linked
