#!/usr/bin/env python3
"""Morning brief and post-run debriefs, written by Claude from the dashboard's own data.

Runs in the GitHub workflow between sync.py and build.py:
  - a debrief for each run from the last couple of days that doesn't have one yet
  - one morning brief a day (Melbourne time), written by the first build between 3am and 2pm

Both land in data/coach.json, which build.py puts into the page.

Claude is reached through the Claude Code CLI using CLAUDE_CODE_OAUTH_TOKEN (made with
`claude setup-token`), so it runs on the Claude subscription rather than API billing.
Without that token this script prints a note and does nothing. It never fails the build.

    python coach.py                      # what the workflow runs
    python coach.py --dry-run            # print the prompts instead of calling Claude
    python coach.py --brief              # write today's brief even if one exists
    python coach.py --debrief i123456789 # rewrite one run's debrief

The plan and gym log are read from Cloudflare KV (where the site saves them) when
CLOUDFLARE_API_TOKEN can read Workers KV; otherwise the plan falls back to plan_seed.json.
"""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import requests

COACH_PATH = os.path.join("data", "coach.json")
RUNS_DIR = os.path.join("data", "runs")
PROMPT_PATH = "coach_prompt.md"
KV_NAMESPACE = os.environ.get("PLAN_KV_ID", "")   # the KV namespace id, from the Cloudflare dashboard
# where the weather comes from: override with HOME_LAT / HOME_LON for anywhere else
HOME = (float(os.environ.get("HOME_LAT", -37.81)), float(os.environ.get("HOME_LON", 144.96)))
DEBRIEF_DAYS = 2        # runs older than this never get a debrief (so no history backfill)
MAX_DEBRIEFS = 4        # per build
BRIEF_HOURS = (3, 14)   # local hours in which a missing brief gets written
KEEP_BRIEFS = 45

STEP_LABEL = {"easy": "easy", "steady": "steady", "tempo": "tempo", "interval": "interval",
              "mp": "marathon pace", "hmp": "half pace", "strides": "strides"}
HARD_STEPS = {"tempo", "interval", "mp", "hmp", "hills"}
TYPE_LABEL = {"easy": "easy", "recovery": "recovery", "long": "long run", "tempo": "tempo",
              "intervals": "intervals", "mp": "marathon pace", "hmp": "half-marathon pace",
              "race": "RACE", "strength": "gym", "xt": "cross-training"}
RUN_TYPES = {"easy", "recovery", "long", "tempo", "intervals", "mp", "hmp", "race"}


# ---------------------------------------------------------------- time

def melbourne_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(os.environ.get("COACH_TZ", "Australia/Melbourne")))
    except Exception:
        # no tz database (bare Windows Python): AEST is close enough to pick the day
        return datetime.now(timezone(timedelta(hours=10)))


def d(key):
    return date.fromisoformat(str(key)[:10])


def day_label(key):
    x = d(key)
    return f"{x:%a} {x.day} {x:%b}"


def fmt_pace(sec_per_km):
    if not sec_per_km or not math.isfinite(sec_per_km):
        return "?"
    s = int(round(sec_per_km))
    return f"{s // 60}:{s % 60:02d}/km"


