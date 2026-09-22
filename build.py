#!/usr/bin/env python3
"""Inject activities.csv, wellness.csv, data/runs/*.json and data/coach.json into template.html
to produce dashboard.html (self-contained, works offline apart from map tiles).

    python3 build.py
    python3 build.py --race 2027-04-18 --race-name "Your Marathon" --goal "sub 3:00"

All the actual rendering logic lives in template.html as JavaScript; this script
only carries data across. That keeps the dashboard testable in a browser without
Python and keeps this file too boring to break.
"""

import argparse
import glob
import json
import hashlib
import os
import re
from datetime import datetime

import pandas as pd


def load_activities(path):
    # Before the first sync there is nothing to read. Build the empty shell rather than
    # crashing, so you can open the page and see the app before any data exists.
    if not os.path.exists(path):
        print(f"build: {path} not found - building an empty dashboard. Run sync.py first for real data.")
        return []
    # utf-8-sig throughout: sync.ps1 (PowerShell 5.1) writes a BOM, sync.py doesn't,
    # and either may have produced these files. utf-8-sig reads both.
    df = pd.read_csv(path, dtype={"id": str}, encoding="utf-8-sig")
    df = df[pd.to_numeric(df["distance_km"], errors="coerce") >= 0.5]
    df = df.sort_values("date")
    records = []
    for _, row in df.iterrows():
        rec = {}
        for col, val in row.items():
            if pd.isna(val) or val == "":
                continue
            if isinstance(val, float):
                val = round(val, 3)
            rec[col] = val
        records.append(rec)
    return records


def load_wellness(path, garmin_path=None):
    """The intervals.icu wellness feed, laid over the one-off Garmin export backfill
    (import_garmin.py). On a date both have, intervals.icu wins column by column;
    the backfill only fills what the live feed never received."""
    frames = []
    if not (path and os.path.exists(path)) and not (garmin_path and os.path.exists(garmin_path)):
        return []
    if os.path.exists(path):
        frames.append(pd.read_csv(path, encoding="utf-8-sig", dtype={"date": str}))
    if garmin_path and os.path.exists(garmin_path):
        frames.append(pd.read_csv(garmin_path, encoding="utf-8-sig", dtype={"date": str}))
    if not frames:
        return []
    df = frames[0].set_index("date")
    for extra in frames[1:]:
        df = df.combine_first(extra.set_index("date"))
    df = df.reset_index().sort_values("date")
    records = []
    for _, row in df.iterrows():
        rec = {}
        for col, val in row.items():
            if pd.isna(val) or val == "":
                continue
            if isinstance(val, float):
                val = round(val, 2)
            rec[col] = val
        records.append(rec)
    return records


def load_runs(dirpath):
    runs = {}
    for fp in glob.glob(os.path.join(dirpath, "*.json")):
        try:
            with open(fp, encoding="utf-8-sig") as f:
                rec = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("no_streams") or not rec.get("id"):
            continue
        runs[str(rec["id"])] = {k: v for k, v in rec.items() if k != "id"}
    return runs


def inject(template, block_id, payload):
    js = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    js = js.replace("</", "<\\/")  # never let data close the script tag
    pattern = re.compile(
        r'(<script[^>]*id="' + re.escape(block_id) + r'"[^>]*>).*?(</script>)',
        re.DOTALL,
    )
    if not pattern.search(template):
        raise SystemExit(f"template.html has no <script id=\"{block_id}\"> block")
    return pattern.sub(lambda m: m.group(1) + js + m.group(2), template, count=1)


