"""Send the plan's upcoming runs to intervals.icu as planned workouts, which puts them on the watch.

intervals.icu holds the Garmin connection: a workout on its calendar appears in Garmin Connect
and on the watch, where pressing Run offers it. Ported from reference/sync_workouts.py, with the
state that file kept in JSON living on the session row instead (external_event_id, and
external_hash as "<date it was sent for>:<digest of what was sent>").

Rules:
  * runs only, for the next WINDOW_DAYS days, never race day (a watch beeping targets is the last
    thing you need there), and only with something to do: steps, a distance or a time
  * a session that moves or changes is updated in place; one that is skipped, deleted, or moved
    into the past has its event removed
  * events for sessions whose day has simply passed are left alone: that is history

Workout text syntax, worked out against the API by the reference project:
  * distances must be in km: "0.4km", never "400m", which is read as 400 minutes
  * pace targets are "- 5km 3:52-3:58 pace"
  * a repeat is "Nx" on its own line, with blank lines around the block
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Literal

from . import db
from .intervals_client import IntervalsAuthError, IntervalsClient, IntervalsError

WINDOW_DAYS = 14
PACE_BAND = 20   # seconds wide, centred on the step's pace: GPS pace can't hold a tighter window

log = logging.getLogger("splitset_sync")


# ---------------------------------------------------------------- workout text

def km_txt(v: float) -> str:
    return f"{round(v, 2):g}km"


def plain(t: Any) -> str:
    """En dashes and middle dots confuse both the workout parser and the watch's display."""
    return str(t).replace("–", "-").replace("—", "-").replace("·", "-")


def pace_band(pace: str, width: int = PACE_BAND) -> str | None:
    """"4:10-4:15" or "4:12" -> a band `width` seconds wide around its middle."""
    secs = []
    for p in (x for x in re.split(r"[-–]", plain(pace)) if ":" in x):
        m, s = p.strip().split(":")
        secs.append(int(m) * 60 + int(s))
    if not secs:
        return None
    mid, half = round(sum(secs) / len(secs)), width // 2
    return "-".join(f"{v // 60}:{v % 60:02d}" for v in (mid - half, mid + half))


def step_lines(st: dict[str, Any]) -> list[str]:
    """One step as workout text. Steps without a pace get no target: an HR alarm on every easy
    kilometre teaches you to ignore the watch."""
    pace = plain(st.get("pace") or "")
    band = pace_band(pace) if pace[:1].isdigit() else None
    rep_line = f"- {km_txt(st['km'])} {f'{band} pace' if band else ''}".rstrip()
    reps = st.get("rep")
    if not reps:
        return [rep_line]
    if not st.get("recKm") or reps < 2:
        return [f"{reps}x", rep_line]
    # recovery goes between reps, not after the last one: repeat one fewer, then the final rep
    rec_line = f"- {km_txt(st['recKm'])}"
    first = [rep_line, rec_line] if reps == 2 else [f"{reps - 1}x", rep_line, rec_line]
    return first + ["", rep_line]


def steps_text(steps: list[dict[str, Any]]) -> str:
    """Blocks separated by blank lines: without one around an "Nx" the repeat is dropped."""
    blocks: list[list[str]] = []
    run: list[str] = []
    for st in steps:
        if st.get("rep"):
            if run:
                blocks.append(run)
                run = []
            blocks.append(step_lines(st))
        else:
            run += step_lines(st)
    if run:
        blocks.append(run)
    return "\n\n".join("\n".join(b) for b in blocks)


def steps_km(steps: list[dict[str, Any]]) -> float:
    return round(sum((st["rep"] * st["km"] + (st["rep"] - 1) * (st.get("recKm") or 0)) if st.get("rep")
                     else st.get("km", 0) for st in steps), 1)