def fmt_dur(sec):
    s = int(round(sec or 0))
    h, m = divmod(s // 60, 60)
    return f"{h}:{m:02d}:{s % 60:02d}" if h else f"{m}:{s % 60:02d}"


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def nums(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    out = [num(x) for x in str(v).split("|")]
    out = [x for x in out if x is not None]
    return out or None


# ---------------------------------------------------------------- data

def load_activities():
    df = pd.read_csv("activities.csv", dtype={"id": str}, encoding="utf-8-sig")
    df = df[pd.to_numeric(df["distance_km"], errors="coerce") >= 0.5]
    rows = []
    for rec in df.sort_values("date").to_dict("records"):
        rec = {k: v for k, v in rec.items() if not (isinstance(v, float) and math.isnan(v))}
        rec["date"] = str(rec["date"])[:10]
        rows.append(rec)
    return rows


def load_wellness():
    frames = []
    for path in ("wellness.csv", "garmin_wellness.csv"):
        if os.path.exists(path):
            frames.append(pd.read_csv(path, encoding="utf-8-sig", dtype={"date": str}).set_index("date"))
    if not frames:
        return {}
    df = frames[0]
    for extra in frames[1:]:
        df = df.combine_first(extra)
    out = {}
    for key, rec in df.sort_index().to_dict("index").items():
        out[str(key)[:10]] = {k: v for k, v in rec.items() if num(v) is not None}
    return out


def load_run_detail(act_id):
    path = os.path.join(RUNS_DIR, f"{act_id}.json")
    if not act_id or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8-sig") as f:
            rec = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return None if rec.get("no_streams") else rec


def kv_doc(key):
    """One document the site saved to Cloudflare KV, or (None, reason)."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        return None, "no Cloudflare credentials in the environment"
    url = (f"https://api.cloudflare.com/client/v4/accounts/{account}"
           f"/storage/kv/namespaces/{KV_NAMESPACE}/values/{key}")
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    except requests.RequestException as e:
        return None, f"network error ({e.__class__.__name__})"
    if r.status_code == 404:
        return None, "nothing saved yet"
    if r.status_code in (401, 403):
        return None, ("the Cloudflare API token can't read Workers KV "
                      "(add Account > Workers KV Storage > Read to it)")
    if not r.ok:
        return None, f"Cloudflare returned {r.status_code}"
    try:
        stored = r.json()
    except ValueError:
        return None, "not JSON"
    # the site wraps each document as {data, updated}; the plan was first saved as {plan, updated}
    return stored.get("data") or stored.get("plan"), None


def load_plan(gym):
    seed = None
    if os.path.exists("plan_seed.json"):
        with open("plan_seed.json", encoding="utf-8-sig") as f:
            seed = json.load(f)
    plan, why = kv_doc("plan")
    if plan and isinstance(plan.get("sessions"), list):
        print(f"coach: plan from Cloudflare KV ({len(plan['sessions'])} sessions)")
        # same as the page's attachWorkouts(): gym sessions saved before workouts existed
        if seed:
            by_id = {s["id"]: s for s in seed.get("sessions", []) if s.get("workout")}
            for s in plan["sessions"]:
                if s.get("type") == "strength" and not s.get("workout") and s.get("id") in by_id:
                    s["workout"] = by_id[s["id"]]["workout"]
        for k in ("races", "phases", "paces"):
            if seed and not plan.get(k):
                plan[k] = seed.get(k)
        return plan
    print(f"coach: using plan_seed.json - KV plan unavailable: {why}")
    return seed or {"sessions": []}


# ---------------------------------------------------------------- plan text

def step_span(st):
    if st.get("rep"):
        return st["rep"] * st.get("km", 0) + (st["rep"] - 1) * (st.get("recKm") or 0)
    return st.get("km", 0)


def session_km(s):
    if s.get("steps"):
        return round(sum(step_span(st) for st in s["steps"]), 1)
    return s.get("km") or 0


def spans(s):
    out, at = [], 0.0
    for st in s.get("steps") or []:
        n = step_span(st)
        out.append({**st, "start": round(at, 1), "end": round(at + n, 1)})
        at += n
    return out


def km_txt(v):
    return str(int(round(v))) if abs(v - round(v)) < 0.05 else f"{v:.1f}"


def step_text(st):
    what = STEP_LABEL.get(st.get("kind"), st.get("kind", ""))
    pace = ""
    if st.get("pace"):
        pace = f" @ {st['pace']}/km" if re.match(r"^\d", st["pace"]) else f" ({st['pace']})"
    note = f" - {st['note']}" if st.get("note") else ""
    if st.get("rep"):
        rep_len = f"{round(st['km'] * 1000)} m" if st["km"] < 1 else f"{km_txt(st['km'])} km"
        rec = ""
        if st.get("recKm"):
            rec_len = f"{km_txt(st['recKm'])} km" if st["recKm"] >= 1 else f"{round(st['recKm'] * 1000)} m"
            rec = f", {rec_len} {st.get('recNote') or 'easy'} between"
        return f"{st['rep']} x {rep_len} {what}{pace}{rec}{note}"
    return f"{km_txt(st.get('km', 0))} km {what}{pace}{note}"


def describe_session(s, gym):
    kind = s.get("type", "easy")
    bits = [f"{s.get('title') or TYPE_LABEL.get(kind, kind)} [{TYPE_LABEL.get(kind, kind)}]"]
    if kind in RUN_TYPES:
        bits.append(f"{km_txt(session_km(s))} km")
    if s.get("minutes"):
        bits.append(f"{s['minutes']} min")
    if s.get("workout"):
        name = ((gym.get("workouts") or {}).get(s["workout"]) or {}).get("name", s["workout"])
        bits.append(f"physio workout {name}{' (light)' if s.get('light') else ''}")
    if s.get("commute"):
        bits.append(f"commute ({s['commute']})")
    text = ", ".join(bits)
    if s.get("steps"):
        text += "; " + "; ".join(f"km {km_txt(sp['start'])}-{km_txt(sp['end'])}: {step_text(sp)}"
                                 for sp in spans(s))
    if s.get("notes"):
        text += f'. Notes: "{s["notes"]}"'
    return text


def sessions_on(plan, key):
    """Sessions on a day, less any you've deliberately skipped - those are not still to come."""
    return [s for s in plan.get("sessions", []) if s.get("date") == key and not s.get("skipped")]


# ---------------------------------------------------------------- shoes (mirrors the page's logic)

SHOE_ADJ = {"active": 0, "backup": -1.5, "retiring": -3}   # other statuses are never suggested
SHOE_ROLES = {
    "Daily trainer": {"mp": 1, "workout": 2, "long": 3, "easy": 3, "recovery": 2, "trail": 1},
    "Super trainer": {"race": 1, "mp": 2, "workout": 3, "long": 3, "easy": 1, "recovery": 0, "trail": 0},
    "Stability": {"workout": 1, "long": 3, "easy": 3, "recovery": 3, "trail": 1},
    "Race day": {"race": 3, "mp": 3, "workout": 1, "trail": 0},
    "Light trainer": {"workout": 2, "long": 1, "easy": 2, "recovery": 2, "trail": 1},
    "Trail": {"trail": 3, "long": 2, "easy": 2, "recovery": 1},
    "Other": {"easy": 1, "recovery": 1},
}


def load_shoes(acts):
    """Catalogue + Garmin history + picks made on the site (KV), with km per pair."""
    if not os.path.exists("shoes.json"):
        return None
    with open("shoes.json", encoding="utf-8-sig") as f:
        shoes = json.load(f)["shoes"]
    history = {}
    path = os.path.join("data", "shoe_history.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            history = json.load(f).get("runs", {})
    doc, why = kv_doc("shoes")
    if why:
        print(f"coach: shoe picks from the site unavailable ({why})")
    doc = doc or {}
    edits, runs = doc.get("edits") or {}, doc.get("runs") or {}
    catalogue = [{**s, **edits.get(s["id"], {})} for s in shoes]
    catalogue += [{**s, "id": sid, **edits.get(sid, {})} for sid, s in (doc.get("added") or {}).items()]

    def run_shoe(act_id):
        if act_id in runs and "shoe" in runs[act_id]:
            return runs[act_id]["shoe"]
        return history.get(act_id)

    km = {s["id"]: s.get("offsetKm", 0) for s in catalogue}
    by_date = {}
    for a in acts:
        sid = run_shoe(a.get("id"))
        if sid in km:
            km[sid] += num(a.get("distance_km")) or 0
            by_date.setdefault(a["date"], []).append(sid)
    return {"list": catalogue, "by_id": {s["id"]: s for s in catalogue}, "km": km, "by_date": by_date, "run_shoe": run_shoe}


def session_shoe_kind(s):
    km, steps = session_km(s), s.get("steps") or []
    if s.get("trail"):
        return "trail"
    if s.get("type") == "race":
        return "race"
    # race shoes are for rehearsals only, not every long run holding marathon-pace blocks
    if s.get("rehearsal") or re.search(r"race shoes|dress rehearsal", s.get("notes") or "", re.I):
        return "mp"
    if s.get("type") in ("tempo", "intervals", "mp", "hmp"):
        return "workout"
    if s.get("type") == "long" or km >= 18:
        return "long"
    if any(st.get("kind") in HARD_STEPS for st in steps):
        return "workout"
    if s.get("type") == "recovery" or km <= 6:
        return "recovery"
    return "easy"


ROT_DAYS, ROT_W, ROT_MIN = 14, 1.6, 20


def load_window(shoes, acts, date):
    """How much of the fortnight before `date` each pair took, as a share of its running."""
    km, total, first = {}, 0.0, (date - timedelta(days=ROT_DAYS)).isoformat()
    for a in acts:
        if not (first <= a["date"] < date.isoformat()):
            continue
        sid, dist = shoes["run_shoe"](a.get("id")), num(a.get("distance_km")) or 0
        if sid and dist > 0:
            km[sid] = km.get(sid, 0) + dist
            total += dist
    return {"km": km, "total": total,
            "share": (lambda sid: km.get(sid, 0) / total if total >= ROT_MIN else 0)}


def suggest_shoe(shoes, kind, worn_day_before, load=None):
    cands = []
    for s in shoes["list"]:
        fit = (s.get("fit") or SHOE_ROLES.get(s.get("role"), SHOE_ROLES["Other"])).get(kind, 0)
        if s.get("status", "active") not in SHOE_ADJ or fit <= 0:
            continue
        km, top = shoes["km"].get(s["id"], 0), s.get("maxKm") or 650
        score = fit + SHOE_ADJ[s.get("status", "active")] - km / 1e5
        score -= 3 if km >= top else 0.5 if km >= top * 0.9 else 0
        score -= 1.2 if s["id"] in worn_day_before else 0
        score -= ROT_W * load["share"](s["id"]) if load else 0
        cands.append((score, s))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[0])
    best = cands[0][1]
    return best, (best.get("why") or {}).get(kind) or best.get("note", "")


def shoe_line(shoes, s):
    km, top = shoes["km"].get(s["id"], 0), s.get("maxKm") or 650
    return f"{s['name']} ({s.get('model', '')}, {km:.0f} of {top:.0f} km{', past its limit' if km >= top else ''})"


# ---------------------------------------------------------------- run text

def zone_text(a):
    times, bounds = nums(a.get("hr_zone_times")), nums(a.get("hr_zones"))
    if not times or sum(times) <= 0:
        return None
    total = sum(times)
    parts = []
    lo = None
    for i, t in enumerate(times):
        if t <= 0:
            lo = bounds[i] if bounds and i < len(bounds) else None
            continue
        hi = bounds[i] if bounds and i < len(bounds) else None
        rng = f"<={int(hi)}" if lo is None and hi else (f"{int(lo) + 1}-{int(hi)}" if lo and hi else "")
        parts.append(f"Z{i + 1}{' ' + rng if rng else ''} bpm {round(100 * t / total)}%")
        lo = hi
    return ", ".join(parts)


def run_line(a):
    km = num(a.get("distance_km")) or 0
    t = num(a.get("moving_time_s"))
    bits = [f"{day_label(a['date'])}", f'"{a.get("name", "Run")}"', f"{km:.1f} km"]
    if t and km:
        bits.append(fmt_pace(t / km))
    if num(a.get("avg_hr")):
        bits.append(f"HR {int(a['avg_hr'])} avg / {int(num(a.get('max_hr')) or 0)} max")
    if num(a.get("load")):
        bits.append(f"load {int(a['load'])}")
    z = nums(a.get("hr_zone_times"))
    if z and sum(z):
        easy = sum(z[:2]) / sum(z)
        bits.append(f"{round(easy * 100)}% in Z1-2")
    return " | ".join(bits)


def split_segments(session, splits):
    """Average pace/HR over each planned segment of 2 km or more, assuming the run followed
    the plan's order from the start. Shorter reps can't be read from whole-km splits."""
    out = []
    by_k = {sp["k"]: sp for sp in splits}

    def seg(start, end, label):
        ks = [k for k in by_k if start <= k - 0.5 <= end]
        if len(ks) < 2:
            return
        t = sum(by_k[k]["t"] for k in ks)
        hrs = [by_k[k]["hr"] for k in ks if by_k[k].get("hr")]
        hr = f", HR {round(sum(hrs) / len(hrs))}" if hrs else ""
        out.append(f"{label} (km {min(ks)}-{max(ks)} splits): {fmt_pace(t / len(ks))}{hr}")

    for sp in spans(session):
        if sp.get("kind") not in HARD_STEPS:
            continue
        if sp.get("rep"):
            if sp.get("km", 0) < 2:
                continue
            at = sp["start"]
            for i in range(sp["rep"]):
                seg(at, at + sp["km"], f"rep {i + 1}/{sp['rep']}: {step_text({**sp, 'rep': None})}")
                at += sp["km"] + (sp.get("recKm") or 0)
        elif sp.get("km", 0) >= 2:
            seg(sp["start"], sp["end"], step_text(sp))
    return out


def drift_text(splits):
    """First half vs second half of the run: pace, HR, and speed per heartbeat."""
    if len(splits) < 6 or not all(sp.get("hr") for sp in splits):
        return None
    half = len(splits) // 2
    a, b = splits[:half], splits[half:]
    pa, pb = sum(s["t"] for s in a) / len(a), sum(s["t"] for s in b) / len(b)
    ha, hb = sum(s["hr"] for s in a) / len(a), sum(s["hr"] for s in b) / len(b)
    eff = ((1000 / pb) / hb) / ((1000 / pa) / ha) - 1
    return (f"first half {fmt_pace(pa)} at {ha:.0f} bpm, second half {fmt_pace(pb)} at {hb:.0f} bpm "
            f"(speed per heartbeat {eff * 100:+.1f}%)")


def run_detail_text(a):
    km = num(a.get("distance_km")) or 0
    t = num(a.get("moving_time_s"))
    lines = [f'Name: "{a.get("name", "Run")}" on {day_label(a["date"])} {a["date"][:4]}']
    stat = [f"{km:.2f} km"]
    if t:
        stat.append(f"moving {fmt_dur(t)}")
        if km:
            stat.append(f"avg {fmt_pace(t / km)}")
    if num(a.get("elapsed_time_s")) and t and a["elapsed_time_s"] - t > 90:
        stat.append(f"elapsed {fmt_dur(a['elapsed_time_s'])} (stops)")
    if num(a.get("gap_ms")):
        stat.append(f"grade-adjusted {fmt_pace(1000 / a['gap_ms'])}")
    lines.append("Summary: " + ", ".join(stat))
    phys = []
    for key, label, unit in (("avg_hr", "avg HR", " bpm"), ("max_hr", "max HR", " bpm"),
                             ("cadence_spm", "cadence", " spm"), ("elev_gain_m", "climb", " m"),
                             ("avg_temp_c", "watch temp", " C"), ("load", "training load", ""),
                             ("intensity", "intensity", "%")):
        v = num(a.get(key))
        if v is not None:
            phys.append(f"{label} {v:.0f}{unit}")
    if num(a.get("gct_ms")):
        phys.append(f"ground contact {a['gct_ms']:.0f} ms")
    if num(a.get("vert_osc_cm")):
        phys.append(f"vertical oscillation {a['vert_osc_cm']:.1f} cm")
    if phys:
        lines.append("Body: " + ", ".join(phys))
    z = zone_text(a)
    if z:
        lines.append(f"HR zones (intervals.icu bands, LTHR {int(num(a.get('lthr')) or 0)}): {z}")
    det = load_run_detail(a.get("id"))
    if det and det.get("splits"):
        rows = []
        for sp in det["splits"]:
            bit = f"{sp['k']}: {fmt_pace(sp['t'])}"
            if sp.get("hr"):
                bit += f" {sp['hr']}"
            if sp.get("el"):
                bit += f" +{sp['el']}m"
            rows.append(bit)
        lines.append("Km splits (pace, HR, climb; times include any stops, so one slow km can be "
                     "lights or a gel): " + " | ".join(rows))
        dr = drift_text(det["splits"])
        if dr:
            lines.append("Drift: " + dr)
    elif not det:
        lines.append("No per-km splits for this run.")
    if det and det.get("efforts"):
        names = {"1000": "1 km", "5000": "5 km", "10000": "10 km", "21097": "half", "42195": "marathon"}
        best = [f"{names[k]} {fmt_dur(v)}" for k, v in det["efforts"].items() if k in names]
        if best:
            lines.append("Fastest stretches inside the run: " + ", ".join(best))
    return lines, det


# ---------------------------------------------------------------- context shared by both

def weekly_km(acts, today, weeks=6):
    monday = today - timedelta(days=today.weekday())
    rows = []
    for w in range(weeks - 1, -1, -1):
        start = monday - timedelta(days=7 * w)
        km = sum(num(a.get("distance_km")) or 0 for a in acts
                 if start <= d(a["date"]) < start + timedelta(days=7))
        rows.append(f"wk of {start.day} {start:%b}: {km:.0f} km{' (so far)' if w == 0 else ''}")
    return rows


def planned_week_km(plan, monday):
    return sum(session_km(s) for s in plan.get("sessions", [])
               if s.get("type") in RUN_TYPES and monday <= d(s["date"]) < monday + timedelta(days=7))


def wellness_lines(well, today, days=8):
    lines = []
    for i in range(days - 1, -1, -1):
        key = (today - timedelta(days=i)).isoformat()
        w = well.get(key)
        if not w:
            lines.append(f"{day_label(key)}: no data")
            continue
        bits = []
        if "resting_hr" in w:
            bits.append(f"RHR {w['resting_hr']:.0f}")
        if "hrv" in w:
            bits.append(f"HRV {w['hrv']:.0f}")
        if "sleep_s" in w:
            bits.append(f"sleep {w['sleep_s'] / 3600:.1f} h")
        if "sleep_score" in w:
            bits.append(f"sleep score {w['sleep_score']:.0f}")
        if "ctl" in w and "atl" in w:
            bits.append(f"fitness {w['ctl']:.0f} / fatigue {w['atl']:.0f} / form {w['ctl'] - w['atl']:+.0f}")
        lines.append(f"{day_label(key)}: " + (", ".join(bits) or "no data"))

    def mean(field, back):
        vals = [well[k][field] for k in well
                if field in well[k] and today - timedelta(days=back) <= d(k) < today]
        return (sum(vals) / len(vals), len(vals)) if vals else (None, 0)

    base = []
    for field, label, back in (("hrv", "HRV", 7), ("hrv", "HRV", 60), ("resting_hr", "resting HR", 30)):
        m, n = mean(field, back)
        if m is not None:
            base.append(f"{label} {back}-day mean {m:.0f} ({n} readings)")
    if base:
        lines.append("Baselines (before today): " + "; ".join(base))
    return lines


def gym_lines(gym_log, gym, today, days=14):
    logs = (gym_log or {}).get("logs") or {}
    out = []
    for key in sorted(logs):
        if not (today - timedelta(days=days) <= d(key) <= today):
            continue
        rec = logs[key] or {}
        ticked = sum(1 for v in (rec.get("sets") or {}).values() if isinstance(v, dict) and v.get("done"))
        name = ((gym.get("workouts") or {}).get(rec.get("workout")) or {}).get("name", rec.get("workout") or "gym")
        weights = sorted({f"{v['kg']:g} kg" for v in (rec.get("sets") or {}).values()
                          if isinstance(v, dict) and v.get("done") and num(v.get("kg"))})
        out.append(f"{day_label(key)}: {name}{' (light)' if rec.get('light') else ''}, {ticked} sets ticked"
                   f"{', finished' if rec.get('finished') else ''}"
                   f"{', weights ' + ', '.join(weights) if weights else ''}")
    return out


def plan_window(plan, gym, acts, centre, back, ahead, marker):
    by_date = {}
    for a in acts:
        by_date.setdefault(a["date"], []).append(a)
    lines = []
    first = min((s["date"] for s in plan.get("sessions", []) if s.get("date")), default=None)
    for i in range(-back, ahead + 1):
        key = (centre + timedelta(days=i)).isoformat()
        planned = sessions_on(plan, key)
        done = by_date.get(key, [])
        tag = f"{day_label(key)} ({marker})" if i == 0 else day_label(key)
        empty = "before this plan started" if first and key < first else "rest / nothing planned"
        text = " + ".join(describe_session(s, gym) for s in planned) or empty
        if i <= 0 and done:
            text += "  -> ran: " + "; ".join(
                f"{num(a.get('distance_km')):.1f} km at {fmt_pace((num(a.get('moving_time_s')) or 0) / num(a.get('distance_km')))}"
                + (f", HR {int(a['avg_hr'])}" if num(a.get("avg_hr")) else "") for a in done)
        lines.append(f"{tag}: {text}")
    return lines


def race_line(plan, today):
    bits = []
    for r in plan.get("races") or []:
        n = (d(r["date"]) - today).days
        if n >= 0:
            bits.append(f"{r['name']} in {n} days ({day_label(r['date'])})")
    for ph in plan.get("phases") or []:
        if d(ph["start"]) <= today <= d(ph["end"]):
            bits.append(f"current phase: {ph['name']}")
    return "; ".join(bits)


def weather_lines(today):
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast", timeout=20, params={
            "latitude": HOME[0], "longitude": HOME[1], "timezone": os.environ.get("COACH_TZ", "Australia/Melbourne"),
            "forecast_days": 1,
            "hourly": "temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m",
            "daily": "temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max",
        })
        r.raise_for_status()
        j = r.json()
    except Exception as e:
        print(f"coach: no weather ({e.__class__.__name__})")
        return []
    h, dly = j["hourly"], j["daily"]
    out = [f"Today: {dly['temperature_2m_min'][0]:.0f}-{dly['temperature_2m_max'][0]:.0f} C, "
           f"rain chance up to {dly['precipitation_probability_max'][0]}%, wind up to {dly['wind_speed_10m_max'][0]:.0f} km/h"]
    for label, hours in (("early morning", (6, 7, 8)), ("evening", (17, 18, 19))):
        idx = [i for i, t in enumerate(h["time"]) if int(t[11:13]) in hours]
        if idx:
            out.append(f"{label}: " + ", ".join(
                f"{h['time'][i][11:16]} {h['temperature_2m'][i]:.0f} C (feels {h['apparent_temperature'][i]:.0f}), "
                f"rain {h['precipitation_probability'][i]}%, wind {h['wind_speed_10m'][i]:.0f} km/h" for i in idx))
    return out