def stamp_worker(path="sw.js"):
    """Give the service worker a version derived from what it actually caches.

    Icons and the manifest are served cache-first, so a new icon is never picked up until
    the cache name changes - which is how a rebuilt notification badge kept rendering as the
    old one. Hashing the worker plus the files it precaches means the version moves exactly
    when one of them does, and not otherwise.
    """
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    h = hashlib.sha1()
    h.update(re.sub(r'const VERSION = "[^"]*";', "", src).encode())
    for name in sorted(glob.glob("icons/*")) + ["manifest.webmanifest"]:
        if os.path.exists(name):
            with open(name, "rb") as f:
                h.update(f.read())
    ver = "v" + h.hexdigest()[:8]
    out = re.sub(r'const VERSION = "[^"]*";', f'const VERSION = "{ver}";', src, count=1)
    if out != src:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(out)
    return ver


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="activities.csv")
    ap.add_argument("--wellness", default="wellness.csv")
    ap.add_argument("--garmin", default="garmin_wellness.csv",
                    help="one-off Garmin export backfill from import_garmin.py")
    ap.add_argument("--runs-dir", default=os.path.join("data", "runs"))
    ap.add_argument("--template", default="template.html")
    ap.add_argument("--plan", default="plan_seed.json",
                    help="starting training plan; edits made on the site are stored in Cloudflare KV")
    ap.add_argument("--gym", default="gym_programs.json",
                    help="exercise library and physio workouts; the gym log lives in Cloudflare KV")
    ap.add_argument("--coach", default=os.path.join("data", "coach.json"),
                    help="morning briefs and run debriefs written by coach.py")
    ap.add_argument("--shoes", default="shoes.json",
                    help="shoe catalogue; picks made on the site are stored in Cloudflare KV")
    ap.add_argument("--shoe-history", default=os.path.join("data", "shoe_history.json"),
                    help="which shoes past runs were in, from import_shoes.py")
    ap.add_argument("--push", default="push.json",
                    help="web push settings; the public key the browser subscribes with")
    ap.add_argument("--videos", default="videos.json",
                    help="Runna's warm-up and cool-down routines to embed on a session")
    ap.add_argument("--race-plan", default="race_plan.json",
                    help="course, drink stations, fuelling and race-morning timeline")
    ap.add_argument("--race", default="")
    ap.add_argument("--race-name", default="Goal race")
    ap.add_argument("--goal", default="")
    ap.add_argument("--out", default="dashboard.html")
    a = ap.parse_args()

    with open(a.template, encoding="utf-8") as f:
        page = f.read()

    activities = load_activities(a.csv)
    wellness = load_wellness(a.wellness, a.garmin)
    runs = load_runs(a.runs_dir)
    # HR zone bounds ride on each activity (hr_zones), so nothing global here.
    meta = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "race": {"name": a.race_name, "date": a.race, "goal": a.goal},
        "build": {
            "run": os.environ.get("GITHUB_RUN_NUMBER") or "",
            "runId": os.environ.get("GITHUB_RUN_ID") or "",
            "sha": (os.environ.get("GITHUB_SHA") or "")[:7],
            "repo": os.environ.get("GITHUB_REPOSITORY") or "",
        },
        "sw": stamp_worker(),
    }

    page = inject(page, "DATA_ACTIVITIES", activities)
    page = inject(page, "DATA_WELLNESS", wellness)
    page = inject(page, "DATA_RUNS", runs)
    page = inject(page, "DATA_META", meta)
    plan = None
    if os.path.exists(a.plan):
        with open(a.plan, encoding="utf-8-sig") as f:
            plan = json.load(f)
    page = inject(page, "DATA_PLAN", plan)
    gym = None
    if os.path.exists(a.gym):
        with open(a.gym, encoding="utf-8-sig") as f:
            gym = json.load(f)
    page = inject(page, "DATA_GYM", gym)
    coach = None
    if os.path.exists(a.coach):
        with open(a.coach, encoding="utf-8-sig") as f:
            coach = json.load(f)
    page = inject(page, "DATA_COACH", coach)
    shoes = None
    if os.path.exists(a.shoes):
        with open(a.shoes, encoding="utf-8-sig") as f:
            shoes = json.load(f)
        shoes.pop("about", None)
        history = {}
        if os.path.exists(a.shoe_history):
            with open(a.shoe_history, encoding="utf-8-sig") as f:
                history = json.load(f).get("runs", {})
        shoes["history"] = history
    page = inject(page, "DATA_SHOES", shoes)
    race = None
    if os.path.exists(a.race_plan):
        with open(a.race_plan, encoding="utf-8-sig") as f:
            race = json.load(f)
        race.pop("about", None)
    page = inject(page, "DATA_RACEPLAN", race)
    videos = None
    if os.path.exists(a.videos):
        with open(a.videos, encoding="utf-8-sig") as f:
            videos = json.load(f)
        videos.pop("about", None)
    page = inject(page, "DATA_VIDEOS", videos)
    push = None
    if os.path.exists(a.push):
        with open(a.push, encoding="utf-8-sig") as f:
            push = json.load(f)
        push.pop("about", None)
    page = inject(page, "DATA_PUSH", push)

    with open(a.out, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"Wrote {a.out}: {len(activities)} runs, {len(wellness)} wellness days, "
          f"{len(runs)} runs with detail ({os.path.getsize(a.out) // 1024} KB)")


if __name__ == "__main__":
    main()
