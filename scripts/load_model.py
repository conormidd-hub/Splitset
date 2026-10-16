#!/usr/bin/env python3
"""Reference implementation of docs/load-model-spec.md.

Pure functions, no I/O beyond loading the two data files. Claude Code ports this
into the app's language; scripts/verify_spec_fixtures.py holds the numbers the
port must reproduce.

Times are hours (floats) on one clock. A "workout" is:
    {"start": h, "end": h, "exercises": [(slug, [set, ...]), ...]}
A "set" is a dict with any of:
    w (kg), r (reps), rpe, warmup (bool), seconds, side ("left"/"right"/None),
    bodyweight (kg snapshot taken when the set was saved; bodyweight/assisted modes)
PB history is a list of records:
    {"slug", "e1rm", "at" (h), "source": "logged" | "manual"}
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = json.loads((ROOT / "data" / "exercise_library.json").read_text())
C = json.loads((ROOT / "data" / "recovery_constants.json").read_text())

EX = {e["slug"]: e for e in LIB["exercises"]}
MUSCLES = [m["id"] for m in LIB["muscles"]]
DAY = 24.0


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


# ---------------- §3.1 e1RM ----------------
def rir_from_rpe(rpe):
    return None if rpe is None else clamp(10 - rpe, 0, 5)


def e1rm(w, r, rir=0):
    reps = min(r + rir, C["e1rm"]["max_reps"])
    return w if reps <= 1 else w * (1 + reps / C["e1rm"]["epley_divisor"])


# ---------------- §3.2 effective weight ----------------
def effective_weight(s, ex, bodyweight):
    mode = ex["load_mode"]
    bodyweight = s.get("bodyweight") or bodyweight
    added = s.get("w") or 0.0
    if mode == "weight":
        return s["w"]
    if mode == "bodyweight":
        return bodyweight * ex["bw_factor"] + added
    if mode == "assisted":
        return max(bodyweight * ex["bw_factor"] - added, 0.0)
    return None  # fixed


# ---------------- §3.3–§3.5 PB before a session ----------------
def _records(slug, at, history):
    recs = [h for h in history if h["slug"] == slug and h["at"] < at]
    if C["pb"]["manual_policy"] == "replace_on_log":
        logged = [h["at"] for h in recs if h["source"] == "logged"]
        if logged:
            newest = max(logged)
            recs = [h for h in recs if h["source"] == "logged" or h["at"] > newest]
    return recs


def _own_pb(slug, at, history):
    """Rules 1–2 of §3.4. Returns (pb, source, kind) with kind = logged | manual."""
    win = C["pb"]["window_days"] * DAY
    recs = _records(slug, at, history)
    in_win = [h for h in recs if h["at"] >= at - win]
    if in_win:
        best = max(in_win, key=lambda h: h["e1rm"])
        return best["e1rm"], "monthly", best["source"]
    if recs:
        last = max(h["at"] for h in recs)
        best = max((h for h in recs if h["at"] >= last - win), key=lambda h: h["e1rm"])
        return best["e1rm"] * C["pb"]["lapsed_factor"], "lapsed", best["source"]
    return None, None, None


def pb_before(slug, at, history):
    """Returns (pb, source, detail).
    source: monthly | lapsed | estimated | calibration
    detail: logged | manual for monthly/lapsed; the anchor slug for estimated; None otherwise.
    An anchor's lapsed factor and the estimate discount both apply when they meet."""
    pb, src, kind = _own_pb(slug, at, history)
    if pb is not None:
        return pb, src, kind
    ratio, cur, hops = 1.0, EX[slug], 0
    while cur.get("pb_estimate") and hops < C["pb"]["estimate_max_hops"]:
        est = cur["pb_estimate"]
        ratio *= est["ratio"]
        hops += 1
        base, _, _ = _own_pb(est["from"], at, history)
        if base is not None:
            return base * ratio * C["pb"]["estimate_discount"], "estimated", est["from"]
        cur = EX[est["from"]]
    return None, "calibration", None


