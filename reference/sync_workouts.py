#!/usr/bin/env python3
"""Push the plan's runs to intervals.icu as planned workouts, which sends them to the watch.

intervals.icu holds the Garmin connection, so a workout written to its calendar appears in
Garmin Connect and on the watch, where pressing Run offers it. Runna's workouts (if you still
sync those) sit alongside these, so the watch will ask which one you're doing.

    python sync_workouts.py --dry-run     # print the workouts, send nothing
    python sync_workouts.py               # push the next 14 days
    python sync_workouts.py --days 21
    python sync_workouts.py --clear       # remove everything this script created

What it sends, and what it doesn't:
  - runs only. Gym sessions go to your calendar app through the .ics feed instead
  - never race day: a watch workout beeping pace targets is the last thing you need there
  - only the window ahead, so the watch calendar stays tidy

data/workout_sync.json remembers which intervals.icu event belongs to which session, so a
session that moves or changes is updated rather than duplicated, and one you delete is removed.

Workout text syntax (worked out against the API, since it isn't documented):
  - distances must be in km: "0.4km", never "400m", which is read as 400 minutes
  - pace targets are "- 5km 3:52-3:58 pace"
  - heart rate is a percentage: "- 12km 75-83% LTHR" (that's about 135-150 bpm at LTHR 181)
"""

import argparse
import hashlib
import json
import os
import re
from datetime import date, timedelta

import requests

from sync import API_ROOT, read_dotenv, session

STATE = os.path.join("data", "workout_sync.json")
RUN_TYPES = {"easy", "recovery", "long", "tempo", "intervals", "mp", "hmp"}
# his easy band, 135-150 bpm, as a share of LTHR 181
EASY_HR = "75-83% LTHR"
HILL_HR = "88-95% LTHR"   # hill reps run by effort; a pace target on a climb is noise
PACE_BAND = 20   # seconds wide, centred on the session's target pace
RECOVERY_PACE = "5:30-7:00 pace"
HARD_KINDS = {"tempo", "interval", "mp", "hmp", "hills"}


def km_txt(v):
    return f"{round(v, 2):g}km"


def plain(t):
    """en dashes and middle dots confuse both the workout parser and the watch's display"""
    return str(t).replace("–", "-").replace("—", "-").replace("·", "-")


def pace_band(pace, width=PACE_BAND):
    """A target pace with a band around it, matching what the dashboard shows. GPS pace can't
    hold a 6-second window, so the watch would just beep at you."""
    parts = [p for p in re.split(r"[-–]", plain(pace)) if ":" in p]
    secs = []
    for p in parts:
        m, s = p.strip().split(":")
        secs.append(int(m) * 60 + int(s))
    if not secs:
        return None
    mid, half = round(sum(secs) / len(secs)), width // 2
    return "-".join(f"{v // 60}:{v % 60:02d}" for v in (mid - half, mid + half))


def step_lines(st, after_hard=False):
    """One plan step as intervals.icu workout text.

    Easy steps that come after the hard work - the floats between reps, the run home - get
    no target at all. Heart rate stays 10 to 15 beats up for the rest of a session once
    you've run hard, so an easy-HR target there alarms continuously for an hour and teaches
    you to ignore the watch. The opening easy block keeps its target, where it does the job
    of stopping you starting too fast.
    """
    pace = plain(st.get("pace") or "")
    band = pace_band(pace) if pace and pace[0].isdigit() else None
    if band:
        target = f"{band} pace"
    elif st.get("kind") == "hills":
        target = HILL_HR
    elif after_hard:
        target = ""
    else:
        target = EASY_HR
    rep_line = f"- {km_txt(st['km'])} {target}".rstrip()
    if not st.get("rep"):
        return [rep_line]
    if not st.get("recKm") or st["rep"] < 2:
        return [f"{st['rep']}x", rep_line]
    # recovery goes between reps, not after the last one, so repeat one fewer and add the
    # final rep on its own - otherwise the session comes out a recovery longer than planned
    jog = "jog" in str(st.get("recNote") or "").lower()
    # a jog recovery keeps its wide pace band; a float between race-pace blocks gets nothing,
    # and the reps it follows are hard by definition even if nothing before them was
    rec_hard = after_hard or st.get("kind") in HARD_KINDS
    rec_target = RECOVERY_PACE if jog else ("" if rec_hard else EASY_HR)
    rec_line = f"- {km_txt(st['recKm'])} {rec_target}".rstrip()
    first = [rep_line, rec_line] if st["rep"] == 2 else [f"{st['rep'] - 1}x", rep_line, rec_line]
    return first + ["", rep_line]


def workout_text(s):
    """Blocks separated by blank lines: without one around an "Nx", the repeat is dropped
    and the reps collapse into a single step."""
    if s.get("steps"):
        blocks, plainRun, hard = [], [], False
        for st in s["steps"]:
            lines = step_lines(st, hard)
            if st.get("kind") in HARD_KINDS:
                hard = True
            if st.get("rep"):
                if plainRun:
                    blocks.append(plainRun); plainRun = []
                blocks.append(lines)
            else:
                plainRun += lines
        if plainRun:
            blocks.append(plainRun)
        return "\n\n".join("\n".join(b) for b in blocks)
    km = s.get("km") or 0
    return f"- {km_txt(km)} {EASY_HR}" if km else ""