def event_body(s: dict[str, Any]) -> dict[str, Any] | None:
    """The intervals.icu event for a session, or None when it shouldn't be on the watch."""
    if s.get("type") != "run" or s.get("subtype") == "race" or s.get("status") == "skipped":
        return None
    steps = s.get("steps") if isinstance(s.get("steps"), list) else None
    if steps:
        text, km = steps_text(steps), steps_km(steps)
    elif s.get("target_distance_m"):
        km = round(float(s["target_distance_m"]) / 1000, 2)
        text = f"- {km_txt(km)}"
    elif s.get("target_seconds"):
        km = 0
        text = f"- {round(int(s['target_seconds']) / 60)}m"
    else:
        return None
    return {
        "category": "WORKOUT",
        "type": "Run",
        "start_date_local": f"{s['date'].isoformat()}T00:00:00",
        "name": plain(f"{s['title']} - {km:g} km" if km else s["title"]),
        "description": text,
    }


def digest(body: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]


def sent_for(stamp: str | None) -> date | None:
    """The day an event was last sent for, from external_hash."""
    try:
        return date.fromisoformat((stamp or "").split(":", 1)[0])
    except ValueError:
        return None


# ---------------------------------------------------------------- what to do

@dataclass(frozen=True)
class Action:
    kind: Literal["create", "update", "delete"]
    session_id: str | None
    event_id: str | None = None
    body: dict[str, Any] | None = None
    stamp: str | None = None          # external_hash to store once it has gone through
    tombstone_id: int | None = None   # a deleted session's event


def plan_actions(sessions: list[dict[str, Any]], tombstones: list[dict[str, Any]], today: date,
                 days: int = WINDOW_DAYS) -> list[Action]:
    """Everything needed to make the intervals.icu calendar match the plan. Pure, for tests."""
    until = today + timedelta(days=days)
    out = [Action("delete", None, str(t["event_id"]), tombstone_id=t["id"]) for t in tombstones]
    for s in sessions:
        sid, eid, stamp = str(s["id"]), s.get("external_event_id"), s.get("external_hash")
        body = event_body(s) if today <= s["date"] < until else None
        if body:
            new = f"{s['date'].isoformat()}:{digest(body)}"
            if not eid:
                out.append(Action("create", sid, body=body, stamp=new))
            elif stamp != new:
                out.append(Action("update", sid, str(eid), body=body, stamp=new))
        elif eid and (sent := sent_for(stamp)) is not None and sent >= today:
            # skipped, changed to something that isn't a watch run, or moved out of the window
            out.append(Action("delete", sid, str(eid)))
    return out


# ---------------------------------------------------------------- doing it

def push_plan(conn: Any, client: IntervalsClient, user_id: Any, today: date, dry_run: bool,
              ulog: logging.LoggerAdapter | logging.Logger = log) -> int:
    """Apply plan_actions for one athlete. Returns how many calendar changes went through."""
    sessions = db.sessions_for_push(conn, user_id, today)
    tombstones = db.event_tombstones(conn, user_id)
    actions = plan_actions(sessions, tombstones, today)
    if not actions:
        ulog.info("plan: intervals.icu calendar is up to date")
        return 0
    done = 0
    for a in actions:
        what = a.body["name"] if a.body else f"event {a.event_id}"
        when = a.body["start_date_local"][:10] if a.body else ""
        ulog.info("plan: %s %s %s%s", a.kind, when, what, " (dry run)" if dry_run else "")
        if dry_run:
            continue
        try:
            if a.kind == "delete":
                client.delete_event(a.event_id)
                if a.tombstone_id is not None:
                    db.drop_event_tombstone(conn, a.tombstone_id)
                else:
                    db.set_session_event(conn, a.session_id, None, None)
            else:
                event = client.update_event(a.event_id, a.body) if a.kind == "update" else None
                if event is None:   # new, or deleted on intervals.icu since: create it
                    event = client.create_event(a.body)
                db.set_session_event(conn, a.session_id, str(event["id"]), a.stamp)
            conn.commit()
            done += 1
        except IntervalsAuthError:
            raise
        except IntervalsError as e:
            conn.rollback()
            ulog.warning("plan: %s failed, will retry next sync: %s", a.kind, e)
    return done