# ---------------- §4 set load ----------------
def fixed_cost(rpe):
    f = C["fixed_set"]
    if rpe is None:
        return f["base"]
    return clamp(f["base"] + f["per_rpe_point"] * (rpe - 8), f["min"], f["max"])


def inol(w, r, ref):
    i = min(w / ref, C["intensity_cap"])
    reps = min(r, C["e1rm"]["max_reps"])
    return reps / (100 * (1 - i)), i


def side_factor(s):
    return C["unilateral_side_factor"] if s.get("side") in ("left", "right") else 1.0


def score_exercise(slug, sets, start, history, bodyweight, session_best=None):
    """§3–§5. Returns dict with L_e, per-set detail, pb info, new PB records.
    session_best: e1RM already reached on this exercise earlier in the same workout
    (an exercise logged in two blocks keeps one running reference, §3.5)."""
    ex = EX[slug]
    f = C["fatigue_factors"][ex["fatigue"]]
    detail, new_records = [], []
    if ex["load_mode"] == "fixed":
        total = 0.0
        for s in sets:
            if s.get("warmup"):
                continue
            c = fixed_cost(s.get("rpe")) * side_factor(s)
            detail.append({"cost": c})
            total += c
        return {"L_e": f * total, "raw": total, "factor": f, "sets": detail,
                "pb_before": None, "pb_source": "not needed", "records": []}

    pb0, src, via = pb_before(slug, start, history)
    calibrating = src == "calibration"
    best = max(pb0 or 0.0, session_best or 0.0)
    total = 0.0
    for s in sets:
        w = effective_weight(s, ex, bodyweight)
        if not w or w <= 0:
            continue
        rir = rir_from_rpe(s.get("rpe"))
        scoring_rir = rir if rir is not None else (C["pb"]["calibration_rir"] if calibrating else C["e1rm"]["rir_default"])
        stored_rir = rir if rir is not None else C["e1rm"]["rir_default"]
        best = max(best, e1rm(w, s["r"], scoring_rir))
        new_records.append({"slug": slug, "e1rm": e1rm(w, s["r"], stored_rir), "source": "logged"})
        if s.get("warmup"):
            detail.append({"w": w, "r": s["r"], "warmup": True, "ref": best})
            continue
        load, i = inol(w, s["r"], best)
        load *= side_factor(s)
        detail.append({"w": w, "r": s["r"], "ref": best, "I": i, "inol": load})
        total += load
    return {"L_e": f * total, "raw": total, "factor": f, "sets": detail,
            "pb_before": pb0, "pb_source": src, "pb_via": via, "records": new_records, "best": best}


# ---------------- §6 muscle load ----------------
def muscle_loads(exercise_loads):
    """exercise_loads: {slug: L_e}. Returns {muscle: L_m} for all muscles."""
    rw = C["role_weights"]
    out = {m: 0.0 for m in MUSCLES}
    for slug, le in exercise_loads.items():
        ex = EX[slug]
        for role in ("primary", "secondary", "tertiary"):
            for m in ex[role]:
                out[m] += rw[role] * le
    return out


def score_workout(workout, history, bodyweight=None):
    """Scores a finished workout and appends its PB records to history.
    Returns {"L_e": {slug: ...}, "L_m": {...}, "R": {...}, "detail": {...}}."""
    bw = bodyweight or C["bodyweight_default_kg"]
    L_e, detail, session_best, records = {}, {}, {}, []
    for slug, sets in workout["exercises"]:
        res = score_exercise(slug, sets, workout["start"], history, bw, session_best.get(slug))
        session_best[slug] = res.get("best", 0.0)
        records.extend(res["records"])
        L_e[slug] = L_e.get(slug, 0.0) + res["L_e"]
        if slug in detail:  # second block of the same exercise: merge
            prev = detail[slug]
            res = dict(prev, L_e=prev["L_e"] + res["L_e"], raw=prev["raw"] + res["raw"],
                       sets=prev["sets"] + res["sets"], records=prev["records"] + res["records"],
                       best=res.get("best"))
        detail[slug] = res
    for rec in records:
        history.append(dict(rec, at=workout["end"]))
    L_m = muscle_loads(L_e)
    R = {m: recovery_hours(L_m[m], m) for m in MUSCLES}
    return {"L_e": L_e, "L_m": L_m, "R": R, "detail": detail, "end": workout["end"]}