def compass(deg):
    pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return pts[int((deg + 11.25) % 360 // 22.5)]


def run_weather(a):
    """What it was actually like while he was out in it.

    Without this the debrief judges a heart rate against nothing: a run into a 25 km/h
    headwind in full sun reads as a bad day rather than a hard one. Hourly readings across
    the run window, so a long run that starts cool and finishes warm shows both ends.
    Open-Meteo keeps about a week of past hours on the forecast endpoint, which covers any
    run new enough to be getting a debrief.
    """
    start = (a.get("start_local") or "").strip()
    if not start or ":" not in start:
        return []
    try:
        back = (date.today() - d(a["date"])).days
        if back > 6:
            return []
        j = requests.get("https://api.open-meteo.com/v1/forecast", timeout=20, params={
            "latitude": HOME[0], "longitude": HOME[1], "timezone": os.environ.get("COACH_TZ", "Australia/Melbourne"),
            "past_days": max(1, min(7, back + 1)), "forecast_days": 1,
            "hourly": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,"
                      "wind_gusts_10m,wind_direction_10m,cloud_cover,shortwave_radiation",
        }).json()
    except Exception as e:
        print(f"coach: no run weather ({e.__class__.__name__})")
        return []
    h = j.get("hourly") or {}
    if not h.get("time"):
        return []
    h0, m0 = int(start[:2]), int(start[3:5])
    secs = num(a.get("elapsed_time_s")) or num(a.get("moving_time_s")) or 0
    last = min(23, (h0 * 60 + m0 + int(secs // 60)) // 60)   # the hour he finished in
    want = [f'{a["date"]}T{hh:02d}:00' for hh in range(h0, last + 1)]
    out = []
    for t in want:
        if t not in h["time"]:
            continue
        i = h["time"].index(t)
        sun = h["shortwave_radiation"][i]
        out.append(f"{t[11:16]} {h['temperature_2m'][i]:.0f} C (feels {h['apparent_temperature'][i]:.0f}), "
                   f"humidity {h['relative_humidity_2m'][i]:.0f}%, "
                   f"wind {h['wind_speed_10m'][i]:.0f} gusting {h['wind_gusts_10m'][i]:.0f} km/h "
                   f"from the {compass(h['wind_direction_10m'][i])}, "
                   f"cloud {h['cloud_cover'][i]:.0f}%, sun {sun:.0f} W/m2"
                   + (" (full sun on him)" if sun > 350 and h["cloud_cover"][i] < 30 else ""))
    return [f"Started {start}. Conditions through the run:"] + out if out else []


# ---------------------------------------------------------------- prompts

def debrief_prompt(a, ctx):
    today, plan, gym = ctx["today"], ctx["plan"], ctx["gym"]
    run_day = d(a["date"])
    lines, det = run_detail_text(a)
    planned = sessions_on(plan, a["date"])
    runs_that_day = [x for x in ctx["acts"] if x["date"] == a["date"]]
    shoes = ctx.get("shoes")
    if shoes:
        sid = shoes["run_shoe"](a.get("id"))
        worn = shoes["by_id"].get(sid)
        lines.append("Shoes: " + (shoe_line(shoes, worn) if worn else "not tagged yet"))
    parts = ["Write the DEBRIEF for this run.", "", "# The run", *lines, ""]
    wx = run_weather(a)
    if wx:
        parts += ["# Conditions", *wx, ""]
    if planned:
        parts.append("# Planned for that day")
        parts += [describe_session(s, gym) for s in planned]
        if det and det.get("splits"):
            for s in planned:
                segs = split_segments(s, det["splits"])
                if segs:
                    parts.append("Planned segments vs splits (assumes the run followed the plan in order): "
                                 + "; ".join(segs))
        if len(runs_that_day) > 1:
            parts.append(f"Note: {len(runs_that_day)} runs were recorded that day; the plan may be split across them.")
    else:
        parts.append("# Planned for that day\nNothing in the plan for that date.")
    parts += ["", f"# Context (today is {day_label(today.isoformat())}; counts below are from the run day)",
              race_line(plan, run_day), "",
              "Plan around the run:", *plan_window(plan, gym, ctx["acts"], run_day, 4, 4, "THIS RUN'S DAY"), "",
              "Other runs in the 10 days before it:",
              *[run_line(x) for x in ctx["acts"] if run_day - timedelta(days=10) <= d(x["date"]) < run_day
                or (x["date"] == a["date"] and x is not a)],
              "", "Weekly distance:", *weekly_km(ctx["acts"], run_day), "",
              "Recovery data:", *wellness_lines(ctx["well"], run_day, 5)]
    return "\n".join(p for p in parts if p is not None)


def brief_prompt(ctx):
    today, plan, gym = ctx["today"], ctx["plan"], ctx["gym"]
    key = today.isoformat()
    monday = today - timedelta(days=today.weekday())
    done_today = [a for a in ctx["acts"] if a["date"] == key]
    parts = [f"Write the MORNING BRIEF for {today:%A} {today.day} {today:%B %Y}.",
             f"Local time now: {ctx['now']:%H:%M}.", "", race_line(plan, today), "",
             "# Plan (TODAY is the one to brief)", *plan_window(plan, gym, ctx["acts"], today, 3, 5, "TODAY"), "",
             f"Planned running this week: {planned_week_km(plan, monday):.0f} km; "
             f"next week: {planned_week_km(plan, monday + timedelta(days=7)):.0f} km.",
             "", "# Recent runs (last 7 days)",
             *([run_line(a) for a in ctx["acts"] if today - timedelta(days=7) <= d(a["date"]) <= today]
               or ["none"]),
             "", "Weekly distance:", *weekly_km(ctx["acts"], today), "",
             "# Recovery (last night's readings are on today's date)", *wellness_lines(ctx["well"], today)]
    shoes = ctx.get("shoes")
    todays_runs = [s for s in sessions_on(plan, key) if s.get("type") in RUN_TYPES]
    if shoes and todays_runs and not done_today:
        pick = suggest_shoe(shoes, session_shoe_kind(todays_runs[0]),
                            shoes["by_date"].get((today - timedelta(days=1)).isoformat(), []),
                            load_window(shoes, ctx["acts"], today))
        if pick:
            parts += ["", f"# Shoes the dashboard suggests for today: {shoe_line(shoes, pick[0])}. Reason: {pick[1]}"]
    gl = gym_lines(ctx["gym_log"], gym, today)
    parts += ["", "# Gym log (last 14 days)", *(gl or ["nothing logged (the log may just be unavailable)"])]
    if done_today:
        parts += ["", "Already done today: " + "; ".join(run_line(a) for a in done_today)
                  + ". It has its own debrief, so don't brief it as still to come."]
    wx = weather_lines(today)
    if wx:
        parts += ["", "# Weather", *wx]
    return "\n".join(parts)


# ---------------------------------------------------------------- Claude

def ask_claude(system, prompt):
    """One paragraph back from Claude Code in print mode, or None."""
    base = ["claude", "-p", "Write it now, following your instructions. Reply with the paragraph only.",
            "--output-format", "json", "--system-prompt", system,
            "--max-turns", "2", "--no-session-persistence",
            "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite"]
    model = os.environ.get("COACH_MODEL", "opus")
    attempts = [base + ["--model", model]] if model else []
    attempts.append(base)   # fall back to the account's default model
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    # run somewhere empty so nothing in the repo (or a CLAUDE.md) leaks into the prompt
    with tempfile.TemporaryDirectory() as cwd:
        for cmd in attempts:
            try:
                p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                                   timeout=300, cwd=cwd, env=env)
            except (OSError, subprocess.TimeoutExpired) as e:
                print(f"coach: claude didn't run ({e.__class__.__name__})")
                continue
            try:
                out = json.loads(p.stdout)
            except ValueError:
                print(f"coach: claude exit {p.returncode}: {(p.stderr or p.stdout).strip()[:300]}")
                continue
            if out.get("is_error") or out.get("subtype") != "success":
                print(f"coach: claude error: {str(out.get('result') or out.get('subtype'))[:300]}")
                continue
            return clean(out.get("result", ""))
    return None


def clean(text):
    text = re.sub(r"[*_#`]+", "", text or "").strip().strip('"').strip()
    text = re.sub(r"\s*\n+\s*", " ", text)
    return text or None


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print prompts, don't call Claude")
    ap.add_argument("--brief", action="store_true", help="write today's brief even if one exists")
    ap.add_argument("--debrief", metavar="ID", action="append", default=[], help="rewrite this run's debrief")
    args = ap.parse_args()

    if not args.dry_run:
        if not (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or "").strip():
            print("coach: CLAUDE_CODE_OAUTH_TOKEN isn't set - no brief or debriefs this time")
            return
        if not shutil.which("claude"):
            print("coach: the claude CLI isn't installed - skipping")
            return

    now = melbourne_now()
    today = now.date()
    coach = {"briefs": {}, "debriefs": {}}
    if os.path.exists(COACH_PATH):
        with open(COACH_PATH, encoding="utf-8-sig") as f:
            coach.update(json.load(f))
    with open(PROMPT_PATH, encoding="utf-8") as f:
        system = f.read()
    gym = {}
    if os.path.exists("gym_programs.json"):
        with open("gym_programs.json", encoding="utf-8-sig") as f:
            gym = json.load(f)

    acts = load_activities()
    ctx = {"now": now, "today": today, "acts": acts, "well": load_wellness(), "gym": gym, "plan": load_plan(gym)}
    gym_log, why = kv_doc("gym")
    if why:
        print(f"coach: no gym log ({why})")
    ctx["gym_log"] = gym_log
    ctx["shoes"] = load_shoes(acts)

    # debriefs: recent runs without one, oldest first
    todo = [a for a in acts if a.get("id") and (
        a["id"] in args.debrief or
        (a["id"] not in coach["debriefs"] and (today - d(a["date"])).days <= DEBRIEF_DAYS))]
    changed = False
    for a in todo[-MAX_DEBRIEFS:]:
        prompt = debrief_prompt(a, ctx)
        if args.dry_run:
            print(f"\n===== DEBRIEF {a['id']} =====\n{prompt}")
            continue
        text = ask_claude(system, prompt)
        if text:
            coach["debriefs"][a["id"]] = {"text": text, "date": a["date"], "at": now.isoformat(timespec="minutes")}
            changed = True
            print(f"coach: debrief for {a['date']} {a.get('name')}: {len(text.split())} words")

    # morning brief
    key = today.isoformat()
    have = coach["briefs"].get(key)
    hrv_now = "hrv" in ctx["well"].get(key, {})
    want = (args.brief
            or (not have and BRIEF_HOURS[0] <= now.hour < BRIEF_HOURS[1])
            # written before the watch synced last night's HRV: once, redo it with the data
            or (have and not have.get("hrv") and hrv_now and now.hour < 12))
    if want:
        prompt = brief_prompt(ctx)
        if args.dry_run:
            print(f"\n===== BRIEF {key} =====\n{prompt}")
        else:
            text = ask_claude(system, prompt)
            if text:
                coach["briefs"][key] = {"text": text, "at": now.isoformat(timespec="minutes"), "hrv": hrv_now}
                changed = True
                print(f"coach: morning brief: {len(text.split())} words")
    else:
        print(f"coach: brief {'already written' if have else 'not due'} ({now:%H:%M} local)")

    if changed:
        coach["briefs"] = dict(sorted(coach["briefs"].items())[-KEEP_BRIEFS:])
        os.makedirs(os.path.dirname(COACH_PATH), exist_ok=True)
        with open(COACH_PATH, "w", encoding="utf-8") as f:
            json.dump(coach, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    try:
        main()
    except Exception:   # a coaching note is never worth failing the dashboard build
        print("coach: skipped after an error:")
        traceback.print_exc(file=sys.stdout)
        sys.exit(0)