def session_km(s):
    if s.get("steps"):
        return round(sum((st["rep"] * st["km"] + (st["rep"] - 1) * (st.get("recKm") or 0))
                         if st.get("rep") else st.get("km", 0) for st in s["steps"]), 1)
    return s.get("km") or 0


def load_plan(allow_seed):
    """The plan the site is showing, from Cloudflare KV.

    Without KV we'd be looking at plan_seed.json, which doesn't have the sessions you've moved
    on the site: it would delete and recreate workouts on the watch to match a plan you're not
    following. So unless you ask for it, no KV means no sync this time."""
    from coach import kv_doc   # shares the same Cloudflare credentials
    plan, why = kv_doc("plan")
    if plan and isinstance(plan.get("sessions"), list):
        print(f"plan from Cloudflare KV ({len(plan['sessions'])} sessions)")
        return plan
    if not allow_seed:
        print(f"skipping: can't read the live plan ({why}). Use --allow-seed to sync plan_seed.json instead.")
        return None
    print(f"using plan_seed.json - KV unavailable: {why}")
    with open("plan_seed.json", encoding="utf-8-sig") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14, help="how far ahead to push (default 14)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--clear", action="store_true", help="delete everything this script created")
    ap.add_argument("--allow-seed", action="store_true",
                    help="sync plan_seed.json when the live plan can't be read (it ignores your edits)")
    args = ap.parse_args()

    env = read_dotenv()
    aid = os.environ.get("INTERVALS_ATHLETE_ID") or env.get("INTERVALS_ATHLETE_ID")
    key = os.environ.get("INTERVALS_API_KEY") or env.get("INTERVALS_API_KEY")
    if not aid or not key:
        raise SystemExit("No intervals.icu credentials")
    if not str(aid).startswith("i"):
        aid = f"i{aid}"
    s = session(key)
    base = f"{API_ROOT}/athlete/{aid}/events"

    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8-sig") as f:
            state = json.load(f).get("events", {})

    today = date.today()
    until = today + timedelta(days=args.days)
    wanted = {}
    if not args.clear:
        plan = load_plan(args.allow_seed)
        if plan is None:
            return
        for x in plan.get("sessions", []):
            if x.get("type") not in RUN_TYPES or not x.get("date") or x.get("skipped"):
                continue
            if not (today.isoformat() <= x["date"] <= until.isoformat()):
                continue
            text = workout_text(x)
            if not text:
                continue
            km = session_km(x)
            wanted[x["id"]] = {
                "start_date_local": f"{x['date']}T00:00:00",
                "category": "WORKOUT", "type": "Run",
                "name": plain(f"{x['title']}{f' - {km:g} km' if km else ''}"),
                "description": text,
            }

    def digest(body):
        return hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]

    changed = False
    # gone from the window, moved, or deleted from the plan
    for sid, rec in list(state.items()):
        if sid in wanted and digest(wanted[sid]) == rec.get("hash"):
            continue
        if sid in wanted and not args.clear:
            body = wanted.pop(sid)
            print(f"update  {body['start_date_local'][:10]}  {body['name']}")
            if args.dry_run:
                continue
            r = s.put(f"{base}/{rec['event_id']}", json=body, timeout=60)
            if r.ok:
                state[sid] = {"event_id": rec["event_id"], "hash": digest(body), "date": body["start_date_local"][:10]}
                changed = True
                continue
            print(f"  update failed ({r.status_code}), recreating")
            wanted[sid] = body   # fall through to a fresh create below
        print(f"remove  {rec.get('date')}  event {rec['event_id']}")
        if args.dry_run:
            continue
        r = s.delete(f"{base}/{rec['event_id']}", timeout=60)
        if r.ok or r.status_code == 404:
            state.pop(sid, None)
            changed = True
        else:
            print(f"  delete failed: {r.status_code} {r.text[:120]}")

    for sid, body in wanted.items():
        if sid in state:
            continue
        print(f"create  {body['start_date_local'][:10]}  {body['name']}")
        print("        " + body["description"].replace("\n", "\n        "))
        if args.dry_run:
            continue
        try:
            r = s.post(base, json=body, timeout=60)
        except requests.RequestException as e:
            print(f"  failed: {e.__class__.__name__}")
            continue
        if not r.ok:
            print(f"  failed: {r.status_code} {r.text[:200]}")
            continue
        state[sid] = {"event_id": r.json()["id"], "hash": digest(body), "date": body["start_date_local"][:10]}
        changed = True

    if changed and not args.dry_run:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump({"events": state}, f, indent=0, sort_keys=True)
    print(f"{len(state)} workouts on the intervals.icu calendar")


if __name__ == "__main__":
    main()