# ---------------- §7 recovery window ----------------
def base_hours(m):
    b = C["base_recovery_hours"]
    return b.get(m, b["default"])


def recovery_hours(L, m):
    r = C["recovery"]
    return base_hours(m) * clamp(r["intercept"] + r["slope"] * L, r["min_multiplier"], r["max_multiplier"])


def hours_until_below(L, R, threshold):
    """For a single workout term: hours after the workout until F < threshold."""
    return 0.0 if L < threshold else R * (1 - threshold / L)


# ---------------- §8 fatigue over time ----------------
def lookback_hours():
    """Longest possible recovery window: no older workout can still be non-zero."""
    b = C["base_recovery_hours"]
    return max(b.values()) * C["recovery"]["max_multiplier"]


def terms_for(scored_workouts, m):
    return [(s["end"], s["L_m"][m], s["R"][m]) for s in scored_workouts if s["L_m"][m] > 0]


def fatigue(terms, t):
    return sum(L * max(0.0, 1 - (t - tw) / R) for tw, L, R in terms if tw <= t)


def weekly(terms, t):
    win = C["fatigue"]["weekly_window_hours"]
    return sum(L for tw, L, R in terms if 0 <= t - tw < win)


# ---------------- §9 levels ----------------
def level_for(F):
    lvl = 0
    for band in C["levels"]:
        if F >= band["min"] and band["level"] > 0:
            lvl = band["level"]
    return lvl


def displayed_level(F, W):
    lvl = level_for(F)
    if W >= C["fatigue"]["weekly_cap"]:
        lvl = max(lvl, C["fatigue"]["weekly_cap_min_level"])
    return lvl


def level_info(lvl):
    return C["levels"][lvl]


def first_time(terms, now, pred, horizon=None, step=0.25):
    """First t >= now (on a 15-minute grid) where pred(t) holds. F only falls and W only
    drops at workout anniversaries, so a scan is exact enough for display."""
    horizon = horizon or (lookback_hours() + C["fatigue"]["weekly_window_hours"])
    t = now
    while t <= now + horizon:
        if pred(t):
            return t
        t += step
    return None


def muscle_state(terms, now):
    F = fatigue(terms, now)
    W = weekly(terms, now)
    lvl = displayed_level(F, W)
    ready = first_time(terms, now, lambda t: displayed_level(fatigue(terms, t), weekly(terms, t)) == 0)
    trainable = first_time(terms, now, lambda t: displayed_level(fatigue(terms, t), weekly(terms, t)) <= C["trainable_max_level"])
    return {"F": F, "W": W, "level": lvl, "label": level_info(lvl)["label"],
            "fill": level_info(lvl)["fill"] or C["ready_fill"],
            "ready_in_h": None if ready is None else ready - now,
            "trainable_in_h": None if trainable is None else trainable - now}


def recovery_map(scored_workouts, now):
    return {m: muscle_state(terms_for(scored_workouts, m), now) for m in MUSCLES}


def session_map(scored):
    """Session view: colour by this workout's own L_m (§10)."""
    out = {}
    for m in MUSCLES:
        L, R = scored["L_m"][m], scored["R"][m]
        lvl = level_for(L)
        out[m] = {"L": L, "level": lvl, "label": level_info(lvl)["label"],
                  "fill": level_info(lvl)["fill"] or C["ready_fill"],
                  "R": R, "ready_in_h": hours_until_below(L, R, C["levels"][1]["min"]),
                  "trainable_in_h": hours_until_below(L, R, C["levels"][C["trainable_max_level"] + 1]["min"])}
    return out


def fmt_hours(h):
    if h is None:
        return "—"
    if h <= 0:
        return "now"
    if h < 24:
        return f"{round(h)} h"
    return f"{h / 24:.1f} days"
